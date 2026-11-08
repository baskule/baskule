---
paths: ["app/apps/web/src/routes/_chat.settings*", "app/apps/web/src/baskule/settingsPages.ts", "app/apps/web/src/baskule/BaskuleSettingsNav.tsx", "app/apps/web/src/baskule/views/PersonalSettingsView.tsx", "app/apps/web/src/baskule/views/DownloadsView.tsx", "app/apps/web/src/baskule/BaskuleUserMenu.tsx", "app/apps/web/src/baskule/ChangePasswordView.tsx"]
journeys: null
profile: "full"
checks: ["scripts/check worker web"]
---
# Personal settings

## Sub-features

Personal preferences, language, appearance, password changes and device connections.

## Open the feature

Open the account menu → Settings. It opens as a pop-up over the chat, like Admin, with one nav row per section: Scheduled tasks, Usage, Plugins, Spaces (owners and space creators), Desktop app (downloads, device connections, and the server in the desktop app), Change password (password sign-in), Language & appearance, and Archived chats.

## Verification

This feature has no dedicated journey; `feature:personal-settings` runs the worker and web checks. Change one preference and verify the visible result, then restore it. For a password check, use a disposable user and prove the old password fails after the new one succeeds.

## Gotchas

Some preferences are per browser, so use an isolated browser context. Use a disposable account. Never change another person's password or signed-in profile. If a port is busy, identify the process using it; never stop another run or worktree to free it.
