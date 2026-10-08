import Foundation
import AppKit
import CryptoKit

struct AppVersion: Comparable, Equatable {
    let numbers: [Int]
    init?(_ value: String) {
        let raw = value.hasPrefix("v") ? String(value.dropFirst()) : value
        let parts = raw.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...3).contains(parts.count), parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy({ $0.isASCII && $0.isNumber }) }),
              parts.allSatisfy({ Int($0) != nil }) else { return nil }
        numbers = parts.map { Int($0)! } + Array(repeating: 0, count: 3 - parts.count)
    }
    static func < (lhs: Self, rhs: Self) -> Bool { lhs.numbers.lexicographicallyPrecedes(rhs.numbers) }
}

struct AppRelease: Decodable {
    struct Asset: Decodable {
        let name: String
        let browser_download_url: URL
        let digest: String?
    }
    let tag_name: String
    let html_url: URL
    let draft: Bool
    let prerelease: Bool
    let assets: [Asset]

    func asset(architecture: String) -> Asset? {
        [architecture, "universal"].compactMap { platform in assets.first {
            $0.name == "Melora-macos-\(platform).zip" &&
            $0.browser_download_url.scheme == "https" &&
            $0.browser_download_url.host == "github.com" &&
            $0.browser_download_url.path.hasPrefix("/999david7/Melora/releases/download/")
        } }.first
    }
    func isNewer(than installed: String) -> Bool {
        guard !draft, !prerelease, let version = AppVersion(tag_name), let current = AppVersion(installed) else { return false }
        return version > current
    }
}

@MainActor
final class AppUpdates: ObservableObject {
    @Published private(set) var isBusy = false
    @Published private(set) var status = "Checks GitHub for new releases automatically."
    static let repository = URL(string: "https://github.com/999david7/Melora/releases")!
    static var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0" }
    static var architecture: String {
        #if arch(arm64)
        return "arm64"
        #else
        return "x86_64"
        #endif
    }

