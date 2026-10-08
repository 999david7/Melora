#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
APP="$PWD/dist/Melora.app"
if [ ! -d "$APP" ]; then ./scripts/build-app.sh; fi
codesign --verify --deep --strict "$APP"
ARCHITECTURES="$(lipo -archs "$APP/Contents/MacOS/Melora")"
ARCHITECTURE="$ARCHITECTURES"
if [[ "$ARCHITECTURES" == *" "* ]]; then ARCHITECTURE="universal"; fi
OUTPUT="${1:-$PWD/dist/Melora-macos-$ARCHITECTURE.dmg}"
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/Melora-dmg.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT
ditto "$APP" "$STAGING/Melora.app"
ln -s /Applications "$STAGING/Applications"
cat > "$STAGING/Install Melora.txt" <<'INSTALL'
Drag Melora.app onto Applications, then open Melora from Applications.

Requires macOS 14 or later. Your music and playlists are stored separately
from the app, by default in ~/Music/Melora.

This personal release is signed locally, but is not notarized by Apple.
For source code, release notes and setup help:
https://github.com/999david7/Melora
INSTALL
hdiutil create -volname "Melora" -srcfolder "$STAGING" -format UDZO -ov "$OUTPUT"
hdiutil verify "$OUTPUT"
echo "Created $OUTPUT"
