import Foundation

struct ImportServices {
    var download: @Sendable (URL, URL, @escaping DownloadService.Progress) async throws -> DownloadResult
    var resolvePlaylist: @Sendable (URL, URL, @escaping DownloadService.Progress) async throws -> PlaylistManifest

    static let live = ImportServices(
        download: { url, staging, progress in
            if ImportURL.spotifyURL(url) != nil { return try await SpotifyService.download(url, stagingRoot: staging, progress: progress) }
            return try await DownloadService.download(url, stagingRoot: staging, progress: progress)
        },
        resolvePlaylist: { url, staging, progress in
            if ImportURL.spotifyURL(url) != nil { return try await SpotifyService.resolve(url, stagingRoot: staging, progress: progress) }
            return try await PlaylistService.resolve(url, stagingRoot: staging, progress: progress)
        }
    )
}

enum PlaylistService {
    static func resolve(_ url: URL, stagingRoot: URL, progress: @escaping DownloadService.Progress) async throws -> PlaylistManifest {
        guard let downloader = DownloadService.executable("yt-dlp"), DownloadService.executable("ffmpeg") != nil else {
            throw MeloraError.message("YouTube playlists need yt-dlp and FFmpeg. Install the download tools in Settings.")
        }
        let folder = stagingRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        await progress(0.01, "Reading YouTube playlist…")
        let output = try await DownloadService.run(downloader, arguments: [
            "--ignore-config", "--yes-playlist", "--flat-playlist", "--dump-single-json",
            "--skip-download", "--no-warnings", "--no-colors", "--socket-timeout", "30",
            "--retries", "3", "--", url.absoluteString
        ], logFolder: folder) { _, _ in }
        try Task.checkCancellation()
        // stderr diagnostics may precede the JSON in the process log.
        guard let json = output.split(whereSeparator: \.isNewline).last(where: { $0.hasPrefix("{") }),
              let data = String(json).data(using: .utf8) else {
            throw MeloraError.message("Could not read this YouTube playlist. Make sure it is public or unlisted.")
        }
        return try parse(data)
    }

    static func parse(_ data: Data) throws -> PlaylistManifest {
        guard let document = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rawEntries = document["entries"] as? [Any], !rawEntries.isEmpty else {
            throw MeloraError.message("This playlist is empty or cannot be accessed. Use a public or unlisted YouTube playlist.")
        }
        let entries: [PlaylistEntry] = rawEntries.map { raw in
            guard let entry = raw as? [String: Any] else {
                return PlaylistEntry(title: "Unavailable video", url: nil, unavailableReason: "YouTube did not provide this video.")
            }
            let title = entry["title"] as? String ?? "Untitled video"
            let availability = entry["availability"] as? String ?? ""
            let unavailable = ["private", "premium_only", "subscriber_only", "needs_auth"].contains(availability) || ["[Private video]", "[Deleted video]"].contains(title)
            var url: URL?
            if let link = (entry["webpage_url"] as? String) ?? (entry["url"] as? String) {
                url = try? ImportURL.parse(link)
            }
            if url == nil, let id = entry["id"] as? String, !id.isEmpty {
                var components = URLComponents(string: "https://www.youtube.com/watch")!
                components.queryItems = [URLQueryItem(name: "v", value: id)]
                url = components.url
            }
            return PlaylistEntry(title: title, url: url,
                                 unavailableReason: unavailable ? "This video is private, deleted or requires access." : url == nil ? "No downloadable video link was provided." : nil)
        }
        let title = (document["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return PlaylistManifest(title: title.flatMap { $0.isEmpty ? nil : $0 } ?? "YouTube playlist", entries: entries)
    }
}
