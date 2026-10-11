import SwiftUI
import AppKit

struct ExploreView: View {
    @EnvironmentObject private var library: LibraryStore
    @ObservedObject var model: ExploreModel
    @FocusState private var searchFocused: Bool

    private var downloadable: [ExploreResult] {
        model.results.filter { result in
            library.existingTrack(for: result.url) == nil &&
            ![.queued, .downloading].contains(library.job(for: result.url)?.state)
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                if !library.toolsAvailable { toolsNotice }
                else if model.isSearching { status("Searching YouTube for “\(model.lastQuery ?? "")”…", spinner: true) }
                else if let error = model.error { status(error) }
                else if let query = model.lastQuery {
                    if model.results.isEmpty { status("No songs found for “\(query)”. Try other words.") }
                    else { results(query) }
                } else { status("Search for a song, artist or album, or pick a genre to start exploring.") }
            }.padding(.horizontal, 24).padding(.top, 22).padding(.bottom, 40)
        }
        .onAppear { if model.lastQuery == nil { searchFocused = true } }
        .onReceive(NotificationCenter.default.publisher(for: .meloraFocusSearch)) { _ in
            DispatchQueue.main.async { searchFocused = true }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            label("Explore")
            Text("Find new music").font(.system(size: 34, weight: .light)).tracking(-0.7)
            HStack(spacing: 10) {
                HStack(spacing: 7) {
                    Image(systemName: "magnifyingglass").font(.system(size: 12, weight: .light)).foregroundStyle(Theme.faint)
                    TextField("SEARCH SONGS, ARTISTS OR ALBUMS", text: $model.query).textFieldStyle(.plain)
                        .font(.system(size: 12, design: .monospaced))
                        .focused($searchFocused).accessibilityLabel("Search for new music")
                        .onSubmit { model.search() }
                        .onExitCommand { if model.query.isEmpty { searchFocused = false } else { model.query = "" } }
                    if !model.query.isEmpty {
                        LineIconButton(icon: "xmark", help: "Clear search (Esc)", size: 18) { model.clear(); searchFocused = true }
                    }
                }.padding(.horizontal, 10).frame(maxWidth: 420).frame(height: 36)
                    .overlay(RoundedRectangle(cornerRadius: 2).stroke(searchFocused ? Theme.muted : Theme.rule))
                Button("SEARCH") { model.search() }.buttonStyle(EditorialButtonStyle(primary: true))
                    .disabled(model.query.trimmingCharacters(in: .whitespaces).isEmpty || !library.toolsAvailable)
            }
            FlowLayout(spacing: 6) {
                ForEach(ExploreCategory.all) { category in
                    let selected = model.lastQuery == category.query
                    Button { model.search(category.query) } label: {
                        Text(category.title.uppercased()).font(.system(size: 9.5, design: .monospaced)).tracking(1.3)
                            .padding(.horizontal, 11).padding(.vertical, 6)
                            .foregroundStyle(selected ? Color.white : Theme.secondary)
                            .background(selected ? Theme.ink : Theme.background, in: Capsule())
                            .overlay(Capsule().stroke(selected ? Theme.ink : Theme.rule))
                    }.buttonStyle(ActionButtonStyle()).disabled(!library.toolsAvailable)
                }
            }
        }.padding(.bottom, 24).overlay(alignment: .bottom) { Hairline() }.padding(.bottom, 18)
    }

    private func results(_ query: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                label("\(model.results.count) results · \(query)")
                Spacer()
                Button("DOWNLOAD ALL \(downloadable.count)") {
                    do { try library.enqueue(downloadable.map(\.url.absoluteString).joined(separator: "\n")) }
                    catch { library.error = error.localizedDescription }
                }.buttonStyle(EditorialButtonStyle()).disabled(downloadable.isEmpty)
            }.padding(.bottom, 12)
            LazyVStack(spacing: 0) {
                ForEach(Array(model.results.enumerated()), id: \.element.id) { index, result in
                    ExploreRow(result: result, index: index + 1)
                }
            }
            Text("Results come from YouTube. Only download music you have permission to keep.")
                .font(.system(size: 11)).foregroundStyle(Theme.muted).padding(.top, 16)
        }
    }

    private var toolsNotice: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Exploring searches YouTube with yt-dlp, and downloads also need FFmpeg.")
                .font(.system(size: 13)).foregroundStyle(Theme.muted)
            Button("OPEN SETTINGS") { library.showSettings = true }.buttonStyle(EditorialButtonStyle())
        }.padding(.vertical, 30)
    }

    private func status(_ text: String, spinner: Bool = false) -> some View {
        HStack(spacing: 10) {
            if spinner { ProgressView().controlSize(.small) }
            Text(text).font(.system(size: 13)).foregroundStyle(Theme.muted).lineSpacing(4)
        }.padding(.vertical, 30)
    }
}

