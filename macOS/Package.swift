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
                          linkerSettings: [.unsafeFlags(["-Xlinker", "-application_extension"])]),
        .testTarget(name: "MeloraTests", dependencies: ["Melora", "MeloraWidgetShared"], resources: [.copy("Fixtures")])
    ],
    swiftLanguageModes: [.v5]
)
