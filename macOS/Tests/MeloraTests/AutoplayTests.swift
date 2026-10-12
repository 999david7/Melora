import Testing
import Foundation
@testable import Melora

@Suite(.serialized)
struct AutoplayTests {
    private func track(_ title: String, by artist: String, album: String = "Album", favorite: Bool = false) -> Track {
        Track(id: UUID(), title: title, artist: artist, album: album, duration: 1,
              audioPath: "Music/\(title).wav", addedAt: Date(), isFavorite: favorite)
    }

    @Test func ranksSameArtistThenSharedCreditsAndPlaylists() {
        let seed = track("Seed", by: "Hanne", album: "Low Tide")
        let sameAlbum = track("Same album", by: "HANNE", album: "low tide")
        let sameArtist = track("Same artist", by: "Hanné - Topic", album: "Later")
        let featured = track("Featured", by: "Someone feat. Hanne")
        let companion = track("Companion", by: "Other")
        let favorite = track("Favorite", by: "Stranger", favorite: true)
        let unrelated = track("Unrelated", by: "Noise Co")
        let library = [seed, unrelated, favorite, companion, featured, sameArtist, sameAlbum]
        let playlists = [NativePlaylist(name: "Mix", trackIDs: [companion.id, seed.id])]
        let ranked = Autoplay.ranked(after: seed, in: library, playlists: playlists, excluding: [], jitter: 0)
        #expect(ranked.map(\.title) == ["Same album", "Same artist", "Featured", "Companion", "Favorite", "Unrelated"]
            || ranked.map(\.title) == ["Same album", "Same artist", "Companion", "Featured", "Favorite", "Unrelated"])
        let excluded = Autoplay.ranked(after: seed, in: library, playlists: playlists,
                                       excluding: [sameAlbum.id, sameArtist.id], jitter: 0)
        #expect(!excluded.contains { $0.id == sameAlbum.id || $0.id == sameArtist.id || $0.id == seed.id })
        // Everything played: start over instead of stopping, but never repeat the seed itself.
        let restarted = Autoplay.ranked(after: seed, in: library, playlists: [], excluding: Set(library.map(\.id)), jitter: 0)
        #expect(restarted.count == library.count - 1)
        #expect(Autoplay.ranked(after: seed, in: [seed], playlists: [], excluding: []).isEmpty)
    }

    @Test func importPlaceholdersAreNotTreatedAsMatches() {
        let seed = track("Seed", by: "Unknown artist", album: "Singles")
        let other = track("Other", by: "unknown artist", album: "Singles")
        let favorite = track("Favorite", by: "Someone", favorite: true)
        let ranked = Autoplay.ranked(after: seed, in: [seed, other, favorite], playlists: [], excluding: [], jitter: 0)
        #expect(ranked.first?.id == favorite.id)
        #expect(Autoplay.credits("A feat. B & C; D") == ["a", "b", "c", "d"])
    }

    @MainActor @Test func playerContinuesPastTheEndOfTheQueue() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("Melora-autoplay-test-\(UUID())")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("Music"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let first = track("First", by: "Hanne")
        let second = track("Second", by: "Hanne")
        let gone = track("Gone", by: "Hanne")
        for song in [first, second] { try silentWAV().write(to: root.appendingPathComponent(song.audioPath)) }
        try JSONEncoder().encode(LibraryDocument(tracks: [first, second, gone])).write(to: root.appendingPathComponent("library.json"))
        let library = LibraryStore(root: root)
        let suite = "Melora-tests-\(UUID())"
        let preferences = try #require(UserDefaults(suiteName: suite))
        defer { preferences.removePersistentDomain(forName: suite) }
        let player = MusicPlayer(preferences: preferences)
        defer { player.stop() }
        player.suggest = { seed, played in library.similar(to: seed, excluding: played) }
        #expect(player.autoplay)

        player.play(first, in: [first], root: root)
        player.next(ended: true)
        #expect(player.current?.id == second.id, "a missing file is never suggested")
        #expect(player.queue.map(\.id) == [first.id, second.id])
        #expect(player.autoplayed == [second.id])
        player.previous()
        #expect(player.current?.id == first.id)

        player.shuffle = true
        player.play(first, in: [first], root: root)
        #expect(player.autoplayed.isEmpty)
        player.next()
        #expect(player.current?.id == second.id, "pressing next at the end continues too, shuffled or not")
        player.previous()
        #expect(player.current?.id == first.id)
        player.shuffle = false

        player.repeatMode = .all
        player.play(first, in: [first], root: root)
        player.next(ended: true)
        #expect(player.current?.id == first.id)
        #expect(player.queue.count == 1, "repeat wins over autoplay")
        player.repeatMode = .off

        player.autoplay = false
        player.play(first, in: [first], root: root)
        player.next(ended: true)
        #expect(player.current?.id == first.id)
        #expect(!player.isPlaying)
        #expect(!MusicPlayer(preferences: preferences).autoplay)
    }

    /// A tenth of a second of silence, so AVPlayer has something real to open.
    private func silentWAV() -> Data {
        let samples = 800
        var data = Data("RIFF".utf8)
        func append<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        append(UInt32(36 + samples * 2)); data.append(contentsOf: Data("WAVEfmt ".utf8))
        append(UInt32(16)); append(UInt16(1)); append(UInt16(1)); append(UInt32(8000)); append(UInt32(16000))
        append(UInt16(2)); append(UInt16(16)); data.append(contentsOf: Data("data".utf8)); append(UInt32(samples * 2))
        data.append(Data(count: samples * 2))
        return data
    }
}
