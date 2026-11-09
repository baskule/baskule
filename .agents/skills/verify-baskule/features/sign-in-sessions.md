---
paths: ["e2e/journeys/native-login.spec.mjs", "platform/src/control/**", "platform/src/worker.ts", "app/apps/web/src/baskule/session.ts", "app/apps/web/src/baskule/connect.ts", "app/apps/web/src/baskule/views/LoginView.tsx", "app/apps/web/src/baskule/views/Connect*", "app/apps/web/src/baskule/views/BrowserSignInButton.tsx", "app/apps/web/src/routes/login.tsx", "app/apps/web/src/routes/reset-password.tsx", "app/apps/web/src/routes/setup.tsx", "app/apps/web/src/baskule/views/SetupView*", "app/apps/web/src/routes/link.tsx", "app/apps/web/src/routes/connect*"]
journeys: "@feature:sign-in-sessions"
profile: "light"
checks: ["scripts/check worker web"]
---
# Sign in and sessions

## Sub-features

First-admin setup, sign in, native browser approval, sign out, session revocation and password reset.

## Open the feature

Open the app URL; sign in with Email and Password.

## Verification

The native login journey submits the approval form in a browser and verifies that the initiating client receives a working session exactly once. `feature:sign-in-sessions` also runs the worker and web checks for the remaining authentication flows.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Use disposable accounts, spaces, and computers created for the check. If a port is busy, identify the process using it; never stop another run or worktree to free it.
