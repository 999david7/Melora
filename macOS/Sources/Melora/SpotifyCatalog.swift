import Foundation
import AppKit

struct SpotifyTrackInfo {
    var title: String
    var artist: String
    var album: String
    var duration: Double
    var cover: URL?
}

enum SpotifyCatalog {
    static func page(_ url: URL) async throws -> String {
        var request = URLRequest(url: url)
        request.timeoutInterval = 25
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              let html = String(data: data, encoding: .utf8) else {
            throw MeloraError.message("Spotify did not return a public page for this link.")
        }
        return html
    }

    static func script(_ id: String, in html: String) throws -> String {
        let pattern = "<script[^>]*id=\"\(id)\"[^>]*>(.*?)</script>"
        let regex = try NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators])
        guard let match = regex.firstMatch(in: html, range: NSRange(html.startIndex..., in: html)),
              let range = Range(match.range(at: 1), in: html) else {
            throw MeloraError.message("Spotify changed its public page or this collection is private.")
        }
        return String(html[range])
    }

    static func entity(in html: String, url: URL) throws -> [String: Any] {
        let raw = try script("initialState", in: html)
        guard let data = Data(base64Encoded: raw),
              let document = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let entities = document["entities"] as? [String: Any],
              let items = entities["items"] as? [String: Any],
              let entity = items[ImportURL.sourceIdentity(url)] as? [String: Any] else {
            throw MeloraError.message("Spotify did not expose this collection's metadata.")
        }
        return entity
    }

    static func embedManifest(_ html: String, total: Int?) throws -> PlaylistManifest {
        let raw = try script("__NEXT_DATA__", in: html)
        let document = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any]
        let props = document?["props"] as? [String: Any]
        let pageProps = props?["pageProps"] as? [String: Any]
        let state = pageProps?["state"] as? [String: Any]
        let data = state?["data"] as? [String: Any]
        guard let entity = data?["entity"] as? [String: Any],
              let tracks = entity["trackList"] as? [[String: Any]], !tracks.isEmpty else {
            throw MeloraError.message("Spotify returned no public tracks for this collection.")
        }
        var entries = tracks.map { track -> PlaylistEntry in
            let uri = track["uri"] as? String ?? ""
            let id = uri.split(separator: ":").last.map(String.init) ?? ""
            let url = URL(string: "https://open.spotify.com/track/\(id)").flatMap(ImportURL.spotifyURL)
            let title = track["title"] as? String ?? "Unavailable track"
            let artist = track["subtitle"] as? String ?? ""
            return PlaylistEntry(title: "\(artist) — \(title)", url: url,
                                 unavailableReason: url == nil ? "Spotify did not expose a track link." : nil)
        }
        if let total, total > entries.count {
            for index in entries.count..<total {
                entries.append(PlaylistEntry(title: "Track \(index + 1) — metadata not exposed", url: nil,
                    unavailableReason: "Spotify only exposes the first \(tracks.count) tracks publicly. Import the remaining songs using a YouTube playlist or individual Spotify links."))
            }
        } else if total == nil && entries.count == 100 {
            entries.append(PlaylistEntry(title: "Collection may be incomplete", url: nil,
                unavailableReason: "Spotify's public embed is limited to 100 tracks; the full count could not be verified."))
        }
        return PlaylistManifest(title: entity["name"] as? String ?? "Spotify collection", entries: entries)
    }

    static func trackInfo(_ entity: [String: Any]) throws -> SpotifyTrackInfo {
        guard let title = entity["name"] as? String else { throw MeloraError.message("Spotify did not expose this track's title.") }
        let album = entity["albumOfTrack"] as? [String: Any] ?? [:]
        let duration = entity["duration"] as? [String: Any] ?? [:]
        let artistGroups = [entity["firstArtist"], entity["otherArtists"], entity["artists"]]
        let artists = artistGroups.compactMap { $0 as? [String: Any] }.flatMap { $0["items"] as? [[String: Any]] ?? [] }
            .compactMap { item -> String? in
                let profile = item["profile"] as? [String: Any]
                return profile?["name"] as? String ?? item["name"] as? String
            }
        let covers = (album["coverArt"] as? [String: Any])?["sources"] as? [[String: Any]] ?? []
        let cover = covers.sorted { ($0["width"] as? Int ?? 0) > ($1["width"] as? Int ?? 0) }.first?["url"] as? String
        return SpotifyTrackInfo(title: title, artist: artists.joined(separator: ", "), album: album["name"] as? String ?? "Singles",
                                duration: ((duration["totalMilliseconds"] as? NSNumber)?.doubleValue ?? 0) / 1000,
                                cover: cover.flatMap(URL.init(string:)))
    }

    static func coreTitle(_ title: String) -> String {
        let original = title
        var title = title.replacingOccurrences(of: #"\([^)]*\)|\[[^\]]*\]"#, with: "", options: .regularExpression)
        title = title.replacingOccurrences(of: #"(?i)\s*-\s*(?:piano version|piano cover|bonus track)\b.*$"#, with: "", options: .regularExpression)
        title = title.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? original : title
    }

    static func searchQueries(_ info: SpotifyTrackInfo) -> [String] {
        let primary = info.artist.components(separatedBy: ",").first ?? info.artist
        let arrangement = info.title.localizedCaseInsensitiveContains("piano") ? " piano" : ""
        let queries = ["\(primary) \(coreTitle(info.title))\(arrangement)", "\(primary) \(info.title)"]
        var seen = Set<String>()
        return queries.filter { seen.insert($0).inserted }
    }

    static func candidates(_ data: Data, info: SpotifyTrackInfo) throws -> [URL] {
        let document = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let entries = document?["entries"] as? [[String: Any]] ?? []
        func words(_ text: String) -> Set<String> {
            Set(text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
                .replacingOccurrences(of: "’", with: "").replacingOccurrences(of: "'", with: "")
                .components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty })
        }
        let titleWords = words(coreTitle(info.title)).subtracting(["the", "a", "an", "and"])
        let primaryArtistWords = words(info.artist.components(separatedBy: ",").first ?? info.artist).subtracting(["the", "and", "feat", "ft"])
        let targetWords = words(info.title)
        let isPiano = targetWords.contains("piano")
        let ranked = entries.compactMap { entry -> (URL, Double)? in
            guard let id = entry["id"] as? String, let title = entry["title"] as? String,
                  let duration = (entry["duration"] as? NSNumber)?.doubleValue, duration.isFinite,
                  info.duration > 0, abs(duration - info.duration) <= max(15, info.duration * 0.08),
                  let url = URL(string: "https://www.youtube.com/watch?v=\(id)") else { return nil }
            let foundTitle = words(title)
            let channel = (entry["channel"] as? String) ?? (entry["uploader"] as? String) ?? ""
            let channelWords = words(channel)
            let foundArtist = foundTitle.union(channelWords)
            let artistChannel = !primaryArtistWords.isEmpty && primaryArtistWords.isSubset(of: channelWords)
            guard !titleWords.isEmpty, titleWords.isSubset(of: foundTitle),
                  !primaryArtistWords.isEmpty, primaryArtistWords.isSubset(of: foundArtist) else { return nil }
            var altered = Set(["remix", "karaoke", "live", "slowed", "sped", "instrumental", "reaction", "tutorial", "synthesia", "attempted"])
            if !isPiano { altered.insert("cover") }
            guard altered.intersection(foundTitle).subtracting(targetWords).isEmpty else { return nil }
            let requiredVersions = targetWords.intersection(["remix", "live", "acoustic", "instrumental"])
            guard requiredVersions.isSubset(of: foundTitle) else { return nil }
            // An arrangement credited to the artist is not a recording performed by them.
            if !artistChannel && (foundTitle.contains("arr") || (foundTitle.contains("arranged") && foundTitle.contains("by"))) { return nil }
            if isPiano && !artistChannel && !foundTitle.contains("piano") { return nil }
            let contextScore = Double(targetWords.intersection(foundTitle).count) / Double(max(1, targetWords.count))
            let score = (artistChannel ? 30.0 : 5.0) + contextScore * 3 - abs(duration - info.duration) / 10
            return (url, score)
        }.sorted { $0.1 > $1.1 }
        var seen = Set<URL>()
        return ranked.map(\.0).filter { seen.insert($0).inserted }
    }

    static func match(_ data: Data, info: SpotifyTrackInfo) throws -> URL {
        guard let match = try candidates(data, info: info).first else {
            throw MeloraError.message("No confident YouTube match was found for \(info.artist) — \(info.title). Import the correct video link directly.")
        }
        return match
    }
}
