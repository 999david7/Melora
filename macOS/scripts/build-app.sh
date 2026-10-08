#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
swift build -c release
BIN_DIR="$(swift build -c release --show-bin-path)"
APP="$PWD/dist/Melora.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/Melora" "$APP/Contents/MacOS/Melora"
cp Resources/Info.plist "$APP/Contents/Info.plist"
if [ -n "${MELORA_VERSION:-}" ]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $MELORA_VERSION" "$APP/Contents/Info.plist"
fi
if [ -n "${MELORA_BUILD:-}" ]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $MELORA_BUILD" "$APP/Contents/Info.plist"
fi
swift scripts/make-icon.swift "$APP/Contents/Resources"
codesign --force --deep --sign - "$APP"
echo "Built $APP"
