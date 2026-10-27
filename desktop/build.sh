#!/usr/bin/env bash
# Package the fork's T3 desktop (bundled renderer + preload + main + dormant backend).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
source "$ROOT/scripts/env.sh"
cd "$ROOT/app"
export VITE_BASKULE_UI=1 VITE_BASKULE_HOSTED=1
# Baskule uses Better Auth, never the upstream Clerk/Connect account.
export VITE_CLERK_PUBLISHABLE_KEY= T3CODE_CLERK_PUBLISHABLE_KEY=
VERSION=${BASKULE_VERSION:-0.0.0}
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]] || { echo 'BASKULE_VERSION must be a semantic version' >&2; exit 1; }
pnpm exec vp run dist:desktop:artifact --platform linux --target AppImage --arch x64 --build-version "$VERSION" --output-dir "$ROOT/.run/desktop-package" "$@"
# Publish only the new desktop output. Android has its own release cadence.
mkdir -p "$ROOT/desktop/release"
find "$ROOT/desktop/release" -maxdepth 1 -type f \( -name '*.AppImage' -o -name '*.tar.gz' \) -delete
cp "$ROOT"/.run/desktop-package/*.AppImage "$ROOT/desktop/release/"
(cd "$ROOT/desktop/release" && sha256sum *.AppImage > SHA256SUMS)
