#!/usr/bin/env bash
# Local Expo/Gradle build; no EAS account or Android emulator.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
source "$ROOT/scripts/ci/native-version.sh"
OUT="$ROOT/.run/native/android"
mkdir -p "$OUT"
cd "$ROOT/app/apps/mobile"
export APP_VARIANT=production EXPO_NO_TELEMETRY=1 EXPO_NO_GIT_STATUS=1 NODE_ENV=production
export ANDROID_SDK_ROOT="${ANDROID_HOME:?Android SDK required}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$ROOT/.run/gradle}"
if [[ "${NATIVE_SIGN:-false}" == true ]]; then
  : "${ANDROID_KEYSTORE_BASE64:?Missing Android release keystore}"
  : "${ANDROID_KEYSTORE_PASSWORD:?Missing Android keystore password}"
  : "${ANDROID_KEY_ALIAS:?Missing Android key alias}"
  : "${ANDROID_KEY_PASSWORD:?Missing Android key password}"
  signing=$(mktemp -d)
  trap 'rm -rf "$signing"' EXIT
  chmod 700 "$signing"
  printf '%s' "$ANDROID_KEYSTORE_BASE64" | base64 --decode > "$signing/release.jks"
  printf 'storeFile=%s\nstorePassword=%s\nkeyAlias=%s\nkeyPassword=%s\n' \
    "$signing/release.jks" "$ANDROID_KEYSTORE_PASSWORD" "$ANDROID_KEY_ALIAS" "$ANDROID_KEY_PASSWORD" > "$signing/keystore.properties"
  chmod 600 "$signing"/*
  BASKULE_KEYSTORE_PROPERTIES="$signing/keystore.properties" OUT="$OUT" \
    BASKULE_ABIS=arm64-v8a BASKULE_GRADLE_WORKERS=2 ./scripts/baskule-build-apk.sh
  status=owner-key-signed
else
  pnpm exec expo prebuild --clean --platform android --no-install
  (cd android && ./gradlew assembleRelease --no-daemon --max-workers=2 -PreactNativeArchitectures=arm64-v8a)
  # Expo's Release template uses its generated debug certificate. Name it honestly.
  cp android/app/build/outputs/apk/release/app-release.apk "$OUT/Baskule-android-arm64-release-debug-signed.apk"
  "$ANDROID_HOME/build-tools/37.0.0/apksigner" verify --verbose --print-certs "$OUT"/*.apk
  status=debug-signed
fi
printf 'Android arm64 Release: %s. Compile/signature verification only; no emulator or device acceptance.\n' "$status" | tee "$OUT/STATUS.txt" >> "$GITHUB_STEP_SUMMARY"
(cd "$OUT" && sha256sum ./*.apk > SHA256SUMS)

printf 'Source release: %s; mobile bundle version: %s; mobile build: %s; commit: %s\n' "$NATIVE_VERSION" "$T3CODE_MOBILE_VERSION" "$BASKULE_MOBILE_BUILD_NUMBER" "${GITHUB_SHA:-local}" >> "$OUT/STATUS.txt"
