#!/usr/bin/env bash
# Focused upstream shell coverage plus Baskule's native API boundary; no services or model calls.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
source "$ROOT/scripts/env.sh"
cd "$ROOT/app/apps/desktop"
../../node_modules/.bin/tsc-rs --noEmit
../../node_modules/.bin/vp test run src/app/BaskuleConnection.test.ts src/app/DesktopEnvironment.test.ts src/app/DesktopUserData.test.ts src/app/DesktopEarlyElectronStartup.test.ts src/settings/DesktopAppSettings.test.ts src/electron/ElectronProtocol.test.ts scripts/verify-preload-bundle.test.mjs scripts/main-process-bundle.test.mjs

cd "$ROOT/app"
pnpm exec vp test run scripts/build-desktop-artifact.test.ts
(cd packages/client-runtime && ../../node_modules/.bin/vp test run src/environment/endpoint.test.ts)
