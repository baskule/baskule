# Verify the native mobile app

Use a development client on an Android emulator or iOS simulator, connected to a disposable
worktree stack. Web checks and mocked React Native tests do not prove native navigation,
permissions, keyboard behaviour, or layout. Keep the reusable procedure here; keep hostnames,
SSH aliases, device IDs, tunnels, credentials and local paths in private machine notes.

## Prepare a disposable backend

From the repository root:

```sh
scripts/worktree setup
source scripts/env.sh
scripts/worktree runtime
BASKULE_STACK_PROXY=0 scripts/stack up --profile light
scripts/stack doctor
node scripts/mobile-fixture.mjs
```

The fixture helper refuses a foreign worktree or a backend configured with a real model. It
creates two fresh accounts: one with only Personal and one with a team space. It enables fake
dictation on this disposable stack and writes credentials to `.run/mobile-fixture.json`, mode
0600. Read that file privately; do not paste it into chat or commit it. Each invocation creates
new accounts, so reuse the file during one test run. A password-change test changes the fixture
account's password; record its replacement only in private notes.

The Personal account also receives a fake plugin with two connected accounts, Work and Personal.
The helper exercises rename, default selection and disconnect with a separate verification user,
then deactivates that user. It uses the real local OAuth redirect and token exchange to seed
accounts, and closes the fake OAuth servers afterward. The retained accounts support native
management checks; new OAuth connections or external tool calls need a running provider fixture.

The light profile is sufficient for native account and navigation checks. For journeys that
execute computer tools, use the full profile and its image-build prerequisites from
[the development workflow](development-workflow.md). Use the fake model in either profile.

## Choose the device host

Android needs an SDK, emulator system image and working hardware acceleration. A Linux host
without KVM should use a linked machine with those capabilities. iOS requires macOS and Xcode.
An unavailable platform is a verification gap, not a passing result.

In T3 Code, discover linked environments and delegate native setup to the intended environment
when needed. On the device host, call `device_list`, then `device_open` with the returned
`hostId` and device `id`. This attaches the emulator to the thread's Device panel. Keep its
returned `agent-device` command and session; use that command for app launches, deep links,
navigation, permission prompts, settings, screenshots and recordings. Open the app before
requesting snapshots or input; use the command's `help` for supported actions. Use
`device_screenshot` to inspect the screen. Do not replace this interaction path with raw adb
or simulator commands. Adb remains useful for installation, logs and port forwarding.

Use a disposable emulator rather than an operator's phone by default. Do not close another
thread's device session or uninstall its app to resolve a collision.

Device sessions are exclusive to a thread. Before a delegate hands the emulator to a new QA
thread, it must close its own device session while leaving the emulator and required services
running. The next thread calls `device_open` for a fresh bound command. If `DEVICE_IN_USE`
occurs, ask the owning thread to release its session; do not reuse its command from another
thread.

## Install and connect the development client

Use the same source revision on the backend and device host. Transfer dirty changes explicitly
and record the revision and diff used; a release APK from another revision cannot verify the
current patch. Keep dependency caches and native build output on the device host.

From `app/`, install the matching native client before starting Metro:

```sh
pnpm run mobile:install android <device-serial>
# On a Mac with an iOS simulator:
pnpm run mobile:install ios <simulator-id>
```

The installer checks the native fingerprint and reuses compatible cached builds. JavaScript-only
changes normally need Metro refresh; native dependencies, patches and config changes require
checking the fingerprint again. The development identity is `dev.baskule.app.dev`, separate from
the installed release. From `app/apps/mobile/`, start Metro with `pnpm run dev:client`. Record
the process you started and use the actual port from its output. Read the
[mobile README](../app/apps/mobile/README.md) for cache and build diagnostics.

For dictation, verify the installed Android package requests `android.permission.RECORD_AUDIO`.
The audio, camera and image-picker config plugins share microphone permissions; disabling one
plugin's permission can remove it for the whole app. `app.config.test.ts` checks their combined
manifest. Permission changes require a rebuilt native client; a Metro refresh cannot apply them.

