import Testing
import Foundation
import AVFoundation
@testable import Melora

@Suite(.serialized)
struct SpotifyTests {
    @Test func spotifyLinksCanonicalizeWithoutAcceptingOtherHosts() throws {
        let id = "4K7czdqhWnjDxaHJa71jWl"
        let canonical = "https://open.spotify.com/playlist/\(id)"
        for input in [canonical + "?si=tracking", "https://open.spotify.com/intl-de/playlist/\(id)", "https://open.spotify.com/embed/playlist/\(id)"] {
            let url = try ImportURL.parse(input)
            #expect(ImportURL.spotifyURL(url)?.absoluteString == canonical)
            #expect(ImportURL.playlistURL(url)?.absoluteString == canonical)
            #expect(ImportURL.sourceIdentity(url) == "spotify:playlist:\(id)")
        }
        #expect(ImportURL.spotifyURL(URL(string: "https://open.spotify.com.evil.test/playlist/\(id)")!) == nil)
        #expect(ImportURL.spotifyURL(URL(string: "https://open.spotify.com/playlist/bad")!) == nil)
        #expect(ImportURL.spotifyURL(URL(string: "https://open.spotify.com/artist/\(id)")!) == nil)
        #expect(ImportURL.playlistURL(URL(string: "https://open.spotify.com/track/\(id)")!) == nil)
    }

    @Test func publicCollectionLimitIsReportedAsMissingEntries() throws {
        let json = #"{"props":{"pageProps":{"state":{"data":{"entity":{"name":"Night drive","trackList":[{"uri":"spotify:track:0VjIjW4GlUZAMYd2vXMi3b","title":"Blinding Lights","subtitle":"The Weeknd"}]}}}}}}"#
        let html = "<script id=\"__NEXT_DATA__\" type=\"application/json\">\(json)</script>"
        let manifest = try SpotifyCatalog.embedManifest(html, total: 3)
        #expect(manifest.title == "Night drive")
        #expect(manifest.entries.count == 3)
        #expect(manifest.entries.first?.url?.absoluteString == "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b")
        #expect(manifest.entries.dropFirst().allSatisfy { $0.url == nil && $0.unavailableReason != nil })
        let full = try SpotifyCatalog.embedManifest(html, total: 1)
        #expect(full.entries.count == 1)
    }

    @Test func matchingRejectsWrongArtistDurationAndAlteredRecordings() throws {
        let info = SpotifyTrackInfo(title: "Blinding Lights", artist: "The Weeknd", album: "After Hours", duration: 200, cover: nil)
        let entries: [[String: Any]] = [
            ["id": "wrongartist", "title": "Blinding Lights", "uploader": "Another singer", "duration": 200],
            ["id": "cover", "title": "The Weeknd Blinding Lights cover", "duration": 200],
            ["id": "wronglength", "title": "The Weeknd Blinding Lights", "duration": 400],
            ["id": "official", "title": "The Weeknd - Blinding Lights (Official Audio)", "duration": 200]
        ]
        let data = try JSONSerialization.data(withJSONObject: ["entries": entries])
        #expect(try SpotifyCatalog.match(data, info: info).absoluteString == "https://www.youtube.com/watch?v=official")
        let bad = try JSONSerialization.data(withJSONObject: ["entries": Array(entries.prefix(3))])
        #expect(throws: MeloraError.self) { try SpotifyCatalog.match(bad, info: info) }
    }

