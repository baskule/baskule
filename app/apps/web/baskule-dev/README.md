# Baskule web dev loop (WP-E)

A mock Baskule front for developing the hosted web client without the platform, plus page
checks with screenshots. No LLM spend: the T3 servers talk to an OpenCode 2 CLI backed by a mock
model. Ports 47700–47749.

```sh
./check.sh                  # unit tests, hosted build, stack up, page checks + screenshots, stack down
SKIP_BUILD=1 ./check.sh admin   # reuse apps/web/dist, one scenario

MOCK_WEB=dist ./up.sh       # serve apps/web/dist (build with VITE_BASKULE_HOSTED=1 first)
MOCK_WEB=dev ./up.sh        # Vite dev server (HMR) behind the mock
node shots.mjs [scenario…]  # login invite voice admin usage passwords apps platform
./down.sh                   # PURGE=1 also deletes baskule/.run/wp-e
```

| Port   | What                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------ |
| 47700  | mock front (open this): `/auth/*`, `/api/baskule/*`, `/s/<space>/*`, `/downloads/*`, the web app                         |
| 47701  | Vite dev server (`MOCK_WEB=dev`)                                                                                         |
| 47702  | mock OpenAI-compatible model                                                                                             |
| 47703  | OpenCode 2.1.2 CLI (shared by every mock space)                                                                          |
| 47710+ | one real T3 server per space, started on the first request like a waking cell (`BASKULE_AUTH_MODE=none` behind the mock) |

- **Accounts** (mock mode): `admin@baskule.test` / `baskule-admin`, `alice@baskule.test` /
  `baskule-alice`, `bob@baskule.test` / `baskule-bob`; invitation
  `/invite#token=demo-invitation-token-0123456789`. Spaces: personal ones, Acme (Alice owner, Bob),
  Lab (admin owner, Alice).
- **API**: the mock mirrors WP-C's `/api/baskule` and Better Auth routes (`platform/README.md`).
  `MOCK_CONTROL=http://127.0.0.1:<port>` forwards `/auth`, `/api/baskule` and `/downloads` to a
  real platform (`PORT=47704 platform/dev.sh --no-llm`) and only plays the space cells; the
  `platform` scenario then needs `PLATFORM_ADMIN_EMAIL`/`PLATFORM_ADMIN_PASSWORD` (from
  `platform/.dev.vars`) and `MOCK_URL`.
- **Authorship**: until WP-B's server stamps `author`, the mock adds one to user messages in team
  spaces (alternating Alice/Bob) on WebSocket frames and HTTP snapshots (`MOCK_INJECT_AUTHOR=0` turns it off).
- State and logs: `baskule/.run/wp-e/`. Processes are tracked by PID files there.

Chat and home now use real worktree journeys: `scripts/check feature:personal-chat feature:team-chat feature:conversation-controls` from the repository root.
