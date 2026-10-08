import Foundation
import AVFoundation
import AppKit
import Darwin

struct DownloadResult: Sendable {
    let track: Track
    let stagingFolder: URL
}

enum DownloadService {
    typealias Progress = @Sendable (Double, String) async -> Void

    static func executable(_ name: String) -> URL? {
        let bundled = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/\(name)")
        let search = [bundled.path, "/opt/homebrew/bin/\(name)", "/usr/local/bin/\(name)", FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin/\(name)").path] +
            (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map { "\($0)/\(name)" }
        return search.first(where: { FileManager.default.isExecutableFile(atPath: $0) }).map { URL(fileURLWithPath: $0) }
    }

    static func download(_ url: URL, stagingRoot: URL, progress: @escaping Progress) async throws -> DownloadResult {
        if url.host?.lowercased() == "open.spotify.com" || ["spotify.link", "spoti.fi"].contains(url.host?.lowercased() ?? "") {
            guard let canonical = ImportURL.spotifyURL(url) else { throw MeloraError.message("Use a full open.spotify.com track, album, or playlist link.") }
            return try await SpotifyService.download(canonical, stagingRoot: stagingRoot, progress: progress)
        }
        let folder = stagingRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        do {
            try Task.checkCancellation()
            let directAudio = ImportURL.isAudio(url) ? true : await hasAudioContentType(url)
            if directAudio {
                return try await directDownload(url, folder: folder, progress: progress)
            }
            guard let downloader = executable("yt-dlp"), let ffmpeg = executable("ffmpeg") else {
                throw MeloraError.message("Video links need yt-dlp and FFmpeg. Open Settings to install the download tools. Direct MP3, M4A and other audio links work immediately.")
            }
            await progress(0.02, "Reading video and finding the best audio…")
            // Arguments are passed directly to the executable, never through a shell.
            var arguments = ["--ignore-config", "--no-playlist", "--no-colors", "--newline",
                             "--socket-timeout", "30", "--retries", "3", "--no-mtime",
                             "--ffmpeg-location", ffmpeg.deletingLastPathComponent().path,
                             "-f", "bestaudio[ext=m4a]/bestaudio/best", "--extract-audio", "--audio-format", "m4a",
                             "--audio-quality", "0", "--embed-metadata", "--write-info-json",
                             "--write-thumbnail", "--convert-thumbnails", "jpg",
                             "-o", folder.appendingPathComponent("audio.%(ext)s").path]
            if let deno = executable("deno") {
                arguments += ["--js-runtimes", "deno:\(deno.path)"]
            } else if let node = executable("node") {
                arguments += ["--js-runtimes", "node:\(node.path)"]
            }
            arguments += ["--", url.absoluteString]
            do {
                _ = try await run(downloader, arguments: arguments, logFolder: folder, progress: progress)
            } catch {
                if error is CancellationError || Task.isCancelled { throw CancellationError() }
                // YouTube sometimes rejects direct audio URLs while its segmented audio remains available.
                guard ImportURL.isYouTube(url), error.localizedDescription.contains("403"),
                      let formatIndex = arguments.firstIndex(of: "-f") else { throw error }
                for file in try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) {
                    try FileManager.default.removeItem(at: file)
                }
                await progress(0.03, "Retrying with another audio stream…")
                arguments[formatIndex + 1] = "bestaudio[protocol=m3u8_native]/bestaudio[protocol=m3u8]"
                _ = try await run(downloader, arguments: arguments, logFolder: folder, progress: progress)
            }
            try Task.checkCancellation()
            let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            guard let audio = files.first(where: { $0.pathExtension == "m4a" }) else {
                throw MeloraError.message("The download finished without a playable audio file.")
            }
            let infoURL = folder.appendingPathComponent("audio.info.json")
            let info = (try? JSONSerialization.jsonObject(with: Data(contentsOf: infoURL))) as? [String: Any] ?? [:]
            let cover = files.first { ["jpg", "jpeg", "png", "webp"].contains($0.pathExtension.lowercased()) }
            var track = try await metadata(audio, source: url)
            track.title = nonempty(info["track"] as? String) ?? nonempty(info["title"] as? String) ?? track.title
            track.artist = nonempty(info["artist"] as? String) ?? nonempty(info["creator"] as? String) ?? nonempty(info["uploader"] as? String) ?? track.artist
            track.album = nonempty(info["album"] as? String) ?? track.album
            if let cover { track.artworkPath = cover.lastPathComponent }
            return DownloadResult(track: track, stagingFolder: folder)
        } catch {
            try? FileManager.default.removeItem(at: folder)
            throw error
        }
    }

    private static func nonempty(_ value: String?) -> String? {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return value
    }

    private static func hasAudioContentType(_ url: URL) async -> Bool {
        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"
        request.timeoutInterval = 15
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return false }
        return response.mimeType?.hasPrefix("audio/") == true
    }

