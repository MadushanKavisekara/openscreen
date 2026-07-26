// swift-tools-version: 5.9

import PackageDescription

let package = Package(
	name: "ScreenlyScreenCaptureKitHelper",
	platforms: [
		.macOS(.v13)
	],
	products: [
		.executable(
			name: "screenly-screencapturekit-helper",
			targets: ["ScreenlyScreenCaptureKitHelper"]
		),
		.executable(
			name: "screenly-macos-cursor-helper",
			targets: ["ScreenlyMacOSCursorHelper"]
		)
	],
	targets: [
		.executableTarget(
			name: "ScreenlyScreenCaptureKitHelper",
			path: "Sources/ScreenlyScreenCaptureKitHelper"
		),
		.executableTarget(
			name: "ScreenlyMacOSCursorHelper",
			path: "Sources/ScreenlyMacOSCursorHelper"
		)
	]
)
