# Build and connect the Baskule Android app

The Android client connects to a Baskule installation with server accounts and spaces.
It uses package `dev.baskule.app` and the `baskule` navigation scheme for production;
development and preview variants use separate identifiers. No server address or T3 service
account is built in. EAS builds and OTA updates are optional and require an operator's own
`EAS_PROJECT_ID`, `EAS_OWNER` and `EXPO_UPDATES_URL` configuration.

## Connect to an installation

Release APKs are attached to [Baskule releases](https://github.com/baskule/baskule/releases).
Download the APK on the phone, or install a local build with:

```sh
adb install -r /path/to/Baskule-<version>-android.apk
```

Android may ask you to allow installation from the browser or file manager. Updates require
the same signing key. Uninstalling an app to change keys also deletes its local data.

Open Baskule and enter your server address. The server determines the available sign-in modes:

- Email and password, when password sign-in is enabled.
- Provider sign-in in the system browser. The app creates a native-login request, opens its URL,
  and polls for completion. Sign in with the provider and approve **Connect app** before returning
  to the app. The endpoints are `/api/baskule/native-login/request` and `/api/baskule/native-login/poll`.
- Anonymous access, when enabled by the server. The app stores no authentication token.

HTTPS is supported; plain HTTP is restricted to private networks. You can also scan the QR
code under the web app's **Settings → Desktop app → Connect a device**, paste its link, or open a
`baskule://connect?server=…&code=…` link. The app shows the server name before redeeming the
one-time code. One server is active at a time; replacing an existing connection requires confirmation.

For authenticated accounts, the app stores the bearer in the OS keystore and sends it on
space HTTP requests and WebSocket upgrades. React Native shares its cookie jar with WebSockets,
so account requests use `credentials: "omit"`: an upgrade carrying a `baskule.*` cookie without
`Origin` is refused. The server controls the list of spaces. A revoked or expired session returns the app to sign-in. Use
**Settings > Account > Sign out** to end the session and clear its local registration.

## Push notifications

Baskule sends Android background notifications through FCM. Follow
[Background notifications](../../../docs/background-push-integration.md) for administrator setup,
then the [Firebase app-build steps](../../docs/operations/android-notifications.md#firebase-and-app-build)
and [native-module checks](../../docs/operations/android-notifications.md#android-compatibility-and-automated-checks).
Supply a matching `google-services.json` through `T3CODE_ANDROID_GOOGLE_SERVICES_FILE` at
prebuild and build a new native binary. JavaScript-only updates cannot add the Firebase
configuration or native handler. Receipt and taps still require device verification.
Baskule push does not require the upstream Clerk or T3 Connect relay setup.

## Prepare the build tools

All repository paths below are relative to the Baskule repository root unless a step changes
its working directory. Start at that root:

```sh
scripts/worktree setup
source scripts/env.sh
BASKULE_ROOT="$PWD"
```

Install JDK 21 and Android command-line tools, then set their absolute locations:

```sh
export JAVA_HOME=/absolute/path/to/jdk-21
export ANDROID_HOME=/absolute/path/to/android-sdk
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
export GRADLE_USER_HOME="$BASKULE_ROOT/.run/android-gradle"
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" --licenses
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" \
  "platform-tools" "platforms;android-37.0" "platforms;android-36" \
  "build-tools;37.0.0" "build-tools;36.0.0" \
  "ndk;27.1.12297006" "cmake;3.22.1"
```

The locked React Native toolchain defines SDK and NDK versions in
`app/apps/mobile/node_modules/react-native/gradle/libs.versions.toml`. Native builds need several GB of
SDK files and Gradle cache. Keep generated tools and signing material outside tracked files.

## Create a signing key

Use your own signing identity; keep the same key for updates. From the repository root,
choose a private directory outside the checkout. Replace the example identity before running:

```sh
SIGNING_DIR="$HOME/.local/share/baskule/android-signing"
mkdir -p "$SIGNING_DIR"
chmod 700 "$SIGNING_DIR"
read -r -s -p 'Signing password: ' BASKULE_SIGNING_PASSWORD
printf '\n'
export BASKULE_SIGNING_PASSWORD
keytool -genkeypair -keystore "$SIGNING_DIR/release.jks" -alias baskule \
  -keyalg RSA -keysize 3072 -validity 10000 \
  -storepass:env BASKULE_SIGNING_PASSWORD -keypass:env BASKULE_SIGNING_PASSWORD \
  -dname "CN=Your Name, O=Your Organization, C=US"
printf 'storeFile=%s\nstorePassword=%s\nkeyAlias=baskule\nkeyPassword=%s\n' \
  "$SIGNING_DIR/release.jks" "$BASKULE_SIGNING_PASSWORD" "$BASKULE_SIGNING_PASSWORD" \
  > "$SIGNING_DIR/keystore.properties"
chmod 600 "$SIGNING_DIR/release.jks" "$SIGNING_DIR/keystore.properties"
unset BASKULE_SIGNING_PASSWORD
export BASKULE_KEYSTORE_PROPERTIES="$SIGNING_DIR/keystore.properties"
```

Back up the key and properties securely. The build helper signs the copied APK explicitly
and fails if signing or verification fails. It uses temporary password files to keep
signing secrets out of command arguments.

## Build the APK

In the same shell, change from the repository root to the mobile package:

```sh
cd "$BASKULE_ROOT/app/apps/mobile"
./scripts/baskule-build-apk.sh
# Output: build-out/Baskule-<version>-android.apk, certificate details and SHA-256.
```

The helper runs Expo prebuild and Gradle `assembleRelease` for `arm64-v8a` with two workers.
`--no-prebuild` reuses the generated `android/` project. Set `BASKULE_ABIS` to a comma-separated
ABI list or `BASKULE_GRADLE_WORKERS` to change the worker limit. The first build downloads
Gradle and Maven dependencies and compiles native modules.

For a connected-phone development loop, run `pnpm android:dev` from `app/apps/mobile`.
The phone must reach Metro. For an optional EAS local build, configure your own Expo project
and run `eas build --local -p android --profile preview:dev` from the same directory.
Store publication requires your own application registration and submission configuration.

## Verify the client

Automated JavaScript tests cover URL parsing, bearer handling, API errors, space registrations
and the authenticated descriptor resolver. From `app/apps/mobile`:

```sh
pnpm exec vp test run --project unit src/baskule
pnpm run typecheck
```

An optional integration check signs in to a configured Baskule server and opens each space's
RPC connection. It requires an installation you are authorized to test and explicit
`BASKULE_TEST_SERVER_URL`, `BASKULE_TEST_EMAIL` and `BASKULE_TEST_PASSWORD` values.
From `app/apps/mobile`, with the test credentials set:

```sh
BASKULE_TEST_SERVER_URL=https://your-installation.example \
  pnpm exec vp test run --project unit src/baskule/frontSession
```

It does not prove native rendering, OS keystore behavior or device WebSocket headers.

A successful build or JavaScript check does not establish device verification. On a connected
device or emulator, verify:

1. Sign-in errors, successful sign-in and connection-link confirmation.
2. Personal and team spaces, a shared chat and live updates from the web client.
3. Reopening the app, offline cached chats and reconnection.
4. Revocation from admin settings, sign-out and signing in as another person.
5. Photo attachments and opening files produced by the agent.
6. Navigation and the absence of disabled PR, terminal, Git, microphone and extended-settings entry points.

A sleeping space can take longer to answer its descriptor; the app retries. Unused account
sessions expire according to the server's authentication policy. Some screens retain the
terms "thread" or "project". The Clerk and hosted T3 Connect relay procedures under
`app/docs/operations/` describe retained upstream integrations, not Baskule's account setup.
