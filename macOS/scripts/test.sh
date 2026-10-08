#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
DEVELOPER_DIR_PATH="$(xcode-select -p)"
# The standalone Command Line Tools keep Testing outside the default search path.
if [[ "$DEVELOPER_DIR_PATH" == */CommandLineTools && -d "$DEVELOPER_DIR_PATH/Library/Developer/Frameworks/Testing.framework" ]]; then
    swift test --build-system native --disable-xctest \
        -Xswiftc "-F$DEVELOPER_DIR_PATH/Library/Developer/Frameworks" \
        -Xswiftc -load-plugin-library \
        -Xswiftc "$DEVELOPER_DIR_PATH/usr/lib/swift/host/plugins/testing/libTestingMacros.dylib" \
        -Xlinker -rpath -Xlinker "$DEVELOPER_DIR_PATH/Library/Developer/Frameworks" "$@"
else
    swift test --disable-xctest "$@"
fi
