# ControlCell reload ownership and native cancellation

Plugin changes must not make unrelated installation requests wait for space reloads. A response deadline must stop the caller waiting without cancelling the receiving cell's handler.

## Saturation evidence and its limits

The verify-only [Release run 41392911020](https://github.com/baskule/baskule/actions/runs/41392911020) runs 15 plugin journeys in one stack. Its eight desktop cases pass. The first phone case exceeds 180 seconds, its cleanup stop requests receive `503 cell request limit reached`, and the next six phone cases cannot sign in. The per-cell limit is 64.

The downloaded `backend-evidence-0.5.0` artifact lacks the referenced journey traces. Its retained celld log starts after the plugin failure. Those files cannot establish the exact outstanding requests or their wait locations.

A controlled reproduction runs the real `ControlService` on stock celld 0.6.3. Its `SpaceCaller` holds a changing request's reconfigure call for three seconds while the driver issues 64 public discovery requests. The base reaches 64 handlers: the changing request and 63 reads waiting in `flush` on the shared reload set. The next read receives 503. With request-owned reload waits, all 64 reads receive 200 and observed concurrency peaks at two. This establishes the saturation mechanism without reconstructing CI's unavailable request list.

The retained regression holds a plugin reconfigure call open and starts 64 unrelated `/me` calls. All reads finish while the changing request still waits for its reload. PR #30's internal-settings callback regression remains intact.

## Reloads belong to their causing request

`reloadSpaces` returns a promise that its caller awaits. Plugin, group, membership, account, and vendor changes await their own work, including OAuth connection callbacks. `flush` still drains revocations for every request. Member removal and deactivation start revocation before awaiting reloads, so a slow reload cannot postpone access removal.

The three abort signals added to settings reloads, plugin reloads, and revocations are removed, along with the fake-caller cancellation test. The existing five-second `withTimeout` bounds the response wait and lets the receiving handler finish later. Independent review proved that aborting a cross-cell fetch on stock celld 0.6.3 strands the callee at its next pending await. Without abort, it completes even after the caller stops waiting.

## The same-cell agent boundary also inherited cancellation

Removing those three signals still leaves intermittent phone named-account failures at `Open the personal space RPC`. A final-source run reaches 14 of 15 passes. Another diagnostic run passes all 15 journeys but leaves two agent-settings reads permanently pending while their spaces have `closing=true`, `booting=false`, and no current server. One passing run therefore does not establish safe teardown.

The embedded Effect HTTP client supplies a scope-owned abort signal. The agent router preserves it through `new Request(url, request)`, including SpaceCell's same-cell self-request. Retiring T3 closes its scope and can abort that receiving agent handler during settings I/O, leaving its shared `agentStarting` promise unresolved.

A separate stock-celld probe exercises this exact boundary with a real same-cell fetch. The caller waits until the agent handler starts, aborts its signal, and stops waiting. With an inherited signal, the callee records `agent:start` and never resumes its I/O or storage write. With an independent signal, it records `agent:io-done` and `agent:stored` after the caller stops waiting. The probe is retained under `.run/evidence/pr32-revision/self-abort-probe/`.

The same-cell agent forwarder now gives the receiving request its own signal. It preserves the URL, method, headers, and streaming body, and retains the same-cell boundary required by [celld #258](https://github.com/denoland/celld/issues/258). A forwarding regression fails before the change and passes afterward: aborting the original POST leaves the forwarded signal active and its JSON body intact. The native probe, rather than that unit mock, proves receiving-handler completion. No settings-cache redesign is needed.

## SpaceCell lifetime and closing ownership

A controlled lifecycle regression holds boot open, starts reconfigure, and then starts a public request. Previously, reconfigure waited for boot before setting `closing`, so the new request obtained the old server while reconfigure began disposing it. The regression observes the old server handling the request and fails.

Reconfigure now owns the existing `closing` promise before its boot wait, through invalidation, disposal, and skill refresh. New requests wait behind it and boot the replacement afterward. A close clears `closing` only while it still owns that promise. Explicit dispose queues behind a pending reload, including one that keeps an active run alive; a second regression catches the case where dispose otherwise returned without closing the runtime. Both regressions pass without new cells, timers, bindings, or lifecycle flags. During teardown, new agent requests receive `503 space_restarting` after the retiring generation is detached. This prevents a retired runtime from creating another agent while its usage writes drain; startup self-requests remain allowed. A third regression holds the usage flush open and verifies that no replacement agent is created.

The boot event remains retained through agent teardown and usage flush and capture, with release in the final `finally`. A native probe without caller cancellation demonstrates the need: releasing the boot event early strands boot-origin cleanup at I/O; releasing it afterward lets cleanup complete. Its results are under `.run/evidence/pr32-revision/boot-lifetime-probe/`.

The WebSocket keepalive also remains around authentication and the complete Effect handler scope. The old on-open timer is removed, retaining one interval per connection. Its transport regression holds authentication and scope cleanup in turn and verifies the event remains retained through both. The shared SQL client and multiplexed alarm are unchanged.

## Discovery restored; pre-wake restoration failed

The first implementation removed `/me` pre-wake and limited descriptor discovery to two concurrent requests. Those changes preceded the final WebSocket fix and had not been independently established as necessary.

Removing pre-wake, then testing unbounded batch and progressive discovery, did not eliminate the named-account hang while same-cell cancellation and teardown races remained. Those experiments cannot justify the discovery limit, which is removed with its test. Original unbounded discovery is restored. Production HTTP/2 behavior does not follow an HTTP/1.1 connection budget.

With all final cancellation and lifecycle fixes present, a clean full-feature attempt restores `/me` pre-wake and its internal route. All eight desktop cases and the first two phone cases pass. Phone curated catalog exceeds its 180-second budget: opening the two add dialogs takes about 21 seconds each, catalog status takes 24 seconds, and the vendor form takes 28 seconds. The form eventually appears; this is cumulative delay rather than a permanently missing form. The log records 63 native `handler is waiting on nothing` errors, with no request-limit or heap-limit errors. The trace includes a SpaceCell descriptor 500 and no `ERR_NETWORK_CHANGED` errors, distinguishing it from the later browser environment failures. The failure is classified as a product cold-start timeout. Its trace, log, screenshots, source variant, and timing summary are retained under `.run/evidence/pr32-revision/prewake-restored-final-guard-run/`.

Pre-wake and its unused internal route are removed under the review's evidence-based exception. The comparison run changes only pre-wake, retaining unbounded discovery and all cancellation and lifecycle fixes. Client requests, webhooks, and due alarms still boot spaces. Boot no longer overlaps the `/me` response, so cold-start latency changes; no performance sample is run here.

## Browser environment failures

Another full attempt passes the first six desktop cases, then fails before MCP JSON starts: Chromium reports `ERR_NETWORK_CHANGED` while importing the main JavaScript module. The trace and boot-error screenshot establish an environment failure. That case bypasses the existing navigation helper, whose boot-error selector is also stale. The helper now accepts the page's readiness locator, recognizes the current `#boot-error`, and handles this initial admin navigation. It still retries at most once and only after an observed `ERR_NETWORK_CHANGED`; ordinary boot failures and persistent network failures remain failures. Four browser policy probes replay the failure marker and verify those outcomes.

A subsequent focused run hits `ERR_NETWORK_CHANGED` during plugin-save and connection-test POSTs. Those actions are not retried. Their traces remain under `.run/evidence/pr32-revision/network-action-failed/`. No browser network overrides or runtime flags are added.

## Verification

The final `node scripts/run-feature.mjs plugins` run passes all 15 journeys in one stack, desktop then phone, in 30.0 minutes. Its saved celld log contains no native waiting-on-nothing, request-limit, or heap-limit errors. The source hashes match the acceptance manifest.

The aggregate command exits 1 because the web component's desktop plugin scenario hits a CSS-preload bootstrap failure and then a 90-second locator timeout. The plugin-runtime check, Worker integration's 99 + 4 + 3 checks, web's 119 unit tests, and the other web browser scenarios pass. After stopping the disposable backend stack, `SKIP_BUILD=1 bash app/apps/web/baskule-dev/check.sh plugins` passes both desktop and phone with unchanged source and bundle. Only the failing selection is rerun; passing evidence is reused. The aggregate failure and focused recovery are retained separately.

All 117 focused tests pass: control (76), Worker (18), SpaceCell lifecycle after runtime build (13), server transport (1), and web spaces (9). Platform, server, and web typechecks, blocking lint, feature-map coverage, and whitespace checks pass. The LLM is fake; native probes use stock celld 0.6.3.

An earlier attempt with pre-wake removed also stalls at desktop named accounts opening the personal-space RPC, without native pre-wake, request-limit, or heap-limit errors. Four isolated repetitions and the five-journey desktop prefix pass with temporary cleanup-stage logging; every observed cleanup reaches release. That intermittent failure remains unexplained, and the retained evidence must be included in re-review rather than treated as disproven by a passing rerun.

Verification uses a separate gateway, volumes, registry, and loopback ports. Production and existing `osdev-*` containers are not operated. Temporary launcher edits and phase logging are excluded. There are no schema changes or required data wipes. Logs, traces, screenshots, native probe results, and regression evidence remain under `.run/evidence/pr32-revision/`.
