import SwiftUI
import AppKit

enum LibrarySection: String, CaseIterable, Identifiable {
    case tracks = "TRACKS", albums = "ALBUMS", artists = "ARTISTS", favorites = "FAVORITES"
    var id: String { rawValue }
}

enum TrackSort: String, CaseIterable {
    case album = "ALBUM", artist = "ARTIST", title = "TITLE", added = "ADDED", playlist = "ORDER"
}

struct MusicGroup: Identifiable {
    let id: String
    let title: String
    let subtitle: String
    let tracks: [Track]
}

struct ContentView: View {
    @EnvironmentObject private var library: LibraryStore
    @EnvironmentObject private var player: MusicPlayer
    @ViewState<LibrarySection> private var section = .tracks
    @ViewState<TrackSort> private var sort = .album
    @ViewState<String> private var search = ""
    @FocusState private var searchFocused: Bool
    @ViewState<Bool> private var showQueue = false
    @ViewState<Bool> private var showNowPlaying = false
    @ViewState<Bool> private var showDownloads = false
    @ViewState<Bool> private var showExplore = false
    @StateObject private var explore = ExploreModel()
    @ViewState<MusicGroup?> private var selectedGroup: MusicGroup?
    @ViewState<UUID?> private var selectedPlaylist: UUID?

    private var playlist: NativePlaylist? { library.playlists.first { $0.id == selectedPlaylist } }
    private var filtered: [Track] {
        library.tracks.filter { track in
            (section != .favorites || track.isFavorite) &&
            (selectedGroup == nil || selectedGroup!.tracks.contains(where: { $0.id == track.id })) &&
            (playlist == nil || playlist!.trackIDs.contains(track.id)) &&
            track.matches(search: search)
        }.sorted {
            switch sort {
            case .playlist: return (playlist?.trackIDs.firstIndex(of: $0.id) ?? Int.max) < (playlist?.trackIDs.firstIndex(of: $1.id) ?? Int.max)
            case .added: return $0.addedAt > $1.addedAt
            case .title: return $0.title.localizedStandardCompare($1.title) == .orderedAscending
            case .artist: return "\($0.artist) \($0.album) \($0.title)".localizedStandardCompare("\($1.artist) \($1.album) \($1.title)") == .orderedAscending
            case .album: return "\($0.album) \($0.artist) \($0.title)".localizedStandardCompare("\($1.album) \($1.artist) \($1.title)") == .orderedAscending
            }
        }
    }
    private var albums: [MusicGroup] { groups(library.tracks, byArtist: false) }
    private var artists: [MusicGroup] { groups(library.tracks, byArtist: true) }
    private var browsingGroups: Bool { !showDownloads && selectedGroup == nil && playlist == nil && (section == .albums || section == .artists) }
    private var currentTitle: String { selectedGroup?.title ?? playlist?.name ?? (section == .favorites ? "Favorites" : "All music") }

