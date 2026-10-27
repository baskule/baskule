---
paths: ["platform/src/control/**", "platform/src/space/**", "app/apps/web/src/baskule/admin/spaces/**", "app/apps/web/src/baskule/SpaceManagementDialog.tsx", "app/apps/web/src/baskule/spaces.ts"]
journeys: null
profile: "full"
checks: ["scripts/check worker space web"]
---
# Spaces and membership

## Sub-features

Create and delete team spaces, manage members and roles, inspect personal spaces.

## How to get to it (user POV)

Open Admin → Spaces for team and personal space lists. Open a team’s space menu to manage its members.

## Driving it with T3 preview or Playwright

Run `scripts/check feature:spaces`. Create a team with two members, verify both can select it in Run on, remove one member and verify access is revoked. Delete the disposable team and verify it leaves the list. The declared legacy checks currently cover these boundaries.

## Gotchas

Deleting a space wipes its alpha data. Use only a space created for this check on the worktree stack.
