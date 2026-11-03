# Baskule desktop

The shipped desktop is the T3 Code Electron app in [`app/apps/desktop`](../app/apps/desktop), with its bundled
renderer, preload, IPC, native menus, window lifecycle, browser implementation, and packaged server backend.
Local-server startup defaults to disabled for the hosted beta. The backend, SSH and WSL implementation remain
available for future local capabilities. Automatic updates select the latest compatible published Baskule release for the installation in use.

On first launch, enter a server address or paste a connection link from the installation's **Settings → Desktop
app → Connect a device** section. `baskule://connect` links use T3's queued OS-link handoff and show the connection
form before switching installations. **Settings → Desktop app → Connect to a server** opens server selection later,
including on anonymous installations.

The renderer loads packaged assets at `baskule://app`; it does not load the server's website. The existing Electron
protocol handler forwards account and space API requests to the selected installation using the native session's
cookies. Space WebSocket upgrades receive those cookies only when initiated by the bundled app and addressed to
that installation's `/s/<id>/ws`. Preview guests have separate partitions. Remote HTML and redirects cannot become
privileged app pages. Provider sign-in opens the system browser and uses the existing one-time approval flow.

State lives in `~/.baskule/` and Chromium's profile in `~/.config/baskule-desktop/` on Linux (the OS application-data
folder on Windows/macOS). Development uses `baskule-dev`. `BASKULE_HOME` overrides the state directory; ambient `T3CODE_HOME` is ignored
so launching Baskule from a T3 terminal cannot select T3's live state. No T3 profile or old shell data is imported. Users reconnect
after installing this build. Remove the retired shell profile (`~/.config/Baskule/` on Linux) when replacing
the old client. The server does not need a wipe for this desktop change.

## Build and verify

From the umbrella checkout with dependencies installed:

```sh
source scripts/env.sh
(cd app && pnpm install --frozen-lockfile)
desktop/check.sh                         # targeted native transport/shell tests, typecheck, preload checks
desktop/build.sh                         # development version 0.0.0; set BASKULE_VERSION for a release
# No real model or live installation is used by this check:
dbus-run-session -- xvfb-run -a node desktop/verify.mjs
```

For a source-only check, build the hosted web and desktop bundles with `VITE_BASKULE_HOSTED=1 VITE_BASKULE_UI=1`
(the normal `app/` `build:desktop` task also stages the client at `apps/server/dist/client`), ensure Electron with
`node app/apps/desktop/scripts/ensure-electron-runtime.mjs`, then run the same verifier with `--source`. The verifier
defaults to the packaged application. Both modes create disposable profiles and an ephemeral local server.

Native packaging needs Node 26.12.1, pnpm 12.14.0, Rust 1.95.0, a C/C++ compiler, pkg-config, libsecret and Wayland
headers, and ImageMagick. The headless packaged-app check also needs GTK, NSS, Xvfb and D-Bus. [`Dockerfile`](Dockerfile)
provides these tools on Ubuntu 24.04. Keep Docker sockets and deployment configuration outside the build container.

The local verifier runs the real AppImage under Xvfb with an ephemeral HTTP/WebSocket fixture. It checks first-launch
discovery, the bundled renderer origin, preload IPC, disabled local startup, login, space-socket cookies, and persisted
login after restart. This is functional headless verification; visual acceptance and real-provider login remain separate
checks. [Hosted workflows](../docs/ci.md) run this check and build Windows/macOS packages on their native runners.
This Linux check does not build or verify those other packages.

Settings → Desktop app links to the Linux x64 AppImage on the GitHub release matching the running installation's
version. The release factory publishes that AppImage separately; server images do not embed app installers.
Add other platforms to the web client's download list when their installable release assets are available.

## Compatible updates

`app/packages/contracts/release-compatibility.json` declares this release's `version`, `minServer` and `minClient`.
Both minimums default to the release version; loosening either is an explicit reviewed edit. Bump the declaration
with `VERSION`. Contract edits must touch it; the `compatibility-noop` PR label overrides the guard for no-op edits.
The release factory validates and appends this entry to the previous published release's `compatibility.json`.
Every release carries the full index. A malformed entry, duplicate version or decreasing minimum fails the build.

Desktop selects the newest newer client whose `minServer` is satisfied by the selected installation and whose
version meets that server's `minClient`. It never downgrades. Clients below `minClient` must update; clients ahead
of an installation's supported window report that the installation needs an update. Desktop takes no server action.
The existing update toast and Settings controls handle check, download, progress and restart.

Linux AppImage updates use the versioned release's generic feed and YAML, with a blockmap embedded in the AppImage. macOS also needs the ZIP and
merged arm64/x64 YAML; real updates require Developer ID signing and notarization. Windows real updates depend on
signing, with the publisher identity supplied by `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`. No signing identity or
credential is hardcoded. Unsigned native CI builds prove packaging only.

The factory creates draft releases. **An owner must publish the release before clients can update.** The owner
keeps publication manual after verification. Installers remain per-platform GitHub release-asset links and
are never embedded in celld images. Mobile store apps cannot self-update; compatible store-update guidance is follow-up work.

Build the first published beta through this pipeline; do not publish a pre-change draft. Update an alpha installation
before connecting a beta desktop: pre-beta servers are outside the declared window and lack `minClient`. If a
published release lacks `compatibility.json`, its owner must attach an index from reviewed release history before
running the next release factory. The factory refuses to silently discard that history.
