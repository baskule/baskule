# Choose checks for a change

Use the smallest check that proves the behavior you changed. These commands describe the available local tools; public CI configuration is separate.

## Prepare the checkout

Follow [Build Baskule](building.md), then source the tool environment:

```sh
source scripts/env.sh
scripts/check plan
```

`plan` names the checks and affected features for your diff without running them. Its default base is the merge base with `main`; `--base <ref>` selects another base. `--dry-run` prints the steps for another target.

Before starting the local app or checks that import SpaceCell, run `scripts/worktree runtime`. Rerun it after changes to `app/`. Documentation-only changes do not need the runtime build.

## Select a check

| Target | What it exercises |
| --- | --- |
| `scripts/check` | Related Baskule unit tests, scoped typechecks, and applicable syntax or documentation checks |
| `scripts/check feature:<name>` | A feature's declared journeys and additional checks |
| `scripts/check journey:<file-or-grep>` | Selected Playwright journeys against the worktree app |
| `scripts/check worker` | Worker and ControlCell authentication, sessions, routing, and revocation |
| `scripts/check space` | SpaceCell and embedded OpenCode with fake computer and model services |
| `scripts/check agent` | Embedded agent through SpaceCell, computerd, and OpenShell |
| `scripts/check computerd` | Computer execution, files, browser access, and lifecycle through OpenShell |
| `scripts/check features` | Platform feature contracts against a worktree stack and computers |
| `scripts/check web` | Hosted client checks against a mock front and local T3 servers |
| `scripts/check unit` | All Baskule unit suites and typechecks |
| `scripts/check upstream` | T3's upstream suites, for deliberate upstream changes or release verification |
| `scripts/check acceptance` | Unit and component checks across the local stack |

Use `scripts/check <loop>:<checks>` to select checks within supported component loops. For example, `scripts/check agent:plain-chat-no-computer` selects one agent check. `scripts/check help` lists targets and options.

For client behavior, use the affected feature from [the feature map](../.agents/skills/verify-baskule/features/README.md). A unit check proves its own behavior; a journey checks wiring through the application. Add a higher check only when that wiring is relevant.

## Drive the local app

The [verification skill](../.agents/skills/verify-baskule/SKILL.md) documents feature-specific profiles, browser actions, and evidence. For a stack that needs computers:

```sh
scripts/worktree runtime
(cd e2e && pnpm exec playwright install chromium)
scripts/stack up --profile full
scripts/stack doctor
scripts/stack url
```

Use `--profile light` when the feature needs no computerd. Read local credentials privately from `.run/stack/stack.json`. Do not print or commit that file. `scripts/stack logs <service>` helps diagnose the service named by `doctor`.

Save screenshots, traces, commands, and observed outcomes under `.run/evidence/<date>/`. Stop the stack you started with `scripts/stack down`. Use `scripts/stack down --purge` only to remove that worktree's disposable data. Preserve evidence before rerunning a journey.

## Respond to failures

Classify each failure before retrying. Fix product or harness defects, or resolve the named environment problem, then rerun the failing selection. If a port is busy, identify its owner; do not stop another worktree's process.

Use condition-based waits with timeouts. Run long commands once and wait for completion. The check runner uses host locks for shared component resources. Direct harness commands may bypass those locks.

The runner can reuse evidence recorded on `origin` for unchanged committed inputs. Dirty inputs run again without recording reusable evidence. `--fresh` forces a new run. A passing record remains useful until a relevant input changes.

## Check a deployed installation

Run deployed-stack checks only when the installation owner asks. `scripts/check e2e:<tags>`, `infra`, and `acceptance --live` exercise the deployed build, not the working tree. They can change provider routing, restart services, or create and remove data.

Use the fake LLM for ordinary checks. Real-provider checks tagged `@real` and measurements tagged `@perf` need explicit authorization. Lifecycle checks belong to changes in lifecycle, storage, routing, or alarms and to release verification.

For packaged desktop changes, follow [the desktop build instructions](../desktop/README.md). Native packages need their own verification; a web journey does not prove the packaged client.
