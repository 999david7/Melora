import SwiftUI
import AppKit

enum Theme {
    // Match public/styles.css: paper, ink, hairlines, and gold only for favourites.
    static let background = Color.white
    static let surface = Color(red: 0.984, green: 0.984, blue: 0.980)
    static let paper3 = Color(red: 0.949, green: 0.949, blue: 0.941)
    static let ink = Color(red: 0.055, green: 0.055, blue: 0.055)
    static let secondary = Color(red: 0.298, green: 0.310, blue: 0.329)
    static let muted = Color(red: 0.545, green: 0.565, blue: 0.592)
    static let faint = Color(red: 0.706, green: 0.722, blue: 0.741)
    static let rule = Color(red: 0.886, green: 0.886, blue: 0.875)
    static let ruleSoft = Color(red: 0.933, green: 0.933, blue: 0.922)
    static let accent = Color(red: 0.929, green: 0.757, blue: 0.165)
    static let danger = Color(red: 0.784, green: 0.267, blue: 0.231)
}

func label(_ text: String) -> some View {
    Text(text.uppercased()).font(.system(size: 10, weight: .regular, design: .monospaced))
        .tracking(1.6).foregroundStyle(Theme.muted)
}

struct Hairline: View {
    var vertical = false
    var body: some View {
        Rectangle().fill(Theme.rule).frame(width: vertical ? 1 : nil, height: vertical ? nil : 1)
    }
}

// Scope cursor changes to individual actions so editable text keeps its I-beam.
private struct ActionCursorModifier: ViewModifier {
    @Environment(\.isEnabled) private var isEnabled
    @ViewState<Bool> private var hovering = false

    func body(content: Content) -> some View {
        content.onContinuousHover { phase in
            switch phase {
            case .active:
                if !hovering { hovering = true }
                if isEnabled { NSCursor.pointingHand.set() }
            case .ended:
                if hovering && isEnabled { NSCursor.arrow.set() }
                hovering = false
            }
        }
        .onChange(of: isEnabled) { _, enabled in
            if hovering { (enabled ? NSCursor.pointingHand : NSCursor.arrow).set() }
        }
        .onDisappear {
            if hovering { NSCursor.arrow.set() }
        }
    }
}

extension View {
    func actionCursor() -> some View { modifier(ActionCursorModifier()) }
}

struct ActionButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            // Include padding, spacers, and icon frames in the clickable area.
            .contentShape(Rectangle())
            .opacity(isEnabled ? 1 : 0.4)
            .actionCursor()
    }
}

struct EditorialButtonStyle: ButtonStyle {
    var primary = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 10, design: .monospaced)).tracking(1.4)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .foregroundStyle(primary ? Color.white : Theme.ink)
            .background(primary ? Theme.ink : configuration.isPressed ? Theme.paper3 : Theme.background)
            .clipShape(RoundedRectangle(cornerRadius: 2))
            .overlay(RoundedRectangle(cornerRadius: 2).stroke(primary ? Theme.ink : Theme.rule))
            .contentShape(Rectangle())
            .actionCursor()
    }
}

struct ChromeButton: View {
    let title: String
    var action: () -> Void
    var body: some View {
        Button(action: action) { label(title).frame(minHeight: 28) }.buttonStyle(ActionButtonStyle())
    }
}

struct LineIconButton: View {
    let icon: String
    let help: String
    var active = false
    var bordered = false
    var size: CGFloat = 26
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: icon).font(.system(size: 13, weight: .light))
                .foregroundStyle(active ? Theme.ink : Theme.muted)
                .frame(width: size, height: size)
                .overlay(RoundedRectangle(cornerRadius: 2).stroke(bordered || active ? Theme.rule : .clear))
        }.buttonStyle(ActionButtonStyle()).help(help).accessibilityLabel(help)
    }
}

struct DiscMark: View {
    var body: some View {
        GeometryReader { geometry in
            let s = min(geometry.size.width, geometry.size.height)
            ZStack {
                Circle().stroke(Theme.ink, lineWidth: 1).padding(s * 0.125)
                Circle().stroke(Theme.ink, lineWidth: 1).padding(s * 0.40)
                Path { path in
                    for fraction in [CGFloat(0.125), 0.875] {
                        path.move(to: CGPoint(x: s / 2, y: s * fraction))
                        path.addLine(to: CGPoint(x: s / 2, y: s * (fraction < 0.5 ? 0.267 : 0.733)))
                        path.move(to: CGPoint(x: s * fraction, y: s / 2))
                        path.addLine(to: CGPoint(x: s * (fraction < 0.5 ? 0.267 : 0.733), y: s / 2))
                    }
                }.stroke(Theme.ink, lineWidth: 1)
            }.frame(width: s, height: s)
        }
    }
}