    var body: some View {
        VStack(spacing: 0) {
            topbar
            Hairline()
            HStack(spacing: 0) {
                sidebar
                Hairline(vertical: true)
                VStack(spacing: 0) {
                    if showExplore && !showDownloads { ExploreView(model: explore) }
                    else {
                        filterbar
                        toolbar
                        if showDownloads { DownloadList() }
                        else { collection }
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
                if showQueue { Hairline(vertical: true); queuePanel }
                else if showNowPlaying && player.current != nil {
                    Hairline(vertical: true)
                    NowPlayingPanel(isPresented: $showNowPlaying) { showQueue = true }
                }
            }
            if let job = library.jobs.first(where: { $0.state == .downloading }) { jobline(job) }
            Hairline()
            PlayerBar(showQueue: $showQueue, showNowPlaying: $showNowPlaying)
        }
        .foregroundStyle(Theme.ink).background(Theme.background)
        .sheet(isPresented: $library.showImporter) { ImportSheet() }
        .sheet(isPresented: $library.showSettings) { SettingsSheet() }
        .alert("Melora", isPresented: Binding(get: { library.error != nil || player.error != nil }, set: { if !$0 { library.error = nil; player.error = nil } })) {
            Button("OK") { library.error = nil; player.error = nil }
        } message: { Text(library.error ?? player.error ?? "") }
        .onChange(of: library.tracks) { _, tracks in
            player.reconcileLibrary(tracks)
        }
        .onChange(of: player.current?.id) { previous, id in
            if id == nil { showNowPlaying = false }
            else if previous == nil { showNowPlaying = true; showQueue = false }
        }
        .onReceive(NotificationCenter.default.publisher(for: .meloraFocusSearch)) { _ in
            showDownloads = false
            // Explore focuses its own online search field.
            guard !showExplore else { return }
            DispatchQueue.main.async { searchFocused = true }
        }
        .onChange(of: showNowPlaying) { _, shown in if shown { showQueue = false } }
        .onChange(of: library.root) { _, _ in resetBrowse() }
        .onChange(of: library.playlists) { _, playlists in
            if let selectedPlaylist, !playlists.contains(where: { $0.id == selectedPlaylist }) { resetBrowse() }
        }
        .onChange(of: library.importedPlaylistID) { _, id in
            guard let id else { return }
            selectedPlaylist = id; selectedGroup = nil; section = .tracks
            sort = .playlist; search = ""; showDownloads = false; showExplore = false
        }
        .onChange(of: showDownloads) { _, shown in if shown { showExplore = false } }
    }

    private var topbar: some View {
        HStack(spacing: 12) {
            DiscMark().frame(width: 19, height: 19)
            Text("MELORA").font(.system(size: 12, design: .monospaced)).tracking(3.3)
            Spacer()
            ChromeButton(title: "EXPLORE") { showExplore = true; showDownloads = false }
            Text("/").foregroundStyle(Theme.faint)
            ChromeButton(title: "ADD FILES") { library.importFiles() }.disabled(library.isBusy)
            Text("/").foregroundStyle(Theme.faint)
            ChromeButton(title: "IMPORT LINK") { library.showImporter = true }
            Hairline(vertical: true).frame(height: 16).padding(.horizontal, 2)
            ChromeButton(title: library.activeJobs.isEmpty ? "DOWNLOADS" : "DOWNLOADS \(library.activeJobs.count)") { showDownloads.toggle() }
            Text("/").foregroundStyle(Theme.faint)
            ChromeButton(title: "SETTINGS") { library.showSettings = true }
        }.padding(.leading, 86).padding(.trailing, 22).frame(height: 56)
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                label("Folders")
                Spacer()
                LineIconButton(icon: "folder.badge.plus", help: "Add audio files", size: 22) { library.importFiles() }.disabled(library.isBusy)
            }.padding(.leading, 20).padding(.trailing, 14).padding(.top, 18).padding(.bottom, 10)
            sidebarRow("Explore", icon: "globe", count: nil, selected: showExplore && !showDownloads) { showExplore = true; showDownloads = false }
                .help("Search and discover new songs online")
                .padding(.bottom, 6)
            sidebarRow("All music", icon: "folder", count: library.tracks.count, selected: playlist == nil && selectedGroup == nil && !showDownloads && !showExplore) { resetBrowse() }
            sidebarRow("Music", icon: "folder", count: library.tracks.count, selected: false, indent: 13) { resetBrowse() }
            Spacer(minLength: 30)
            Hairline()
            HStack {
                label("Playlists"); Spacer()
                LineIconButton(icon: "plus", help: "New playlist", size: 22) { library.createPlaylist() }
            }.padding(.leading, 20).padding(.trailing, 14).padding(.top, 14).padding(.bottom, 10)
            if library.playlists.isEmpty {
                Text("No playlists yet").font(.system(size: 12.5)).foregroundStyle(Theme.faint).padding(.horizontal, 20).padding(.bottom, 16)
            } else {
                ScrollView {
                    VStack(spacing: 2) {
                        ForEach(library.playlists) { item in
                            sidebarRow(item.name, icon: "list.bullet", count: item.trackIDs.count, selected: selectedPlaylist == item.id) {
                                selectedPlaylist = item.id; selectedGroup = nil; section = .tracks; sort = .playlist; showDownloads = false; showExplore = false
                            }.contextMenu {
                                Button("Rename…") { library.renamePlaylist(item) }
                                Button("Duplicate playlist") { library.duplicatePlaylist(item) }
                                Divider()
                                Button("Delete playlist…", role: .destructive) { library.requestDeletePlaylist(item) }
                            }
                        }
                    }
                }.frame(maxHeight: 180).padding(.bottom, 12)
            }
            Hairline()
            VStack(alignment: .leading, spacing: 9) {
                label("Library").padding(.bottom, 3)
                stat("\(library.tracks.count) tracks")
                stat("\(albums.count) albums")
                stat("\(artists.count) artists")
                stat(library.root.lastPathComponent)
            }.padding(.horizontal, 20).padding(.vertical, 18)
        }.frame(width: 244).background(Theme.surface)
    }

