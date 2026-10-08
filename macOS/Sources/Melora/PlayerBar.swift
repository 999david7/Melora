import SwiftUI

struct PlayerBar: View {
    @EnvironmentObject private var library: LibraryStore
    @EnvironmentObject private var player: MusicPlayer
    @Binding var showQueue: Bool
    @Binding var showNowPlaying: Bool

    var body: some View {
        HStack(spacing: 24) {
            HStack(spacing: 12) {
                Button { showNowPlaying.toggle(); showQueue = false } label: {
                    ArtworkView(url: player.current.flatMap(library.artworkURL), seed: player.current?.title ?? "Melora")
                        .frame(width: 44, height: 44).overlay(Rectangle().stroke(Theme.rule))
                }.buttonStyle(ActionButtonStyle()).help("Show now playing")
                VStack(alignment: .leading, spacing: 4) {
                    Text(player.current?.title ?? "Nothing playing").font(.system(size: 12.5, weight: .medium)).lineLimit(1)
                    Text(player.current?.artist ?? "").font(.system(size: 11.5)).foregroundStyle(Theme.muted).lineLimit(1)
                }.frame(maxWidth: .infinity, alignment: .leading)
                if let current = player.current, let track = library.tracks.first(where: { $0.id == current.id }) {
                    Button { library.toggleFavorite(track) } label: {
                        Image(systemName: track.isFavorite ? "star.fill" : "star").font(.system(size: 13, weight: .light))
                            .foregroundStyle(track.isFavorite ? Theme.accent : Theme.faint).frame(width: 22, height: 22)
                    }.buttonStyle(ActionButtonStyle()).help("Favourite")
                }
            }.frame(width: 280)
            VStack(spacing: 5) {
                HStack(spacing: 8) {
                    LineIconButton(icon: "shuffle", help: "Shuffle", active: player.shuffle, size: 22) { player.shuffle.toggle() }
                    LineIconButton(icon: "backward.end", help: "Previous", size: 30) { player.previous() }
                    Button { player.toggle() } label: {
                        Image(systemName: player.isPlaying ? "pause" : "play").font(.system(size: 15, weight: .light))
                            .foregroundStyle(Theme.ink).frame(width: 34, height: 30)
                            .overlay(RoundedRectangle(cornerRadius: 2).stroke(Theme.ink))
                    }.buttonStyle(ActionButtonStyle()).disabled(player.current == nil).help("Play / pause (⌘P)")
                    LineIconButton(icon: "forward.end", help: "Next", size: 30) { player.next() }
                    LineIconButton(icon: player.repeatMode == .one ? "repeat.1" : "repeat", help: "Repeat: \(player.repeatMode.rawValue)", active: player.repeatMode != .off, size: 22) { player.cycleRepeat() }
                }
                PlaybackProgressView()
            }.frame(maxWidth: .infinity)
            HStack(spacing: 8) {
                LineIconButton(icon: "list.bullet", help: "Play queue", active: showQueue) { showQueue.toggle() }
                SleepTimerControl()
                LineIconButton(icon: player.volume == 0 ? "speaker.slash" : "speaker.wave.2", help: "Mute / unmute (⌘⇧M)", size: 22) { player.toggleMute() }
                Slider(value: $player.volume, in: 0...1).frame(width: 82).controlSize(.mini).tint(Theme.ink).accessibilityLabel("Volume").actionCursor()
            }.frame(width: 190)
        }.padding(.horizontal, 22).frame(height: 72).foregroundStyle(Theme.ink).background(Theme.background)
    }
}