struct ExploreRow: View {
    @EnvironmentObject private var library: LibraryStore
    @EnvironmentObject private var player: MusicPlayer
    let result: ExploreResult
    let index: Int
    @ViewState<Bool> private var hovering = false

    var body: some View {
        let track = library.existingTrack(for: result.url)
        HStack(spacing: 14) {
            Text(String(format: "%02d", index)).font(.system(size: 10, design: .monospaced)).foregroundStyle(Theme.faint)
                .frame(width: 24, alignment: .trailing)
            AsyncImage(url: result.thumbnail) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                ZStack { Theme.paper3; Image(systemName: "music.note").font(.system(size: 12, weight: .ultraLight)).foregroundStyle(Theme.faint) }
            }.frame(width: 80, height: 45).clipShape(RoundedRectangle(cornerRadius: 2)).overlay(RoundedRectangle(cornerRadius: 2).stroke(Theme.ruleSoft))
            VStack(alignment: .leading, spacing: 3) {
                Text(result.title).font(.system(size: 13.5)).foregroundStyle(Theme.ink).lineLimit(1)
                Text([result.channel, result.views.map(ExploreService.viewLabel)].compactMap { $0 }.joined(separator: " · "))
                    .font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
            }.frame(maxWidth: .infinity, alignment: .leading)
            Text(result.duration.map(timeLabel) ?? "—").font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.muted)
                .frame(width: 50, alignment: .trailing)
            action(track).frame(width: 112, alignment: .trailing)
            Menu {
                if let track { Button("Play") { player.play(track, in: [track], root: library.root) } }
                Button("Open on YouTube") { NSWorkspace.shared.open(result.url) }
                Button("Copy link") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(result.url.absoluteString, forType: .string)
                }
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 12)).foregroundStyle(Theme.muted).frame(width: 26, height: 26)
            }.menuStyle(.borderlessButton).menuIndicator(.hidden).frame(width: 26, height: 26)
                .help("More actions").accessibilityLabel("More actions for \(result.title)")
        }.padding(.horizontal, 10).padding(.vertical, 8)
            .background(hovering ? Theme.surface : .clear)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.ruleSoft).frame(height: 1) }
            .onHover { hovering = $0 }
            .help("\(result.title)\n\(result.channel)")
    }

    @ViewBuilder private func action(_ track: Track?) -> some View {
        if let track {
            Button(player.current?.id == track.id ? "PLAYING" : "PLAY") { player.play(track, in: [track], root: library.root) }
                .buttonStyle(EditorialButtonStyle()).help("Already in your library")
        } else if let job = library.job(for: result.url), job.state == .queued || job.state == .downloading {
            label(job.state == .queued ? "Queued" : "\(Int(job.progress * 100))%")
                .help(job.message)
        } else if let job = library.job(for: result.url), job.state == .failed {
            Button("RETRY") { library.retry(job.id) }.buttonStyle(EditorialButtonStyle()).help(job.message)
        } else {
            Button("DOWNLOAD") {
                do { try library.enqueue(result.url.absoluteString) }
                catch { library.error = error.localizedDescription }
            }.buttonStyle(EditorialButtonStyle(primary: true)).help("Add this song to your library")
        }
    }
}

// Wraps chips onto new lines instead of clipping them in narrow windows.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(subviews, width: proposal.width ?? .infinity)
        return CGSize(width: rows.map(\.width).max() ?? 0, height: rows.last.map { $0.y + $0.height } ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for row in arrange(subviews, width: bounds.width) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: bounds.minY + row.y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
        }
    }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> [(indices: [Int], y: CGFloat, width: CGFloat, height: CGFloat)] {
        var rows: [(indices: [Int], y: CGFloat, width: CGFloat, height: CGFloat)] = []
        var current: [Int] = []
        var x: CGFloat = 0, y: CGFloat = 0, height: CGFloat = 0
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            if !current.isEmpty && x + size.width > width {
                rows.append((current, y, x - spacing, height))
                y += height + spacing
                current = []; x = 0; height = 0
            }
            current.append(index)
            x += size.width + spacing
            height = max(height, size.height)
        }
        if !current.isEmpty { rows.append((current, y, x - spacing, height)) }
        return rows
    }
}
