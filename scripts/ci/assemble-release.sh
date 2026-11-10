#!/usr/bin/env bash
set -euo pipefail
: "${VERSION:?Release version is required}"
mkdir release
# Publish only what people install or update from. Image archives and bundles stay CI artifacts;
# Compose and Helm pull the images from GHCR.
for kind in backend linux-apps; do
  (cd "artifacts/$kind" && sha256sum -c SHA256SUMS)
done
tar -czf "release/backend-$VERSION-metadata.tar.gz" --exclude='*.tar.gz' -C artifacts/backend .
cp artifacts/linux-apps/*.AppImage artifacts/linux-apps/*.yml artifacts/linux-apps/compatibility.json release/
cp artifacts/backend/*.yml artifacts/backend/*.env.example artifacts/backend/baskule-*.tgz release/
for directory in artifacts/native/*; do
  (cd "$directory" && sha256sum -c SHA256SUMS)
  [[ $directory != *ios-simulator* ]] || continue
  while IFS= read -r -d '' package; do
    if [[ $package == */latest-mac.yml || $package == */nightly-mac.yml ]]; then continue; fi
    destination="release/$(basename "$package")"
    [[ ! -e $destination ]] || { echo "Duplicate release asset: $destination" >&2; exit 1; }
    cp "$package" "$destination"
  done < <(find "$directory" -type f \( -name '*.apk' -o -name '*.dmg' -o -name '*.exe' -o -name '*.zip' -o -name '*.blockmap' -o -name '*.yml' \) -print0)
done
for channel in latest nightly; do
  if [[ -f artifacts/native/native-desktop-mac-arm64-$VERSION/$channel-mac.yml ]]; then
    node app/scripts/merge-update-manifests.ts --platform mac \
      "artifacts/native/native-desktop-mac-arm64-$VERSION/$channel-mac.yml" \
      "artifacts/native/native-desktop-mac-x64-$VERSION/$channel-mac.yml" "release/$channel-mac.yml"
  fi
done
(cd release && sha256sum * > SHA256SUMS)
find release -type f -size +2147483647c -print -quit | while read -r oversized; do
  echo "Release asset exceeds GitHub's 2 GiB limit: $oversized" >&2
  exit 1
done
