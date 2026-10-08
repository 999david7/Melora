import Foundation
import CryptoKit
import Testing
@testable import Melora

@MainActor @Suite
struct UpdateTests {
    @Test func versionsCompareNumericallyAndRejectNonReleases() throws {
        #expect(AppVersion("v1.10.0")! > AppVersion("1.9.9")!)
        #expect(AppVersion("1.2") == AppVersion("1.2.0"))
        for invalid in ["", "v", "1.0.0-beta", "1..0", "-1.2.3", "1.2.3.4", "one"] { #expect(AppVersion(invalid) == nil) }
        let release = try JSONDecoder().decode(AppRelease.self, from: Data(#"{"tag_name":"v1.2.0","html_url":"https://github.com/999david7/Melora/releases/tag/v1.2.0","draft":false,"prerelease":false,"assets":[{"name":"Melora-macos-arm64.zip","browser_download_url":"https://github.com/999david7/Melora/releases/download/v1.2.0/Melora-macos-arm64.zip","digest":"sha256:test"},{"name":"Melora-macos-x86_64.zip","browser_download_url":"https://example.com/not-melora.zip"}]}"#.utf8))
        #expect(release.isNewer(than: "1.0.0"))
        #expect(!release.isNewer(than: "1.2.0"))
        #expect(release.asset(architecture: "arm64") != nil)
        #expect(release.asset(architecture: "x86_64") == nil)
    }

    @Test func updatesRequireMatchingDigestAndSafeArchivePaths() throws {
        let data = Data("a verified release".utf8)
        let digest = "sha256:" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        try AppUpdates.verifyArchive(data, digest: digest)
        #expect(throws: MeloraError.self) { try AppUpdates.verifyArchive(data, digest: nil) }
        #expect(throws: MeloraError.self) { try AppUpdates.verifyArchive(Data("modified".utf8), digest: digest) }
        try AppUpdates.validateArchivePaths("Melora.app/\nMelora.app/Contents/MacOS/Melora\n")
        for invalid in ["/Melora.app/executable", "Melora.app/../../bad", "Other.app/file", ""] {
            #expect(throws: MeloraError.self) { try AppUpdates.validateArchivePaths(invalid) }
        }
    }

    @Test func installerReplacesAppAndRollsBackOnLaunchFailure() async throws {
        for launchFails in [false, true] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent("Melora installer ' test \(UUID())")
            let work = root.appendingPathComponent("work")
            let app = root.appendingPathComponent("Melora.app")
            let prepared = root.appendingPathComponent("new.app")
            let backup = root.appendingPathComponent("backup.app")
            for folder in [work, app, prepared] { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
            defer { try? FileManager.default.removeItem(at: root) }
            try Data("old".utf8).write(to: app.appendingPathComponent("version"))
            try Data("new".utf8).write(to: prepared.appendingPathComponent("version"))
            let mock = work.appendingPathComponent("mock-open")
            try "#!/bin/sh\nexit \(launchFails ? 1 : 0)\n".write(to: mock, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: mock.path)
            let script = work.appendingPathComponent("install.sh")
            try AppUpdates.installScript.replacingOccurrences(of: "/usr/bin/open", with: "\"$work/mock-open\"").write(to: script, atomically: true, encoding: .utf8)
            _ = try await DownloadService.run(URL(fileURLWithPath: "/bin/sh"), arguments: [script.path, "2147483647", app.path, prepared.path, backup.path, work.path], logFolder: root, timeout: 5) { _, _ in }
            #expect(try String(contentsOf: app.appendingPathComponent("version"), encoding: .utf8) == (launchFails ? "old" : "new"))
            #expect(!FileManager.default.fileExists(atPath: backup.path))
        }
    }
}
