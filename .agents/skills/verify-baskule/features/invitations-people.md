---
paths: ["platform/src/control/**", "app/apps/web/src/baskule/admin/people/**", "app/apps/web/src/baskule/views/InvitationView.tsx", "app/apps/web/src/baskule/views/AddPersonDialog.tsx", "app/apps/web/src/routes/invite.tsx"]
journeys: null
profile: "full"
checks: ["scripts/check worker web"]
---
# Invitations and people

## Sub-features

Invite, accept, remove and manage membership.

## Open the feature

Open Admin → People; create a user or invitation.

## Verification

This feature has no dedicated journey; `feature:invitations-people` runs the worker and web checks.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Use disposable accounts, spaces, and computers created for the check. If a port is busy, identify the process using it; never stop another run or worktree to free it.