    private func sidebarRow(_ title: String, icon: String, count: Int?, selected: Bool, indent: CGFloat = 0, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "chevron.right").font(.system(size: 8)).foregroundStyle(Theme.faint)
                Image(systemName: icon).font(.system(size: 12, weight: .light)).foregroundStyle(Theme.muted)
                Text(title).font(.system(size: 13, weight: selected ? .medium : .regular)).lineLimit(1)
                Spacer()
                if let count { Text("\(count)").font(.system(size: 10, design: .monospaced)).foregroundStyle(Theme.faint) }
            }.foregroundStyle(Theme.secondary).padding(.vertical, 7).padding(.horizontal, 9).padding(.leading, indent)
                .background(selected ? Theme.paper3 : .clear)
                .overlay(alignment: .leading) { if selected { Rectangle().fill(Theme.ink).frame(width: 2) } }
        }.buttonStyle(ActionButtonStyle()).padding(.horizontal, 10)
    }

    private func stat(_ text: String) -> some View {
        HStack(spacing: 10) { Text("—").foregroundStyle(Theme.faint); Text(text).foregroundStyle(Theme.secondary).lineLimit(1) }.font(.system(size: 12))
    }

    private var filterbar: some View {
        HStack(spacing: 2) {
            ForEach(LibrarySection.allCases) { item in
                Button {
                    section = item; selectedGroup = nil; selectedPlaylist = nil; showDownloads = false; showExplore = false; if sort == .playlist { sort = .album }
                } label: {
                    HStack(spacing: 7) {
                        if item == section && !showDownloads { Circle().fill(Theme.ink).frame(width: 4, height: 4) }
                        Text(item.rawValue).font(.system(size: 10.5, design: .monospaced)).tracking(1.6)
                        Text("\(count(item))").font(.system(size: 9.5, design: .monospaced)).foregroundStyle(Theme.faint)
                    }.foregroundStyle(item == section && !showDownloads ? Theme.ink : Theme.muted)
                        .padding(.horizontal, showQueue || showNowPlaying ? 10 : 18).padding(.top, 7).padding(.bottom, 8)
                        .overlay(alignment: .bottom) { if item == section && !showDownloads { Rectangle().fill(Theme.ink).frame(height: 1).padding(.horizontal, 18).padding(.bottom, 2) } }
                }.buttonStyle(ActionButtonStyle())
            }
        }.padding(4).overlay(Capsule().stroke(Theme.rule)).padding(.top, 16).padding(.bottom, 2)
            .frame(maxWidth: .infinity)
    }

    private var toolbar: some View {
        ViewThatFits(in: .horizontal) {
            fullToolbar
            HStack(spacing: 12) {
                Text(showDownloads ? "DOWNLOADS" : currentTitle.uppercased())
                    .font(.system(size: 10.5, design: .monospaced)).tracking(1.4).lineLimit(1)
                Spacer(minLength: 0)
                if !showDownloads {
                    Menu {
                        ForEach(TrackSort.allCases.filter { $0 != .playlist || playlist != nil }, id: \.self) { item in
                            Button(item.rawValue) { sort = item }
                        }
                    } label: { label(sort.rawValue) }.menuStyle(.borderlessButton).actionCursor().fixedSize()
                    searchField(compact: true)
                }
            }
        }.padding(.horizontal, 24).padding(.vertical, 14)
    }

    private var fullToolbar: some View {
        HStack(spacing: 18) {
            Button { resetBrowse() } label: { label("Library") }.buttonStyle(ActionButtonStyle())
            Text("/").font(.system(size: 10)).foregroundStyle(Theme.faint)
            Text(showDownloads ? "DOWNLOADS" : currentTitle.uppercased()).font(.system(size: 10.5, design: .monospaced)).tracking(1.4).lineLimit(1)
            Spacer(minLength: 4)
            if !showDownloads {
                HStack(spacing: 0) {
                    ForEach(Array(TrackSort.allCases.filter { $0 != .playlist || playlist != nil }.enumerated()), id: \.element) { index, item in
                        Button { sort = item } label: {
                            VStack(spacing: 2) {
                                Text(String(format: "%02d", index + 1)).font(.system(size: 8.5, design: .monospaced)).foregroundStyle(Theme.faint)
                                Text(item.rawValue).font(.system(size: 9.5, design: .monospaced)).tracking(1.3)
                            }.padding(.horizontal, 11).padding(.top, 5).padding(.bottom, 6)
                                .foregroundStyle(item == sort ? Color.white : Theme.muted)
                                .background(item == sort ? Theme.ink : Theme.background)
                                .overlay(Rectangle().stroke(Theme.rule, lineWidth: 0.5))
                        }.buttonStyle(ActionButtonStyle())
                    }
                }.clipShape(RoundedRectangle(cornerRadius: 2)).fixedSize()
                searchField(compact: false)
            }
        }
    }

    private func searchField(compact: Bool) -> some View {
        HStack(spacing: 7) {
            Image(systemName: "magnifyingglass").font(.system(size: 12, weight: .light)).foregroundStyle(Theme.faint)
            TextField("SEARCH", text: $search).textFieldStyle(.plain)
                .font(.system(size: compact ? 11 : 11.5, design: .monospaced))
                .focused($searchFocused).accessibilityLabel("Search music")
                .onExitCommand {
                    if search.isEmpty { searchFocused = false } else { search = "" }
                }
            if !search.isEmpty {
                LineIconButton(icon: "xmark", help: "Clear search (Esc)", size: 18) { search = ""; searchFocused = true }
            }
        }.padding(.horizontal, compact ? 8 : 10).frame(width: compact ? 120 : 170, height: 34)
            .overlay(RoundedRectangle(cornerRadius: 2).stroke(searchFocused ? Theme.muted : Theme.rule))
            .help("Search title, artist or album (⌘F)")
    }

    private var collection: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let group = selectedGroup { groupHero(group) }
                else if let playlist { playlistHero(playlist) }
                if filtered.isEmpty { emptyState }
                else if browsingGroups {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 186), spacing: 16)], alignment: .leading, spacing: 20) {
                        ForEach(groups(filtered, byArtist: section == .artists)) { group in
                            GroupCard(group: group, round: section == .artists) { selectedGroup = group }
                        }
                    }
                } else {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(filtered.enumerated()), id: \.element.id) { index, track in
                            TrackRow(track: track, tracks: filtered, index: index + 1, playlist: playlist)
                        }
                    }
                }
            }.padding(.horizontal, 24).padding(.top, 16).padding(.bottom, 40)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            label(search.isEmpty ? (section == .favorites ? "No favorites" : playlist != nil ? "Empty playlist" : "No music yet") : "No matches")
            Rectangle().fill(Theme.rule).frame(width: 28, height: 1).padding(.vertical, 4)
            Text(search.isEmpty ? (playlist != nil ? "Add tracks from their context menu." : section == .favorites ? "Mark a track with a star to find it here." : "Import a music link or add audio files to your library.") : "Try a different title, artist or album.")
                .font(.system(size: 13)).foregroundStyle(Theme.muted).lineSpacing(5).multilineTextAlignment(.center)
            if search.isEmpty && section != .favorites && playlist == nil {
                Button("IMPORT LINK") { library.showImporter = true }.buttonStyle(EditorialButtonStyle()).padding(.top, 10)
            }
        }.frame(maxWidth: 340).padding(.vertical, 84).frame(maxWidth: .infinity)
    }

    private func groupHero(_ group: MusicGroup) -> some View {
        HStack(alignment: .bottom, spacing: 26) {
            ArtworkView(url: group.tracks.compactMap(library.artworkURL).first, seed: group.title)
                .frame(width: 208, height: 208).overlay(Rectangle().stroke(Theme.rule))
            VStack(alignment: .leading, spacing: 10) {
                label(section == .artists ? "Artist" : "Album")
                Text(group.title).font(.system(size: 34, weight: .light)).tracking(-0.7)
                Text(group.subtitle).font(.system(size: 13)).foregroundStyle(Theme.muted)
                label("\(filtered.count) tracks · \(timeLabel(filtered.reduce(0) { $0 + $1.duration }))")
                Button("PLAY ALL") { playAll() }.buttonStyle(EditorialButtonStyle()).padding(.top, 10)
            }
            Spacer()
        }.padding(.bottom, 26).overlay(alignment: .bottom) { Hairline() }.padding(.bottom, 22)
    }

    private func playlistHero(_ playlist: NativePlaylist) -> some View {
        HStack(alignment: .top, spacing: 24) {
            ArtworkView(url: playlist.trackIDs.compactMap { id in library.tracks.first { $0.id == id }.flatMap(library.artworkURL) }.first, seed: playlist.name)
                .frame(width: 120, height: 120).clipShape(RoundedRectangle(cornerRadius: 2))
        VStack(alignment: .leading, spacing: 12) {
            label("Playlist")
            Text(playlist.name).font(.system(size: 34, weight: .light)).tracking(-0.7)
            label("\(filtered.count) tracks · \(timeLabel(filtered.reduce(0) { $0 + $1.duration }))")
            HStack(spacing: 8) {
                Button("PLAY ALL") { playAll() }.buttonStyle(EditorialButtonStyle()).disabled(filtered.isEmpty)
                Button("RENAME") { library.renamePlaylist(playlist) }.buttonStyle(EditorialButtonStyle())
                Button("DUPLICATE") { library.duplicatePlaylist(playlist) }.buttonStyle(EditorialButtonStyle())
                Button("DELETE", role: .destructive) { library.requestDeletePlaylist(playlist) }
                    .buttonStyle(EditorialButtonStyle()).help("Delete playlist; keep its songs")
            }
            Text("Right-click a song to move it or remove it from this playlist.")
                .font(.system(size: 11)).foregroundStyle(Theme.muted)
        }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.bottom, 26).overlay(alignment: .bottom) { Hairline() }.padding(.bottom, 22)
    }

    private func jobline(_ job: ImportJob) -> some View {
        HStack(spacing: 12) {
            label("Import")
            Text(job.message).font(.system(size: 10, design: .monospaced)).foregroundStyle(Theme.muted).lineLimit(1)
            Spacer()
            ChromeButton(title: "CANCEL") { library.cancel(job.id) }
        }.padding(.horizontal, 24).frame(height: 30).background(Theme.surface)
            .overlay(alignment: .top) { Hairline() }
            .overlay(alignment: .bottomLeading) { Rectangle().fill(Theme.ink).frame(height: 1).frame(maxWidth: .infinity, alignment: .leading).scaleEffect(x: job.progress, y: 1, anchor: .leading) }
    }

    private var queuePanel: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                label("Queue"); Spacer()
                if player.current != nil {
                    LineIconButton(icon: "music.note", help: "Show now playing") { showQueue = false; showNowPlaying = true }
                }
                LineIconButton(icon: "xmark", help: "Close queue") { showQueue = false }
            }.padding(20)
            Hairline()
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(Array(player.queue.enumerated()), id: \.element.id) { index, track in
                        Button { player.play(track, in: player.queue, root: library.root) } label: {
                            HStack(spacing: 12) {
                                Text(String(format: "%02d", index + 1)).font(.system(size: 10, design: .monospaced)).foregroundStyle(Theme.faint)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(track.title).font(.system(size: 13)).lineLimit(1)
                                    Text(track.artist).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                                }
                                Spacer(minLength: 0)
                            }.foregroundStyle(Theme.ink).padding(14).background(player.current?.id == track.id ? Theme.paper3 : .clear)
                        }.buttonStyle(ActionButtonStyle())
                        Hairline()
                    }
                }
            }
        }.frame(width: 300).background(Theme.background)
    }

    private func resetBrowse() { if sort == .playlist { sort = .album }; section = .tracks; selectedGroup = nil; selectedPlaylist = nil; showDownloads = false; showExplore = false; search = "" }
    private func playAll() { if let first = filtered.first { player.play(first, in: filtered, root: library.root) } }
    private func count(_ section: LibrarySection) -> Int {
        switch section { case .tracks: library.tracks.count; case .albums: albums.count; case .artists: artists.count; case .favorites: library.tracks.filter(\.isFavorite).count }
    }
    private func groups(_ tracks: [Track], byArtist: Bool) -> [MusicGroup] {
        let grouped = Dictionary(grouping: tracks) { byArtist ? $0.artist : "\($0.artist)\u{0}\($0.album)" }
        return grouped.map { key, tracks in
            MusicGroup(id: key, title: byArtist ? tracks[0].artist : tracks[0].album,
                       subtitle: byArtist ? "\(tracks.count) tracks" : tracks[0].artist, tracks: tracks)
        }.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    }
}

