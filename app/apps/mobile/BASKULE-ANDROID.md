# Baskule Android client (0.2): build, install, test

The Android app is T3 Code's Expo app (`apps/mobile`, MIT, Copyright (c) 2026 T3 Tools Inc.), rebranded and reduced to
the Baskule scope. Connect to a server first: its authentication configuration determines whether to show password login, system-browser provider login, or enter the shared anonymous test workspace. External provider login requires approving **Connect app** in the browser and returning to the app. Anonymous connections store and send no authentication token.

## What 0.2 changes (on top of 0.1)

| Area           | 0.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Where                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Sign-in        | A sign-in screen (email, password, server address) replaces the app until someone is signed in. It calls Better Auth `POST /auth/sign-in/email` and keeps the `set-auth-token` bearer in the OS keystore (expo-secure-store). Errors: wrong password, deactivated (403), rate limit (429), network.                                                                                                                                                                                                                                                                                             | `src/baskule/BaskuleLoginScreen.tsx`, `api.ts`, `session.ts`, `App.tsx`                                             |
| Server         | None built in (0.3). The sign-in screen scans a connection QR code (web: Apps → Connect a device), reads a pasted link or an opened `baskule://connect?server=…&code=…` link, shows the server's name (`/.well-known/baskule`) and asks before redeeming the one-time code (`POST /auth/connect/redeem`). Email + password and a typed address still work (https; plain http only on private networks). An invitation link opens in the browser. One server is active at a time. Opening a connection link while signed in asks before replacing it; cancellation keeps the current connection. | `src/baskule/BaskuleLoginScreen.tsx`, `config.ts`, `api.ts`, `session.ts`                                           |
| Spaces         | `GET /api/baskule/me` with the bearer (on start, every 60 s, on foreground). One T3 environment per space at `<server>/s/<id>/`, registered as a **platform** environment (the server owns the list; it can't be removed by hand). The environment id comes from the space's descriptor and is cached on the device, as is the last `/me`, so spaces show offline.                                                                                                                                                                                                                              | `src/baskule/spaces.ts`, `registrations.ts`, `connection/platform.ts`                                               |
| Auth on `/s/*` | Shared client-runtime mode `BearerConnectionProfile.authorization: "front-session"`: the bearer goes in `Authorization` on every HTTP request, on the descriptor and on the WebSocket upgrade (`PreparedConnection.socketHeaders`). No T3 token exchange, no socket ticket, no learned alternate routes. The phone's WebSocket constructor passes handshake headers (React Native's third argument).                                                                                                                                                                                            | `packages/client-runtime/src/connection/{catalog,model,resolver,routes}.ts`, `rpc/session.ts`, `src/lib/runtime.ts` |
| Account        | Settings → **Account**: name and email (admin badge), organisation and server address, Spaces (→ the environment list), **Sign out** (with confirmation; `POST /auth/sign-out`, then the device forgets the token, `/me` and the spaces). A 401 from the server (signed out everywhere, deactivated, deleted) signs the phone out with a notice.                                                                                                                                                                                                                                                | `features/settings/SettingsRouteScreen.tsx`, `src/baskule/session.ts`                                               |
| Removed        | 0.1's no-auth auto-connect (`BaskuleAutoConnect`, the dummy pairing token) and its integration test.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |                                                                                                                     |
| Version        | `0.2.0` (`T3CODE_MOBILE_VERSION` overrides it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `app.config.ts`                                                                                                     |

**Kept from 0.1:** name "Baskule", package `dev.baskule.app`, schemes `baskule*`, no T3 services (EAS, OTA, Clerk,
relay), the feature flags (no PR tab, terminal, git, previews, voice, extended settings, project picker), Chats +
Settings bottom navigation, cleartext HTTP allowed (Tailscale alpha).

**Cookies:** every Baskule account call uses `credentials: "omit"` (React Native → OkHttp `NO_COOKIES`), so the session
cookie the server also sets never enters the shared cookie jar. That matters: React Native's WebSocket module sends
the jar's cookies, and the front refuses an upgrade that carries a `baskule.*` cookie without an `Origin`.

## Prebuilt APK

If your administrator has published an Android build, download it from your installation's **Apps** page or
`/downloads/`. Build artifacts are not included in this repository. Publishing instructions are in the umbrella
[desktop guide](../../../desktop/README.md).

### Install on the phone

1. Install **Tailscale** from the Play Store and log in to the same tailnet as the server.
2. Download the APK on the phone from your installation's **Apps** page, or copy it
   over USB, or `adb install -r Baskule-0.2.0-android.apk`.
3. Allow "Install unknown apps" for the browser or file manager when Android asks.
4. Open **Baskule**, enter your server address and sign in with the account your administrator created.

An APK signed with another key (an earlier debug build) must be uninstalled first.

## What to test on the phone

1. **Sign-in:** wrong password shows "Wrong email or password."; with Tailscale off, "Cannot reach the server…";
   the right password opens the chat list.
2. **Spaces:** Settings → Account → Spaces lists Personal and every team space. New chat → the space picker under
   the composer lists them; a chat started in a team space appears for the other members (web).
3. **Live chat:** send a message, watch the answer stream; open the same chat on the web and send from one side.
4. **Persistence:** kill the app and reopen: still signed in, chats there. With Tailscale off, the cached chats
   show; turning Tailscale on reconnects on return to the app.
5. **Revocation:** from the web admin, "Sign out everywhere" for this person: within a minute (or on return to the
   app) the phone goes back to the sign-in screen with a notice.
6. **Sign out:** Settings → Account → Sign out → the sign-in screen; signing in as someone else shows only their spaces.
7. **Files and attachments:** attach a photo; open a file the agent wrote (folder icon in the chat header).
8. **Hidden features:** no PRs tab, terminal, git buttons, mic button or extra settings pages.

## Build it yourself

### Toolchain (user-local, no root, no services)

What the build host used (2026-10-23), all under `baskule/.tools/`:

```sh
T=baskule/.tools
# JDK 21 (Temurin): AGP 9.2 needs 17+
curl -sSL -o jdk21.tar.gz "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse"
mkdir -p $T/jdk21 && tar -xzf jdk21.tar.gz -C $T/jdk21 --strip-components=1
# Android command-line tools (sdkmanager 23 uses '/' or ';' in package names)
curl -sSL -o cmdline.zip https://dl.google.com/android/repository/commandlinetools-linux-16111833_latest.zip
mkdir -p $T/android-sdk/cmdline-tools && unzip -q cmdline.zip -d $T/android-sdk/cmdline-tools
mv $T/android-sdk/cmdline-tools/cmdline-tools $T/android-sdk/cmdline-tools/latest
export JAVA_HOME=$T/jdk21 ANDROID_HOME=$T/android-sdk PATH=$T/jdk21/bin:$PATH
yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --sdk_root=$ANDROID_HOME --licenses
$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --sdk_root=$ANDROID_HOME \
  "platform-tools" "platforms;android-37.0" "platforms;android-36" "build-tools;37.0.0" "build-tools;36.0.0" \
  "ndk;27.1.12297006" "cmake;3.22.1"
```

React Native 0.88 pins compileSdk 37, build-tools 37.0.0 and NDK 27.1.12297006
(`node_modules/react-native/gradle/libs.versions.toml`). The SDK takes about 2.8 GB, Gradle's cache several more
(`GRADLE_USER_HOME=baskule/.tools/gradle-home` keeps it out of `~/.gradle`).

Node and pnpm as for the rest of the fork: `source baskule/scripts/env.sh` (Node 24, pnpm 11), then `CI=1 pnpm install`
at the fork's root.

### Release signing key (required)

```sh
K=baskule/.tools/android-keystore; mkdir -p $K && chmod 700 $K
export PW=$(openssl rand -base64 18 | tr -d '/+=')
keytool -genkeypair -keystore $K/baskule-release.jks -alias baskule -keyalg RSA -keysize 3072 -validity 10000 \
  -storepass:env PW -keypass:env PW -dname "CN=Baskule, O=Baskule, C=FR"
printf 'storeFile=%s\nstorePassword=%s\nkeyAlias=baskule\nkeyPassword=%s\n' "$PWD/$K/baskule-release.jks" "$PW" "$PW" \
  > $K/keystore.properties; chmod 600 $K/*
unset PW
```

Never commit the keystore or its properties (`.tools/` is gitignored). Keep a backup: updates of an installed app must
be signed with the same key. The helper requires these properties, explicitly signs the copied APK with `apksigner`,
and fails if signing or verification fails. Temporary password files keep signing secrets out of command arguments.

### Build

```sh
cd baskule/<fork checkout>/apps/mobile
export JAVA_HOME=... ANDROID_HOME=... GRADLE_USER_HOME=baskule/.tools/gradle-home
export BASKULE_KEYSTORE_PROPERTIES=baskule/.tools/android-keystore/keystore.properties
./scripts/baskule-build-apk.sh        # expo prebuild --clean + gradlew assembleRelease (arm64-v8a, 2 workers)
# -> build-out/Baskule-0.2.0-android.apk (+ apksigner certificate and sha256)
```

Options: `--no-prebuild` reuses `android/`; `BASKULE_ABIS=arm64-v8a,armeabi-v7a` for old 32-bit phones;
`BASKULE_GRADLE_WORKERS`. The first build downloads
Gradle 9.4.1 and the Maven dependencies and compiles every native module.

### Other ways

- **Connected phone, debug loop:** `pnpm android` (= prebuild + `expo run:android`), or `pnpm android:dev` for the dev
  client (Metro must be reachable from the phone).
- **EAS local build:** `eas build --local -p android --profile preview:dev` under your own Expo account
  (`EAS_PROJECT_ID`, `EAS_OWNER`).

No App Store or Google Play submission target is configured. Store publication requires your own application
registration and submission configuration; the TestFlight build profile uses the configured app version.

## Verification on the build host

- **Unit tests** (`vp test run --project unit src/baskule`): the API client (bearer from `set-auth-token`, error
  kinds, `credentials: "omit"`), URL helpers, the space registrations and the authenticated descriptor read.
  Client-runtime: a resolver test for `front-session` (header auth, descriptor with the bearer, no ticket).
- **Integration test against a real Baskule 0.2 server** (`platform/dev.sh`):
  `BASKULE_TEST_SERVER_URL=http://127.0.0.1:47800 BASKULE_TEST_EMAIL=... BASKULE_TEST_PASSWORD=... vp test run --project unit src/baskule/frontSession`.
  It signs in like the phone (no `Sec-Fetch-*` headers), reads `/me`, and for every space runs the shared resolver
  and opens the real RPC session (WebSocket upgrade with `Authorization`) up to the space's server config snapshot.
- `tsc-rs --noEmit` on `apps/mobile` and `packages/client-runtime` is clean; `vp lint` on the touched files is clean.
- The alpha APK was built on the host. **It was not run on a device or emulator** (no KVM-backed
  emulator was set up on the shared host): treat the first install as a test.

## Known risks

- Never run on a device: native-module or runtime issues (e.g. the React Native WebSocket header path) would show
  only there. The JS paths are covered by the tests above.
- A space whose cell is asleep answers its descriptor slowly the first time; the app retries every 10 s.
- A session unused for 7 days expires (Better Auth default; use extends it), then the phone asks to sign in again.
- The Agent Activity widget is registered by `expo-widgets` and uses the Baskule symbol.
- Some deeper screens say "thread" or "project".
