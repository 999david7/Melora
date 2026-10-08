import Testing
import Foundation
@testable import Melora

@Suite(.serialized)
struct FeatureTests {
    @MainActor @Test func deletingSongTrashesItsFilesAndUpdatesEveryPlaylist() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("Melora-delete-test-\(UUID())")
        let id = UUID()
        let folder = root.appendingPathComponent("Music/\(id)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("audio".utf8).write(to: folder.appendingPathComponent("audio.m4a"))
        try Data("cover".utf8).write(to: folder.appendingPathComponent("cover"))
        let track = Track(id: id, title: "Song", artist: "Artist", album: "Album", duration: 60,
                          audioPath: "Music/\(id)/audio.m4a", artworkPath: "Music/\(id)/cover", addedAt: Date())
        let playlists = [NativePlaylist(name: "One", trackIDs: [id]), NativePlaylist(name: "Two", trackIDs: [id])]
        try JSONEncoder().encode(LibraryDocument(tracks: [track], playlists: playlists)).write(to: root.appendingPathComponent("library.json"))
        let trash = root.appendingPathComponent("TestTrash")
        let library = LibraryStore(root: root, trashFile: { source in
            try FileManager.default.moveItem(at: source, to: trash)
            return trash
        })
        library.deleteSong(track)
        #expect(library.error == nil)
        #expect(library.tracks.isEmpty)
        #expect(library.playlists.allSatisfy { $0.trackIDs.isEmpty })
        #expect(FileManager.default.fileExists(atPath: trash.appendingPathComponent("audio.m4a").path))
        #expect(FileManager.default.fileExists(atPath: trash.appendingPathComponent("cover").path))
        #expect(LibraryStore(root: root).tracks.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: folder.path))
    }

    @MainActor @Test func failedTrashKeepsSongAndPlaylist() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("Melora-delete-failure-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let track = Track(id: UUID(), title: "Song", artist: "Artist", album: "Album", duration: 60, audioPath: "audio.m4a", addedAt: Date())
        try Data("audio".utf8).write(to: root.appendingPathComponent(track.audioPath))
        let playlist = NativePlaylist(name: "One", trackIDs: [track.id])
        try JSONEncoder().encode(LibraryDocument(tracks: [track], playlists: [playlist])).write(to: root.appendingPathComponent("library.json"))
        let library = LibraryStore(root: root, trashFile: { _ in throw MeloraError.message("Trash unavailable") })
        library.deleteSong(track)
        #expect(library.error != nil)
        #expect(library.tracks == [track])
        #expect(library.playlists == [playlist])
        #expect(FileManager.default.fileExists(atPath: root.appendingPathComponent(track.audioPath).path))
    }

