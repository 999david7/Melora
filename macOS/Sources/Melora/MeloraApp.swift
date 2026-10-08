import SwiftUI
import AppKit

@main
struct MeloraApp: App {
    @StateObject private var library = LibraryStore()
    @StateObject private var player = MusicPlayer()
    @StateObject private var updates = AppUpdates()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(library)
                .environmentObject(player)
                .environmentObject(updates)
                .frame(minWidth: 980, minHeight: 680)
                .preferredColorScheme(.light)
                .tint(Theme.ink)
                .task {
                    while !Task.isCancelled {
                        await updates.check(automatically: true, canInstall: { !library.isBusy })
                        do { try await Task.sleep(for: .seconds(6 * 3600)) }
                        catch { break }
                    }
                }
        }
        .defaultSize(width: 1280, height: 820)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Check for Updates…") { Task { await updates.check(canInstall: { !library.isBusy }) } }
                    .disabled(updates.isBusy || library.isBusy)
            }
            CommandGroup(replacing: .newItem) {
                Button("Import Music Link…") { library.showImporter = true }.keyboardShortcut("n")
                Button("Add Audio Files…") { library.importFiles() }.keyboardShortcut("o")
                    .disabled(library.isBusy)
            }
            CommandGroup(after: .textEditing) {
                Button("Search Music") { NotificationCenter.default.post(name: .meloraFocusSearch, object: nil) }.keyboardShortcut("f")
            }
            CommandMenu("Playback") {
                Button(player.isPlaying ? "Pause" : "Play") { player.toggle() }.keyboardShortcut("p")
                Button("Next Track") { player.next() }.keyboardShortcut(.rightArrow, modifiers: .command)
                Button("Previous Track") { player.previous() }.keyboardShortcut(.leftArrow, modifiers: .command)
                Divider()
                Button(player.shuffle ? "Turn Shuffle Off" : "Turn Shuffle On") { player.shuffle.toggle() }.keyboardShortcut("s", modifiers: [.command, .shift])
                Button("Cycle Repeat Mode") { player.cycleRepeat() }.keyboardShortcut("r", modifiers: [.command, .shift])
                Button(player.volume == 0 ? "Unmute" : "Mute") { player.toggleMute() }.keyboardShortcut("m", modifiers: [.command, .shift])
                Divider()
                Menu("Sleep Timer") { SleepTimerOptions().environmentObject(player) }
            }
            CommandGroup(replacing: .appSettings) {
                Button("Settings…") { library.showSettings = true }.keyboardShortcut(",")
            }
        }
    }
}

// Explicit wrapper alias also builds with SDKs that introduce a State macro.
typealias ViewState<Value> = SwiftUI.State<Value>
