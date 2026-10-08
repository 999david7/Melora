import SwiftUI

struct SleepTimerOptions: View {
    @EnvironmentObject private var player: MusicPlayer

    var body: some View {
        ForEach([15, 30, 45, 60, 90], id: \.self) { minutes in
            Button("Pause in \(minutes) minutes") { player.setSleepTimer(seconds: Double(minutes * 60)) }
        }
        Button("At the end of this song") { player.sleepAtEndOfTrack() }.disabled(player.current == nil)
        if player.sleepDeadline != nil || player.sleepAfterTrack {
            Divider()
            Button("Cancel sleep timer") { player.cancelSleepTimer() }
        }
    }
}

struct SleepTimerControl: View {
    @EnvironmentObject private var player: MusicPlayer

    var body: some View {
        Menu {
            SleepTimerOptions()
        } label: {
            Image(systemName: player.sleepDeadline != nil || player.sleepAfterTrack ? "moon.fill" : "moon")
                .font(.system(size: 12, weight: .light))
                .foregroundStyle(player.sleepDeadline != nil || player.sleepAfterTrack ? Theme.ink : Theme.muted)
                .frame(width: 22, height: 26).contentShape(Rectangle())
        }.menuStyle(.borderlessButton).fixedSize().actionCursor()
            .help("Sleep timer").accessibilityLabel("Sleep timer")
    }
}

struct SleepTimerStatus: View {
    @EnvironmentObject private var player: MusicPlayer

    var body: some View {
        if let deadline = player.sleepDeadline {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                label("Sleep in \(timeLabel(max(0, deadline.timeIntervalSince(context.date))))")
            }
        } else if player.sleepAfterTrack {
            label("Sleep after this song")
        }
    }
}
