import Foundation

// The app and its sandboxed widget share nothing but this folder. The app writes
// the snapshot; the widget may only read it (a read-only sandbox exception).
public struct WidgetSnapshot: Codable, Equatable, Sendable {
    public struct Song: Codable, Equatable, Sendable {
        public var title: String
        public var artist: String
        public init(title: String, artist: String) { self.title = title; self.artist = artist }
    }

    public var title: String
    public var artist: String
    public var album: String
    public var duration: Double
    public var elapsed: Double
    public var isPlaying: Bool
    /// When `elapsed` was measured, so the widget can extrapolate progress.
    public var updatedAt: Date
    /// Changes with the cover so a widget never shows the previous song's artwork.
    public var artworkID: String?
    public var upNext: [Song]
    /// Shuffled order is not known ahead of time, so there is no "up next".
    public var shuffle: Bool
    public var appRunning: Bool

    public init(title: String, artist: String, album: String, duration: Double, elapsed: Double, isPlaying: Bool,
                updatedAt: Date = Date(), artworkID: String?, upNext: [Song], shuffle: Bool = false, appRunning: Bool = true) {
        self.title = title
        self.artist = artist
        self.album = album
        self.duration = duration
        self.elapsed = elapsed
        self.isPlaying = isPlaying
        self.updatedAt = updatedAt
        self.artworkID = artworkID
        self.upNext = upNext
        self.shuffle = shuffle
        self.appRunning = appRunning
    }

    /// The moment playback started, if it is playing now, for live timers.
    public var startedAt: Date { updatedAt.addingTimeInterval(-elapsed) }
    public var endsAt: Date { startedAt.addingTimeInterval(duration) }
    public var isLive: Bool { isPlaying && appRunning && duration > 0 && endsAt > Date() }

    public func elapsed(at date: Date) -> Double {
        guard isPlaying, appRunning else { return min(elapsed, duration) }
        return max(0, min(duration, elapsed + date.timeIntervalSince(updatedAt)))
    }
}

public enum WidgetShared {
    public static let widgetKind = "app.melora.desktop.nowplaying"

    /// Commands the widget posts and the app observes. Sandboxed senders cannot
    /// attach a payload, so each command has its own name.
    public enum Command: String, CaseIterable, Sendable {
        case toggle, next, previous
        public var notification: Notification.Name { Notification.Name("app.melora.desktop.widget.\(rawValue)") }
    }

    /// The real home folder; inside the sandbox `NSHomeDirectory()` is the container.
    public static var homeDirectory: URL {
        if let entry = getpwuid(getuid()), let dir = entry.pointee.pw_dir {
            return URL(fileURLWithPath: String(cString: dir), isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
    }

    /// Must match the widget's home-relative-path sandbox exception.
    public static let relativeDirectory = "Library/Application Support/Melora/Widget"
    public static var directory: URL { homeDirectory.appendingPathComponent(relativeDirectory, isDirectory: true) }
    public static var snapshotURL: URL { directory.appendingPathComponent("now-playing.json") }
    public static var artworkURL: URL { directory.appendingPathComponent("artwork.png") }

    public static func readSnapshot() -> WidgetSnapshot? {
        guard let data = try? Data(contentsOf: snapshotURL) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(WidgetSnapshot.self, from: data)
    }

    public static func encode(_ snapshot: WidgetSnapshot) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(snapshot)
    }
}
