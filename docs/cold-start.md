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

Alternate independent cold processes under the same CPU and memory limits. Keep builds and profilers outside measured runs. Report the complete authenticated Control-then-Space interval, its range and sample count, and the immediate follow-up request. Record the later OpenCode boot marker too. An earlier response alone does not establish an improvement if required initialization moves behind it.

Keep experiments, native timelines, and raw results under ignored `.run/evidence/`. Use fake models and disposable state. [The development workflow](development-workflow.md) describes the focused functional checks.
