import Foundation
import AVFoundation
import MediaPlayer

@MainActor
final class MusicPlayer: ObservableObject {
    enum RepeatMode: String, CaseIterable { case off, all, one }
    @Published private(set) var current: Track?
    @Published private(set) var isPlaying = false
    @Published private(set) var elapsed: Double = 0
    @Published private(set) var duration: Double = 0
    @Published private(set) var queue: [Track] = []
    @Published var shuffle = false {
        didSet {
            if shuffle != oldValue { shuffleTraversal.reset(ids: queue.map(\.id), current: current?.id) }
            preferences.set(shuffle, forKey: "playback.shuffle")
        }
    }
    @Published var repeatMode: RepeatMode = .off {
        didSet { preferences.set(repeatMode.rawValue, forKey: "playback.repeat") }
    }
    @Published var volume: Double = 0.8 {
        didSet {
            player.volume = Float(volume)
            preferences.set(volume, forKey: "playback.volume")
            if volume > 0 {
                unmutedVolume = volume
                preferences.set(volume, forKey: "playback.unmutedVolume")
            }
        }
    }
    @Published var error: String?
    @Published private(set) var sleepDeadline: Date?
    @Published private(set) var sleepAfterTrack = false
    private var sleepTask: Task<Void, Never>?
    private var unmutedVolume: Double = 0.8
    private let preferences: UserDefaults
    private var shuffleTraversal = ShuffleTraversal()
    private let player = AVPlayer()
    private var root: URL?
    private var observer: Any?
    private var endObserver: NSObjectProtocol?
    private var itemObservation: NSKeyValueObservation?