    @Test func soundtrackAnnotationsMatchThePerformersOwnRecordings() throws {
        let fixture = try #require(Bundle.module.url(forResource: "PianoMatches", withExtension: "json", subdirectory: "Fixtures"))
        let samples = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [[String: Any]])
        for sample in samples {
            let title = try #require(sample["title"] as? String)
            let artist = try #require(sample["artist"] as? String)
            let duration = try #require(sample["duration"] as? Double)
            let candidates = try #require(sample["candidates"] as? [String: Any])
            let info = SpotifyTrackInfo(title: title, artist: artist, album: "", duration: duration, cover: nil)
            let match = try SpotifyCatalog.match(JSONSerialization.data(withJSONObject: candidates), info: info)
            let entries = try #require(candidates["entries"] as? [[String: Any]])
            let selected = entries.first { entry in match.query == "v=" + (entry["id"] as? String ?? "") }
            #expect(selected?["channel"] as? String == "Patrik Pietschmann", "Wrong performer for \(title)")
        }
    }

    @Test func originalPerformerWinsOverCreditedArrangements() throws {
        let info = SpotifyTrackInfo(title: "Sadness and Sorrow (From Naruto) - Piano Version", artist: "Patrik Pietschmann", album: "", duration: 188, cover: nil)
        let entries: [[String: Any]] = [
            ["id": "someoneelse", "title": "Sadness and Sorrow Piano (arr. Patrik Pietschmann)", "channel": "Other Pianist", "duration": 188],
            ["id": "ownchannel", "title": "Naruto - Sadness and Sorrow (Piano Version)", "channel": "Patrik Pietschmann", "duration": 192],
            ["id": "tutorial", "title": "Naruto Sadness and Sorrow Piano Tutorial Patrik Pietschmann", "channel": "Tutorials", "duration": 188]]
        let data = try JSONSerialization.data(withJSONObject: ["entries": entries])
        let matches = try SpotifyCatalog.candidates(data, info: info)
        #expect(matches.map(\.absoluteString) == ["https://www.youtube.com/watch?v=ownchannel"])
        #expect(SpotifyCatalog.searchQueries(info).first == "Patrik Pietschmann Sadness and Sorrow piano")
        let remix = SpotifyTrackInfo(title: "Sadness and Sorrow (Remix)", artist: "Patrik Pietschmann", album: "", duration: 192, cover: nil)
        #expect(try SpotifyCatalog.candidates(data, info: remix).isEmpty)
    }

    @Test func metadataReadsArtistAlbumAndLargestCover() throws {
        let entity: [String: Any] = ["name": "Song", "duration": ["totalMilliseconds": 123000],
            "firstArtist": ["items": [["profile": ["name": "Artist"]]]],
            "albumOfTrack": ["name": "Album", "coverArt": ["sources": [
                ["width": 64, "url": "https://example.com/small.jpg"], ["width": 640, "url": "https://example.com/large.jpg"]]]]]
        let info = try SpotifyCatalog.trackInfo(entity)
        #expect(info.artist == "Artist")
        #expect(info.album == "Album")
        #expect(info.duration == 123)
        #expect(info.cover?.lastPathComponent == "large.jpg")
    }

    @MainActor @Test func spotifyCollectionReusesTracksAndReportsPartialImport() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("Melora-spotify-test-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let server = try FixtureServer()
        defer { server.stop() }
        let trackURL = URL(string: "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b")!
        let services = ImportServices(download: { url, staging, progress in
            let result = try await DownloadService.download(server.url("song.wav"), stagingRoot: staging, progress: progress)
            var track = result.track
            track.sourceURL = url.absoluteString
            return DownloadResult(track: track, stagingFolder: result.stagingFolder)
        }, resolvePlaylist: { _, _, _ in
            PlaylistManifest(title: "Spotify fixture", entries: [PlaylistEntry(title: "Song", url: trackURL),
                PlaylistEntry(title: "Unavailable track", url: nil, unavailableReason: "Spotify did not expose metadata.")])
        })
        let library = LibraryStore(root: root, services: services)
        try library.enqueue(trackURL.absoluteString + "?si=first")
        try await wait(library)
        try library.enqueue("https://open.spotify.com/playlist/4K7czdqhWnjDxaHJa71jWl?si=test")
        try await wait(library)
        #expect(library.tracks.count == 1)
        #expect(library.playlists.first?.name == "Spotify fixture")
        #expect(library.playlists.first?.trackIDs == library.tracks.map(\.id))
        #expect(library.jobs.last?.state == .failed)
        #expect(library.jobs.last?.failures.count == 1)
        library.retry(try #require(library.jobs.last).id)
        try await wait(library)
        #expect(library.tracks.count == 1)
        #expect(library.playlists.count == 1)
        #expect(library.jobs.last?.failures.count == 1)
    }

    @MainActor private func wait(_ library: LibraryStore) async throws {
        for _ in 0..<200 {
            if !library.isBusy { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        Issue.record("Import did not finish")
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["MELORA_CHECK_SPOTIFY"] != nil))
    func livePublicPlaylistMetadataAndFirstTrackMatch() async throws {
        let url = try #require(ProcessInfo.processInfo.environment["MELORA_CHECK_SPOTIFY"].flatMap(URL.init(string:)))
        let page = try await SpotifyCatalog.page(url)
        let entity = try SpotifyCatalog.entity(in: page, url: url)
        let total = (entity["content"] as? [String: Any])?["totalCount"] as? Int
        let embed = try await SpotifyCatalog.page(URL(string: "https://open.spotify.com/embed" + url.path)!)
        let manifest = try SpotifyCatalog.embedManifest(embed, total: total)
        #expect(!manifest.title.isEmpty)
        #expect(manifest.entries.count == total)
        let trackURL = try #require(manifest.entries.first?.url)
        let trackPage = try await SpotifyCatalog.page(trackURL)
        let info = try SpotifyCatalog.trackInfo(SpotifyCatalog.entity(in: trackPage, url: trackURL))
        #expect(!info.artist.isEmpty)
        #expect(manifest.entries.first?.title.contains(info.title) == true)
        let downloader = try #require(DownloadService.executable("yt-dlp"))
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("Melora-spotify-live-\(UUID())")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let output = try await DownloadService.run(downloader, arguments: ["--ignore-config", "--flat-playlist", "--dump-single-json", "--skip-download", "--no-warnings", "--socket-timeout", "15", "--retries", "1", "--", "ytsearch10:\(SpotifyCatalog.searchQueries(info)[0])"], logFolder: folder, timeout: 90) { _, _ in }
        let raw = try #require(output.split(whereSeparator: \.isNewline).last(where: { $0.hasPrefix("{") }))
        let match = try SpotifyCatalog.match(Data(raw.utf8), info: info)
        #expect(match.host == "www.youtube.com")
        let result = try await SpotifyService.download(trackURL, stagingRoot: folder) { _, _ in }
        #expect(result.track.title == info.title)
        #expect(result.track.artist == info.artist)
        #expect(result.track.sourceURL == trackURL.absoluteString)
        #expect(result.track.artworkPath == "spotify-cover")
        let playable = try await AVURLAsset(url: result.stagingFolder.appendingPathComponent(result.track.audioPath)).load(.isPlayable)
        #expect(playable)
    }
}
