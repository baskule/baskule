# Baskule desktop

Baskule desktop uses the T3 Code Electron app in [`app/apps/desktop`](../app/apps/desktop),
with a bundled renderer, preload, IPC, native menus, browser, and packaged backend.
Local-server startup is disabled by default for hosted use. Automatic updates select
the latest compatible published Baskule release for the selected installation.

On first launch, enter a server address or paste a connection link from
**Settings → Desktop app → Connect a device**. `baskule://connect` links use the queued
OS-link handoff and show the connection form before switching installations.
**Settings → Desktop app → Connect to a server** opens server selection later.

The renderer loads packaged assets at `baskule://app`. The Electron protocol handler
forwards account and space API requests to the selected installation with native-session
cookies. Space WebSockets receive those cookies only when the bundled app opens that
installation's `/s/<id>/ws`. Preview guests use separate partitions. Remote HTML and
redirects cannot become privileged app pages. Provider sign-in opens the system browser
and uses the one-time approval flow.

## State directories

State lives in `~/.baskule/`. Chromium uses `~/.config/baskule-desktop/` on Linux and the
OS application-data folder on Windows/macOS. Development uses `baskule-dev`.
`BASKULE_HOME` overrides the state directory. Ambient `T3CODE_HOME` does not select
Baskule state.

## Build and verify

Prepare the [build environment](../docs/building.md), then run:

```sh
source scripts/env.sh
desktop/check.sh
desktop/build.sh
dbus-run-session -- xvfb-run -a node desktop/verify.mjs
```

`desktop/build.sh` defaults to the repository `VERSION`; `BASKULE_VERSION` overrides it.
It builds a Linux x64 AppImage and update metadata under `desktop/release/`.

Native packaging needs the tool versions in [`Dockerfile`](Dockerfile), Rust, a C/C++
compiler, pkg-config, libsecret and Wayland headers, and ImageMagick. The headless check
also needs GTK, NSS, Xvfb, and D-Bus. Keep deployment configuration and Docker sockets
outside the build container.

The verifier runs the real AppImage with disposable profiles and an ephemeral HTTP/WebSocket
fixture. It checks first-launch discovery, bundled renderer origin, preload IPC, disabled
local startup, sign-in, space-socket cookies, and persisted sign-in after restart. It uses
no real model. Visual acceptance and provider sign-in require separate checks.

For source verification, build hosted web and desktop bundles with
`VITE_BASKULE_HOSTED=1 VITE_BASKULE_UI=1`, prepare Electron with
`node app/apps/desktop/scripts/ensure-electron-runtime.mjs`, and pass `--source` to the
verifier. The normal `app/` `build:desktop` task also stages the client at
`apps/server/dist/client`.

[Hosted workflows](../docs/ci.md) build Windows/macOS packages on native runners.
The Linux check does not verify those packages. The installation's Desktop app settings
link to its version's Linux x64 AppImage on GitHub Releases. Installers are release assets;
server images do not embed them.

## Compatible updates

`app/packages/contracts/release-compatibility.json` declares `version`, `minServer`, and
`minClient`. Update it with `VERSION`. Both minimums default to the release version;
loosening either requires review. Contract edits must touch the declaration; the
`compatibility-noop` PR label overrides that guard for a no-op edit.

The release factory appends the declaration to the previous published release's
`compatibility.json`. Every release carries the full index. Malformed entries, duplicate
versions, and decreasing minimums fail the build.

Desktop selects a newer client only when its `minServer` is satisfied and its version
meets the installation's `minClient`. It never downgrades. A client below `minClient`
requires an update; a client ahead of the supported window reports that the installation
needs an update. Desktop does not change the server.

Compatible updates download in the background. A completed download installs when the
user quits the app; the update control can still restart and install immediately. Closing
the last window on macOS leaves the app running, so use Quit to apply the update.
Before quitting, desktop rechecks compatibility and prepares the cached installer. This
keeps a download from an earlier installation from being applied after switching servers.
Native preparation has a 30-second timeout; a failed preparation allows normal quit.

Linux AppImage updates use the release's generic feed, YAML, and embedded blockmap.
macOS also needs the ZIP and merged arm64/x64 YAML; updates require Developer ID signing
and notarization. Windows updates depend on signing, with the publisher supplied through
`AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`. Unsigned native builds prove packaging only.

## Publish a desktop release

Release maintainers verify the packages and compatibility index before publishing the
factory's draft release. Clients can update only after publication. Preserve published
compatibility history: if a previous release lacks `compatibility.json`, attach an index
from reviewed release history before running the next factory. The factory refuses to
discard that history silently. Keep signing material outside tracked files.

Mobile store apps use their store's update mechanism; the desktop updater does not manage them.
