---
paths: ["platform/src/control/**", "platform/src/agent/**", "app/apps/web/src/baskule/plugins/**", "app/apps/web/src/baskule/admin/plugins/**", "app/apps/web/src/routes/apps.tsx", "app/apps/web/src/routes/settings.plugins.tsx", "app/apps/web/src/routes/settings.connections.tsx"]
journeys: null
profile: "full"
checks: ["scripts/check features worker web"]
---
# Plugins: catalog, install, runtime and connections

## Sub-features

Catalog, installation, runtime tools, connection lifecycle.

## How to get to it (user POV)

Open Settings → Plugins; browse, install and connect.

## Driving it with T3 preview or Playwright

Run `scripts/check feature:plugins`. Not migrated yet: the declared check preserves the current harness coverage.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Do not assume existing users, spaces or computers. Legacy checks may own fixed ports; do not kill another run to free them.
