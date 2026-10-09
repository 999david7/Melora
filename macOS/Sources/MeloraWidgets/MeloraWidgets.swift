import AppIntents
import AppKit
import MeloraWidgetShared
import SwiftUI
import WidgetKit

@main
struct MeloraWidgetBundle: WidgetBundle {
    var body: some Widget { NowPlayingWidget() }
}

struct NowPlayingWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: WidgetShared.widgetKind, provider: NowPlayingProvider()) { entry in
            NowPlayingWidgetView(entry: entry)
        }
        .configurationDisplayName("Now Playing")
        .description("The song Melora is playing, with playback controls.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

// MARK: - Timeline

struct NowPlayingEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
    let artwork: NSImage?

    static let placeholder = NowPlayingEntry(
        date: Date(),
        snapshot: WidgetSnapshot(title: "Spirit of Eden", artist: "Talk Talk", album: "Spirit of Eden", duration: 240,
                                 elapsed: 80, isPlaying: true, artworkID: nil,
                                 upNext: [.init(title: "Wealth", artist: "Talk Talk")]),
        artwork: nil)
}

struct NowPlayingProvider: TimelineProvider {
    func placeholder(in context: Context) -> NowPlayingEntry { .placeholder }

    func getSnapshot(in context: Context, completion: @escaping (NowPlayingEntry) -> Void) {
        completion(context.isPreview && WidgetShared.readSnapshot() == nil ? .placeholder : current())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<NowPlayingEntry>) -> Void) {
        let entry = current()
        // The app asks for a reload whenever playback changes. While a song plays,
        // also refresh when it should end, in case the app quit in the meantime.
        if let snapshot = entry.snapshot, snapshot.isLive {
            completion(Timeline(entries: [entry], policy: .after(snapshot.endsAt.addingTimeInterval(2))))
        } else {
            completion(Timeline(entries: [entry], policy: .never))
        }
    }

    private func current() -> NowPlayingEntry {
        let snapshot = WidgetShared.readSnapshot()
        let artwork = snapshot?.artworkID == nil ? nil : NSImage(contentsOf: WidgetShared.artworkURL)
        return NowPlayingEntry(date: Date(), snapshot: snapshot, artwork: artwork)
    }
}

// MARK: - Controls

private func send(_ command: WidgetShared.Command) async {
    DistributedNotificationCenter.default().postNotificationName(command.notification, object: nil, userInfo: nil, deliverImmediately: true)
    // WidgetKit reloads right after perform(); give the app a moment to write
    // the new state first so the button does not flicker back.
    try? await Task.sleep(for: .milliseconds(350))
}

struct TogglePlaybackIntent: AppIntent {
    static let title: LocalizedStringResource = "Play or Pause Melora"
    static let isDiscoverable = false
    func perform() async throws -> some IntentResult { await send(.toggle); return .result() }
}

struct NextTrackIntent: AppIntent {
    static let title: LocalizedStringResource = "Next Track in Melora"
    static let isDiscoverable = false
    func perform() async throws -> some IntentResult { await send(.next); return .result() }
}

struct PreviousTrackIntent: AppIntent {
    static let title: LocalizedStringResource = "Previous Track in Melora"
    static let isDiscoverable = false
    func perform() async throws -> some IntentResult { await send(.previous); return .result() }
}

// MARK: - Views

private enum Palette {
    // Match the app: paper, ink, hairlines.
    static let paper = Color.white
    static let paper3 = Color(red: 0.949, green: 0.949, blue: 0.941)
    static let ink = Color(red: 0.055, green: 0.055, blue: 0.055)
    static let muted = Color(red: 0.545, green: 0.565, blue: 0.592)
    static let faint = Color(red: 0.706, green: 0.722, blue: 0.741)
    static let rule = Color(red: 0.886, green: 0.886, blue: 0.875)
}

private func caption(_ text: String) -> some View {
    Text(text.uppercased()).font(.system(size: 9, design: .monospaced)).tracking(1.4).foregroundStyle(Palette.muted)
}

struct NowPlayingWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: NowPlayingEntry

    var body: some View {
        Group {
            if let snapshot = entry.snapshot, snapshot.appRunning, !snapshot.title.isEmpty {
                switch family {
                case .systemSmall: SmallView(snapshot: snapshot, artwork: entry.artwork, date: entry.date)
                case .systemLarge: LargeView(snapshot: snapshot, artwork: entry.artwork, date: entry.date)
                default: MediumView(snapshot: snapshot, artwork: entry.artwork, date: entry.date)
                }
            } else {
                IdleView(appRunning: entry.snapshot?.appRunning ?? false)
            }
        }
        .foregroundStyle(Palette.ink)
        .containerBackground(for: .widget) { Palette.paper }
    }
}

private struct Artwork: View {
    let image: NSImage?
    var body: some View {
        GeometryReader { geometry in
            if let image {
                Image(nsImage: image).resizable().scaledToFill()
                    .frame(width: geometry.size.width, height: geometry.size.height).clipped()
            } else {
                ZStack {
                    Palette.paper3
                    Image(systemName: "opticaldisc").font(.system(size: max(14, geometry.size.width * 0.3), weight: .ultraLight))
                        .foregroundStyle(Palette.faint)
                }
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 4))
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Palette.rule, lineWidth: 0.5))
    }
}

