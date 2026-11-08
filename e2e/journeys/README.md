# Worktree journeys

Use `source scripts/env.sh`, then `scripts/check feature:personal-chat` or `scripts/check journey:personal-chat`.
A filter matching a spec path selects that file; other filters grep test titles/tags, for example
`scripts/check journey:"home lists spaces"`.
Install Chromium once with `(cd e2e && pnpm exec playwright install chromium)`.

Each test uses fresh users, its own personal/team spaces and the real app. The `stack` fixture starts
`scripts/stack up --profile <tag>` when needed and reads `.run/stack/stack.json`; it also runs Doctor.
API-only `chat-contracts` run in the desktop project once; UI journeys run in both projects.
Every test must have `@feature:<map-entry>`. `@profile:<name>` selects its stack profile (default `full`);
`JOURNEY_PROFILE` supplies the feature-map default. All local dev profiles share the stock celld lease default of 60000 ms; explicit overrides remain possible. An existing stack must have the selected profile: explicitly
stop it before changing profiles. Keep lifecycle/restart journeys serial; the config has one worker per worktree.
Use `@computer` for computer-dependent work and `@slow` for costly lifecycle work.

Fixtures: `stack`, `api`, `people` (Alice, Bob, fresh team), `fakeLlm` (request bodies/reset), `stackCtl`
(restart celld/computerd). `api` signs in, creates users/invitations/spaces, sends RPC chat, observes runs and
reads files. Close raw RPC clients in `finally` with `client.close(); await client.closed`.
Cookies and admin credentials are local to stack.json; do not include them in evidence.

Assertions wait on UI or RPC state. No fixed sleeps. The fake LLM answers title-generation prompts with valid JSON independently of normal chat markers. The catch-up journey streams a long first turn while title generation runs.
Use fake markers documented in
`platform/dev/fake-llm/server.mjs`. The coverage lint rejects unknown or missing feature tags and empty map entries.

List and HTML reports go under `.run/journeys/`; failure traces and screenshots are in `results/`. Run one
Playwright invocation at a time per worktree so its report is not overwritten. Two worktrees are independent.
Save durable evidence under `.run/evidence/<date>/` before the next run. Stop stacks you start with
`scripts/stack down` (or `--purge` for disposable test data); evidence survives. Tests leave the stack available
for inspection; their people fixture closes its clients and retains fresh users/spaces for inspection. Every world is stopped after clients close. `down --purge` removes all test data for this worktree; account-deletion behavior belongs to its own feature checks.

The [feature map](../../.agents/skills/verify-baskule/features/README.md) selects coverage:

- `personal-chat` checks the home page, space selection, two-turn chat, and lazy computers.
- `team-chat` checks attribution, shared answers, follow-ups, and disconnected catch-up.
- `conversation-controls` checks menus and lifecycle behavior across two devices.
- `chat-contracts` checks streaming, generated titles, provider selection, authorship,
  conversation commands, queue operations, and schedules through the API.
- Plugin journeys check catalog, installation, authorization, runtime tools, and settings.

Initial navigation and reload can repeat once only after a traced Chromium `ERR_NETWORK_CHANGED` navigation or bootstrap failure. Chat and stop actions are never retried; Playwright test retries remain zero.
