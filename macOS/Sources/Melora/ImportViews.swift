import SwiftUI
import AppKit

struct ImportSheet: View {
    @EnvironmentObject private var library: LibraryStore
    @Environment(\.dismiss) private var dismiss
    @ViewState<String> private var links = ""
    @ViewState<String?> private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack { label("Import music"); Spacer(); LineIconButton(icon: "xmark", help: "Close") { dismiss() } }.padding(.horizontal, 24).padding(.vertical, 12)
            Hairline()
            VStack(alignment: .leading, spacing: 18) {
                Text("Add from a link").font(.system(size: 34, weight: .light)).tracking(-0.7)
                Text("Paste a Spotify track, album or playlist, a YouTube playlist, a music video, or a direct audio download. One link per line.")
                    .font(.system(size: 13)).foregroundStyle(Theme.secondary).lineSpacing(5).fixedSize(horizontal: false, vertical: true)
                VStack(alignment: .leading, spacing: 7) {
                    label("Music links")
                    TextEditor(text: $links).font(.system(size: 12, design: .monospaced)).scrollContentBackground(.hidden)
                        .padding(9).frame(height: 120).background(Theme.background)
                        .overlay(RoundedRectangle(cornerRadius: 2).stroke(focused ? Theme.ink : Theme.rule))
                        .focused($focused).accessibilityLabel("Music links, one per line")
                }
                if links.split(whereSeparator: \.isNewline).contains(where: { line in
                    guard let url = try? ImportURL.parse(String(line)) else { return false }
                    return ImportURL.youtubePlaylistURL(url) != nil
                }) {
                    Text("The full YouTube playlist will become a local playlist with the same name and track order. Existing downloads are reused.")
                        .font(.system(size: 12.5)).foregroundStyle(Theme.secondary).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
                }
                if links.split(whereSeparator: \.isNewline).contains(where: { line in
                    guard let url = try? ImportURL.parse(String(line)) else { return false }
                    return ImportURL.spotifyURL(url) != nil
                }) {
                    Text("Spotify supplies titles, tags and cover art. Audio is matched from YouTube and may differ from the Spotify recording. Public playlists and albums become local playlists.")
                        .font(.system(size: 12.5)).foregroundStyle(Theme.secondary).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
                    if !library.spotifyToolsAvailable {
                        Button("SET UP SPOTIFY LINKS") { dismiss(); library.showSettings = true }.buttonStyle(EditorialButtonStyle())
                    }
                }
                if !library.toolsAvailable {
                    VStack(alignment: .leading, spacing: 9) {
                        Hairline().padding(.bottom, 8)
                        label("Video download tools")
                        Text("Video links need yt-dlp and FFmpeg. Direct audio links already work.")
                            .font(.system(size: 12.5)).foregroundStyle(Theme.secondary)
                        Button("OPEN SETTINGS") { dismiss(); library.showSettings = true }.buttonStyle(EditorialButtonStyle())
                    }
                }
                if let error { Text(error).font(.system(size: 12.5)).foregroundStyle(Theme.danger) }
                HStack(spacing: 12) {
                    Button {
                        do { try library.enqueue(links); dismiss() }
                        catch { self.error = error.localizedDescription }
                    } label: {
                        HStack(spacing: 35) { Text("IMPORT MUSIC"); Image(systemName: "arrow.right").font(.system(size: 14, weight: .light)) }
                    }.buttonStyle(EditorialButtonStyle(primary: true)).disabled(links.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).keyboardShortcut(.defaultAction)
                    ChromeButton(title: "Cancel") { dismiss() }
                }.padding(.top, 4)
                Text("Audio and artwork are saved in your library. Import downloadable, unprotected media you have permission to keep.")
                    .font(.system(size: 11.5)).foregroundStyle(Theme.faint).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
            }.padding(24)
        }.frame(width: 540).foregroundStyle(Theme.ink).background(Theme.background)
            .onAppear { library.refreshTools(); focused = true }
    }
}

struct DownloadList: View {
    @EnvironmentObject private var library: LibraryStore
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .bottom) {
                    VStack(alignment: .leading, spacing: 10) {
                        label("Imports")
                        Text("Downloads").font(.system(size: 34, weight: .light)).tracking(-0.7)
                    }
                    Spacer()
                    Button("CLEAR COMPLETED") { library.clearFinishedJobs() }.buttonStyle(EditorialButtonStyle()).disabled(library.isBusy)
                }
                Hairline()
                if library.jobs.isEmpty {
                    VStack(spacing: 10) {
                        label("No downloads")
                        Rectangle().fill(Theme.rule).frame(width: 28, height: 1).padding(.vertical, 4)
                        Text("Import a link to download audio and cover art.").font(.system(size: 13)).foregroundStyle(Theme.muted)
                        Button("IMPORT LINK") { library.showImporter = true }.buttonStyle(EditorialButtonStyle()).padding(.top, 10)
                    }.frame(maxWidth: .infinity).padding(.vertical, 84)
                }
                ForEach(library.jobs) { job in
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 10) {
                            Image(systemName: job.state == .completed ? "checkmark" : job.state == .failed ? "exclamationmark.triangle" : "arrow.down.to.line")
                                .font(.system(size: 13, weight: .light)).foregroundStyle(job.state == .failed ? Theme.danger : Theme.muted)
                            Text(job.playlistName ?? (ImportURL.youtubePlaylistURL(job.url) != nil ? "YouTube playlist" : job.url.host ?? "Music link")).font(.system(size: 13, weight: .medium))
                            Spacer()
                            if job.state == .queued || job.state == .downloading {
                                ChromeButton(title: "Cancel") { library.cancel(job.id) }
                            } else if job.state == .failed || job.state == .cancelled {
                                Button("RETRY") { library.retry(job.id) }.buttonStyle(EditorialButtonStyle())
                            }
                        }
                        Text(job.url.absoluteString).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.faint).lineLimit(1).textSelection(.enabled)
                        if job.state == .downloading { ProgressView(value: job.progress).tint(Theme.ink) }
                        Text(job.message).font(.system(size: 12.5)).foregroundStyle(job.state == .failed ? Theme.danger : Theme.muted).textSelection(.enabled)
                        if !job.failures.isEmpty {
                            DisclosureGroup("\(job.failures.count) unavailable or failed tracks") {
                                VStack(alignment: .leading, spacing: 10) {
                                    ForEach(job.failures) { failure in
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text("\(failure.id). \(failure.title)").font(.system(size: 12.5, weight: .medium))
                                            Text(failure.message).font(.system(size: 11.5)).foregroundStyle(Theme.muted).textSelection(.enabled)
                                        }
                                    }
                                }.padding(.top, 8)
                            }.font(.system(size: 12)).tint(Theme.ink)
                        }
                        Hairline().padding(.top, 10)
                    }
                }
            }.padding(.horizontal, 24).padding(.top, 16).padding(.bottom, 40)
        }.foregroundStyle(Theme.ink)
    }
}

