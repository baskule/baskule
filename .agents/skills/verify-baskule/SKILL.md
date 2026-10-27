---
name: verify-baskule
description: Drive and verify Baskule's real worktree app with scripts/stack, T3 preview or Playwright journeys. Use for behaviour checks and evidence after a feature change.
---
# Verify Baskule

## Launch

From the worktree root, `source scripts/env.sh`, then opt in to the SpaceCell build with `scripts/worktree runtime` (also after changing `app/`). Install the browser once with `(cd e2e && pnpm exec playwright install chromium)` if absent, then `scripts/stack up --profile full` (other features may declare another profile).
Use `scripts/stack url` for the browser URL. `.run/stack/stack.json` contains service ports, instance id and local admin credentials; read credentials privately, never print or commit them. `scripts/stack status --json` describes this instance. Use `scripts/stack up --profile light` for features that do not need computerd. Each feature declares its profile or custom checks in [the feature map](features/README.md).

## Doctor

Run `scripts/stack doctor` before driving, and whenever anything looks wrong. It must pass; diagnose its named service instead of retrying a journey against a broken stack. Never substitute staging.

## Drive

Read the feature file first. `scripts/check feature:personal-chat` runs the personal chat journey in desktop and phone projects. `scripts/check journey:personal-chat` runs that file alone. `scripts/check journey:@feature:personal-chat` selects a tag. Journeys create independent fresh users through the real admin API and use only the fake LLM. Tests close their clients and retain their fresh worlds for inspection; every world is stopped while its data is retained. Use `scripts/stack down --purge` to remove this worktree stack and its test data.

For manual driving, use T3 `preview_status`, then `preview_open` if no usable preview exists. Navigate to `scripts/stack url`; sign in with the local admin from stack.json. Inspect a snapshot for real locators. The login labels are `Email`, `Password`, and button `Sign in`. On the home screen, the combobox `Run on` selects `Personal` or a team. When the account has only Personal, the picker is omitted and the draft is already personal. The composer is `[contenteditable="true"]`; fill `Skill proof [[fake:text verified chat]]` and press Enter. Wait for `[data-message-role="assistant"]` containing `verified chat`; capture the sent message and answer. On phones, close the drawer before editing and use the button `Expand composer` when the editor is compact. `Toggle main sidebar` opens the drawer; `baskule-new-chat` starts a new chat. Use snapshots to resolve changing controls. Never drive a human-owned preview tab.

API clients and browser setup are in `e2e/journeys/fixtures.mjs` and `api.mjs`. API helpers support sign-in, fresh people, team creation, RPC chat, stream observation and commands. Do not forge identity headers or mutate internal state. Wait on visible state, RPC completion or an explicit condition, never a fixed sleep.

## Evidence

Create `.run/evidence/<YYYY-MM-DD>/` and save screenshots of the action and resulting state there, plus commands, timestamps and observed outcome. Copy useful `.run/journeys/results/` traces/screenshots before another run overwrites them. The HTML report is `.run/journeys/report/index.html`. A screenshot alone proves only its visible state: assert the answer, shared update, file bytes or other side effect named by the feature. Record failures as failures.

## Cleanup

Close preview tabs you opened. Run `scripts/stack down` for a stack you started (use `--purge` to remove its alpha test data). Never stop another worktree or staging. Check `scripts/stack status --json` and confirm the files under `.run/evidence/<YYYY-MM-DD>/` still exist after cleanup. Cleanup must preserve evidence.

## Helpers

- `scripts/check plan`: features whose paths match the diff.
- `scripts/check feature:<name>`: feature journeys plus additional declared checks.
- `scripts/check journey[:file-or-grep]`: direct journeys; configure profile with `JOURNEY_PROFILE` when needed.
- `scripts/stack restart celld` / `scripts/stack restart computerd`: persistence checks on this instance only.
- `scripts/stack logs <service>`: diagnose a failed condition.
