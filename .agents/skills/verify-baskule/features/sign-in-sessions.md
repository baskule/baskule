---
paths: ["platform/src/control/**", "platform/src/worker.ts", "app/apps/web/src/baskule/session.ts", "app/apps/web/src/baskule/connect.ts", "app/apps/web/src/baskule/views/LoginView.tsx", "app/apps/web/src/baskule/views/Connect*", "app/apps/web/src/baskule/views/BrowserSignInButton.tsx", "app/apps/web/src/routes/login.tsx", "app/apps/web/src/routes/reset-password.tsx", "app/apps/web/src/routes/link.tsx", "app/apps/web/src/routes/connect*"]
journeys: null
profile: "full"
checks: ["scripts/check worker web"]
---
# Sign in and sessions

## Sub-features

Sign in, sign out, session revocation and password reset.

## How to get to it (user POV)

Open the app URL; sign in with Email and Password.

## Driving it with T3 preview or Playwright

Run `scripts/check feature:sign-in-sessions`. Not migrated yet: the declared check preserves the current harness coverage.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Do not assume existing users, spaces or computers. Legacy checks may own fixed ports; do not kill another run to free them.
