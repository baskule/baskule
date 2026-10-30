---
paths: ["app/apps/web/src/routes/_chat.settings*", "app/apps/web/src/baskule/settingsPages.ts", "app/apps/web/src/baskule/BaskuleSettingsNav.tsx", "app/apps/web/src/baskule/views/PersonalSettingsView.tsx", "app/apps/web/src/baskule/views/DownloadsView.tsx", "app/apps/web/src/baskule/BaskuleUserMenu.tsx", "app/apps/web/src/baskule/ChangePasswordView.tsx"]
journeys: null
profile: "full"
checks: ["scripts/check worker web"]
---
# Personal settings

## Sub-features

Personal preferences, language, appearance, password changes and device connections.

## How to get to it (user POV)

Open the account menu → Settings. It opens as a pop-up over the chat, like Admin, with one nav row per section: Scheduled tasks, Usage, Plugins, Spaces (owners and space creators), Desktop app (downloads, device connections, and the server in the desktop app), Change password (password sign-in), Language & appearance, and Archived chats.

## Driving it with T3 preview or Playwright

Run `scripts/check feature:personal-settings`. Change one preference and verify the visible result, then restore it. For a password check, use a disposable user and prove the old password fails after the new one succeeds. The current web harness covers these screens until migration.

## Gotchas

Some preferences are per browser, so use an isolated browser context. Never change the owner’s account password or an existing signed-in profile.
