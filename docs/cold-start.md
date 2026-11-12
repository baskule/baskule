# Space cold starts

Space startup pays for JavaScript compilation, module evaluation, service construction, and database work. The native frontend routes Control and Space requests to the backend worker. Control and Space can still share a cell isolate, so synchronous T3 work can delay Control requests.

## Minification and diagnostics

Both hosted build stages disable esbuild's `keepNames`. Name preservation adds `Object.defineProperty` calls to functions and classes, including schema factories called repeatedly during import. Removing those calls reduces initialization work as well as bundle bytes. The T3 and platform stages need the same setting because a later build retains an earlier build's name helpers.

Minified native stack frames have shorter function labels. Stack capture and positions in the deployed bundle remain available (no source maps), and Effect's explicit operation names remain unchanged. This is a deliberate diagnostic tradeoff. For readable local identifiers, rebuild T3 without `--minify`, then build the platform without `BASKULE_MINIFY=1`.

The local tracer formats failures when it records a sampled span. It also redacts a sampled failure before handing it to a supplied tracer delegate. Ending an unsampled span retains its cause without formatting its logical stack, including when an OTLP delegate is configured. Trace-file serialization still redacts URL credentials. Exported errors and recorded errors keep their diagnostic messages and stacks.

## Idle alarms and durable work

A stale agent alarm checks durable work before it creates the agent or imports T3's shared SQL client. A busy marker requires recovery. Pending outbox records or completed, unreported assistant messages with stored usage context also require the agent, even when no turn is busy. A resident or starting agent continues through its normal alarm handler.

The check reads the existing native SQLite connection. It creates no tables or additional SQL clients. The Space alarm still runs, and the multiplexed alarm still claims and completes each owner's work. Scheduled work, active-run recovery, and usage retries retain their existing paths.

These changes require no data migration or new runtime capability beyond the runtime described in [celld runtime patches](celld-runtime-patch.md).

## Measurement boundaries

Use client monotonic timers for HTTP durations and native celld log timestamps for JavaScript stage markers. Guest `Date.now()` and `performance.now()` are frozen during a celld turn and cannot measure synchronous compilation or evaluation. The built-in T3 `bootMs` therefore omits some startup work.

A process restart against copied state can include expired-lease replica restoration and overdue alarms. It is a different case from waking an evicted cell. Record the alarm state, storage mode, and exact module hashes with each comparison. LocalStore metadata scans are development-store work, not production S3 traffic.

Compare builds against one offline synthetic seed with deployment objects removed before cloning it. Republish each build before starting its node, then verify that each trial contains one deployment manifest. Otherwise, old deployment BLOBs can change restore cost. Preserve the nondeployment seed records exactly.

Alternate independent cold processes under the same CPU and memory limits. Keep builds and profilers outside measured runs. Measure from Control request start through completion of the following authenticated `GET /api/orchestration/shell`, validating its projects, threads, and snapshot sequence. Report the median, full range, sample count, and immediate follow-up requests. Record the later OpenCode boot marker too. An earlier response alone does not establish an improvement if required initialization moves behind it.

Keep experiments, native timelines, and raw results under ignored `.run/evidence/`. Use fake models and disposable state. [The development workflow](development-workflow.md) describes the focused functional checks.

## Hosted construction and first use

The hosted build substitutes a narrow composition into the upstream server. ProviderRegistry,
EnvironmentTheme, and the MCP OAuth signer acquire on first use through `deferredService`.
Each captures its constructing Space's dependencies, shares concurrent acquisition, caches only
success, and closes resources with that Space. Failed acquisitions retry on the next use.
No acquired context, settings, identity, SQL client, or credentials are shared between Spaces.
SecretRequests stays eager so its boot sweep expires saved secret files and its hourly sweep
belongs to the retained boot event. Recovery, scheduling, usage, and storage cleanup remain eager.

The hosted keybinding service provides the compiled defaults for the managed empty configuration.
It does not watch or backfill the file; existing RPC policy refuses mutations. Analytics stays
inert under the managed configuration. Native resource telemetry reports unavailable, host power
retains its unknown state and client activity policy, and Connect remains unconfigured. Native
speech files cannot be installed in a Space; transcription continues through the front service.
Environment construction uses the adapter hostname instead of probing host files or processes.
These adapters retain their service keys, supported behavior, and authorization boundaries.

`sharedHttpCodecs.mjs` reuses immutable schema-only codec closures across Spaces in one isolate.
Handlers, middleware, contexts, and request state remain per Space. Build guards require every
rewrite target, complete source anchors, and the reviewed codec factory body. Missing namespace exports fail the hosted build.

Descriptor and session reads can proceed while startup recovery is pending, and propagate a
recorded recovery failure. Other HTTP routes and RPC commands retain command readiness gates.
Descriptor latency therefore excludes command readiness; use the authenticated shell boundary
above. First use and first chat can repay deferred work, so construction time alone proves no
end-to-end gain.

The activation helper registers and parks a scoped child immediately behind the persistent gate,
without a second parent handshake. This also applies to Node. Closing the scope interrupts parked
children, and the gate still prevents due work from running before recovery.

## Returning-cell initialization

T3 compares the complete stored migration history with its manifest. An exact match skips preview
reconciliation and the migrator transaction. Control similarly compares every bundled journal
timestamp. Any mismatch takes the original migration path, including collision checks.
Authentication mode and Everyone-group bootstrap writes run only when their records are missing.

Existing filesystem tables avoid repeated DDL. Managed settings and keybindings retain identical
contents. Front-session upserts and Space recovery-status writes run only when their inputs change.
Authentication, authorization, revocation, startup recovery, and alarm deadlines retain their
existing durable paths. No schema marker, data-layout change, credential cache, or extra SQL client
is introduced. The multiplexed alarm and same-cell OpenCode request remain unchanged.
