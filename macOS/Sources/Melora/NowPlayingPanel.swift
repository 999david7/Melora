import SwiftUI

struct NowPlayingPanel: View {
    @EnvironmentObject private var library: LibraryStore
    @EnvironmentObject private var player: MusicPlayer
    @Binding var isPresented: Bool
    var openQueue: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                label("Now playing")
                Spacer()
                LineIconButton(icon: "list.bullet", help: "Show queue") { openQueue() }
                LineIconButton(icon: "xmark", help: "Close now playing") { isPresented = false }
            }.padding(.horizontal, 20).padding(.vertical, 14)
            Hairline()
            ScrollView {
                if let track = player.current {
                    VStack(alignment: .leading, spacing: 20) {
                        ArtworkView(url: library.artworkURL(track), seed: track.title)
                            .aspectRatio(1, contentMode: .fit)
                            .overlay(RoundedRectangle(cornerRadius: 2).stroke(Theme.rule))
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(alignment: .top, spacing: 12) {
                                Text(track.title).font(.system(size: 24, weight: .light)).tracking(-0.4)
                                    .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                                if let saved = library.tracks.first(where: { $0.id == track.id }) {
                                    Button { library.toggleFavorite(saved) } label: {
                                        Image(systemName: saved.isFavorite ? "star.fill" : "star")
                                            .font(.system(size: 14, weight: .light))
                                            .foregroundStyle(saved.isFavorite ? Theme.accent : Theme.faint).frame(width: 24, height: 28)
                                    }.buttonStyle(ActionButtonStyle()).help("Favourite")
                                }
                            }
                            Text(track.artist).font(.system(size: 13)).foregroundStyle(Theme.secondary).textSelection(.enabled)
                            Text(track.album).font(.system(size: 12)).foregroundStyle(Theme.muted).textSelection(.enabled)
                        }
                        Hairline()
                        HStack(spacing: 7) {
                            Circle().fill(player.isPlaying ? Theme.ink : Theme.faint).frame(width: 4, height: 4)
                            label(player.isPlaying ? "Playing" : "Paused")
                        }
                        SleepTimerStatus()
                        PlaybackProgressView(stacked: true, accessibilityName: "Now playing position")
                        HStack(spacing: 14) {
                            Spacer()
                            LineIconButton(icon: "backward.end", help: "Previous track", size: 30) { player.previous() }
                            Button { player.toggle() } label: {
                                Image(systemName: player.isPlaying ? "pause" : "play").font(.system(size: 17, weight: .light))
                                    .frame(width: 42, height: 38).overlay(RoundedRectangle(cornerRadius: 2).stroke(Theme.ink))
                            }.buttonStyle(ActionButtonStyle()).help("Play / pause")
                            LineIconButton(icon: "forward.end", help: "Next track", size: 30) { player.next() }
                            Spacer()
                        }
                        Hairline()
                        Button("SHOW IN FINDER") { library.reveal(track) }.buttonStyle(EditorialButtonStyle())
                    }.padding(20)
                }
            }
        }.frame(width: 320).frame(maxHeight: .infinity)
            .foregroundStyle(Theme.ink).background(Theme.background)
    }
}

// Both player surfaces use the same playback clock and seek behaviour.
struct PlaybackProgressView: View {
    @EnvironmentObject private var player: MusicPlayer
    var stacked = false
    var accessibilityName = "Playback position"
    @ViewState<Bool> private var scrubbing = false
    @ViewState<Double> private var seekValue = 0

    private var currentPosition: Double { scrubbing ? seekValue : player.elapsed }
    private var slider: some View {
        Slider(value: Binding(get: {
            min(currentPosition, max(1, player.duration))
        }, set: { value in
            seekValue = value
            scrubbing = true
        }), in: 0...max(1, player.duration)) { editing in
            if editing {
                if !scrubbing { seekValue = player.elapsed; scrubbing = true }
            } else {
                player.seek(seekValue)
                scrubbing = false
            }
        }.controlSize(.mini).tint(Theme.ink).actionCursor()
            .disabled(player.current == nil || player.duration <= 0)
            .accessibilityLabel(accessibilityName)
    }

    var body: some View {
        Group {
            if stacked {
                VStack(spacing: 8) {
                    slider
                    HStack {
                        Text(timeLabel(currentPosition))
                        Spacer()
                        Text(timeLabel(player.duration))
                    }
                }
            } else {
                HStack(spacing: 10) {
                    Text(timeLabel(currentPosition)).frame(width: 35, alignment: .trailing)
                    slider
                    Text(timeLabel(player.duration)).frame(width: 35, alignment: .leading)
                }
            }
        }.font(.system(size: stacked ? 10 : 9, design: .monospaced)).foregroundStyle(Theme.muted)
            .onChange(of: player.current?.id) { _, _ in scrubbing = false; seekValue = 0 }
    }
}
