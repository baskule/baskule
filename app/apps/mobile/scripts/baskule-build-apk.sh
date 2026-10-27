#!/usr/bin/env bash
# baskule: builds the Baskule Android APK (release, arm64-v8a) without Android Studio.
#
#   apps/mobile/scripts/baskule-build-apk.sh [--no-prebuild]
#
# Env:
#   JAVA_HOME, ANDROID_HOME       JDK 17+ and an Android SDK (platforms;android-37.0, build-tools;37.0.0,
#                                 ndk;27.1.12297006, cmake;3.22.1, platform-tools). See BASKULE-ANDROID.md.
#   BASKULE_KEYSTORE_PROPERTIES  a properties file with storeFile, storePassword, keyAlias, keyPassword:
#                                 required: the release APK is explicitly signed with that key.
#   BASKULE_ABIS                 comma-separated ABIs (default arm64-v8a: every phone of the last years)
#   BASKULE_GRADLE_WORKERS       Gradle workers (default 2: the build host is shared)
#   OUT                           where to copy the APK (default apps/mobile/build-out/)
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
cd "$HERE"
: "${JAVA_HOME:?set JAVA_HOME to a JDK 17+}"
: "${ANDROID_HOME:?set ANDROID_HOME to the Android SDK}"
: "${BASKULE_KEYSTORE_PROPERTIES:?set BASKULE_KEYSTORE_PROPERTIES to the release signing properties}"
export PATH="$JAVA_HOME/bin:$PATH" ANDROID_SDK_ROOT="$ANDROID_HOME"
export APP_VARIANT=production EXPO_NO_GIT_STATUS=1 EXPO_NO_TELEMETRY=1 NODE_ENV=production
ABIS=${BASKULE_ABIS:-arm64-v8a}
WORKERS=${BASKULE_GRADLE_WORKERS:-2}
OUT=${OUT:-$HERE/build-out}

if [[ "${1:-}" != --no-prebuild ]]; then
  nice -n 10 npx expo prebuild --clean --platform android
fi

cd android
nice -n 10 ./gradlew assembleRelease --no-daemon --max-workers="$WORKERS" \
  -PreactNativeArchitectures="$ABIS"

VERSION=$(cd .. && APP_VARIANT=production npx expo config --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version)}catch{console.log("0.0.0")}})')
mkdir -p "$OUT"
APK="$OUT/Baskule-$VERSION-android.apk"
cp app/build/outputs/apk/release/app-release.apk "$APK"
APKSIGNER=$(ls -d "$ANDROID_HOME"/build-tools/*/apksigner | sort -V | tail -1)
if [[ -n "${BASKULE_KEYSTORE_PROPERTIES:-}" ]]; then
  # Sign the copied artifact explicitly: Expo's generated Gradle project uses its debug key.
  # Password files keep credentials out of command-line arguments and build logs.
  prop() { sed -n "s/^$1=//p" "$BASKULE_KEYSTORE_PROPERTIES"; }
  SIGNING_DIR=$(mktemp -d)
  trap 'rm -rf "$SIGNING_DIR"' EXIT
  STORE_FILE=$(prop storeFile)
  KEY_ALIAS=$(prop keyAlias)
  [[ -n "$STORE_FILE" && -f "$STORE_FILE" && -n "$KEY_ALIAS" ]] || { echo "Invalid signing properties" >&2; exit 1; }
  printf '%s\n' "$(prop storePassword)" > "$SIGNING_DIR/store-pass"
  printf '%s\n' "$(prop keyPassword)" > "$SIGNING_DIR/key-pass"
  chmod 600 "$SIGNING_DIR/store-pass" "$SIGNING_DIR/key-pass"
  "$APKSIGNER" sign --ks "$STORE_FILE" --ks-key-alias "$KEY_ALIAS" \
    --ks-pass "file:$SIGNING_DIR/store-pass" --key-pass "file:$SIGNING_DIR/key-pass" "$APK"
fi
"$APKSIGNER" verify --verbose --print-certs "$APK"
ls -l "$APK"
sha256sum "$APK"
