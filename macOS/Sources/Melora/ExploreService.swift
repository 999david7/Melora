import Foundation

struct ExploreResult: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let channel: String
    let duration: Double?
    let views: Int?
    let thumbnail: URL?
    var url: URL { URL(string: "https://www.youtube.com/watch?v=\(id)")! }
}

struct ExploreCategory: Identifiable, Hashable {
    let title: String
    let query: String
    var id: String { title }

    static let all = [
        ExploreCategory(title: "Top hits", query: "top hits this week official audio"),
        ExploreCategory(title: "Chill", query: "chill songs official audio"),
        ExploreCategory(title: "Lo-fi", query: "lofi hip hop beats"),
        ExploreCategory(title: "Indie", query: "indie songs official audio"),
        ExploreCategory(title: "Hip-hop", query: "hip hop hits official audio"),
        ExploreCategory(title: "Electronic", query: "electronic dance official audio"),
        ExploreCategory(title: "Rock classics", query: "classic rock songs official audio"),
        ExploreCategory(title: "Jazz", query: "jazz classics"),
        ExploreCategory(title: "Piano", query: "solo piano music"),
        ExploreCategory(title: "Film scores", query: "film score soundtrack theme"),
        ExploreCategory(title: "Acoustic", query: "acoustic cover songs"),
        ExploreCategory(title: "Focus", query: "instrumental focus music"),
    ]
}

// Searches YouTube through yt-dlp's flat search, which reads result metadata without downloading.
enum ExploreService {
    static let resultLimit = 24

    static func search(_ query: String) async throws -> [ExploreResult] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return [] }
        guard let downloader = DownloadService.executable("yt-dlp") else {
            throw MeloraError.message("Exploring needs yt-dlp. Open Settings to install the download tools.")
        }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("Melora-explore-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        // The query is a single argument after "--", never interpreted by a shell or as an option.
        let output = try await DownloadService.run(downloader, arguments: ["--ignore-config", "--flat-playlist", "--dump-single-json",
            "--skip-download", "--no-warnings", "--socket-timeout", "15", "--retries", "1", "--",
            "ytsearch\(resultLimit):\(query)"], logFolder: folder, timeout: 60) { _, _ in }
        guard let raw = output.split(whereSeparator: \.isNewline).last(where: { $0.hasPrefix("{") }) else {
            throw MeloraError.message("YouTube returned no search results. Check your connection and try again.")
        }
        return try parse(Data(raw.utf8))
    }

    static func parse(_ data: Data) throws -> [ExploreResult] {
        guard let document = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw MeloraError.message("YouTube returned unreadable search results.")
        }
        var seen = Set<String>()
        return (document["entries"] as? [[String: Any]] ?? []).compactMap { entry in
            guard let id = entry["id"] as? String, id.count == 11, seen.insert(id).inserted,
                  let title = (entry["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty,
                  !["is_live", "is_upcoming"].contains(entry["live_status"] as? String ?? "") else { return nil }
            let channel = (entry["channel"] as? String) ?? (entry["uploader"] as? String) ?? ""
            let thumbnails = (entry["thumbnails"] as? [[String: Any]] ?? [])
                .sorted { ($0["width"] as? Int ?? 0) < ($1["width"] as? Int ?? 0) }
            // The smallest thumbnail at least 320 wide is sharp enough for a row and quick to load.
            let thumbnail = (thumbnails.first { ($0["width"] as? Int ?? 0) >= 320 } ?? thumbnails.last)?["url"] as? String
            return ExploreResult(id: id, title: title, channel: cleanChannel(channel),
                                 duration: (entry["duration"] as? NSNumber)?.doubleValue,
                                 views: (entry["view_count"] as? NSNumber)?.intValue,
                                 thumbnail: thumbnail.flatMap(URL.init(string:)))
        }
    }

    static func cleanChannel(_ channel: String) -> String {
        var name = channel.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.hasSuffix(" - Topic") { name.removeLast(" - Topic".count) }
        if name.hasSuffix("VEVO"), name.count > 4 { name.removeLast(4) }
        return name.isEmpty ? "Unknown channel" : name
    }

    static func viewLabel(_ views: Int) -> String {
        switch views {
        case 1_000_000_000...: String(format: "%.1fB views", Double(views) / 1_000_000_000)
        case 1_000_000...: String(format: "%.1fM views", Double(views) / 1_000_000)
        case 1_000...: "\(views / 1_000)K views"
        default: "\(views) views"
        }
    }
}

@MainActor
final class ExploreModel: ObservableObject {
    @Published var query = ""
    @Published private(set) var results: [ExploreResult] = []
    @Published private(set) var lastQuery: String?
    @Published private(set) var isSearching = false
    @Published private(set) var error: String?
    private var task: Task<Void, Never>?
    private let searcher: @Sendable (String) async throws -> [ExploreResult]

    init(searcher: @escaping @Sendable (String) async throws -> [ExploreResult] = { try await ExploreService.search($0) }) {
        self.searcher = searcher
    }

    func search(_ text: String? = nil) {
        if let text { query = text }
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { clear(); return }
        task?.cancel()
        isSearching = true
        error = nil
        lastQuery = query
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let found = try await searcher(query)
                guard !Task.isCancelled else { return }
                results = found
            } catch {
                guard !Task.isCancelled, !(error is CancellationError) else { return }
                results = []
                self.error = error.localizedDescription
            }
            isSearching = false
        }
    }

    func clear() {
        task?.cancel()
        task = nil
        query = ""
        results = []
        lastQuery = nil
        error = nil
        isSearching = false
    }
}
