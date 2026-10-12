import Foundation

// A shuffle pass visits every song once. Back/forward retraces listening history.
struct ShuffleTraversal {
    private var remaining: [UUID] = []
    private var history: [UUID] = []
    private var forward: [UUID] = []

    mutating func reset(ids: [UUID], current: UUID?) {
        remaining = Array(Set(ids)).filter { $0 != current }.shuffled()
        history = []
        forward = []
    }

    mutating func next(after current: UUID, ids: [UUID], repeating: Bool) -> UUID? {
        let valid = Set(ids)
        remaining.removeAll { !valid.contains($0) }
        forward.removeAll { !valid.contains($0) }
        if let next = forward.popLast() {
            history.append(current)
            return next
        }
        if remaining.isEmpty && repeating {
            remaining = Array(valid).filter { $0 != current }.shuffled()
            if remaining.isEmpty { return valid.contains(current) ? current : nil }
        }
        guard !remaining.isEmpty else { return nil }
        history.append(current)
        return remaining.removeFirst()
    }

    mutating func previous(before current: UUID, ids: [UUID]) -> UUID? {
        let valid = Set(ids)
        history.removeAll { !valid.contains($0) }
        guard let previous = history.popLast() else { return nil }
        forward.append(current)
        return previous
    }

    /// A song chosen outside the shuffle order, so back still returns to `current`.
    mutating func leave(_ current: UUID) {
        history.append(current)
        forward = []
    }
}

// Autoplay: when the queue runs out, rank the library by how well each song
// follows the last one. Same artist counts most, then a shared credit or
// playlist, then album and favourites. Jitter keeps a long session varied.
enum Autoplay {
    static func ranked(after seed: Track, in library: [Track], playlists: [NativePlaylist],
                       excluding played: Set<UUID>, jitter: Double = 2.5) -> [Track] {
        var pool = library.filter { $0.id != seed.id && !played.contains($0.id) }
        // Everything has played: start over rather than fall silent.
        if pool.isEmpty { pool = library.filter { $0.id != seed.id } }
        let artist = key(seed.artist, placeholder: "unknown artist")
        let seedCredits = credits(seed.artist)
        let album = key(seed.album, placeholder: "singles")
        let companions = Set(playlists.filter { $0.trackIDs.contains(seed.id) }.flatMap(\.trackIDs))
        return pool.map { track -> (Track, Double) in
            var score = 0.0
            if let artist, key(track.artist, placeholder: "unknown artist") == artist {
                score += 4
                if let album, key(track.album, placeholder: "singles") == album { score += 1 }
            } else if !seedCredits.isDisjoint(with: credits(track.artist)) { score += 2 }
            if companions.contains(track.id) { score += 2 }
            if track.isFavorite { score += 1 }
            return (track, score + (jitter > 0 ? Double.random(in: 0..<jitter) : 0))
        }.sorted { $0.1 > $1.1 }.map(\.0)
    }

    /// Case- and accent-free, without YouTube's " - Topic" channel suffix. Nil for import placeholders.
    static func key(_ text: String, placeholder: String) -> String? {
        var value = text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasSuffix(" - topic") { value = String(value.dropLast(8)) }
        return value.isEmpty || value == placeholder ? nil : value
    }

    /// The individual artists in a credit such as "A feat. B & C".
    static func credits(_ artist: String) -> Set<String> {
        guard var text = key(artist, placeholder: "unknown artist") else { return [] }
        for separator in [" featuring ", " feat. ", " feat ", " ft. ", " & ", ";", "/"] {
            text = text.replacingOccurrences(of: separator, with: ",")
        }
        return Set(text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
    }
}

extension Track {
    func matches(search: String) -> Bool {
        let words = search.split(whereSeparator: \.isWhitespace)
        let text = "\(title) \(artist) \(album)"
        return words.allSatisfy {
            text.range(of: String($0), options: [.caseInsensitive, .diacriticInsensitive], locale: .current) != nil
        }
    }
}

extension Notification.Name {
    static let meloraFocusSearch = Notification.Name("Melora.focusSearch")
}
