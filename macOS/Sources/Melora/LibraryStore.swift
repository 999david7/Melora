import Foundation
import AppKit
import AVFoundation
import UniformTypeIdentifiers

@MainActor
final class LibraryStore: ObservableObject {
    @Published private(set) var tracks: [Track] = []
    @Published private(set) var playlists: [NativePlaylist] = []
    @Published private(set) var importedPlaylistID: UUID?
    @Published private(set) var jobs: [ImportJob] = []
    @Published private(set) var root: URL
    @Published var error: String?
    @Published var showImporter = false
    @Published var showSettings = false
    @Published private(set) var isInstalling = false
    @Published var toolsMessage = ""
    @Published private(set) var toolsAvailable = false
    @Published private(set) var spotifyToolsAvailable = false
    @Published private(set) var isImportingFiles = false
    private var worker: Task<Void, Never>?
    private var currentImport: Task<Void, Error>?
    private let services: ImportServices
    private let trashFile: (URL) throws -> URL?
    private var canWrite = false

    var isBusy: Bool { worker != nil || isImportingFiles }
    var activeJobs: [ImportJob] { jobs.filter { $0.state == .queued || $0.state == .downloading } }
    var documentURL: URL { root.appendingPathComponent("library.json") }

    init(root selectedRoot: URL? = nil, services: ImportServices = .live,
         trashFile: @escaping (URL) throws -> URL? = { url in
             var trashed: NSURL?
             try FileManager.default.trashItem(at: url, resultingItemURL: &trashed)
             return trashed as URL?
         }) {
        self.services = services
        self.trashFile = trashFile
        let defaultRoot = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Music/Melora", isDirectory: true)
        root = selectedRoot ?? UserDefaults.standard.string(forKey: "libraryPath").map { URL(fileURLWithPath: $0, isDirectory: true) } ?? defaultRoot
        load()
        refreshTools()
        if selectedRoot == nil { Task { await restoreMissingArtwork() } }
    }

    func refreshTools() {
        toolsAvailable = DownloadService.executable("yt-dlp") != nil && DownloadService.executable("ffmpeg") != nil
        spotifyToolsAvailable = toolsAvailable
    }

