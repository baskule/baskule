# ControlCell reload ownership

Plugin changes must not make unrelated installation requests wait for space reloads or retain abandoned outbound calls. Membership reads must not boot spaces that the caller has not opened.

## Evidence and its limits

The verify-only [Release run 41392911020](https://github.com/baskule/baskule/actions/runs/41392911020) runs 15 plugin journeys in one stack. Its eight desktop cases pass. The first phone case exceeds 180 seconds, its three cleanup stop requests receive `503 cell request limit reached`, and the next six phone cases cannot sign in. The default per-cell limit is 64.

The downloaded `backend-evidence-0.5.0` artifact does not contain the referenced journey traces. Its retained feature-stack celld log begins at 07:03 UTC, after the plugin failure. Those files cannot establish the exact set of 64 outstanding requests or their wait locations.

Local instrumentation counts entries and exits of `ControlCell.fetch`, without logging credentials or bodies. On the unchanged base, the named-accounts desktop case exceeds 180 seconds. Its trace contains 22 environment-descriptor requests: four succeed and 18 abort, with the aborted requests taking approximately 10 seconds. A later agent start logs its database phase and never reaches OpenCode boot. Pre-wake reports `handler is waiting on nothing`. The observed peak is three ControlCell JavaScript handlers. This reproduces the space stall, but does not reproduce the CI count of 64 native requests.

A controlled native reproduction runs the real `ControlService` on stock celld 0.6.3. Its `SpaceCaller` holds the changing request's reconfigure call for three seconds, then the driver issues 64 public discovery requests. The original service reaches exactly 64 concurrent handlers: the changing request and 63 discovery requests waiting in `flush` on its reload set. The next discovery request receives 503. With request-owned reload waits, all 64 discovery requests receive 200 and the observed peak is two handlers. The limit is unchanged. This reproduces the saturation mechanism, rather than reconstructing the unavailable CI request list.

A focused regression holds one plugin reconfigure request open and starts 64 unrelated `/me` calls. Before the fix, every read waits for the reload timeout. After the fix, all 64 reads finish while the changing request still waits for its own reload. This establishes the shared reload barrier independently of browser connection limits.

## Request and settings lifetimes

Previously, `ControlService.reloadSpaces` added work to a shared set. Every public request drained that set in `flush`, including sign-in and `/me`. More public requests therefore retained request slots while they waited for work caused by another request. Internal authorization and settings callbacks already skipped reload waits after PR #30.

`reloadSpaces` now returns a promise that its caller awaits. Plugin, group, membership, account, and vendor changes all await their own work, including OAuth connection callbacks. `flush` still drains revocations for immediate access removal. Member removal and deactivation start revocation before awaiting reload work, covered by a separate regression. The internal settings callback never waits for the reload that caused it. The change adds no cells, bindings, services, limits, or flags.

The investigation also tested whether reusing a resolved settings promise across celld events explains the stall. A separate celld reproduction caches the result of one cell request, then awaits that promise and makes another outbound call in two later requests. Both calls succeed. An exploratory parsed-data cache change also leaves stalled pre-wakes in the full application. That change is removed because the evidence does not support it. The resolved-promise settings cache remains unchanged.

## Native event lifetime and speculative boots

The request-barrier fix alone passes the first failing phone skills case, but a full local run still finishes with 11 passes and four phone failures. Named accounts stalls opening its personal-space RPC after OAuth reloads. Its trace contains 17 failed descriptor probes. ControlCell handler concurrency peaks at six. Later requests fail while materializing SQL results because the isolate has reached its configured 1 GiB heap limit. No limits are raised.

The Worker previously pre-woke up to four member spaces on every successful `/me` read. That includes API-only sign-ins before plugin setup and every OAuth return. The Worker no longer performs this speculative work. The now-unused internal wake route is removed. Client requests, webhooks, and due alarms still use the existing boot path.

ControlCell's five-second promise timeout previously stopped waiting without aborting the underlying reload fetch. Reload and revocation calls now receive an abort signal with the same deadline, so timed-out outbound work is cancelled. A stalled-caller regression verifies that the reload has no active outbound call when the timeout response completes.

SpaceCell also released its retained boot event before agent teardown and usage flush/capture had finished. An extension to the existing shared-SQL lifecycle test fails on that ordering: the old event has ended while its flush is still pending. The event is now released in a final `finally` after cleanup. This preserves the existing [celld #258](https://github.com/denoland/celld/issues/258) workaround, shared SQL client, and same-cell agent request. The focused phone named-accounts journey passes after removing speculative boots and cancelling timed-out calls.

## Browser request budget

A later full run with bounded native work still times out in the first phone skills case. The trace reaches the shared-team run after admin form actions have spent tens of seconds queued. The web connection source starts all space-descriptor requests with unbounded concurrency. Unreachable spaces retry after the descriptor's ten-second timeout and can occupy the browser's same-origin HTTP/1.1 connections.

Descriptor discovery now uses two concurrent requests. This leaves connections for sign-in, settings, and active chat requests while retaining the existing membership order and retry behavior. A focused test holds four descriptor calls open: the original implementation starts all four, while the new implementation keeps the observed peak at two. All ten space-registration/order tests pass with this change.

## Upgrade-handler event lifetime

The bounded-discovery run passes 14 of 15 journeys. Phone named accounts still stalls in `Open the personal space RPC`, before its upgrade completes. The other six phone cases pass and ControlCell remains available.

The normal WebSocket transport starts its existing keepalive only in `onOpen`, after authentication and socket acceptance. Its close listener releases that keepalive before the Effect handler's scope finishes. The documented #258 invariant requires the event that creates these continuations to remain alive throughout the handler. The keepalive now starts immediately before the upgrade program runs and is released in that program's `finally`, after its scope closes. The old on-open timer is removed, so this retains one existing interval per connection.

A focused transport test blocks authentication and then blocks scope cleanup. It fails on the original code because no keepalive exists during authentication. It passes when the same keepalive covers both gates and is released afterward.

## Verification

Focused control, Worker, SpaceCell lifecycle, web space-registration, and transport tests pass. Platform, server, and web typechecks pass. The regressions cover 64 unrelated reads, revocation ordering, cancellation, membership reads without boots, boot lifetime through SQL cleanup, and upgrade lifetime through authentication and scope cleanup. The original PR #30 callback regression remains intact and passes. Blocking lint and feature-map coverage pass.

The final full plugins run passes all 15 journeys in one stack, desktop then phone (23.6 minutes). Its retained celld log contains no request-limit or heap-limit errors. Verification uses fake model and OAuth fixtures. Logs, screenshots, and diagnostic failure traces remain under `.run/evidence/control-saturation/`. The declared plugin-runtime and Worker checks pass. The web check initially stops because its required Playwright Chromium executable is missing, after all 120 web unit tests pass. After installing that browser version, only `scripts/check web` is rerun; all unit and desktop/phone browser checks pass. The original feature command exits at that environment failure, so its passing journey and component evidence is combined with the repaired web check rather than rerunning unchanged selections.

The host portless proxy could not start, so local verification uses `BASKULE_STACK_PROXY=0`. Temporary launcher edits select a separate gateway container, network, volumes, ports, and stack registry. Those edits and request counters are excluded from the PR. The production-like installation and existing `osdev-*` containers are not operated. There is no schema change or required data wipe.
