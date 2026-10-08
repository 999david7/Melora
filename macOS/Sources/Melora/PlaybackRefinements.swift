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
