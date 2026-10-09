import AppKit
import Combine
import Foundation
import MeloraWidgetShared
import WidgetKit

// Keeps the desktop widget in step with the player. The widget is sandboxed and
// can only read the snapshot folder; its buttons come back as distributed
// notifications, which carry no payload, so nothing but playback can be asked for.
@MainActor
final class WidgetBridge: ObservableObject {
    private var cancellables: Set<AnyCancellable> = []
    private var observers: [NSObjectProtocol] = []
    private weak var player: MusicPlayer?
    private weak var library: LibraryStore?
    private var lastWritten: WidgetSnapshot?
    private var artworkID: String?
    private let directory: URL
    private let reload: () -> Void

    init(directory: URL = WidgetShared.directory,
         reload: @escaping () -> Void = { WidgetCenter.shared.reloadTimelines(ofKind: WidgetShared.widgetKind) }) {
        self.directory = directory
        self.reload = reload
    }

    func start(player: MusicPlayer, library: LibraryStore) {
        guard self.player == nil else { return }
        self.player = player
        self.library = library
        let changes: [AnyPublisher<Void, Never>] = [
            player.$current.map { _ in () }.eraseToAnyPublisher(),
            player.$isPlaying.map { _ in () }.eraseToAnyPublisher(),
            player.$queue.map { _ in () }.eraseToAnyPublisher(),
            player.$shuffle.map { _ in () }.eraseToAnyPublisher(),
            player.$repeatMode.map { _ in () }.eraseToAnyPublisher(),
            player.$duration.removeDuplicates().map { _ in () }.eraseToAnyPublisher(),
            library.$tracks.map { _ in () }.eraseToAnyPublisher()
        ]
        Publishers.MergeMany(changes)
            .debounce(for: .milliseconds(150), scheduler: RunLoop.main)
            .sink { [weak self] in self?.publish() }
            .store(in: &cancellables)
        // Elapsed ticks twice a second; only a seek moves it away from where the
        // widget's own clock already has it.
        player.$elapsed
            .sink { [weak self] elapsed in
                guard let self, let written = self.lastWritten,
                      abs(written.elapsed(at: Date()) - elapsed) > 2 else { return }
                self.publish()
            }
            .store(in: &cancellables)

        let center = DistributedNotificationCenter.default()
        for command in WidgetShared.Command.allCases {
            observers.append(center.addObserver(forName: command.notification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.perform(command) }
            })
        }
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.publishQuit() }
        })
        publish()
    }

    func perform(_ command: WidgetShared.Command) {
        guard let player else { return }
        switch command {
        case .toggle: player.toggle()
        case .next: player.next()
        case .previous: player.previous()
        }
    }

    func publish() {
        guard let player else { return }
        guard let current = player.current else { return write(Self.idle()) }
        let artwork = library?.artworkURL(current)
        let id = artwork.map { "\(current.id.uuidString)-\($0.lastPathComponent)" }
        if id != artworkID {
            artworkID = id
            writeArtwork(artwork)
        }
        let snapshot = WidgetSnapshot(
            title: current.title, artist: current.artist, album: current.album,
            duration: player.duration > 0 ? player.duration : current.duration,
            elapsed: player.elapsed, isPlaying: player.isPlaying, artworkID: id,
            upNext: player.shuffle ? [] : Self.upNext(after: current, in: player.queue, wrapping: player.repeatMode == .all)
                .map { WidgetSnapshot.Song(title: $0.title, artist: $0.artist) },
            shuffle: player.shuffle)
        write(snapshot)
    }

    private func publishQuit() {
        guard var snapshot = lastWritten else { return }
        snapshot.elapsed = snapshot.elapsed(at: Date())
        snapshot.isPlaying = false
        snapshot.appRunning = false
        snapshot.updatedAt = Date()
        write(snapshot)
    }

    static func idle() -> WidgetSnapshot {
        WidgetSnapshot(title: "", artist: "", album: "", duration: 0, elapsed: 0, isPlaying: false, artworkID: nil, upNext: [])
    }

    nonisolated static func upNext(after current: Track, in queue: [Track], wrapping: Bool, limit: Int = 5) -> [Track] {
        guard let index = queue.firstIndex(where: { $0.id == current.id }) else { return [] }
        var rest = Array(queue[(index + 1)...])
        if wrapping { rest += queue[..<index] }
        return Array(rest.prefix(limit))
    }

    private func write(_ snapshot: WidgetSnapshot) {
        // Re-writing an identical state would only make the widget redraw.
        if let lastWritten, Self.sameState(lastWritten, snapshot) { return }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try WidgetShared.encode(snapshot).write(to: directory.appendingPathComponent(WidgetShared.snapshotURL.lastPathComponent), options: .atomic)
            lastWritten = snapshot
            reload()
        } catch {
            // The widget is a convenience; playback must not depend on it.
        }
    }

    private static func sameState(_ a: WidgetSnapshot, _ b: WidgetSnapshot) -> Bool {
        var a = a, b = b
        let drift = abs(a.elapsed(at: Date()) - b.elapsed(at: Date()))
        a.updatedAt = .distantPast; b.updatedAt = .distantPast
        a.elapsed = 0; b.elapsed = 0
        return a == b && drift < 2
    }

    private func writeArtwork(_ source: URL?) {
        let target = directory.appendingPathComponent(WidgetShared.artworkURL.lastPathComponent)
        guard let source, let image = NSImage(contentsOf: source), let data = Self.thumbnail(image, side: 360) else {
            try? FileManager.default.removeItem(at: target)
            return
        }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? data.write(to: target, options: .atomic)
    }

    /// Widgets have a small memory budget; a 3000px scan would not load at all.
    nonisolated static func thumbnail(_ image: NSImage, side: CGFloat) -> Data? {
        guard image.size.width > 0, image.size.height > 0 else { return nil }
        let pixels = Int(side)
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8,
                                            samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                            bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        bitmap.size = NSSize(width: side, height: side)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        // Fill the square the way the app's artwork does: centre crop.
        let scale = max(side / image.size.width, side / image.size.height)
        let drawn = NSSize(width: image.size.width * scale, height: image.size.height * scale)
        image.draw(in: NSRect(x: (side - drawn.width) / 2, y: (side - drawn.height) / 2, width: drawn.width, height: drawn.height),
                   from: .zero, operation: .copy, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        return bitmap.representation(using: .png, properties: [:])
    }
}