private struct ControlButton<Intent: AppIntent>: View {
    let intent: Intent
    let icon: String
    var size: CGFloat = 26
    var filled = false
    var body: some View {
        Button(intent: intent) {
            Image(systemName: icon).font(.system(size: size * 0.42, weight: filled ? .regular : .light))
                .foregroundStyle(filled ? Palette.paper : Palette.ink)
                .frame(width: size, height: size)
                .background(filled ? Palette.ink : Color.clear, in: Circle())
                .overlay(Circle().stroke(filled ? Palette.ink : Palette.rule))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
    }
}

private struct Controls: View {
    let snapshot: WidgetSnapshot
    var size: CGFloat = 28
    var body: some View {
        HStack(spacing: 10) {
            ControlButton(intent: PreviousTrackIntent(), icon: "backward.end", size: size)
            ControlButton(intent: TogglePlaybackIntent(), icon: snapshot.isPlaying ? "pause" : "play", size: size + 6, filled: true)
            ControlButton(intent: NextTrackIntent(), icon: "forward.end", size: size)
        }
    }
}

private struct Progress: View {
    let snapshot: WidgetSnapshot
    let date: Date
    var showsTimes = true
    var body: some View {
        VStack(spacing: 4) {
            if snapshot.isLive {
                ProgressView(timerInterval: snapshot.startedAt...snapshot.endsAt, countsDown: false) { EmptyView() } currentValueLabel: { EmptyView() }
                    .progressViewStyle(.linear).tint(Palette.ink)
            } else {
                ProgressView(value: snapshot.duration > 0 ? snapshot.elapsed(at: date) / snapshot.duration : 0)
                    .progressViewStyle(.linear).tint(Palette.ink)
            }
            if showsTimes { HStack {
                if snapshot.isLive {
                    Text(timerInterval: snapshot.startedAt...snapshot.endsAt, countsDown: false)
                } else {
                    Text(clock(snapshot.elapsed(at: date)))
                }
                Spacer()
                Text(clock(snapshot.duration))
            }
            .font(.system(size: 9, design: .monospaced)).monospacedDigit().foregroundStyle(Palette.muted) }
        }
    }
}

private func clock(_ seconds: Double) -> String {
    guard seconds.isFinite, seconds >= 0 else { return "0:00" }
    let seconds = Int(seconds)
    return "\(seconds / 60):\(String(format: "%02d", seconds % 60))"
}

private struct Titles: View {
    let snapshot: WidgetSnapshot
    var titleSize: CGFloat = 13
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(snapshot.title).font(.system(size: titleSize, weight: .medium)).lineLimit(1)
            Text(snapshot.artist.isEmpty ? snapshot.album : snapshot.artist)
                .font(.system(size: titleSize - 1.5)).foregroundStyle(Palette.muted).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct SmallView: View {
    let snapshot: WidgetSnapshot
    let artwork: NSImage?
    let date: Date
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                Artwork(image: artwork).frame(width: 64, height: 64)
                Spacer(minLength: 4)
                ControlButton(intent: TogglePlaybackIntent(), icon: snapshot.isPlaying ? "pause" : "play", size: 34, filled: true)
            }
            Spacer(minLength: 0)
            Titles(snapshot: snapshot, titleSize: 12.5)
            Progress(snapshot: snapshot, date: date, showsTimes: false)
        }
    }
}

private struct MediumView: View {
    let snapshot: WidgetSnapshot
    let artwork: NSImage?
    let date: Date
    var body: some View {
        HStack(spacing: 14) {
            Artwork(image: artwork)
            VStack(alignment: .leading, spacing: 0) {
                caption(snapshot.isPlaying ? "Now playing" : "Paused")
                Spacer(minLength: 4)
                Titles(snapshot: snapshot)
                Spacer(minLength: 6)
                Progress(snapshot: snapshot, date: date)
                Spacer(minLength: 6)
                Controls(snapshot: snapshot, size: 26).frame(maxWidth: .infinity)
            }
        }
    }
}

private struct LargeView: View {
    let snapshot: WidgetSnapshot
    let artwork: NSImage?
    let date: Date
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 14) {
                Artwork(image: artwork).frame(width: 120, height: 120)
                VStack(alignment: .leading, spacing: 6) {
                    caption(snapshot.isPlaying ? "Now playing" : "Paused")
                    Titles(snapshot: snapshot, titleSize: 15)
                    if !snapshot.album.isEmpty && snapshot.album != snapshot.artist {
                        Text(snapshot.album).font(.system(size: 11)).foregroundStyle(Palette.faint).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Controls(snapshot: snapshot, size: 28)
                }
            }
            Progress(snapshot: snapshot, date: date)
            Rectangle().fill(Palette.rule).frame(height: 0.5)
            caption("Up next")
            if snapshot.upNext.isEmpty {
                Text(snapshot.shuffle ? "Shuffling the queue." : "The queue ends after this song.").font(.system(size: 11.5)).foregroundStyle(Palette.muted)
            }
            ForEach(Array(snapshot.upNext.prefix(4).enumerated()), id: \.offset) { index, song in
                HStack(spacing: 10) {
                    Text(String(format: "%02d", index + 1)).font(.system(size: 9.5, design: .monospaced)).foregroundStyle(Palette.faint)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(song.title).font(.system(size: 11.5, weight: .medium)).lineLimit(1)
                        if !song.artist.isEmpty {
                            Text(song.artist).font(.system(size: 10.5)).foregroundStyle(Palette.muted).lineLimit(1)
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
    }
}

private struct IdleView: View {
    @Environment(\.widgetFamily) private var family
    let appRunning: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            caption("Melora")
            Spacer(minLength: 0)
            Image(systemName: "opticaldisc").font(.system(size: 26, weight: .ultraLight)).foregroundStyle(Palette.faint)
            Text("Nothing playing").font(.system(size: 13, weight: .medium))
            Text(appRunning ? "Choose a song in Melora." : "Click to open Melora.")
                .font(.system(size: 11.5)).foregroundStyle(Palette.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}