    private func load() {
        canWrite = false
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: documentURL.path) {
                let document = try JSONDecoder().decode(LibraryDocument.self, from: Data(contentsOf: documentURL))
                guard document.version == 1 else { throw MeloraError.message("This library was created by a newer version of Melora.") }
                for track in document.tracks {
                    _ = try LibraryPaths.resolve(track.audioPath, in: root)
                    if let art = track.artworkPath { _ = try LibraryPaths.resolve(art, in: root) }
                }
                tracks = document.tracks
                playlists = document.playlists
            } else { tracks = []; playlists = [] }
            canWrite = true
        } catch { self.error = "Could not open your library: \(error.localizedDescription)" }
    }

    private func persist(_ next: [Track]) throws {
        guard canWrite else { throw MeloraError.message("The library could not be loaded. Choose another folder in Settings before making changes.") }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(LibraryDocument(tracks: next, playlists: playlists)).write(to: documentURL, options: .atomic)
        tracks = next
    }

    func fileURL(_ track: Track) -> URL? { try? LibraryPaths.resolve(track.audioPath, in: root) }
    func artworkURL(_ track: Track) -> URL? {
        if let art = track.artworkPath.flatMap({ try? LibraryPaths.resolve($0, in: root) }),
           FileManager.default.fileExists(atPath: art.path) { return art }
        guard let audio = fileURL(track) else { return nil }
        return ["spotify-cover", "audio.jpg", "cover"].map { audio.deletingLastPathComponent().appendingPathComponent($0) }
            .first { FileManager.default.fileExists(atPath: $0.path) }
    }

    private func restoreMissingArtwork() async {
        let libraryRoot = root
        for track in tracks where artworkURL(track) == nil {
            guard root == libraryRoot else { return }
            guard let source = track.sourceURL.flatMap(URL.init(string:)).flatMap(ImportURL.spotifyURL),
                  source.path.hasPrefix("/track/"), let audio = fileURL(track) else { continue }
            let staging = FileManager.default.temporaryDirectory.appendingPathComponent("Melora-artwork-\(UUID())")
            defer { try? FileManager.default.removeItem(at: staging) }
            do {
                guard let art = try await SpotifyService.restoreArtwork(source, in: staging),
                      root == libraryRoot, let index = tracks.firstIndex(where: { $0.id == track.id }),
                      tracks[index].audioPath == track.audioPath else { continue }
                try FileManager.default.createDirectory(at: audio.deletingLastPathComponent(), withIntermediateDirectories: true)
                try Data(contentsOf: staging.appendingPathComponent(art)).write(to: audio.deletingLastPathComponent().appendingPathComponent(art), options: .atomic)
                var next = tracks
                next[index].artworkPath = track.audioPath.split(separator: "/").dropLast().joined(separator: "/") + "/" + art
                try persist(next)
            } catch { /* Keep the track available; a later launch can retry artwork separately. */ }
        }
    }

    func createPlaylist() {
        guard canWrite else { return }
        let alert = NSAlert()
        alert.messageText = "New playlist"
        alert.informativeText = "Give your playlist a name."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.placeholderString = "Playlist name"
        alert.accessoryView = field
        alert.addButton(withTitle: "Create")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let name = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        let previous = playlists
        playlists.append(NativePlaylist(name: name))
        do { try persist(tracks) }
        catch { playlists = previous; self.error = error.localizedDescription }
    }

    func add(_ track: Track, to playlist: NativePlaylist) {
        guard let index = playlists.firstIndex(where: { $0.id == playlist.id }), !playlists[index].trackIDs.contains(track.id) else { return }
        let previous = playlists
        playlists[index].trackIDs.append(track.id)
        do { try persist(tracks) }
        catch { playlists = previous; self.error = error.localizedDescription }
    }

    func renamePlaylist(_ playlist: NativePlaylist) {
        let alert = NSAlert()
        alert.messageText = "Rename playlist"
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = playlist.name
        alert.accessoryView = field
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        renamePlaylist(playlist.id, to: field.stringValue)
    }

    func renamePlaylist(_ id: UUID, to name: String) {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, let index = playlists.firstIndex(where: { $0.id == id }) else { return }
        var next = playlists
        next[index].name = name
        savePlaylists(next)
    }

    func duplicatePlaylist(_ playlist: NativePlaylist) {
        guard let original = playlists.first(where: { $0.id == playlist.id }) else { return }
        // The copy is independent of the source playlist's future imports.
        let baseName = original.name + " copy"
        var name = baseName
        var number = 2
        while playlists.contains(where: { $0.name.localizedCaseInsensitiveCompare(name) == .orderedSame }) {
            name = "\(baseName) \(number)"
            number += 1
        }
        let copy = NativePlaylist(name: name, trackIDs: original.trackIDs)
        savePlaylists(playlists + [copy])
    }

    func requestDeletePlaylist(_ playlist: NativePlaylist) {
        let alert = NSAlert()
        alert.messageText = "Delete \(playlist.name)?"
        alert.informativeText = "This removes the playlist. Its songs and downloaded files stay in your library."
        alert.addButton(withTitle: "Delete playlist")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        deletePlaylist(playlist.id)
    }

    func deletePlaylist(_ id: UUID) {
        guard canWrite, let playlist = playlists.first(where: { $0.id == id }) else { return }
        let previous = playlists
        playlists.removeAll { $0.id == id }
        do { try persist(tracks) }
        catch { playlists = previous; self.error = error.localizedDescription; return }
        if importedPlaylistID == id { importedPlaylistID = nil }
        // Stop an in-progress collection import from updating the deleted playlist.
        if let source = playlist.sourceURL {
            for job in activeJobs where job.url.absoluteString == source { cancel(job.id) }
        }
    }

    func remove(_ track: Track, from playlist: NativePlaylist) {
        guard let index = playlists.firstIndex(where: { $0.id == playlist.id }) else { return }
        var next = playlists
        next[index].trackIDs.removeAll { $0 == track.id }
        savePlaylists(next)
    }

    func move(_ track: Track, in playlist: NativePlaylist, by offset: Int) {
        guard let index = playlists.firstIndex(where: { $0.id == playlist.id }),
              let position = playlists[index].trackIDs.firstIndex(of: track.id) else { return }
        let destination = position + offset
        guard playlists[index].trackIDs.indices.contains(destination) else { return }
        var next = playlists
        next[index].trackIDs.remove(at: position)
        next[index].trackIDs.insert(track.id, at: destination)
        savePlaylists(next)
    }

    private func savePlaylists(_ next: [NativePlaylist]) {
        let previous = playlists
        playlists = next
        do { try persist(tracks) }
        catch { playlists = previous; self.error = error.localizedDescription }
    }

    func toggleFavorite(_ track: Track) {
        var next = tracks
        guard let index = next.firstIndex(where: { $0.id == track.id }) else { return }
        next[index].isFavorite.toggle()
        do { try persist(next) } catch { self.error = error.localizedDescription }
    }

    func removeFromLibrary(_ track: Track) {
        // Keep the downloaded files so removing a row never destroys a music archive.
        let previous = playlists
        playlists = playlists.map { playlist in
            var updated = playlist
            updated.trackIDs.removeAll { $0 == track.id }
            return updated
        }
        do { try persist(tracks.filter { $0.id != track.id }) }
        catch { playlists = previous; self.error = error.localizedDescription }
    }

    func deleteSong(_ track: Track) {
        guard canWrite, tracks.contains(where: { $0.id == track.id }) else { return }
        let previous = playlists
        var moved: (original: URL, trash: URL)?
        do {
            let audio = try LibraryPaths.resolve(track.audioPath, in: root)
            let components = track.audioPath.split(separator: "/")
            var target = audio
            // Imported songs have their own folder, containing audio, cover and metadata.
            if components.count == 3, components[0] == "Music", UUID(uuidString: String(components[1])) != nil,
               !tracks.contains(where: { $0.id != track.id && fileURL($0)?.deletingLastPathComponent() == audio.deletingLastPathComponent() }) {
                target = audio.deletingLastPathComponent()
            }
            if FileManager.default.fileExists(atPath: target.path), let trashed = try trashFile(target) {
                moved = (target, trashed)
            }
            playlists = playlists.map { item in
                var item = item
                item.trackIDs.removeAll { $0 == track.id }
                return item
            }
            try persist(tracks.filter { $0.id != track.id })
        } catch {
            playlists = previous
            if let moved { try? FileManager.default.moveItem(at: moved.trash, to: moved.original) }
            self.error = "Could not delete \(track.title): \(error.localizedDescription)"
        }
    }

    func reveal(_ track: Track) {
        if let url = fileURL(track) { NSWorkspace.shared.activateFileViewerSelecting([url]) }
    }

    func enqueue(_ input: String) throws {
        guard canWrite else { throw MeloraError.message("Choose a writable library folder in Settings first.") }
        let lines = input.split(whereSeparator: \.isNewline).map(String.init).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        guard !lines.isEmpty else { throw MeloraError.message("Paste at least one music link.") }
        let urls = try lines.map(ImportURL.parse)
        for url in urls {
            let normalized = ImportURL.spotifyURL(url) ?? ImportURL.youtubePlaylistURL(url) ?? url
            let isPlaylist = ImportURL.playlistURL(normalized) != nil
            let alreadyImported = !isPlaylist && existingTrack(for: normalized) != nil
            let alreadyQueued = activeJobs.contains { $0.url == normalized }
            if !alreadyImported && !alreadyQueued { jobs.append(ImportJob(url: normalized)) }
        }
        startQueue()
    }

    func cancel(_ id: UUID) {
        guard let index = jobs.firstIndex(where: { $0.id == id }) else { return }
        if jobs[index].state == .downloading { currentImport?.cancel() }
        if jobs[index].state == .queued || jobs[index].state == .downloading {
            jobs[index].state = .cancelled
            jobs[index].message = "Cancelled"
        }
    }

    func retry(_ id: UUID) {
        guard let index = jobs.firstIndex(where: { $0.id == id }), jobs[index].state == .failed || jobs[index].state == .cancelled else { return }
        jobs[index].state = .queued
        jobs[index].progress = 0
        jobs[index].message = "Waiting to import"
        jobs[index].failures = []
        startQueue()
    }

    func clearFinishedJobs() { guard !isBusy else { return }; jobs.removeAll { $0.state == .completed || $0.state == .cancelled } }

    private func update(_ id: UUID, progress: Double, message: String) {
        guard let index = jobs.firstIndex(where: { $0.id == id }), jobs[index].state == .downloading else { return }
        jobs[index].progress = max(jobs[index].progress, progress)
        jobs[index].message = message
    }

    private func startQueue() {
        guard worker == nil else { return }
        worker = Task { [weak self] in
            guard let self else { return }
            defer { self.worker = nil; self.currentImport = nil }
            while let index = self.jobs.firstIndex(where: { $0.state == .queued }) {
                let job = self.jobs[index]
                self.jobs[index].state = .downloading
                self.jobs[index].message = "Connecting…"
                let task = Task { try await self.performImport(job) }
                self.currentImport = task
                do {
                    try await task.value
                    if self.jobs[index].state != .cancelled {
                        self.jobs[index].state = .completed
                        self.jobs[index].progress = 1
                        if self.jobs[index].playlistName == nil { self.jobs[index].message = "Added to your library" }
                    }
                } catch {
                    if self.jobs[index].state != .cancelled {
                        self.jobs[index].state = .failed
                        self.jobs[index].message = error.localizedDescription
                    }
                }
                self.currentImport = nil
            }
        }
    }

    func job(for url: URL) -> ImportJob? {
        let identity = ImportURL.sourceIdentity(url)
        return jobs.last { ImportURL.sourceIdentity($0.url) == identity }
    }

    func existingTrack(for url: URL) -> Track? {
        let identity = ImportURL.sourceIdentity(url)
        return tracks.first {
            guard let source = $0.sourceURL.flatMap(URL.init(string:)),
                  ImportURL.sourceIdentity(source) == identity,
                  let file = fileURL($0) else { return false }
            return FileManager.default.fileExists(atPath: file.path)
        }
    }

    private func performImport(_ job: ImportJob) async throws {
        let staging = root.appendingPathComponent(".incoming", isDirectory: true)
        let progress: DownloadService.Progress = { [weak self] value, message in
            await self?.update(job.id, progress: value, message: message)
        }
        guard let playlistURL = ImportURL.playlistURL(job.url) else {
            if existingTrack(for: job.url) != nil { return }
            let result = try await services.download(job.url, staging, progress)
            _ = try await commit(result)
            return
        }
        let manifest = try await services.resolvePlaylist(playlistURL, staging, progress)
        try Task.checkCancellation()
        guard !manifest.entries.isEmpty else { throw MeloraError.message("This collection contains no tracks.") }
        let playlistID: UUID
        if let playlist = playlists.first(where: { $0.sourceURL == playlistURL.absoluteString }) {
            playlistID = playlist.id
        } else {
            let previous = playlists
            let playlist = NativePlaylist(name: manifest.title, sourceURL: playlistURL.absoluteString)
            playlists.append(playlist)
            do { try persist(tracks) }
            catch { playlists = previous; throw error }
            playlistID = playlist.id
        }
        importedPlaylistID = nil
        importedPlaylistID = playlistID
        if let index = jobs.firstIndex(where: { $0.id == job.id }) { jobs[index].playlistName = manifest.title; jobs[index].failures = [] }
        var orderedTrackIDs: [UUID] = []
        var failures: [PlaylistFailure] = manifest.entries.enumerated().compactMap { position, entry in
            entry.unavailableReason.map { PlaylistFailure(id: position + 1, title: entry.title, message: $0) }
        }
        if let index = jobs.firstIndex(where: { $0.id == job.id }) { jobs[index].failures = failures }
        var readyEntries = 0
        for (position, entry) in manifest.entries.enumerated() {
            try Task.checkCancellation()
            let prefix = "\(manifest.title) · \(position + 1)/\(manifest.entries.count)"
            update(job.id, progress: Double(position) / Double(manifest.entries.count), message: "\(prefix) · \(entry.title)")
            do {
                guard entry.unavailableReason == nil, let url = entry.url else {
                    throw MeloraError.message(entry.unavailableReason ?? "No track link is available.")
                }
                let track: Track
                if let existing = existingTrack(for: url) { track = existing }
                else {
                    let result = try await services.download(url, staging) { [weak self] value, message in
                        await self?.update(job.id, progress: (Double(position) + value) / Double(manifest.entries.count), message: "\(prefix) · \(entry.title) · \(message)")
                    }
                    track = try await commit(result)
                }
                readyEntries += 1
                if !orderedTrackIDs.contains(track.id) { orderedTrackIDs.append(track.id) }
                try updatePlaylist(playlistID, orderedTrackIDs: orderedTrackIDs)
            } catch {
                if error is CancellationError || Task.isCancelled { throw CancellationError() }
                // Storage failures must stop the import; individual inaccessible videos may be skipped.
                if (error as NSError).domain == NSCocoaErrorDomain { throw error }
                if !failures.contains(where: { $0.id == position + 1 }) {
                    failures.append(PlaylistFailure(id: position + 1, title: entry.title, message: error.localizedDescription))
                    failures.sort { $0.id < $1.id }
                }
                if let index = jobs.firstIndex(where: { $0.id == job.id }) { jobs[index].failures = failures }
            }
        }
        try Task.checkCancellation()
        if failures.isEmpty {
            // Reimporting updates the source order while keeping manually added songs at the end.
            try updatePlaylist(playlistID, orderedTrackIDs: orderedTrackIDs)
        }
        let summary = "\(manifest.title): \(readyEntries) of \(manifest.entries.count) tracks imported"
        if !failures.isEmpty { throw MeloraError.message("\(summary) · \(failures.count) failed. Retry to try the missing tracks again.") }
        update(job.id, progress: 1, message: summary)
    }

    private func updatePlaylist(_ id: UUID, orderedTrackIDs: [UUID]) throws {
        guard let index = playlists.firstIndex(where: { $0.id == id }) else { return }
        let previous = playlists
        let remaining = playlists[index].trackIDs.filter { !orderedTrackIDs.contains($0) }
        playlists[index].trackIDs = orderedTrackIDs + remaining
        do { try persist(tracks) }
        catch { playlists = previous; throw error }
    }

    private func commit(_ result: DownloadResult) async throws -> Track {
        let directory = "Music/\(result.track.id.uuidString)"
        let destination = root.appendingPathComponent(directory, isDirectory: true)
        do {
            let asset = AVURLAsset(url: result.stagingFolder.appendingPathComponent(result.track.audioPath))
            guard (try? await asset.load(.isPlayable)) == true,
                  !(try await asset.loadTracks(withMediaType: .audio)).isEmpty else {
                throw MeloraError.message("The downloaded file does not contain playable audio.")
            }
            try Task.checkCancellation()
            let attributes = try FileManager.default.attributesOfItem(atPath: result.stagingFolder.appendingPathComponent(result.track.audioPath).path)
            guard (attributes[.size] as? NSNumber)?.intValue ?? 0 > 0 else { throw MeloraError.message("The audio file is empty.") }
            try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileManager.default.moveItem(at: result.stagingFolder, to: destination)
            var track = result.track
            track.audioPath = directory + "/" + track.audioPath
            track.artworkPath = track.artworkPath.map { directory + "/" + $0 }
            var next = tracks
            if let source = track.sourceURL.flatMap(URL.init(string:)),
               let index = next.firstIndex(where: {
                   guard let original = $0.sourceURL.flatMap(URL.init(string:)) else { return false }
                   return ImportURL.sourceIdentity(original) == ImportURL.sourceIdentity(source)
               }) {
                track.id = next[index].id
                track.isFavorite = next[index].isFavorite
                track.addedAt = next[index].addedAt
                next[index] = track
            } else { next.append(track) }
            try persist(next)
            return track
        } catch {
            try? FileManager.default.removeItem(at: destination)
            try? FileManager.default.removeItem(at: result.stagingFolder)
            throw error
        }
    }

    func importFiles() {
        guard !isBusy, canWrite else { return }
        let panel = NSOpenPanel()
        panel.title = "Add local music"
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = [.audio]
        guard panel.runModal() == .OK else { return }
        let files = panel.urls
        isImportingFiles = true
        Task {
            defer { isImportingFiles = false }
            for file in files {
                let folder = root.appendingPathComponent(".incoming/\(UUID().uuidString)", isDirectory: true)
                do {
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    let destination = folder.appendingPathComponent(file.lastPathComponent)
                    try await Task.detached { try FileManager.default.copyItem(at: file, to: destination) }.value
                    let track = try await DownloadService.metadata(destination, source: nil)
                    _ = try await commit(DownloadResult(track: track, stagingFolder: folder))
                } catch {
                    try? FileManager.default.removeItem(at: folder)
                    self.error = "Could not import \(file.lastPathComponent): \(error.localizedDescription)"
                }
            }
        }
    }

    func chooseLibrary(onSwitch: () -> Void) {
        guard !isBusy else { return }
        let panel = NSOpenPanel()
        panel.title = "Choose a Melora library folder"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let selected = panel.url else { return }
        onSwitch()
        root = selected
        tracks = []
        playlists = []
        jobs = []
        UserDefaults.standard.set(selected.path, forKey: "libraryPath")
        load()
    }

    func installSpotifyTools() {
        guard !isInstalling else { return }
        guard let brew = DownloadService.executable("brew") else {
            toolsMessage = "Install Homebrew, then run: brew install uv ffmpeg && uv tool install --python 3.12 spotdl"
            return
        }
        isInstalling = true
        toolsMessage = "Installing Spotify link support…"
        Task {
            let logs = FileManager.default.temporaryDirectory.appendingPathComponent("Melora-spotify-tools-\(UUID())")
            defer { isInstalling = false; try? FileManager.default.removeItem(at: logs); refreshTools() }
            do {
                try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
                _ = try await DownloadService.run(brew, arguments: ["install", "uv", "ffmpeg", "yt-dlp", "deno"], logFolder: logs) { _, _ in }
                guard let uv = DownloadService.executable("uv") else { throw MeloraError.message("uv was installed but could not be found. Reopen Melora and try again.") }
                _ = try await DownloadService.run(uv, arguments: ["tool", "install", "--python", "3.12", "spotdl"], logFolder: logs) { _, _ in }
                toolsMessage = "Spotify link support is ready. Audio is matched on YouTube."
            } catch { toolsMessage = error.localizedDescription }
        }
    }

    func installTools() {
        guard !isInstalling else { return }
        guard let brew = DownloadService.executable("brew") else {
            toolsMessage = "Install Homebrew from brew.sh, then run: brew install yt-dlp ffmpeg deno"
            return
        }
        isInstalling = true
        toolsMessage = "Installing yt-dlp, FFmpeg and the video JavaScript runtime. This may take a few minutes…"
        Task {
            let logs = FileManager.default.temporaryDirectory.appendingPathComponent("Melora-tools-\(UUID().uuidString)")
            defer { isInstalling = false; try? FileManager.default.removeItem(at: logs); refreshTools() }
            do {
                try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
                _ = try await DownloadService.run(brew, arguments: ["install", "yt-dlp", "ffmpeg", "deno"], logFolder: logs) { _, _ in }
                toolsMessage = "Download tools are ready. You can now import video links."
            } catch { toolsMessage = error.localizedDescription }
        }
    }
}