    func check(automatically: Bool = false, canInstall: @escaping () -> Bool = { true }) async {
        guard !isBusy, canInstall() else { return }
        if automatically, let last = UserDefaults.standard.object(forKey: "lastReleaseCheck") as? Date,
           Date().timeIntervalSince(last) < 6 * 3600 { return }
        isBusy = true
        var acceptedInstallation = false
        defer { isBusy = false }
        status = "Checking for updates…"
        do {
            var request = URLRequest(url: URL(string: "https://api.github.com/repos/999david7/Melora/releases/latest")!)
            request.timeoutInterval = 20
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            request.setValue("Melora/\(Self.version)", forHTTPHeaderField: "User-Agent")
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw MeloraError.message("GitHub did not respond.") }
            if http.statusCode == 404 {
                UserDefaults.standard.set(Date(), forKey: "lastReleaseCheck")
                status = "No published releases yet."
                if !automatically { inform("No releases yet", "You’re running Melora \(Self.version). New releases will appear here automatically.") }
                return
            }
            guard http.statusCode == 200 else { throw MeloraError.message("GitHub could not check for updates (HTTP \(http.statusCode)). Try again later.") }
            let release = try JSONDecoder().decode(AppRelease.self, from: data)
            UserDefaults.standard.set(Date(), forKey: "lastReleaseCheck")
            guard release.isNewer(than: Self.version) else {
                status = "Melora \(Self.version) is up to date."
                if !automatically { inform("You’re up to date", status) }
                return
            }
            status = "Melora \(release.tag_name) is available."
            guard canInstall(), !Task.isCancelled else { return }
            let alert = NSAlert()
            alert.messageText = "Melora \(release.tag_name) is available"
            alert.informativeText = "Install the new release and restart Melora? Your music, playlists and settings stay on this Mac."
            let asset = release.asset(architecture: Self.architecture)
            alert.addButton(withTitle: asset == nil ? "View release" : "Install & Restart")
            alert.addButton(withTitle: "Later")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            if let asset { acceptedInstallation = true; try await install(asset, version: release.tag_name) }
            else { NSWorkspace.shared.open(Self.repository) }
        } catch {
            status = error.localizedDescription
            if !automatically || acceptedInstallation { inform("Update unavailable", status) }
        }
    }

    private func inform(_ title: String, _ message: String) {
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = message
        alert.addButton(withTitle: "OK"); alert.runModal()
    }

    static func verifyArchive(_ data: Data, digest: String?) throws {
        let actual = "sha256:" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard let digest, digest.lowercased() == actual else { throw MeloraError.message("The downloaded update could not be verified. Download it again from the release page.") }
    }

    static func validateArchivePaths(_ listing: String) throws {
        let paths = listing.split(whereSeparator: \.isNewline)
        guard !paths.isEmpty, paths.allSatisfy({ path in
            !path.hasPrefix("/") && !path.split(separator: "/").contains("..") &&
            (path.hasPrefix("Melora.app/") || path.hasPrefix("__MACOSX/"))
        }) else { throw MeloraError.message("The release archive contains unexpected files.") }
    }

    private func install(_ asset: AppRelease.Asset, version: String) async throws {
        let fm = FileManager.default
        let app = Bundle.main.bundleURL.resolvingSymlinksInPath()
        guard app.pathExtension == "app", fm.isWritableFile(atPath: app.path), fm.isWritableFile(atPath: app.deletingLastPathComponent().path) else {
            throw MeloraError.message("Move Melora to a writable Applications folder before installing an update.")
        }
        let work = fm.temporaryDirectory.appendingPathComponent("Melora-update-\(UUID())")
        try fm.createDirectory(at: work, withIntermediateDirectories: true)
        var handedOff = false
        defer { if !handedOff { try? fm.removeItem(at: work) } }
        do {
            status = "Downloading Melora \(version)…"
            var request = URLRequest(url: asset.browser_download_url); request.timeoutInterval = 180
            let (download, response) = try await URLSession.shared.download(for: request)
            defer { try? fm.removeItem(at: download) }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw MeloraError.message("GitHub refused the update download.") }
            try Self.verifyArchive(Data(contentsOf: download, options: .mappedIfSafe), digest: asset.digest)
            let archive = work.appendingPathComponent("release.zip")
            try fm.moveItem(at: download, to: archive)
            let listing = try await DownloadService.run(URL(fileURLWithPath: "/usr/bin/zipinfo"), arguments: ["-1", archive.path], logFolder: work, timeout: 30) { _, _ in }
            try Self.validateArchivePaths(listing)
            let details = try await DownloadService.run(URL(fileURLWithPath: "/usr/bin/zipinfo"), arguments: ["-l", archive.path], logFolder: work, timeout: 30) { _, _ in }
            guard !details.split(whereSeparator: \.isNewline).contains(where: { $0.hasPrefix("l") }) else { throw MeloraError.message("The update archive contains unsupported symbolic links.") }
            let extracted = work.appendingPathComponent("extracted")
            _ = try await DownloadService.run(URL(fileURLWithPath: "/usr/bin/ditto"), arguments: ["-x", "-k", archive.path, extracted.path], logFolder: work, timeout: 60) { _, _ in }
            let candidate = extracted.appendingPathComponent("Melora.app")
            guard let bundle = Bundle(url: candidate), bundle.bundleIdentifier == "app.melora.desktop",
                  let candidateVersion = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
                  AppVersion(candidateVersion) == AppVersion(version), let executable = bundle.executableURL else {
                throw MeloraError.message("This release is not a compatible Melora app.")
            }
            let os = ProcessInfo.processInfo.operatingSystemVersion
            if let minimum = bundle.object(forInfoDictionaryKey: "LSMinimumSystemVersion") as? String,
               let required = AppVersion(minimum), let installed = AppVersion("\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"),
               installed < required { throw MeloraError.message("This release needs macOS \(minimum) or newer.") }
            _ = try await DownloadService.run(URL(fileURLWithPath: "/usr/bin/lipo"), arguments: ["-verify_arch", Self.architecture, executable.path], logFolder: work, timeout: 30) { _, _ in }
            _ = try await DownloadService.run(URL(fileURLWithPath: "/usr/bin/codesign"), arguments: ["--verify", "--deep", "--strict", candidate.path], logFolder: work, timeout: 30) { _, _ in }
            let prepared = app.deletingLastPathComponent().appendingPathComponent(".Melora-update-\(UUID()).app")
            let backup = app.deletingLastPathComponent().appendingPathComponent(".Melora-backup-\(UUID()).app")
            try fm.copyItem(at: candidate, to: prepared)
            do {
                let script = work.appendingPathComponent("install.sh")
                try Self.installScript.write(to: script, atomically: true, encoding: .utf8)
                let helper = Process(); helper.executableURL = URL(fileURLWithPath: "/bin/sh")
                helper.arguments = [script.path, String(ProcessInfo.processInfo.processIdentifier), app.path, prepared.path, backup.path, work.path]
                helper.standardInput = FileHandle.nullDevice; helper.standardOutput = FileHandle.nullDevice; helper.standardError = FileHandle.nullDevice
                try helper.run()
                handedOff = true
                NSApplication.shared.terminate(nil)
            } catch { try? fm.removeItem(at: prepared); throw error }
        } catch { throw error }
    }

    // Paths are separate arguments; release data is never interpolated into shell code.
    static let installScript = """
    set -eu
    pid="$1"; app="$2"; prepared="$3"; backup="$4"; work="$5"
    count=0
    while kill -0 "$pid" 2>/dev/null; do
      count=$((count + 1))
      if [ "$count" -ge 120 ]; then rm -rf "$prepared" "$work"; exit 1; fi
      sleep 1
    done
    if mv "$app" "$backup"; then
      if mv "$prepared" "$app"; then
        if /usr/bin/open "$app"; then
          rm -rf "$backup" "$work"
          exit 0
        fi
        mv "$app" "$prepared"
      fi
      mv "$backup" "$app"
    fi
    /usr/bin/open "$app" || true
    rm -rf "$prepared" "$work"
    """
}
