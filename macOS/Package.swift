// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Melora",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "Melora", targets: ["Melora"])],
    targets: [
        .executableTarget(name: "Melora"),
        .testTarget(name: "MeloraTests", dependencies: ["Melora"], resources: [.copy("Fixtures")])
    ],
    swiftLanguageModes: [.v5]
)
