import AppKit
import Foundation
import Testing
import MeloraWidgetShared
@testable import Melora

@Suite(.serialized)
struct WidgetTests {
    private func track(_ title: String) -> Track {
        Track(id: UUID(), title: title, artist: "Artist", album: "Album", duration: 60, audioPath: "\(title).m4a", addedAt: Date())
    }

    @Test func upNextFollowsTheQueueAndWrapsOnlyWhenRepeating() {
        let songs = ["A", "B", "C", "D"].map(track)
        #expect(WidgetBridge.upNext(after: songs[2], in: songs, wrapping: false).map(\.title) == ["D"])
        #expect(WidgetBridge.upNext(after: songs[2], in: songs, wrapping: true).map(\.title) == ["D", "A", "B"])
        #expect(WidgetBridge.upNext(after: songs[0], in: songs, wrapping: false, limit: 2).map(\.title) == ["B", "C"])
        #expect(WidgetBridge.upNext(after: track("Elsewhere"), in: songs, wrapping: true).isEmpty)
    }

    @Test func snapshotCarriesProgressForwardOnlyWhilePlaying() throws {
        let start = Date(timeIntervalSince1970: 1_000_000)
        var snapshot = WidgetSnapshot(title: "Song", artist: "Artist", album: "Album", duration: 100, elapsed: 10,
                                      isPlaying: true, updatedAt: start, artworkID: nil, upNext: [])
        #expect(snapshot.elapsed(at: start.addingTimeInterval(5)) == 15)
        #expect(snapshot.elapsed(at: start.addingTimeInterval(500)) == 100)
        #expect(snapshot.startedAt == start.addingTimeInterval(-10))
        snapshot.isPlaying = false
        #expect(snapshot.elapsed(at: start.addingTimeInterval(5)) == 10)
        snapshot.isPlaying = true
        snapshot.appRunning = false
        #expect(snapshot.elapsed(at: start.addingTimeInterval(5)) == 10)
        #expect(!snapshot.isLive)
    }

    @Test func snapshotSurvivesTheTripThroughDisk() throws {
        let snapshot = WidgetSnapshot(title: "Ünïcode", artist: "Artist", album: "Album", duration: 100, elapsed: 10,
                                      isPlaying: true, updatedAt: Date(timeIntervalSince1970: 1_700_000_000), artworkID: "x",
                                      upNext: [.init(title: "Next", artist: "Artist")], shuffle: true)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        #expect(try decoder.decode(WidgetSnapshot.self, from: WidgetShared.encode(snapshot)) == snapshot)
    }

    @Test func thumbnailsAreSquareAndSmall() throws {
        let image = NSImage(size: NSSize(width: 3000, height: 1500))
        image.lockFocus()
        NSColor.red.setFill()
        NSRect(x: 0, y: 0, width: 3000, height: 1500).fill()
        image.unlockFocus()
        let data = try #require(WidgetBridge.thumbnail(image, side: 360))
        let bitmap = try #require(NSBitmapImageRep(data: data))
        #expect(bitmap.pixelsWide == 360)
        #expect(bitmap.pixelsHigh == 360)
    }

    @MainActor @Test func idlePlayerWritesAnIdleSnapshotOnceAndCommandsAreSafe() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("Melora-widget-\(UUID())")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("Melora-widget-library-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: directory)
            try? FileManager.default.removeItem(at: root)
        }
        let preferences = try #require(UserDefaults(suiteName: "Melora-widget-tests-\(UUID())"))
        var reloads = 0
        let bridge = WidgetBridge(directory: directory, reload: { reloads += 1 })
        let player = MusicPlayer(preferences: preferences)
        bridge.start(player: player, library: LibraryStore(root: root))
        bridge.publish()

        let data = try Data(contentsOf: directory.appendingPathComponent("now-playing.json"))
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let snapshot = try decoder.decode(WidgetSnapshot.self, from: data)
        #expect(snapshot.title.isEmpty)
        #expect(!snapshot.isPlaying)
        #expect(snapshot.appRunning)
        #expect(reloads == 1)
        // Nothing loaded: every command is a no-op rather than a crash.
        for command in WidgetShared.Command.allCases { bridge.perform(command) }
        #expect(player.current == nil)
    }
}
