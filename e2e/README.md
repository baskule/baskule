# Baskule end-to-end checks

Use the [development workflow](../docs/development-workflow.md) to select focused checks.
[Worktree journeys](journeys/README.md) run against disposable local app stacks. The
`tests/`, `infra/`, `ux/`, and `perf/` runners exercise a test installation managed by
the installation's operator, using the source Compose services, normally at
`http://127.0.0.1:47090`.
These checks create accounts and data, change organization settings, and can restart
services. Run them only with permission from the installation's operator.

Prepare the [build environment](../docs/building.md), the source Compose installation,
and system Chrome. Supply an existing administrator through `E2E_LOGIN_EMAIL` and
`E2E_LOGIN_PASSWORD`; `E2E_BASE_URL` selects its browser origin. The optional `deploy/.env`
can supply credentials and the bind address. Environment-only configuration works too.
The worktree and release-install checks create their own administrators through setup.

## Run a selection

```sh
e2e/run.sh tests/05-security.spec.ts
e2e/run.sh --grep @chat
E2E_SLOW=0 e2e/run.sh               # skip serial lifecycle checks
scripts/check infra               # source Compose infrastructure smoke checks
```

`run.sh` holds `deploy/.stack-lock`, starts the source stack if needed, points organization
AI settings at the fake LLM router, and sets idle stop to `E2E_IDLE_MINUTES`, default 1.5.
`BUILD=1` builds and deploys first. The normal run executes `main` with `E2E_WORKERS`
workers, default two, followed by serial `lifecycle` checks tagged `@slow`. File and grep
selections apply to both phases; `--project <name>` selects one project.

The runner restores saved AI and idle settings on exit. `KEEP_ROUTER=1` retains the
router between iterations; restore it with `e2e/llm/llm.sh restore` when finished.
`RESTORE=0` also leaves settings changed. Checks exercise the deployed build, so deploy
source changes before claiming they are covered.

Artifacts under `e2e/artifacts/` include screenshots, traces, results, metrics, and fixture
worlds. They may contain test credentials and sessions; keep them private. Set
`E2E_WORLD_FILE` to a separate path for an independent run. Fixture reuse requires the
same `E2E_RUN`; worker slots above zero use their own world files.

## Opt into a real provider

Fake routing is the default and needs no provider key. For a paid run, explicitly set
all of the following environment variables:

| Variable | Required value |
| --- | --- |
| `E2E_REAL` | `1` to enable real requests |
| `REAL_BASE_URL` | OpenAI-compatible provider endpoint, including `/v1` if required |
| `E2E_MODEL` | Provider model ID |
| `E2E_REAL_API_KEY` | Provider credential, supplied privately |
| `PRICE_IN`, `PRICE_OUT` | USD per million input/output tokens; explicit zero is allowed |
| `E2E_REAL_BUDGET` | Optional metered budget, default USD 0.25 |

Then run `e2e/run.sh --grep @real`. Choose a model supporting the selected checks,
including tools and native PDF input when applicable. The test configuration declares
image/PDF input and context/output limits; it does not discover provider capabilities.

`llm/llm.sh` forwards the endpoint, model, prices, and real-mode flag into the router
container. Source or configuration changes recreate the container and retain its usage
volume. `RESET=1` explicitly resets that volume and its budget history.

Only messages whose last user turn contains `[[real]]` reach the real provider. The
router strips the marker, forwards the caller's credential, requests streaming usage,
and meters cost. A request is refused once recorded cost reaches the budget. This is
a usage-based guard, not a provider-side hard spending cap. Metered spend is appended
to `.run/llm-spend.md`; `llm/llm.sh usage` returns totals. Chat-title requests always use
the fake model.

Ordinary checks use `custom/fake-model`. The settings helper saves and restores the
organization configuration and selects the test model explicitly. Fake markers include
`[[fake:text ...]]`, `[[fake:tool shell {"command":"..."}]]`, `[[fake:long N]]`,
and `[[fake:delay ms]]`. Inspect captured requests for the available tools rather than
assuming a fixed tool count.

## Coverage

| Specs | Behavior |
| --- | --- |
| `01`, `05`, `06` | Administrator onboarding, authentication, space isolation, origin checks, membership revocation |
| `03`, `10`, `14` | Computer tools, file bytes, uploads, native attachments, search and path confinement |
| `04`, `15` | Team streaming and queueing, shared browser control and viewer revocation |
| `07`, `08`, `09`, `17` | Idle wake, restart persistence, celld failover, tools/files in the same resumed chat, lazy computer creation |
| `12`, `16` | Phone layout and administrator computer-health status |
| `13` | Explicit real-provider arithmetic, shell/file output, and native PDF input |
| `18` | Direct configured-provider greeting and DOCX/PDF creation in one chat |

`E2E_RESTART_THREAD_ID` optionally selects a test chat for the same-chat restart drill.
A security positive control must create real fixture data; an empty directory does not
prove isolation. The suite uses no blanket retries. Its bounded exceptions cover
Chromium network-change recovery and authentication rate-limit backoff.

The direct-provider spec requires `E2E_DIRECT_REAL=1` and the installation's explicitly
configured provider. Restore router settings first, hold the stack lock, and invoke
Playwright directly with a fresh run/world. `run.sh` installs the router and is unsuitable
for that selection. Remove only the fixture accounts and spaces after the check.

## Review UX and measure performance

`e2e/ux/run.sh [journey...]` captures onboarding, first chat, collaboration, files,
schedules, and phone layout. A person or automated reviewer can follow
[the UX checklist](ux/BRIEF.md) to record findings against screenshots and text snapshots.
Rerun affected journeys after fixes.

Performance runs are explicit selections: `e2e/run.sh --project perf` or
`e2e/perf/run.sh <label> 5`. They restart services and record timings, memory, and host
load. Supply `PERF_EMAIL` and `PERF_PASSWORD` to use an account directly, or select an
existing fixture with `PERF_WORLD`. Compare measurements under equivalent conditions.
