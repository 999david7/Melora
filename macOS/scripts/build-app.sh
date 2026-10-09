#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
APP="$PWD/dist/Melora.app"
WIDGETS="$APP/Contents/PlugIns/MeloraWidgets.appex"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$WIDGETS/Contents/MacOS"
if [ "${MELORA_UNIVERSAL:-0}" = "1" ]; then
  UNIVERSAL_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/Melora-universal.XXXXXX")"
  trap 'rm -rf "$UNIVERSAL_STAGE"' EXIT
  for ARCHITECTURE in arm64 x86_64; do
    swift build -c release --arch "$ARCHITECTURE"
    BIN_DIR="$(swift build -c release --arch "$ARCHITECTURE" --show-bin-path)"
    cp "$BIN_DIR/Melora" "$UNIVERSAL_STAGE/Melora-$ARCHITECTURE"
    cp "$BIN_DIR/MeloraWidgets" "$UNIVERSAL_STAGE/MeloraWidgets-$ARCHITECTURE"
  done
  lipo -create "$UNIVERSAL_STAGE/Melora-arm64" "$UNIVERSAL_STAGE/Melora-x86_64" -output "$APP/Contents/MacOS/Melora"
  lipo -create "$UNIVERSAL_STAGE/MeloraWidgets-arm64" "$UNIVERSAL_STAGE/MeloraWidgets-x86_64" -output "$WIDGETS/Contents/MacOS/MeloraWidgets"
else
  swift build -c release
  BIN_DIR="$(swift build -c release --show-bin-path)"
  cp "$BIN_DIR/Melora" "$APP/Contents/MacOS/Melora"
  cp "$BIN_DIR/MeloraWidgets" "$WIDGETS/Contents/MacOS/MeloraWidgets"
fi
cp Resources/Info.plist "$APP/Contents/Info.plist"
cp Resources/MeloraWidgets-Info.plist "$WIDGETS/Contents/Info.plist"
# The widget's version must match the app's or macOS will not load it.
for PLIST in "$APP/Contents/Info.plist" "$WIDGETS/Contents/Info.plist"; do
  if [ -n "${MELORA_VERSION:-}" ]; then
    /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $MELORA_VERSION" "$PLIST"
  fi
  if [ -n "${MELORA_BUILD:-}" ]; then
    /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $MELORA_BUILD" "$PLIST"
  fi
done
swift scripts/make-icon.swift "$APP/Contents/Resources"
./scripts/widget-intents-metadata.sh "$BIN_DIR" "$WIDGETS/Contents/Resources"
# Sign inside-out: --deep would re-sign the widget without its sandbox entitlements.
codesign --force --sign - --entitlements Resources/MeloraWidgets.entitlements "$WIDGETS"
codesign --force --sign - "$APP"
echo "Built $APP"
