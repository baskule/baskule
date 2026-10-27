---
paths: ["desktop/**", "app/apps/desktop/**", "app/apps/web/src/baskule/views/Desktop*", "app/apps/web/src/baskule/views/DownloadsView.tsx", "app/apps/web/src/baskule/connect.ts"]
journeys: null
profile: "full"
checks: ["desktop/check.sh"]
---
# Desktop client

## Sub-features

Native shell, connection and IPC.

## How to get to it (user POV)

Launch the packaged desktop app and connect to the installation.

## Driving it with T3 preview or Playwright

Run `scripts/check feature:desktop-client`. Not migrated yet: the declared check preserves the current harness coverage.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Do not assume existing users, spaces or computers. Legacy checks may own fixed ports; do not kill another run to free them.
