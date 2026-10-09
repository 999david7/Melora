#!/bin/bash
# Widget buttons run App Intents, which macOS finds through Metadata.appintents.
# Xcode normally generates it; SwiftPM does not, so this does the same two steps:
# extract the intents' constant values, then compile them into the bundle.
set -euo pipefail
cd "$(dirname "$0")/.."
BIN_DIR="$1"
OUTPUT="$2"
PROCESSOR="$(xcrun --find appintentsmetadataprocessor 2>/dev/null || true)"
if [ -z "$PROCESSOR" ] && [ -d /Applications/Xcode.app ]; then
  PROCESSOR="$(DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun --find appintentsmetadataprocessor 2>/dev/null || true)"
fi
if [ -z "$PROCESSOR" ]; then
  echo "warning: appintentsmetadataprocessor needs Xcode; widget buttons will not respond in this build" >&2
  exit 0
fi
TOOLCHAIN="$(cd "$(dirname "$PROCESSOR")/../.." && pwd)"
SDK="$(xcrun --show-sdk-path)"
# Match the architecture the widget module in BIN_DIR was built for.
TRIPLE="$(lipo -archs "$BIN_DIR/MeloraWidgets" | awk "{print \$1}")-apple-macos14.0"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/Melora-intents.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
echo '["AppIntent","EntityQuery","AppEntity","TransientEntity","AppEnum","AppShortcutProviding","AppShortcutsProvider","AnyResolverProviding","AppIntentsPackage","DynamicOptionsProvider"]' > "$STAGE/protocols.json"
ls "$PWD"/Sources/MeloraWidgets/*.swift > "$STAGE/sources.txt"
swiftc -c -wmo -parse-as-library -swift-version 5 -sdk "$SDK" -target "$TRIPLE" \
  -I "$BIN_DIR" -I "$BIN_DIR/Modules" -module-name MeloraWidgets @"$STAGE/sources.txt" -o "$STAGE/MeloraWidgets.o" \
  -emit-const-values-path "$STAGE/MeloraWidgets.swiftconstvalues" \
  -Xfrontend -const-gather-protocols-file -Xfrontend "$STAGE/protocols.json"
echo "$STAGE/MeloraWidgets.swiftconstvalues" > "$STAGE/constvalues.txt"
: > "$STAGE/empty.txt"
mkdir -p "$OUTPUT"
"$PROCESSOR" --output "$OUTPUT" --toolchain-dir "$TOOLCHAIN" --module-name MeloraWidgets --sdk-root "$SDK" \
  --xcode-version "$(xcodebuild -version 2>/dev/null | awk '/Build version/ {print $3}' || echo unknown)" \
  --platform-family macOS --deployment-target 14.0 --target-triple "$TRIPLE" \
  --binary-file "$BIN_DIR/MeloraWidgets" --source-file-list "$STAGE/sources.txt" \
  --swift-const-vals-list "$STAGE/constvalues.txt" --metadata-file-list "$STAGE/empty.txt" \
  --static-metadata-file-list "$STAGE/empty.txt" --force --quiet-warnings
test -f "$OUTPUT/Metadata.appintents/extract.actionsdata"