struct ArtworkView: View {
    let url: URL?
    let seed: String
    var body: some View {
        GeometryReader { geometry in
            if let url, let image = ArtworkCache.shared.image(url) {
                Image(nsImage: image).resizable().scaledToFill().frame(width: geometry.size.width, height: geometry.size.height).clipped()
            } else {
                ZStack {
                    Theme.paper3
                    Image(systemName: "opticaldisc").font(.system(size: min(40, max(16, geometry.size.width * 0.14)), weight: .ultraLight)).foregroundStyle(Theme.faint)
                }
            }
        }.accessibilityLabel("Cover for \(seed)")
    }
}

final class ArtworkCache {
    static let shared = ArtworkCache()
    private let cache = NSCache<NSURL, NSImage>()
    private init() { cache.countLimit = 200 }
    func image(_ url: URL) -> NSImage? {
        if let image = cache.object(forKey: url as NSURL) { return image }
        guard let image = NSImage(contentsOf: url) else { return nil }
        cache.setObject(image, forKey: url as NSURL)
        return image
    }
}

struct GroupCard: View {
    @EnvironmentObject private var library: LibraryStore
    let group: MusicGroup
    var round: Bool
    var action: () -> Void
    @ViewState<Bool> private var hovering = false
    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 0) {
                ArtworkView(url: group.tracks.compactMap(library.artworkURL).first, seed: group.title).aspectRatio(1, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: round ? 999 : 2))
                    .overlay(RoundedRectangle(cornerRadius: round ? 999 : 2).stroke(hovering ? Theme.ink : Theme.rule))
                    .overlay(alignment: .bottomTrailing) {
                        if hovering { Image(systemName: "arrow.right").font(.system(size: 13, weight: .light)).frame(width: 32, height: 32).background(Theme.background, in: Circle()).overlay(Circle().stroke(Theme.ink)).padding(9) }
                    }
                Text(group.title).font(.system(size: 13, weight: .medium)).lineLimit(1).padding(.top, 10).padding(.horizontal, 2)
                Text(group.subtitle.uppercased()).font(.system(size: 9.5, design: .monospaced)).tracking(1.2).foregroundStyle(Theme.faint).lineLimit(1).padding(.top, 3).padding(.horizontal, 2)
            }.foregroundStyle(Theme.ink)
        }.buttonStyle(ActionButtonStyle()).onHover { hovering = $0 }
    }
}

