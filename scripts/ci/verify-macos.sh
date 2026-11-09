#!/usr/bin/env bash
# Verify the distributed containers, including a Finder-style copy from the DMG.
set -euo pipefail
dmg=${1:?Expected a DMG path}
zip=${2:?Expected a ZIP path}
: "${APPLE_TEAM_ID:?Expected the publisher Apple team ID}"
work=$(mktemp -d)
mounted=false
cleanup() {
  if [[ $mounted == true ]]; then hdiutil detach "$work/mount"; fi
  rm -rf "$work"
}
trap cleanup EXIT
shopt -s nullglob

verify_app() {
  local apps=("$1"/*.app)
  [[ ${#apps[@]} == 1 ]] || { echo "Expected exactly one app in $1" >&2; return 1; }
  codesign --verify --deep --strict --verbose=2 "${apps[0]}"
  local signature
  signature=$(codesign --display --verbose=4 "${apps[0]}" 2>&1)
  grep -Fx "TeamIdentifier=$APPLE_TEAM_ID" <<< "$signature"
  grep -E '^Authority=Developer ID Application: ' <<< "$signature"
  xcrun stapler validate "${apps[0]}"
  spctl --assess --type execute --verbose=4 "${apps[0]}"
}

mkdir "$work/mount" "$work/installed" "$work/update"
hdiutil verify "$dmg"
hdiutil attach "$dmg" -readonly -nobrowse -mountpoint "$work/mount"
mounted=true
apps=("$work/mount"/*.app)
[[ ${#apps[@]} == 1 ]] || { echo 'Expected exactly one app in the DMG' >&2; exit 1; }
ditto "${apps[0]}" "$work/installed/$(basename "${apps[0]}")"
verify_app "$work/installed"
hdiutil detach "$work/mount"
mounted=false
ditto -x -k "$zip" "$work/update"
verify_app "$work/update"
