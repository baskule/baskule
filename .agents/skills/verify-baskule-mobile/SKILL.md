---
name: verify-baskule-mobile
description: Verify Baskule's native Android or iOS app through T3 Code device tools, a matching development client, and a disposable fake-model backend. Use for mobile behaviour and visual acceptance; web checks do not replace device evidence.
---

# Verify Baskule mobile

Read [the native verification workflow](../../../docs/mobile-verification.md). It owns backend
fixtures, source/build matching, device interaction, acceptance journeys and cleanup.

Discover the device host rather than assuming the current machine can emulate Android or iOS.
For a linked host, delegate there with the source revision and the verification task. Pass known
`hostId` and device `id`; the delegate must call `device_open` and use its returned command for
interaction. Keep machine-specific connection details in private local notes, outside Git.

Before editing the UI, capture the affected baseline states. After loading the final source,
drive the actual user actions and inspect screenshots as well as their outcomes. Use fresh
fixture accounts and fake providers. Record a blocked or unavailable journey honestly;
successful unit tests, a simulator boot, or an installed APK are not native acceptance.

Save evidence in `.run/evidence/`, run focused checks, then stop only resources this run owns.
