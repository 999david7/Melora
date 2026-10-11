import Testing
import Foundation
@testable import Melora

struct ExploreTests {
    @Test func parsesSearchResultsAndSkipsLiveAndDuplicateEntries() throws {
        let json = """
        {"entries": [
          {"id": "FGBhQbmPwH8", "title": " Daft Punk - One More Time ", "channel": "Daft Punk - Topic", "duration": 322, "view_count": 620540174,
           "thumbnails": [{"url": "https://i.ytimg.com/large.jpg", "width": 720}, {"url": "https://i.ytimg.com/small.jpg", "width": 360}]},
          {"id": "FGBhQbmPwH8", "title": "Duplicate"},
          {"id": "abcdefghijk", "title": "24/7 radio", "live_status": "is_live"},
          {"id": "UCchannel00000000", "title": "A channel"},
          {"id": "zyxwvutsrqp", "title": "Song", "uploader": "ArtistVEVO"}
        ]}
        """
        let results = try ExploreService.parse(Data(json.utf8))
        #expect(results.map(\.id) == ["FGBhQbmPwH8", "zyxwvutsrqp"])
        #expect(results[0].title == "Daft Punk - One More Time")
        #expect(results[0].channel == "Daft Punk")
        #expect(results[0].duration == 322)
        #expect(results[0].thumbnail?.absoluteString == "https://i.ytimg.com/small.jpg")
        #expect(results[0].url.absoluteString == "https://www.youtube.com/watch?v=FGBhQbmPwH8")
        #expect(results[1].channel == "Artist")
        #expect(results[1].duration == nil)
        #expect(ImportURL.sourceIdentity(results[0].url) == "youtube:FGBhQbmPwH8")
    }

    @Test func formatsViewCounts() {
        #expect(ExploreService.viewLabel(620_540_174) == "620.5M views")
        #expect(ExploreService.viewLabel(1_200_000_000) == "1.2B views")
        #expect(ExploreService.viewLabel(4_321) == "4K views")
        #expect(ExploreService.viewLabel(12) == "12 views")
    }

    @MainActor @Test func modelSearchesTrimmedQueriesAndReportsErrors() async throws {
        let model = ExploreModel { query in
            if query == "fail" { throw MeloraError.message("Offline") }
            return [ExploreResult(id: "FGBhQbmPwH8", title: query, channel: "C", duration: 1, views: nil, thumbnail: nil)]
        }
        model.search("  daft punk  ")
        #expect(model.isSearching)
        while model.isSearching { try await Task.sleep(for: .milliseconds(5)) }
        #expect(model.lastQuery == "daft punk")
        #expect(model.results.map(\.title) == ["daft punk"])
        model.search("fail")
        while model.isSearching { try await Task.sleep(for: .milliseconds(5)) }
        #expect(model.results.isEmpty)
        #expect(model.error == "Offline")
        model.search("   ")
        #expect(model.lastQuery == nil && model.error == nil && !model.isSearching)
    }

    @MainActor @Test func libraryFindsImportedTrackForExploreResult() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("Melora-explore-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let track = Track(id: UUID(), title: "Song", artist: "A", album: "B", duration: 1, audioPath: "audio.m4a",
                          sourceURL: "https://youtu.be/FGBhQbmPwH8", addedAt: Date())
        try Data("audio".utf8).write(to: root.appendingPathComponent("audio.m4a"))
        try JSONEncoder().encode(LibraryDocument(tracks: [track])).write(to: root.appendingPathComponent("library.json"))
        let library = LibraryStore(root: root)
        let result = ExploreResult(id: "FGBhQbmPwH8", title: "Song", channel: "A", duration: 1, views: nil, thumbnail: nil)
        #expect(library.existingTrack(for: result.url)?.id == track.id)
        #expect(library.job(for: result.url) == nil)
    }
}
