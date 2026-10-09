// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Melora",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Melora", targets: ["Melora"]),
        .executable(name: "MeloraWidgets", targets: ["MeloraWidgets"])
    ],
    targets: [
        .target(name: "MeloraWidgetShared"),
        .executableTarget(name: "Melora", dependencies: ["MeloraWidgetShared"]),
        // Packaged by scripts/build-app.sh as Melora.app/Contents/PlugIns/MeloraWidgets.appex.
        .executableTarget(name: "MeloraWidgets", dependencies: ["MeloraWidgetShared"],
                          swiftSettings: [.unsafeFlags(["-application-extension"])],
                          // Like Xcode: extensions start in Foundation's NSExtensionMain, which
                          // sets up the extension context and then calls the WidgetBundle's main.
                          linkerSettings: [.unsafeFlags(["-Xlinker", "-application_extension", "-Xlinker", "-e", "-Xlinker", "_NSExtensionMain"])]),
        .testTarget(name: "MeloraTests", dependencies: ["Melora", "MeloraWidgetShared"], resources: [.copy("Fixtures")])
    ],
    swiftLanguageModes: [.v5]
)
