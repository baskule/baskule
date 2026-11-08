---
paths: ["platform/src/control/**", "platform/src/space/**", "app/apps/web/src/baskule/admin/spaces/**", "app/apps/web/src/baskule/SpaceManagementDialog.tsx", "app/apps/web/src/baskule/spaces.ts"]
journeys: null
profile: "full"
checks: ["scripts/check worker space web"]
---
# Spaces and membership

## Sub-features

Create and delete team spaces, manage members and roles, inspect personal spaces.

## Open the feature

Open Admin → Spaces for team and personal space lists. Open a team's space menu to manage its members.

## Verification

This feature has no dedicated journey; `feature:spaces` runs the worker, SpaceCell, and web checks. Create a team with two members, verify both can select it in Run on, remove one member and verify access is revoked. Delete the disposable team and verify it leaves the list.

## Gotchas

Deleting a space deletes its data. Use only a space created for this check on the worktree stack. If a port is busy, identify the process using it; never stop another run or worktree to free it.