When forwarding Metro over loopback, use the development command's equivalent with
`--localhost --port <port>` instead of `--lan`. If localhost resolves to IPv6 while the
Android reverse mapping targets IPv4, set `NODE_OPTIONS=--dns-result-order=ipv4first`.
With an external shared pnpm store, Metro's lazy imports may generate an invalid cache path;
`EXPO_NO_METRO_LAZY=1` disables that development optimisation without changing source. Keep
these environment-specific settings in the local launch notes. Use the real device keyboard
for layout checks (`--no-test-ime` on the returned device command), since a test keyboard can
hide composer and inset defects.

Keep the backend and Metro reachable privately. If the backend runs on another host, use a
loopback-bound SSH forward on the emulator host and an Android reverse port mapping for the
selected device. Do not expose the backend publicly or bake host addresses into source.
Retain the original process IDs and port mappings in private notes for cleanup. Use the
device-bound CLI to open the development client with Metro's development-client link, then
enter the forwarded backend address in Baskule's connection screen. Test credentials come
from the fixture file, not a live installation.

## Exercise user journeys

Capture the baseline before loading edited source, then repeat the affected journeys after
the change. Inspect the accessibility tree and screenshots rather than relying on a bundle
build or a successful launch alone.

| Journey | Evidence to collect |
| --- | --- |
| Fresh launch, signed out | Light/dark system appearance, language menu, server validation, keyboard, compact layout and Android Back |
| Password sign-in | Only the submitted action shows progress; errors recover; sign-in reaches the chat list |
| Personal-only home | Loading resolves; useful empty state; no project/environment/model controls or redundant space picker |
| New chat | Opens directly without picker/back navigation; send `Hello [[fake:text Mobile verified]]` and observe `Mobile verified`; reopen and send a follow-up |
| Team account | Space selection stays in the chosen space; offline selection does not silently send to another space |
| Conversation | Header, composer, keyboard, scrolling, attachments and back navigation; no upstream provider badges or model picker |
| Voice | First permission grant, denial, retry, cancel and background interruption; stop a recording and verify draft insertion and nonempty upload |
| Settings | Top-bar entry and Back; system/light/dark preference; native usage, plugin accounts and password; scheduled tasks, notifications and archived chats |
| Session lifecycle | Change password, remain signed in with the replacement session, sign out, then sign in with the new password |

Fake dictation returns `Voice input verified.` for a nonempty multipart audio upload. Inspect
the fake service's `/_fake/requests` for `kind: "transcription"` and a positive byte count;
audio bytes are not retained there. This proves recording, upload and draft insertion, not
speech-recognition accuracy. Real-provider testing requires explicit authorization.

For plugin OAuth, the provider's consent flow is external; ordinary account listing, renaming,
default selection and disconnection should stay native. Empty lists alone do not verify those
mutations: use a disposable plugin fixture when changing them. Do not connect a real account
as a substitute for a test fixture.

Save before/after screenshots, recordings, commands, source identity and observed assertions
under `.run/evidence/<date>/`. Redact credentials and private host details before publishing PR
evidence. Record Android and iOS results separately; shared code alone does not establish that
both native platforms passed. Run `scripts/check plan` and focused checks for the logic changed.

## Diagnose connection failures

Separate the backend, host tunnel, Android transport and app before changing product code.
A native-style bearer request and WebSocket probe from the backend host establish server
behaviour; repeating them through the emulator host's tunnel isolates that tunnel. Neither
proves that the emulator can reach the service or that a native conversation completes.

Android transport loss can remove reverse port mappings while Metro and the tunnel remain
healthy. Inspect the selected device's inventory, transport logs and reverse mappings. After
checking ownership, restore only missing mappings for that device. Record the interruption
and repeat the affected journey; do not count a successful host probe as device acceptance.
Do not restart a shared adb server or another emulator to repair an isolated test.

If device tools fail, follow their recovery advice once and stop interaction if the failure
persists. Diagnose the host infrastructure without bypassing the device tools. After a verified
recovery, open a fresh owned session before continuing. Preserve timestamps and sanitized
transport errors, not authorization headers or raw application traffic. Report an unknown
reset trigger as unknown even if connectivity has returned.

## Finish

Close device sessions opened for the run unless the user is using them. Stop Metro, tunnels
and stacks you started, using their recorded ownership; preserve evidence. `scripts/stack down`
stops this worktree's stack and retains its data. Purge only disposable data you are authorized
to remove. Never stop another worktree or live installation to free a port.
