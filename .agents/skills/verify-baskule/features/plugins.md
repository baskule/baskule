---
paths: ["platform/src/control/**", "platform/src/agent/**", "app/apps/web/src/baskule/plugins/**", "app/apps/web/src/baskule/admin/plugins/**", "app/apps/web/src/routes/_chat.settings.plugins.tsx", "app/apps/web/baskule-dev/mock-plugins.mjs", "e2e/journeys/plugins.spec.mjs"]
journeys: "@feature:plugins"
profile: "full"
checks: ["scripts/check features:6-plugins worker web"]
---
# Plugins: catalog, install, runtime and connections

## Sub-features

Catalog, installation, runtime tools, connection lifecycle.

## How to get to it (user POV)

Administrators add plugins under Admin → Plugins and choose groups. Members open Settings → Plugins to see readiness and connect accounts. Assigned skills require no member activation.

## Driving it with T3 preview or Playwright

Run `scripts/check feature:plugins`. The plugins journey uploads portable skills, verifies Ready without activation, loads a skill in a fake-model personal chat, and checks that deactivating the sole contributor removes team skill files. The focused runtime check covers encrypted-key delivery and call-time policy; worker covers OAuth.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Do not assume existing users, spaces or computers. Legacy checks may own fixed ports; do not kill another run to free them.