    init(preferences: UserDefaults = .standard) {
        self.preferences = preferences
        if let saved = preferences.object(forKey: "playback.volume") as? NSNumber, saved.doubleValue.isFinite {
            volume = max(0, min(1, saved.doubleValue))
        }
        if let saved = preferences.object(forKey: "playback.unmutedVolume") as? NSNumber, saved.doubleValue.isFinite, saved.doubleValue > 0 {
            unmutedVolume = min(1, saved.doubleValue)
        }
        shuffle = preferences.bool(forKey: "playback.shuffle")
        repeatMode = preferences.string(forKey: "playback.repeat").flatMap(RepeatMode.init(rawValue:)) ?? .off
        player.volume = Float(volume)
        observer = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] time in
            Task { @MainActor in
                guard let self else { return }
                self.elapsed = time.seconds.isFinite ? time.seconds : 0
                if let seconds = self.player.currentItem?.duration.seconds, seconds.isFinite { self.duration = seconds }
                self.updateNowPlaying()
            }
        }
        let commands = MPRemoteCommandCenter.shared()
        commands.playCommand.addTarget { [weak self] _ in Task { @MainActor in self?.resume() }; return .success }
        commands.pauseCommand.addTarget { [weak self] _ in Task { @MainActor in self?.pause() }; return .success }
        commands.togglePlayPauseCommand.addTarget { [weak self] _ in Task { @MainActor in self?.toggle() }; return .success }
        commands.nextTrackCommand.addTarget { [weak self] _ in Task { @MainActor in self?.next() }; return .success }
        commands.previousTrackCommand.addTarget { [weak self] _ in Task { @MainActor in self?.previous() }; return .success }
        commands.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            Task { @MainActor in self?.seek(event.positionTime) }
            return .success
        }
    }

    func play(_ track: Track, in tracks: [Track], root: URL) {
        queue = tracks
        shuffleTraversal.reset(ids: tracks.map(\.id), current: track.id)
        self.root = root
        load(track)
    }

    private func load(_ track: Track) {
        guard let root else { return }
        do {
            let url = try LibraryPaths.resolve(track.audioPath, in: root)
            guard FileManager.default.fileExists(atPath: url.path) else { throw MeloraError.message("This song is missing. Reconnect your library drive or reveal the file in Finder.") }
            if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
            itemObservation = nil
            current = track
            elapsed = 0
            duration = track.duration
            let item = AVPlayerItem(url: url)
            itemObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
                if item.status == .failed {
                    let message = item.error?.localizedDescription ?? "macOS could not play this audio file."
                    Task { @MainActor in self?.error = message; self?.pause() }
                }
            }
            player.replaceCurrentItem(with: item)
            endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.next(ended: true) }
            }
            resume()
        } catch { self.error = error.localizedDescription; pause() }
    }

    func resume() {
        guard current != nil else { return }
        if duration > 0 && elapsed >= duration - 0.1 { seek(0) }
        player.play()
        isPlaying = true
        updateNowPlaying()
    }
    func pause() { player.pause(); isPlaying = false; updateNowPlaying() }
    func toggle() { isPlaying ? pause() : resume() }
    func reconcileLibrary(_ tracks: [Track]) {
        if let current, !tracks.contains(where: { $0.id == current.id }) { stop(); return }
        queue = queue.compactMap { queued in tracks.first { $0.id == queued.id } }
        if let playing = current { current = tracks.first { $0.id == playing.id } }
    }

    func stop() {
        cancelSleepTimer()
        pause()
        player.replaceCurrentItem(with: nil)
        current = nil
        queue = []
        root = nil
        elapsed = 0
        duration = 0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }
    func seek(_ seconds: Double) {
        let seconds = max(0, min(seconds, duration))
        player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600))
        elapsed = seconds
    }
    func next(ended: Bool = false) {
        guard let current, let index = queue.firstIndex(where: { $0.id == current.id }) else { return }
        if ended && sleepAfterTrack { cancelSleepTimer(); pause(); return }
        if ended && repeatMode == .one { seek(0); resume(); return }
        if shuffle {
            if let id = shuffleTraversal.next(after: current.id, ids: queue.map(\.id), repeating: repeatMode == .all),
               let track = queue.first(where: { $0.id == id }) { load(track) }
            else { pause() }
            return
        }
        if index + 1 < queue.count { load(queue[index + 1]) }
        else if repeatMode == .all, let first = queue.first { load(first) }
        else { pause() }
    }
    func previous() {
        if elapsed > 3 { seek(0); return }
        guard let current, let index = queue.firstIndex(where: { $0.id == current.id }) else { return }
        if shuffle {
            if let id = shuffleTraversal.previous(before: current.id, ids: queue.map(\.id)),
               let track = queue.first(where: { $0.id == id }) { load(track) }
            else { seek(0) }
        } else if index > 0 { load(queue[index - 1]) } else { seek(0) }
    }
    func setSleepTimer(seconds: Double) {
        cancelSleepTimer()
        guard seconds.isFinite, seconds > 0 else { return }
        sleepDeadline = Date().addingTimeInterval(seconds)
        sleepTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(seconds)) }
            catch { return }
            guard !Task.isCancelled, let self else { return }
            self.cancelSleepTimer()
            self.pause()
        }
    }
    func sleepAtEndOfTrack() {
        cancelSleepTimer()
        sleepAfterTrack = current != nil
    }
    func cancelSleepTimer() {
        sleepTask?.cancel()
        sleepTask = nil
        sleepDeadline = nil
        sleepAfterTrack = false
    }
    func toggleMute() {
        if volume > 0 { unmutedVolume = volume; volume = 0 }
        else { volume = unmutedVolume }
    }

    func cycleRepeat() {
        repeatMode = repeatMode == .off ? .all : repeatMode == .all ? .one : .off
    }
    private func updateNowPlaying() {
        guard let current else { return }
        var info: [String: Any] = [MPMediaItemPropertyTitle: current.title, MPMediaItemPropertyArtist: current.artist,
                                 MPMediaItemPropertyAlbumTitle: current.album, MPMediaItemPropertyPlaybackDuration: duration,
                                 MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
                                 MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0]
        if let root, let path = current.artworkPath, let url = try? LibraryPaths.resolve(path, in: root), let image = ArtworkCache.shared.image(url) {
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        MPNowPlayingInfoCenter.default().playbackState = isPlaying ? .playing : .paused
    }
}
