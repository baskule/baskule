---
paths: ["desktop/**", "app/apps/desktop/**", "app/apps/web/src/baskule/views/Desktop*", "app/apps/web/src/baskule/views/DownloadsView.tsx", "app/apps/web/src/baskule/connect.ts"]
journeys: null
profile: "full"
checks: ["desktop/check.sh"]
---
# Desktop client

## Sub-features

Native shell, connection and IPC.

## Open the feature

Launch the packaged desktop app and connect to the installation.

## Verification

This feature has no dedicated journey; `feature:desktop-client` runs the desktop checks.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Use disposable accounts, spaces, and computers created for the check. If a port is busy, identify the process using it; never stop another run or worktree to free it.
