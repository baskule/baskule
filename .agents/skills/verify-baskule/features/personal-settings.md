---
paths: ["app/apps/web/src/routes/settings*", "app/apps/web/src/baskule/views/PersonalSettingsView.tsx", "app/apps/web/src/baskule/BaskuleUserMenu.tsx", "app/apps/web/src/baskule/ChangePasswordDialog.tsx"]
journeys: null
profile: "full"
checks: ["scripts/check worker web"]
---
# Personal settings

## Sub-features

Personal preferences, language, appearance, password changes and device connections.

## How to get to it (user POV)

Open the account menu → Settings. Password changes and device connections are in the personal account controls.

## Driving it with T3 preview or Playwright

Run `scripts/check feature:personal-settings`. Change one preference and verify the visible result, then restore it. For a password check, use a disposable user and prove the old password fails after the new one succeeds. The current web harness covers these screens until migration.

## Gotchas

Some preferences are per browser, so use an isolated browser context. Never change the owner’s account password or an existing signed-in profile.