    private static func directDownload(_ url: URL, folder: URL, progress: @escaping Progress) async throws -> DownloadResult {
        await progress(0.05, "Downloading audio…")
        var request = URLRequest(url: url)
        request.timeoutInterval = 120
        let (temporary, response) = try await URLSession.shared.download(for: request)
        defer { try? FileManager.default.removeItem(at: temporary) }
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw MeloraError.message("The server refused the audio download. Check that the link points to a downloadable file.")
        }
        let mime = response.mimeType ?? ""
        guard !mime.contains("text/html"), !mime.contains("application/json") else {
            throw MeloraError.message("This link returned a webpage instead of audio. Use the actual download link or the video page URL.")
        }
        let extensions = ["audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/flac": "flac", "audio/x-flac": "flac", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg"]
        let suggested = URL(fileURLWithPath: response.suggestedFilename ?? url.lastPathComponent)
        let ext = ImportURL.isAudio(suggested) ? suggested.pathExtension : (extensions[mime] ?? "m4a")
        let destination = folder.appendingPathComponent("audio.\(ext)")
        try FileManager.default.moveItem(at: temporary, to: destination)
        await progress(0.9, "Reading tags and cover art…")
        var track = try await metadata(destination, source: url)
        if track.title == "audio" {
            track.title = suggested.deletingPathExtension().lastPathComponent.removingPercentEncoding ?? "Untitled"
        }
        // AVFoundation does not decode every format; convert FLAC/Opus/Ogg if needed.
        let asset = AVURLAsset(url: destination)
        if (try? await asset.load(.isPlayable)) != true {
            guard let ffmpeg = executable("ffmpeg") else {
                throw MeloraError.message("This audio format needs FFmpeg to convert it for macOS playback. Install the download tools in Settings.")
            }
            let converted = folder.appendingPathComponent("converted.m4a")
            _ = try await run(ffmpeg, arguments: ["-nostdin", "-y", "-i", destination.path, "-vn", "-c:a", "aac", "-b:a", "256k", converted.path], logFolder: folder, progress: progress)
            let convertedMetadata = try await metadata(converted, source: url)
            track.audioPath = converted.lastPathComponent
            track.duration = convertedMetadata.duration
        }
        return DownloadResult(track: track, stagingFolder: folder)
    }

    static func metadata(_ file: URL, source: URL?) async throws -> Track {
        let asset = AVURLAsset(url: file)
        let metadata = (try? await asset.load(.commonMetadata)) ?? []
        var title = file.deletingPathExtension().lastPathComponent
        var artist = "Unknown artist"
        var album = "Singles"
        var art: String?
        for item in metadata {
            switch item.commonKey {
            case .commonKeyTitle: title = (try? await item.load(.stringValue)) ?? title
            case .commonKeyArtist: artist = (try? await item.load(.stringValue)) ?? artist
            case .commonKeyAlbumName: album = (try? await item.load(.stringValue)) ?? album
            case .commonKeyArtwork:
                if let data = try? await item.load(.dataValue), NSImage(data: data) != nil {
                    let target = file.deletingLastPathComponent().appendingPathComponent("cover")
                    try data.write(to: target, options: .atomic)
                    art = target.lastPathComponent
                }
            default: break
            }
        }
        let duration = (try? await asset.load(.duration).seconds) ?? 0
        return Track(id: UUID(), title: title, artist: artist, album: album,
                     duration: duration.isFinite ? duration : 0, audioPath: file.lastPathComponent,
                     artworkPath: art, sourceURL: source?.absoluteString, addedAt: Date())
    }

    static func run(_ executable: URL, arguments: [String], logFolder: URL, timeout: TimeInterval = 600, progress: @escaping Progress) async throws -> String {
        let worker = Task.detached(priority: .userInitiated) {
            let log = logFolder.appendingPathComponent("process-\(UUID().uuidString).log")
            FileManager.default.createFile(atPath: log.path, contents: nil)
            let handle = try FileHandle(forWritingTo: log)
            defer { try? handle.close(); try? FileManager.default.removeItem(at: log) }
            let process = Process()
            process.executableURL = executable
            process.arguments = arguments
            process.standardOutput = handle
            process.standardError = handle
            process.standardInput = FileHandle.nullDevice
            var environment = ProcessInfo.processInfo.environment
            environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (environment["PATH"] ?? "")
            process.environment = environment
            try process.run()
            let deadline = Date().addingTimeInterval(timeout)
            do {
                while process.isRunning {
                    try Task.checkCancellation()
                    guard Date() < deadline else { throw MeloraError.message("The download service timed out. Check your connection and retry.") }
                    let output = (try? String(contentsOf: log, encoding: .utf8)) ?? ""
                    let last = output.split(whereSeparator: \.isNewline).last.map(String.init) ?? "Working…"
                    if let range = last.range(of: #"\d+(?:\.\d+)?%"#, options: .regularExpression),
                       let percent = Double(last[range].dropLast()) {
                        await progress(min(percent / 100 * 0.85, 0.85), "Downloading audio · \(Int(percent))%")
                    } else if last.contains("ExtractAudio") || last.contains("ffmpeg") {
                        await progress(0.9, "Converting audio and saving artwork…")
                    }
                    try await Task.sleep(for: .milliseconds(250))
                }
            } catch {
                stop(process)
                throw error
            }
            let output = (try? String(contentsOf: log, encoding: .utf8)) ?? ""
            guard process.terminationStatus == 0 else {
                let lines = output.split(whereSeparator: \.isNewline)
                let error = lines.last(where: { $0.contains("ERROR") }) ?? lines.last ?? "Download failed"
                throw MeloraError.message(String(error.prefix(600)))
            }
            return output
        }
        return try await withTaskCancellationHandler {
            try await worker.value
        } onCancel: {
            worker.cancel()
        }
    }

    // Runs on the process worker, including when its task has already been cancelled.
    private static func stop(_ process: Process) {
        if process.isRunning {
            process.terminate()
            let deadline = Date().addingTimeInterval(1)
            while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
        process.waitUntilExit()
    }
}