struct SettingsSheet: View {
    @EnvironmentObject private var library: LibraryStore
    @EnvironmentObject private var player: MusicPlayer
    @EnvironmentObject private var updates: AppUpdates
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack { label("Settings"); Spacer(); LineIconButton(icon: "xmark", help: "Close settings") { dismiss() } }.padding(.horizontal, 24).padding(.vertical, 12)
            Hairline()
            ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Text("Your library").font(.system(size: 34, weight: .light)).tracking(-0.7)
                VStack(alignment: .leading, spacing: 12) {
                    label("Location")
                    Text(library.root.path).font(.system(size: 11.5, design: .monospaced)).textSelection(.enabled).lineLimit(3)
                    Text("Music, artwork and the index live together here. Choose a folder on this Mac or an external drive. Changing the folder opens a separate library.")
                        .font(.system(size: 13)).foregroundStyle(Theme.secondary).lineSpacing(5).fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 10) {
                        Button("CHOOSE FOLDER") { library.chooseLibrary { player.stop() } }.buttonStyle(EditorialButtonStyle()).disabled(library.isBusy)
                        Button("SHOW IN FINDER") { NSWorkspace.shared.open(library.root) }.buttonStyle(EditorialButtonStyle())
                    }
                }
                Hairline()
                VStack(alignment: .leading, spacing: 12) {
                    label("Video download tools")
                    HStack(spacing: 9) {
                        Image(systemName: library.toolsAvailable ? "checkmark" : "arrow.down.to.line").font(.system(size: 13, weight: .light))
                        Text(library.toolsAvailable ? "yt-dlp and FFmpeg are ready" : "Set up video imports").font(.system(size: 13))
                    }
                    Text("yt-dlp downloads audio and thumbnails from supported sites. FFmpeg converts audio for playback. Direct audio links work without these tools.")
                        .font(.system(size: 13)).foregroundStyle(Theme.secondary).lineSpacing(5).fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Button("INSTALL TOOLS") { library.installTools() }.buttonStyle(EditorialButtonStyle()).disabled(library.isInstalling)
                        Button("CHECK AGAIN") { library.refreshTools() }.buttonStyle(EditorialButtonStyle())
                        if library.isInstalling { ProgressView().controlSize(.small) }
                    }
                    Hairline()
                    label("Spotify links")
                    Text(library.spotifyToolsAvailable ? "Spotify link support is ready" : "Install video tools to match Spotify tracks from YouTube.")
                        .font(.system(size: 13))
                    Text("Matches audio on YouTube and keeps Spotify tags and artwork. Spotify audio itself is not downloaded.")
                        .font(.system(size: 12)).foregroundStyle(Theme.secondary).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
                    Text("Optional full-playlist reader: spotDL can try collections beyond Spotify's public-page limit. Availability depends on Spotify.")
                        .font(.system(size: 11.5)).foregroundStyle(Theme.muted).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
                    Button("INSTALL FULL PLAYLIST READER") { library.installSpotifyTools() }.buttonStyle(EditorialButtonStyle()).disabled(library.isInstalling)
                    if !library.toolsMessage.isEmpty { Text(library.toolsMessage).font(.system(size: 12)).foregroundStyle(Theme.muted).textSelection(.enabled) }
                    Text("brew install yt-dlp ffmpeg deno").font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.muted).textSelection(.enabled)
                    Link("Get Homebrew", destination: URL(string: "https://brew.sh")!).font(.system(size: 12)).foregroundStyle(Theme.secondary).actionCursor()
                }
                Hairline()
                VStack(alignment: .leading, spacing: 12) {
                    label("App updates")
                    Text("Melora \(AppUpdates.version)").font(.system(size: 13))
                    Text(updates.status).font(.system(size: 12)).foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    Button(updates.isBusy ? "CHECKING…" : "CHECK FOR UPDATES") {
                        Task { await updates.check(canInstall: { !library.isBusy }) }
                    }.buttonStyle(EditorialButtonStyle()).disabled(updates.isBusy || library.isBusy)
                    Link("Release notes", destination: AppUpdates.repository).font(.system(size: 12)).actionCursor()
                }
                Hairline()
                Text("Melora for macOS · Local audio and artwork · No account required")
                    .font(.system(size: 11.5)).foregroundStyle(Theme.faint)
            }.padding(24)
            }.frame(height: 550)
        }.frame(width: 560).foregroundStyle(Theme.ink).background(Theme.background).onAppear { library.refreshTools() }
    }
}