struct TrackRow: View {
    @EnvironmentObject private var library: LibraryStore
    @EnvironmentObject private var player: MusicPlayer
    let track: Track
    let tracks: [Track]
    var index = 1
    var playlist: NativePlaylist? = nil
    @ViewState<Bool> private var hovering = false
    var body: some View {
        HStack(spacing: 14) {
            Button { player.play(track, in: tracks, root: library.root) } label: {
                HStack(spacing: 14) {
                    Group {
                        if player.current?.id == track.id { Image(systemName: "waveform").font(.system(size: 11, weight: .light)) }
                        else if hovering { Image(systemName: "play").font(.system(size: 10, weight: .light)) }
                        else { Text(String(format: "%02d", index)).font(.system(size: 10, design: .monospaced)).foregroundStyle(Theme.faint) }
                    }.frame(width: 30, alignment: .trailing)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(track.title).font(.system(size: 13.5, weight: player.current?.id == track.id ? .medium : .regular)).foregroundStyle(Theme.ink).lineLimit(1)
                        Text(track.artist).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    Text(track.album).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1).frame(minWidth: 60, idealWidth: 160, maxWidth: 160, alignment: .leading)
                    Text(timeLabel(track.duration)).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.muted).frame(width: 50, alignment: .trailing)
                }.contentShape(Rectangle()).foregroundStyle(Theme.ink)
            }.buttonStyle(ActionButtonStyle()).help("\(track.title)\n\(track.artist) · \(track.album)")
            Button { library.toggleFavorite(track) } label: {
                Image(systemName: track.isFavorite ? "star.fill" : "star").font(.system(size: 12, weight: .light))
                    .foregroundStyle(track.isFavorite ? Theme.accent : Theme.faint).opacity(track.isFavorite || hovering ? 1 : 0)
                    .frame(width: 26, height: 26)
            }.buttonStyle(ActionButtonStyle()).help("Favourite")
            Menu {
                TrackMenu(track: track, tracks: tracks, playlist: playlist)
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 12)).foregroundStyle(Theme.muted)
                    .frame(width: 26, height: 26)
            }.menuStyle(.borderlessButton).menuIndicator(.hidden)
                .frame(width: 26, height: 26).help("Song actions").accessibilityLabel("Actions for \(track.title)")
        }.padding(.horizontal, 10).padding(.vertical, 7)
            .background(player.current?.id == track.id ? Theme.paper3 : hovering ? Theme.surface : .clear)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.ruleSoft).frame(height: 1) }
            .overlay(alignment: .leading) { if player.current?.id == track.id { Rectangle().fill(Theme.ink).frame(width: 2) } }
            .onHover { hovering = $0 }.contextMenu { TrackMenu(track: track, tracks: tracks, playlist: playlist) }
    }
}

