#!/usr/bin/env bash
# Full-capability production identity, compiled unsigned for the simulator.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
source "$ROOT/scripts/ci/native-version.sh"
OUT="$ROOT/.run/native/ios"
mkdir -p "$OUT"
cd "$ROOT/app/apps/mobile"
export APP_VARIANT=production EXPO_NO_TELEMETRY=1 EXPO_NO_GIT_STATUS=1 NODE_ENV=production
pnpm exec expo prebuild --clean --platform ios --no-install
(cd ios && pod install)
# Select a simulator from the pinned SDK, rather than relying on the host's default.
xcrun simctl list devices available --json > "$OUT/devices.json"
UDID=$(python3 - "$OUT/devices.json" <<'PY'
import json, sys
for runtime, devices in json.load(open(sys.argv[1]))['devices'].items():
    if runtime.endswith('iOS-27-1'):
        for device in devices:
            if device['name'].startswith('iPhone'):
                print(device['udid'])
                sys.exit(0)
sys.exit('No available iOS 27.1 iPhone simulator on this runner')
PY
)
xcodebuild -workspace ios/Baskule.xcworkspace -scheme Baskule -configuration Release \
  -sdk iphonesimulator -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath "$ROOT/.run/ios-derived" -resultBundlePath "$OUT/build.xcresult" \
  -jobs 2 CODE_SIGNING_ALLOWED=NO build 2>&1 | tee "$OUT/xcodebuild.log"
APP="$ROOT/.run/ios-derived/Build/Products/Release-iphonesimulator/Baskule.app"
[[ -d "$APP" ]]
# Simulator launch is smoke evidence, not physical-device or account-flow acceptance.
xcrun simctl boot "$UDID"
trap 'xcrun simctl shutdown "$UDID"' EXIT
xcrun simctl bootstatus "$UDID" -b
xcrun simctl install "$UDID" "$APP"
xcrun simctl launch "$UDID" dev.baskule.app | tee "$OUT/launch.txt"
xcrun simctl io "$UDID" screenshot "$OUT/launch.png"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/Baskule-ios-simulator-unsigned.zip"
printf '%s\n' 'iOS: unsigned Release simulator build and install/launch smoke. No IPA, physical-device acceptance, TestFlight, or App Store submission.' | tee "$OUT/STATUS.txt" >> "$GITHUB_STEP_SUMMARY"

(cd "$OUT" && shasum -a 256 ./*.zip > SHA256SUMS)

printf 'Source release: %s; mobile bundle version: %s; mobile build: %s; commit: %s\n' "$NATIVE_VERSION" "$T3CODE_MOBILE_VERSION" "$BASKULE_MOBILE_BUILD_NUMBER" "${GITHUB_SHA:-local}" >> "$OUT/STATUS.txt"