    @MainActor @Test func playlistEditsPersistAndKeepMusic() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("Melora-edit-test-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let tracks = ["First", "Second", "Third"].map {
            Track(id: UUID(), title: $0, artist: "Artist", album: "Album", duration: 60,
                  audioPath: "Music/\($0).wav", addedAt: Date())
        }
        let playlist = NativePlaylist(name: "Original", trackIDs: tracks.map(\.id), sourceURL: "https://www.youtube.com/playlist?list=fixture")
        try JSONEncoder().encode(LibraryDocument(tracks: tracks, playlists: [playlist]))
            .write(to: root.appendingPathComponent("library.json"))
        let library = LibraryStore(root: root)
        library.renamePlaylist(playlist.id, to: "  Night drive  ")
        library.renamePlaylist(playlist.id, to: " \n ")
        #expect(library.playlists[0].name == "Night drive")
        library.move(tracks[0], in: playlist, by: -1)
        #expect(library.playlists[0].trackIDs == tracks.map(\.id))
        library.move(tracks[2], in: playlist, by: -1)
        #expect(library.playlists[0].trackIDs == [tracks[0].id, tracks[2].id, tracks[1].id])
        library.duplicatePlaylist(playlist)
        let copy = try #require(library.playlists.last)
        #expect(copy.id != playlist.id)
        #expect(copy.sourceURL == nil)
        #expect(copy.name == "Night drive copy")
        library.duplicatePlaylist(playlist)
        #expect(library.playlists.last?.name == "Night drive copy 2")
        library.remove(tracks[2], from: playlist)
        #expect(library.playlists[0].trackIDs == [tracks[0].id, tracks[1].id])
        #expect(library.playlists[1].trackIDs == copy.trackIDs)
        #expect(library.tracks == tracks)
        let reopened = LibraryStore(root: root)
        #expect(reopened.playlists == library.playlists)
        #expect(reopened.tracks == tracks)
        reopened.deletePlaylist(playlist.id)
        #expect(reopened.playlists.count == 2)
        #expect(!reopened.playlists.contains { $0.id == playlist.id })
        #expect(reopened.tracks == tracks)
        #expect(reopened.playlists.first == copy)
        let afterDelete = LibraryStore(root: root)
        #expect(afterDelete.playlists == reopened.playlists)
        #expect(afterDelete.tracks == tracks)
    }

    @Test func searchHandlesAccentsWhitespaceAndWordOrder() {
        let track = Track(id: UUID(), title: "Déjà Vu", artist: "Beyoncé", album: "Night Drive", duration: 60,
                          audioPath: "song.wav", addedAt: Date())
        #expect(track.matches(search: "  BEYONCE   deja "))
        #expect(track.matches(search: "drive vu"))
        #expect(track.matches(search: "  "))
        #expect(!track.matches(search: "deja missing"))
    }

    @Test func shuffleVisitsEveryTrackAndRetracesHistory() throws {
        let ids = (0..<8).map { _ in UUID() }
        var shuffle = ShuffleTraversal()
        shuffle.reset(ids: ids, current: ids[0])
        var visited = [ids[0]]
        while let next = shuffle.next(after: visited.last!, ids: ids, repeating: false) { visited.append(next) }
        #expect(visited.count == ids.count)
        #expect(Set(visited) == Set(ids))
        let previousResult = shuffle.previous(before: visited.last!, ids: ids)
        let previous = try #require(previousResult)
        #expect(previous == visited[visited.count - 2])
        #expect(shuffle.next(after: previous, ids: ids, repeating: false) == visited.last)
        #expect(shuffle.next(after: visited.last!, ids: ids, repeating: false) == nil)
        #expect(shuffle.next(after: visited.last!, ids: ids, repeating: true) != visited.last)
        shuffle.reset(ids: [ids[0]], current: ids[0])
        #expect(shuffle.next(after: ids[0], ids: [ids[0]], repeating: false) == nil)
        #expect(shuffle.next(after: ids[0], ids: [ids[0]], repeating: true) == ids[0])
    }

    @MainActor @Test func playbackPreferencesRestoreIncludingMutedVolume() throws {
        let suite = "Melora-preferences-test-\(UUID())"
        let preferences = try #require(UserDefaults(suiteName: suite))
        defer { preferences.removePersistentDomain(forName: suite) }
        let first = MusicPlayer(preferences: preferences)
        first.volume = 0.27
        first.shuffle = true
        first.repeatMode = .all
        first.toggleMute()
        let second = MusicPlayer(preferences: preferences)
        #expect(second.volume == 0)
        #expect(second.shuffle)
        #expect(second.repeatMode == .all)
        second.toggleMute()
        #expect(second.volume == 0.27)
        preferences.set(3, forKey: "playback.volume")
        preferences.set("unknown", forKey: "playback.repeat")
        let repaired = MusicPlayer(preferences: preferences)
        #expect(repaired.volume == 1)
        #expect(repaired.repeatMode == .off)
    }

    @MainActor @Test func sleepTimerCanBeReplacedAndCancelled() async throws {
        let suite = "Melora-tests-\(UUID())"
        let preferences = try #require(UserDefaults(suiteName: suite))
        defer { preferences.removePersistentDomain(forName: suite) }
        let player = MusicPlayer(preferences: preferences)
        player.setSleepTimer(seconds: 0.03)
        player.setSleepTimer(seconds: 10)
        let deadline = player.sleepDeadline
        try await Task.sleep(for: .milliseconds(100))
        #expect(player.sleepDeadline == deadline)
        player.cancelSleepTimer()
        #expect(player.sleepDeadline == nil)
        player.setSleepTimer(seconds: 0.03)
        try await Task.sleep(for: .milliseconds(100))
        #expect(player.sleepDeadline == nil)
        #expect(!player.isPlaying)
        player.setSleepTimer(seconds: -1)
        #expect(player.sleepDeadline == nil)
        player.sleepAtEndOfTrack()
        #expect(!player.sleepAfterTrack)
        player.volume = 0.35
        player.toggleMute()
        #expect(player.volume == 0)
        player.toggleMute()
        #expect(player.volume == 0.35)
    }

    @MainActor @Test func endOfSongSleepOverridesRepeatAndShuffle() async throws {
        let server = try FixtureServer()
        defer { server.stop() }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("Melora-sleep-test-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let result = try await DownloadService.download(server.url("song.wav"), stagingRoot: root) { _, _ in }
        let suite = "Melora-tests-\(UUID())"
        let preferences = try #require(UserDefaults(suiteName: suite))
        defer { preferences.removePersistentDomain(forName: suite) }
        let player = MusicPlayer(preferences: preferences)
        defer { player.stop() }
        player.play(result.track, in: [result.track], root: result.stagingFolder)
        #expect(player.isPlaying)
        player.repeatMode = .one
        player.shuffle = true
        player.sleepAtEndOfTrack()
        #expect(player.sleepAfterTrack)
        player.next(ended: true)
        #expect(!player.isPlaying)
        #expect(!player.sleepAfterTrack)
        #expect(player.current?.id == result.track.id)
    }
}