struct TrackMenu: View {
    @EnvironmentObject private var library: LibraryStore
    @EnvironmentObject private var player: MusicPlayer
    let track: Track
    let tracks: [Track]
    var playlist: NativePlaylist? = nil
    var body: some View {
        Button("Play") { player.play(track, in: tracks, root: library.root) }
        Button(track.isFavorite ? "Remove from favorites" : "Add to favorites") { library.toggleFavorite(track) }
        if !library.playlists.isEmpty {
            Menu("Add to playlist") { ForEach(library.playlists) { playlist in Button(playlist.name) { library.add(track, to: playlist) } } }
        }
        if let playlist, let position = playlist.trackIDs.firstIndex(of: track.id) {
            Divider()
            Button("Move up in playlist") { library.move(track, in: playlist, by: -1) }.disabled(position == 0)
            Button("Move down in playlist") { library.move(track, in: playlist, by: 1) }.disabled(position == playlist.trackIDs.count - 1)
            Button("Remove from this playlist") { library.remove(track, from: playlist) }
            Divider()
        }
        Button("Show in Finder") { library.reveal(track) }
        if let source = track.sourceURL, let url = URL(string: source) { Button("Open original link") { NSWorkspace.shared.open(url) } }
        Divider()
        Button("Remove from library (keep file)") { library.removeFromLibrary(track) }
        Button("Delete song (move to Trash)", role: .destructive) { library.deleteSong(track) }
    }
}
