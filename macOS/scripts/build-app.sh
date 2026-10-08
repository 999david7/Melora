#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
APP="$PWD/dist/Melora.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
if [ "${MELORA_UNIVERSAL:-0}" = "1" ]; then
  UNIVERSAL_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/Melora-universal.XXXXXX")"
  trap 'rm -rf "$UNIVERSAL_STAGE"' EXIT
  for ARCHITECTURE in arm64 x86_64; do
    swift build -c release --arch "$ARCHITECTURE"
    BIN_DIR="$(swift build -c release --arch "$ARCHITECTURE" --show-bin-path)"
    cp "$BIN_DIR/Melora" "$UNIVERSAL_STAGE/Melora-$ARCHITECTURE"
  done
  lipo -create "$UNIVERSAL_STAGE/Melora-arm64" "$UNIVERSAL_STAGE/Melora-x86_64" -output "$APP/Contents/MacOS/Melora"
else
  swift build -c release
  BIN_DIR="$(swift build -c release --show-bin-path)"
  cp "$BIN_DIR/Melora" "$APP/Contents/MacOS/Melora"
fi
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
