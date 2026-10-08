import Foundation
import AppKit

// Spotify supplies the catalogue; yt-dlp retrieves matched YouTube audio.
// No Spotify audio stream, login, or protected offline cache is accessed.
enum SpotifyService {
    static func resolve(_ url: URL, stagingRoot: URL, progress: @escaping DownloadService.Progress) async throws -> PlaylistManifest {
        await progress(0.01, "Reading public Spotify collection…")
        let page = try await SpotifyCatalog.page(url)
        let entity = try SpotifyCatalog.entity(in: page, url: url)
        let content = entity["content"] as? [String: Any] ?? entity["tracks"] as? [String: Any] ?? [:]
        let total = content["totalCount"] as? Int
        let embedURL = URL(string: "https://open.spotify.com/embed" + url.path)!
        let embed = try await SpotifyCatalog.page(embedURL)
        let visible = try SpotifyCatalog.embedManifest(embed, total: total)
        // Try the optional full catalogue reader before reporting public-page limits.
        if visible.entries.contains(where: { $0.url == nil }), let spotdl = DownloadService.executable("spotdl") {
            let folder = stagingRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: folder) }
            let file = folder.appendingPathComponent("collection.spotdl")
            do {
                await progress(0.01, "Checking the remaining Spotify tracks…")
                _ = try await DownloadService.run(spotdl, arguments: ["save", url.absoluteString,
                    "--save-file", file.path, "--max-retries", "1", "--log-level", "ERROR", "--lyrics"],
                    logFolder: folder, timeout: 20) { _, _ in }
                let full = try parse(Data(contentsOf: file))
                if total == nil || full.entries.count >= total! { return full }
            } catch {
                if error is CancellationError || Task.isCancelled { throw CancellationError() }
            }
        }
        return visible
    }

    static func parse(_ data: Data) throws -> PlaylistManifest {
        guard let songs = try JSONSerialization.jsonObject(with: data) as? [[String: Any]], !songs.isEmpty else {
            throw MeloraError.message("Spotify returned no tracks for this collection.")
        }
        let entries = songs.map { song -> PlaylistEntry in
            let name = song["name"] as? String ?? "Unavailable track"
            let artist = song["artist"] as? String ?? ""
            let url = (song["url"] as? String).flatMap(URL.init(string:)).flatMap(ImportURL.spotifyURL)
            let trackURL = url.flatMap { $0.path.hasPrefix("/track/") ? $0 : nil }
            return PlaylistEntry(title: artist.isEmpty ? name : "\(artist) — \(name)", url: trackURL,
                                 unavailableReason: trackURL == nil ? "Spotify did not provide an accessible track link." : nil)
        }
        let title = [songs.first?["list_name"] as? String, songs.first?["album_name"] as? String]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }.first { !$0.isEmpty } ?? "Spotify collection"
        return PlaylistManifest(title: title, entries: entries)
    }

    static func download(_ url: URL, stagingRoot: URL, progress: @escaping DownloadService.Progress) async throws -> DownloadResult {
        guard let url = ImportURL.spotifyURL(url), url.path.hasPrefix("/track/") else {
            throw MeloraError.message("Use a Spotify track link, or import the album or playlist as a collection.")
        }
        guard let downloader = DownloadService.executable("yt-dlp"), DownloadService.executable("ffmpeg") != nil else {
            throw MeloraError.message("Spotify matching needs yt-dlp and FFmpeg. Install the download tools in Settings.")
        }
        await progress(0.02, "Reading Spotify tags and finding a matching recording…")
        let info = try SpotifyCatalog.trackInfo(SpotifyCatalog.entity(in: await SpotifyCatalog.page(url), url: url))
        guard !info.artist.isEmpty else { throw MeloraError.message("Spotify did not provide an artist for this track. Import its video link directly.") }
        let folder = stagingRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        var attempted = Set<URL>()
        var downloaded: DownloadResult?
        var lastError: String?
        for query in SpotifyCatalog.searchQueries(info) {
            try Task.checkCancellation()
            await progress(0.03, "Finding a recording by \(info.artist)…")
            let output = try await DownloadService.run(downloader, arguments: ["--ignore-config", "--flat-playlist", "--dump-single-json",
                "--skip-download", "--no-warnings", "--socket-timeout", "15", "--retries", "1", "--",
                "ytsearch10:\(query)"], logFolder: folder, timeout: 60) { _, _ in }
            guard let raw = output.split(whereSeparator: \.isNewline).last(where: { $0.hasPrefix("{") }) else { continue }
            let matches = try SpotifyCatalog.candidates(Data(raw.utf8), info: info)
            for match in matches.prefix(3) where attempted.insert(match).inserted {
                do {
                    downloaded = try await DownloadService.download(match, stagingRoot: stagingRoot) { value, message in
                        await progress(value, "Spotify match · " + message)
                    }
                    break
                } catch {
                    if error is CancellationError || Task.isCancelled { throw CancellationError() }
                    lastError = error.localizedDescription
                }
            }
            if downloaded != nil { break }
        }
        guard let result = downloaded else {
            if let lastError { throw MeloraError.message("Matching recordings were found, but downloads failed: \(lastError)") }
            throw MeloraError.message("No confident YouTube match was found for \(info.artist) — \(info.title). Import the correct video link directly.")
        }
        do {
            try Task.checkCancellation()
            var track = result.track
            track.title = info.title
            track.artist = info.artist
            track.album = info.album
            track.sourceURL = url.absoluteString
            if let art = try? await saveArtwork(info.cover, in: result.stagingFolder) { track.artworkPath = art }
            try Task.checkCancellation()
            return DownloadResult(track: track, stagingFolder: result.stagingFolder)
        } catch {
            try? FileManager.default.removeItem(at: result.stagingFolder)
            throw error
        }
    }

    static func restoreArtwork(_ source: URL, in folder: URL) async throws -> String? {
        let info = try SpotifyCatalog.trackInfo(SpotifyCatalog.entity(in: await SpotifyCatalog.page(source), url: source))
        return try await saveArtwork(info.cover, in: folder)
    }

    private static func saveArtwork(_ cover: URL?, in folder: URL) async throws -> String? {
        guard let cover else { return nil }
        var request = URLRequest(url: cover)
        request.timeoutInterval = 15
        let (data, response) = try await URLSession.shared.data(for: request)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              NSImage(data: data) != nil else { return nil }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try data.write(to: folder.appendingPathComponent("spotify-cover"), options: .atomic)
        return "spotify-cover"
    }
}
