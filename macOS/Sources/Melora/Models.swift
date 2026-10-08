import Foundation

struct Track: Codable, Identifiable, Equatable, Sendable {
    var id: UUID
    var title: String
    var artist: String
    var album: String
    var duration: Double
    var audioPath: String
    var artworkPath: String?
    var sourceURL: String?
    var addedAt: Date
    var isFavorite: Bool = false
}

struct NativePlaylist: Codable, Identifiable, Equatable {
    var id = UUID()
    var name: String
    var trackIDs: [UUID] = []
    var sourceURL: String?
}

struct LibraryDocument: Codable {
    var version = 1
    var tracks: [Track] = []
    var playlists: [NativePlaylist] = []

    init(tracks: [Track] = [], playlists: [NativePlaylist] = []) {
        self.tracks = tracks
        self.playlists = playlists
    }

    enum CodingKeys: String, CodingKey { case version, tracks, playlists }
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(Int.self, forKey: .version)
        tracks = try container.decode([Track].self, forKey: .tracks)
        playlists = try container.decodeIfPresent([NativePlaylist].self, forKey: .playlists) ?? []
    }
}

struct ImportJob: Identifiable {
    enum State: Equatable {
        case queued, downloading, completed, failed, cancelled
    }
    let id = UUID()
    let url: URL
    var state: State = .queued
    var progress: Double = 0
    var message = "Waiting to import"
    var playlistName: String?
    var failures: [PlaylistFailure] = []
}

struct PlaylistFailure: Identifiable, Equatable {
    var id: Int
    var title: String
    var message: String
}

struct PlaylistEntry: Sendable {
    let title: String
    let url: URL?
    var unavailableReason: String?
}

struct PlaylistManifest: Sendable {
    let title: String
    let entries: [PlaylistEntry]
}

enum MeloraError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let text): text }
    }
}

enum ImportURL {
    static func parse(_ input: String) throws -> URL {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: value),
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil else {
            throw MeloraError.message("Paste a complete http:// or https:// music or video link.")
        }
        return url
    }

    static func isYouTube(_ url: URL) -> Bool {
        let host = url.host?.lowercased() ?? ""
        return host == "youtube.com" || host.hasSuffix(".youtube.com") || host == "youtu.be"
    }

    static func youtubePlaylistURL(_ url: URL) -> URL? {
        guard isYouTube(url),
              let id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "list" })?.value,
              !id.isEmpty else { return nil }
        // A watch link's automatic radio Mix is not a standalone playlist page.
        if id.hasPrefix("RD"), sourceIdentity(url).hasPrefix("youtube:") { return nil }
        var canonical = URLComponents(string: "https://www.youtube.com/playlist")!
        canonical.queryItems = [URLQueryItem(name: "list", value: id)]
        return canonical.url
    }

    static func spotifyURL(_ url: URL) -> URL? {
        guard url.host?.lowercased() == "open.spotify.com" else { return nil }
        var parts = url.path.split(separator: "/").map(String.init)
        if parts.first?.hasPrefix("intl-") == true { parts.removeFirst() }
        if parts.first == "embed" { parts.removeFirst() }
        guard parts.count == 2, ["track", "album", "playlist"].contains(parts[0]),
              parts[1].count == 22, parts[1].allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return nil }
        return URL(string: "https://open.spotify.com/\(parts[0])/\(parts[1])")
    }

    static func playlistURL(_ url: URL) -> URL? {
        if let youtube = youtubePlaylistURL(url) { return youtube }
        if let spotify = spotifyURL(url), !spotify.path.hasPrefix("/track/") { return spotify }
        return nil
    }

    static func sourceIdentity(_ url: URL) -> String {
        if let spotify = spotifyURL(url) { return "spotify:" + spotify.path.split(separator: "/").joined(separator: ":") }
        guard isYouTube(url) else { return url.absoluteString }
        let host = url.host?.lowercased() ?? ""
        let components = url.path.split(separator: "/")
        let id: String?
        if host == "youtu.be" { id = components.first.map(String.init) }
        else if ["shorts", "embed", "live"].contains(components.first.map(String.init) ?? "") {
            id = components.dropFirst().first.map(String.init)
        } else {
            id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "v" })?.value
        }
        return id.flatMap { $0.isEmpty ? nil : "youtube:\($0)" } ?? url.absoluteString
    }

    static let audioExtensions: Set<String> = ["mp3", "m4a", "aac", "wav", "aiff", "aif", "flac", "ogg", "opus", "alac", "caf"]

    static func isAudio(_ url: URL) -> Bool {
        audioExtensions.contains(url.pathExtension.lowercased())
    }
}

enum LibraryPaths {
    static func resolve(_ path: String, in root: URL) throws -> URL {
        guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("\0"),
              !path.split(separator: "/").contains("..") else {
            throw MeloraError.message("The library contains an unsafe file path.")
        }
        let root = root.resolvingSymlinksInPath().standardizedFileURL
        // Resolve existing ancestors separately: Foundation may leave a symlink
        // unresolved when the final audio file is missing.
        var result = root
        for component in path.split(separator: "/") {
            result = result.appendingPathComponent(String(component)).resolvingSymlinksInPath().standardizedFileURL
        }
        guard result.path.hasPrefix(root.path + "/") else {
            throw MeloraError.message("This file is outside the library.")
        }
        return result
    }
}

func timeLabel(_ seconds: Double) -> String {
    guard seconds.isFinite, seconds >= 0 else { return "0:00" }
    let seconds = Int(seconds)
    return "\(seconds / 60):\(String(format: "%02d", seconds % 60))"
}
