import Testing
import Foundation
import AVFoundation
@testable import Melora

@Suite(.serialized)
struct PlaylistTests {
    @Test func radioMixWatchLinksKeepTheSelectedVideo() throws {
        let link = try ImportURL.parse("https://www.youtube.com/watch?v=yKIJR0EEOHQ&list=RDTjTTgpKELAQ&index=2")
        #expect(ImportURL.youtubePlaylistURL(link) == nil)
        #expect(ImportURL.playlistURL(link) == nil)
        #expect(ImportURL.sourceIdentity(link) == "youtube:yKIJR0EEOHQ")
        let short = try ImportURL.parse("https://youtu.be/yKIJR0EEOHQ?list=RDTjTTgpKELAQ")
        #expect(ImportURL.playlistURL(short) == nil)
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["MELORA_CHECK_VIDEO"] != nil))
    func liveMixWatchLinkImportsSelectedSong() async throws {
        let link = try #require(ProcessInfo.processInfo.environment["MELORA_CHECK_VIDEO"].flatMap(URL.init(string:)))
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let result = try await DownloadService.download(link, stagingRoot: root) { _, _ in }
        #expect(!result.track.title.isEmpty)
        #expect(result.track.artworkPath != nil)
        let asset = AVURLAsset(url: result.stagingFolder.appendingPathComponent(result.track.audioPath))
        #expect(try await asset.load(.isPlayable))
    }

    @Test func identifiesAndCanonicalizesYouTubePlaylists() throws {
        let canonical = "https://www.youtube.com/playlist?list=PLtesting"
        for link in [canonical, "https://music.youtube.com/playlist?list=PLtesting&si=tracking", "https://www.youtube.com/watch?v=video000001&list=PLtesting&index=3", "https://youtu.be/video000001?list=PLtesting"] {
            #expect(ImportURL.youtubePlaylistURL(try ImportURL.parse(link))?.absoluteString == canonical)
        }
        for link in ["https://example.com/?list=PLtesting", "https://youtube.com.evil.test/?list=PLtesting", "https://youtube.com/watch?v=video000001", "https://youtube.com/playlist?list="] {
            #expect(ImportURL.youtubePlaylistURL(try ImportURL.parse(link)) == nil)
        }
        let identity = ImportURL.sourceIdentity(try ImportURL.parse("https://youtu.be/video000001?si=tracking"))
        #expect(identity == ImportURL.sourceIdentity(try ImportURL.parse("https://www.youtube.com/watch?v=video000001")))
    }

    @Test func parsesOrderedPlaylistAndUnavailableVideos() throws {
        let manifest = try PlaylistService.parse(Data(#"{"title":"Night drive","entries":[{"id":"video000003","title":"Third"},null,{"id":"video000001","title":"[Private video]","availability":"private"},{"url":"https://www.youtube.com/watch?v=video000002","title":"Second"}]}"#.utf8))
        #expect(manifest.title == "Night drive")
        #expect(manifest.entries.map(\.title) == ["Third", "Unavailable video", "[Private video]", "Second"])
        #expect(manifest.entries[0].url?.absoluteString == "https://www.youtube.com/watch?v=video000003")
        #expect(manifest.entries[1].unavailableReason != nil)
        #expect(manifest.entries[2].unavailableReason != nil)
        do {
            _ = try PlaylistService.parse(Data(#"{"title":"Empty","entries":[]}"#.utf8))
            Issue.record("An empty playlist should fail")
        } catch { #expect(error.localizedDescription.contains("empty")) }
    }

    @MainActor
    @Test func playlistImportReusesDownloadsRetriesFailuresAndKeepsOrder() async throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let server = try FixtureServer()
        defer { server.stop() }
        let controller = DownloadController()
        let urls = try ["video000003", "video000001", "video000002"].map { try ImportURL.parse("https://www.youtube.com/watch?v=\($0)") }
        let manifest = PlaylistManifest(title: "Night drive", entries: urls.enumerated().map { PlaylistEntry(title: "Song \($0.offset)", url: $0.element) })
        let services = ImportServices(download: { url, staging, progress in
            try await controller.download(url, staging: staging, server: server.url("song.wav"), progress: progress)
        }, resolvePlaylist: { _, _, _ in manifest })
        let library = LibraryStore(root: root, services: services)
        // A previously downloaded short link must be reused by its matching watch link.
        try library.enqueue("https://youtu.be/video000003?si=tracking")
        try await wait(library)
        let original = try #require(library.tracks.first)
        try library.enqueue("https://www.youtube.com/watch?v=video000001&list=PLfixture")
        try await wait(library)
        let playlist = try #require(library.playlists.first)
        #expect(playlist.name == "Night drive")
        #expect(playlist.sourceURL == "https://www.youtube.com/playlist?list=PLfixture")
        #expect(library.importedPlaylistID == playlist.id)
        #expect(playlist.trackIDs.first == original.id)
        #expect(library.tracks.count == 2)
        #expect(library.jobs.last?.state == .failed)
        #expect(library.jobs.last?.failures.map(\.id) == [2])
        let job = try #require(library.jobs.last)
        await controller.allowMissingTrack()
        library.retry(job.id)
        try await wait(library)
        #expect(library.jobs.last?.state == .completed)
        #expect(library.jobs.last?.failures.isEmpty == true)
        #expect(library.tracks.count == 3)
        #expect(library.playlists.count == 1)
        let ordered = try #require(library.playlists.first).trackIDs.compactMap { id in library.tracks.first { $0.id == id }?.sourceURL }.compactMap(URL.init(string:)).map(ImportURL.sourceIdentity)
        #expect(ordered == urls.map(ImportURL.sourceIdentity))
        #expect(await controller.count("youtube:video000003") == 1)
        #expect(await controller.count("youtube:video000002") == 1)
        let reopened = LibraryStore(root: root, services: services)
        #expect(reopened.playlists == library.playlists)
        try reopened.enqueue("https://www.youtube.com/playlist?list=PLfixture&si=new")
        try await wait(reopened)
        #expect(reopened.playlists.count == 1)
        #expect(reopened.tracks.count == 3)
        #expect(reopened.playlists.first?.trackIDs == library.playlists.first?.trackIDs)
        reopened.toggleFavorite(original)
        try FileManager.default.removeItem(at: try #require(reopened.fileURL(original)))
        try reopened.enqueue("https://www.youtube.com/playlist?list=PLfixture")
        try await wait(reopened)
        #expect(reopened.tracks.count == 3)
        let repaired = try #require(reopened.tracks.first { $0.id == original.id })
        #expect(repaired.isFavorite)
        #expect(FileManager.default.fileExists(atPath: try #require(reopened.fileURL(repaired)).path))
        #expect(reopened.playlists.first?.trackIDs == library.playlists.first?.trackIDs)
    }

    @MainActor
    @Test func cancellingPlaylistStopsRemainingTracksAndRetainsCompletedOnes() async throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let server = try FixtureServer()
        defer { server.stop() }
        let urls = try ["video000003", "video000004", "video000005"].map { try ImportURL.parse("https://www.youtube.com/watch?v=\($0)") }
        let manifest = PlaylistManifest(title: "Cancel test", entries: urls.map { PlaylistEntry(title: "Song", url: $0) })
        let services = ImportServices(download: { url, staging, progress in
            if url == urls[1] { try await Task.sleep(for: .seconds(30)) }
            var result = try await DownloadService.download(server.url("song.wav"), stagingRoot: staging, progress: progress)
            var track = result.track
            track.sourceURL = url.absoluteString
            result = DownloadResult(track: track, stagingFolder: result.stagingFolder)
            return result
        }, resolvePlaylist: { _, _, _ in manifest })
        let library = LibraryStore(root: root, services: services)
        try library.enqueue("https://www.youtube.com/playlist?list=PLcancel")
        for _ in 0..<100 {
            if library.tracks.count == 1 { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        let job = try #require(library.jobs.first)
        library.cancel(job.id)
        try await wait(library)
        #expect(library.jobs.first?.state == .cancelled)
        #expect(library.tracks.count == 1)
        #expect(library.playlists.first?.trackIDs == library.tracks.map(\.id))
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(".incoming").path).isEmpty)
    }

    private func temporaryDirectory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("Melora-playlist-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }
    @MainActor private func wait(_ library: LibraryStore) async throws {
        for _ in 0..<200 {
            if !library.isBusy { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        Issue.record("Import queue did not finish")
    }
}

private actor DownloadController {
    private var attempts: [String: Int] = [:]
    private var allowMissing = false
    func allowMissingTrack() { allowMissing = true }
    func count(_ key: String) -> Int { attempts[key, default: 0] }
    func download(_ url: URL, staging: URL, server: URL, progress: @escaping DownloadService.Progress) async throws -> DownloadResult {
        let key = ImportURL.sourceIdentity(url)
        attempts[key, default: 0] += 1
        if key == "youtube:video000001" && !allowMissing { throw MeloraError.message("Fixture video unavailable") }
        let result = try await DownloadService.download(server, stagingRoot: staging, progress: progress)
        var track = result.track
        track.sourceURL = url.absoluteString
        return DownloadResult(track: track, stagingFolder: result.stagingFolder)
    }
}
