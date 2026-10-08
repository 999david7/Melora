import Testing
import AppKit
@testable import Melora

@Suite(.serialized)
struct MeloraTests {
    @Test func testURLValidation() throws {
        #expect(try ImportURL.parse(" https://example.com/song.mp3?token=abc \n").host == "example.com")
        for url in ["file:///etc/passwd", "javascript:alert(1)", "example.com", "https://", "ftp://example.com/music", "https://user:password@example.com"] {
            expectThrow { _ = try ImportURL.parse(url) }
        }
        #expect(ImportURL.isAudio(try ImportURL.parse("https://example.com/music.MP3?signature=123")))
        #expect(!ImportURL.isAudio(try ImportURL.parse("https://example.com/watch?v=1")))
    }

    @Test func testPathContainmentAndSymlinks() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        #expect(try LibraryPaths.resolve("Music/song.m4a", in: root).lastPathComponent == "song.m4a")
        for path in ["/etc/passwd", "../song.mp3", "Music/../../secret", "\0", ""] {
            expectThrow(path.debugDescription) { _ = try LibraryPaths.resolve(path, in: root) }
        }
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("outside"), withDestinationURL: URL(fileURLWithPath: "/tmp"))
        expectThrow("symlink") { _ = try LibraryPaths.resolve("outside/music.mp3", in: root) }
    }

    @Test func testTimeFormatting() {
        #expect(timeLabel(125.9) == "2:05")
        #expect(timeLabel(.nan) == "0:00")
        #expect(timeLabel(-1) == "0:00")
    }

    @Test func testProcessFailuresAndCancellation() async throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let output = try await DownloadService.run(URL(fileURLWithPath: "/usr/bin/printf"), arguments: ["hello"], logFolder: root) { _, _ in }
        #expect(output == "hello")
        do {
            _ = try await DownloadService.run(URL(fileURLWithPath: "/usr/bin/false"), arguments: [], logFolder: root) { _, _ in }
            Issue.record("Nonzero exit must fail")
        } catch { #expect(!error.localizedDescription.isEmpty) }
        let task = Task {
            try await DownloadService.run(URL(fileURLWithPath: "/bin/sleep"), arguments: ["30"], logFolder: root) { _, _ in }
        }
        try await Task.sleep(for: .milliseconds(300))
        let start = Date()
        task.cancel()
        do { _ = try await task.value; Issue.record("Cancellation must fail") }
        catch { #expect(error is CancellationError) }
        #expect(Date().timeIntervalSince(start) < 3)
        let timeoutStart = Date()
        do {
            _ = try await DownloadService.run(URL(fileURLWithPath: "/bin/sh"),
                arguments: ["-c", "trap '' TERM; while :; do :; done"], logFolder: root, timeout: 0.3) { _, _ in }
            Issue.record("An unresponsive process must time out")
        } catch { #expect(error.localizedDescription.contains("timed out")) }
        #expect(Date().timeIntervalSince(timeoutStart) < 3)
    }

    @MainActor
    @Test func testDirectDownloadPersistenceAndDuplicates() async throws {
        let server = try FixtureServer()
        defer { server.stop() }
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let library = LibraryStore(root: root)
        try library.enqueue(server.url("song.wav").absoluteString)
        try library.enqueue(server.url("song.wav").absoluteString)
        #expect(library.jobs.count == 1)
        for _ in 0..<100 {
            if !library.isBusy { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        #expect(library.jobs.first?.state == .completed, "\(library.jobs.first?.message ?? "")")
        #expect(library.tracks.count == 1)
        let track = try #require(library.tracks.first)
        #expect(track.duration > 0)
        #expect(FileManager.default.fileExists(atPath: try #require(library.fileURL(track)).path))
        library.toggleFavorite(track)
        let reopened = LibraryStore(root: root)
        #expect(reopened.tracks.count == 1)
        #expect(try #require(reopened.tracks.first).isFavorite)
        reopened.removeFromLibrary(track)
        #expect(reopened.tracks.count == 0)
        #expect(FileManager.default.fileExists(atPath: try #require(library.fileURL(track)).path))
    }

    @Test func testRejectsWebpageDisguisedAsAudioAndCleansStaging() async throws {
        let server = try FixtureServer()
        defer { server.stop() }
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        do {
            _ = try await DownloadService.download(server.url("fake.mp3"), stagingRoot: root) { _, _ in }
            Issue.record("HTML must not be imported as audio")
        } catch { #expect(error.localizedDescription.contains("webpage")) }
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
    }

    @MainActor
    @Test func testCorruptLibraryIsPreserved() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("library.json")
        let corrupt = Data("invalid document".utf8)
        try corrupt.write(to: file)
        let library = LibraryStore(root: root)
        #expect(library.error != nil)
        expectThrow { _ = try library.enqueue("https://example.com/song.mp3") }
        #expect(try Data(contentsOf: file) == corrupt)
    }

    @Test func testVideoExtractionWithArtwork() async throws {
        guard let ffmpeg = DownloadService.executable("ffmpeg"), DownloadService.executable("yt-dlp") != nil else {
            return
        }
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let video = root.appendingPathComponent("clip.mp4")
        _ = try await DownloadService.run(ffmpeg, arguments: ["-nostdin", "-y", "-f", "lavfi", "-i", "color=c=green:s=160x160:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-c:a", "aac", "-shortest", video.path], logFolder: root) { _, _ in }
        let cover = root.appendingPathComponent("poster.jpg")
        _ = try await DownloadService.run(ffmpeg, arguments: ["-nostdin", "-y", "-i", video.path, "-frames:v", "1", cover.path], logFolder: root) { _, _ in }
        let server = try FixtureServer(mediaRoot: root)
        defer { server.stop() }
        let result = try await DownloadService.download(server.url("video.html"), stagingRoot: root.appendingPathComponent("staging")) { _, _ in }
        #expect(result.track.audioPath == "audio.m4a")
        #expect(result.track.duration > 0)
        let art = try #require(result.track.artworkPath)
        #expect(NSImage(contentsOf: result.stagingFolder.appendingPathComponent(art)) != nil)
        #expect(FileManager.default.fileExists(atPath: result.stagingFolder.appendingPathComponent(result.track.audioPath).path))
    }

    @Test func testPlaylistPersistenceAndOldIndexCompatibility() throws {
        let decoder = JSONDecoder()
        let old = try decoder.decode(LibraryDocument.self, from: Data(#"{"version":1,"tracks":[]}"#.utf8))
        #expect(old.playlists.isEmpty)
        let playlist = NativePlaylist(name: "Late nights", trackIDs: [UUID()])
        let encoded = try JSONEncoder().encode(LibraryDocument(playlists: [playlist]))
        let restored = try decoder.decode(LibraryDocument.self, from: encoded)
        #expect(restored.playlists == [playlist])
    }

    private func expectThrow(_ context: String = "", _ action: () throws -> Void) {
        do { try action(); Issue.record("Expected an error: \(context)") } catch { }
    }

    private func temporaryDirectory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("Melora-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }
}

final class FixtureServer {
    let process = Process()
    let port: Int
    init(mediaRoot: URL? = nil) throws {
        let script = #"""
import http.server, struct, io, wave, sys, pathlib
buffer = io.BytesIO()
with wave.open(buffer, 'wb') as output:
    output.setnchannels(1)
    output.setsampwidth(2)
    output.setframerate(44100)
    output.writeframes(b'\0\0' * 4410)
audio = buffer.getvalue()
class Handler(http.server.BaseHTTPRequestHandler):
    def do_HEAD(self):
        self.respond(False)
    def do_GET(self):
        self.respond(True)
    def respond(self, body):
        fake = self.path.startswith('/fake')
        data = b'<html>not music</html>' if fake else audio
        content_type = 'text/html' if fake else 'audio/wav'
        if self.path == '/video.html':
            data = b'<html><head><title>Fixture song</title><meta property="og:image" content="/poster.jpg"></head><body><video controls poster="/poster.jpg"><source src="/clip.mp4" type="video/mp4"></video></body></html>'
            content_type = 'text/html'
        elif self.path in ['/clip.mp4', '/poster.jpg']:
            data = (pathlib.Path(sys.argv[1]) / self.path.lstrip('/')).read_bytes()
            content_type = 'video/mp4' if self.path.endswith('.mp4') else 'image/jpeg'
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if body: self.wfile.write(data)
    def log_message(self, *args): pass
server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
print(server.server_port, flush=True)
server.serve_forever()
"""#
        process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        process.arguments = ["-u", "-c", script, mediaRoot?.path ?? ""]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = pipe.fileHandleForReading.availableData
        guard let text = String(data: data, encoding: .utf8), let port = Int(text.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            process.terminate()
            throw MeloraError.message("Fixture server failed to start")
        }
        self.port = port
    }
    func url(_ path: String) -> URL { URL(string: "http://127.0.0.1:\(port)/\(path)")! }
    func stop() { if process.isRunning { process.terminate(); process.waitUntilExit() } }
}
