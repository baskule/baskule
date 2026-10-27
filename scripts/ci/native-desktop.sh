#!/usr/bin/env bash
# Use T3's artifact builder and its built-in payload/runtime verification.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
source "$ROOT/scripts/ci/native-version.sh"
PLATFORM=${1:?mac or win}
ARCH=${2:?arm64 or x64}
VERSION=$NATIVE_VERSION
OUT="$ROOT/.run/native/desktop-$PLATFORM-$ARCH"
mkdir -p "$OUT"
cd "$ROOT/app"
export VITE_BASKULE_UI=1 VITE_BASKULE_HOSTED=1
export VITE_CLERK_PUBLISHABLE_KEY= T3CODE_CLERK_PUBLISHABLE_KEY= T3CODE_TELEMETRY_ENABLED=false
args=(--platform "$PLATFORM" --arch "$ARCH" --build-version "$VERSION" --output-dir "$OUT" --verbose)
case "$PLATFORM" in
  mac) args+=(--target dmg) ;;
  win) args+=(--target nsis) ;;
  *) echo 'Expected mac or win' >&2; exit 1 ;;
esac
status=unsigned
if [[ "${NATIVE_SIGN:-false}" == true ]]; then
  if [[ "$PLATFORM" == mac ]]; then
    for key in CSC_LINK CSC_KEY_PASSWORD APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_TEAM_ID MACOS_PROVISIONING_PROFILE T3CODE_CLERK_PASSKEY_RP_DOMAINS; do
      [[ -n "${!key:-}" ]] || { echo "Missing signing configuration: $key" >&2; exit 1; }
    done
    signing=$(mktemp -d)
    trap 'rm -rf "$signing"' EXIT
    chmod 700 "$signing"
    printf '%s' "$APPLE_API_KEY" > "$signing/AuthKey.p8"
    printf '%s' "$MACOS_PROVISIONING_PROFILE" | base64 -D > "$signing/profile.provisionprofile"
    chmod 600 "$signing"/*
    security cms -D -i "$signing/profile.provisionprofile" >/dev/null
    export APPLE_API_KEY="$signing/AuthKey.p8" T3CODE_APPLE_TEAM_ID="$APPLE_TEAM_ID" T3CODE_MACOS_PROVISIONING_PROFILE="$signing/profile.provisionprofile"
  else
    for key in AZURE_TENANT_ID AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_TRUSTED_SIGNING_ENDPOINT AZURE_TRUSTED_SIGNING_ACCOUNT_NAME AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME AZURE_TRUSTED_SIGNING_PUBLISHER_NAME; do
      [[ -n "${!key:-}" ]] || { echo "Missing signing configuration: $key" >&2; exit 1; }
    done
  fi
  args+=(--signed)
  status=owner-signed
fi
pnpm exec vp run dist:desktop:artifact "${args[@]}"
# On native Windows this executes the Electron fff native-load probe and the
# server.asar self-containment probe inside validateWindowsPackagedPayload.
printf 'Desktop %s/%s: %s. T3 native packager; Windows includes packaged runtime probes. WSL archive omitted for the hosted alpha.\n' "$PLATFORM" "$ARCH" "$status" | tee "$OUT/STATUS.txt" >> "$GITHUB_STEP_SUMMARY"

(cd "$OUT" && node --input-type=module <<'JS'
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const files = readdirSync('.').filter(name => /\.(dmg|exe)$/.test(name));
if (!files.length) throw new Error('No native desktop package was produced');
writeFileSync('SHA256SUMS', files.map(name => `${createHash('sha256').update(readFileSync(name)).digest('hex')}  ${name}\n`).join(''));
JS
)

printf 'Source release: %s; mobile bundle version: %s; mobile build: %s; commit: %s\n' "$NATIVE_VERSION" "$T3CODE_MOBILE_VERSION" "$BASKULE_MOBILE_BUILD_NUMBER" "${GITHUB_SHA:-local}" >> "$OUT/STATUS.txt"
