import AppKit

// Melora's music note in the family's white / halftone / orange icon language.
// Draw at exact pixel dimensions so the ICNS stays crisp at every Dock size.
let destination = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let iconset = destination.appendingPathComponent("AppIcon.iconset", isDirectory: true)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

func render(pixels: Int) throws -> Data {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                                  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                  isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    let context = NSGraphicsContext(bitmapImageRep: bitmap)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    defer { NSGraphicsContext.restoreGraphicsState() }
    context.shouldAntialias = true
    let s = CGFloat(pixels)
    let tile = NSBezierPath(roundedRect: NSRect(x: s * 0.07, y: s * 0.07, width: s * 0.86, height: s * 0.86),
                            xRadius: s * 0.24, yRadius: s * 0.24)

    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.12)
    shadow.shadowBlurRadius = s * 0.012
    shadow.shadowOffset = NSSize(width: 0, height: -s * 0.006)
    shadow.set()
    NSColor.white.setFill()
    tile.fill()
    NSGraphicsContext.restoreGraphicsState()

    let gradient = NSGradient(starting: .white, ending: NSColor(calibratedWhite: 0.974, alpha: 1))!
    gradient.draw(in: tile, angle: -90)
    NSColor(calibratedWhite: 1, alpha: 0.9).setStroke()
    tile.lineWidth = max(0.5, s * 0.002)
    tile.stroke()

    // A single eighth note, rendered in the family's separated halftone dots.
    let note = NSBezierPath()
    note.move(to: CGPoint(x: 0.535, y: 0.300))
    note.curve(to: CGPoint(x: 0.376, y: 0.310), controlPoint1: CGPoint(x: 0.530, y: 0.351), controlPoint2: CGPoint(x: 0.438, y: 0.347))
    note.curve(to: CGPoint(x: 0.390, y: 0.202), controlPoint1: CGPoint(x: 0.315, y: 0.274), controlPoint2: CGPoint(x: 0.321, y: 0.213))
    note.curve(to: CGPoint(x: 0.549, y: 0.279), controlPoint1: CGPoint(x: 0.458, y: 0.190), controlPoint2: CGPoint(x: 0.549, y: 0.225))
    note.line(to: CGPoint(x: 0.549, y: 0.563))
    note.curve(to: CGPoint(x: 0.643, y: 0.532), controlPoint1: CGPoint(x: 0.564, y: 0.551), controlPoint2: CGPoint(x: 0.618, y: 0.550))
    note.curve(to: CGPoint(x: 0.617, y: 0.423), controlPoint1: CGPoint(x: 0.689, y: 0.498), controlPoint2: CGPoint(x: 0.665, y: 0.455))
    note.curve(to: CGPoint(x: 0.702, y: 0.534), controlPoint1: CGPoint(x: 0.688, y: 0.444), controlPoint2: CGPoint(x: 0.727, y: 0.487))
    note.curve(to: CGPoint(x: 0.553, y: 0.680), controlPoint1: CGPoint(x: 0.679, y: 0.585), controlPoint2: CGPoint(x: 0.570, y: 0.594))
    note.line(to: CGPoint(x: 0.500, y: 0.680))
    note.line(to: CGPoint(x: 0.500, y: 0.305))
    note.close()

    if pixels <= 32 {
        // Keep the stem legible when halftone dots would be smaller than a pixel.
        let transform = AffineTransform(scale: s)
        note.transform(using: transform)
        NSColor(calibratedWhite: 0.43, alpha: 1).setFill()
        note.fill()
    } else {
        let spacing: CGFloat = 0.016
        for row in 0...64 {
            for column in 0...64 {
                let point = CGPoint(x: CGFloat(column) * spacing, y: CGFloat(row) * spacing)
                guard note.contains(point) else { continue }
                let grey = 0.40 + (point.y - 0.2) * 0.32
                NSColor(calibratedWhite: grey, alpha: 1).setFill()
                let dotRadius = s * spacing * 0.32
                NSBezierPath(ovalIn: NSRect(x: point.x * s - dotRadius, y: point.y * s - dotRadius,
                                           width: dotRadius * 2, height: dotRadius * 2)).fill()
            }
        }
    }

    // The family's single orange status dot, separate from the note.
    NSColor(calibratedRed: 0.91, green: 0.52, blue: 0.025, alpha: 1).setFill()
    NSBezierPath(ovalIn: NSRect(x: s * 0.69, y: s * 0.695, width: s * 0.087, height: s * 0.087)).fill()
    return bitmap.representation(using: .png, properties: [:])!
}

for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let data = try render(pixels: size * scale)
        let name = "icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"
        try data.write(to: iconset.appendingPathComponent(name))
        if size == 128 && scale == 2 {
            try data.write(to: destination.appendingPathComponent("AppIcon-preview.png"))
        }
    }
}
let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["-c", "icns", iconset.path, "-o", destination.appendingPathComponent("AppIcon.icns").path]
try process.run()
process.waitUntilExit()
guard process.terminationStatus == 0 else { exit(1) }
try FileManager.default.removeItem(at: iconset)
