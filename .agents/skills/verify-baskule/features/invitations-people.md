---
paths: ["platform/src/control/**", "app/apps/web/src/baskule/admin/people/**", "app/apps/web/src/baskule/views/InvitationView.tsx", "app/apps/web/src/baskule/views/AddPersonDialog.tsx", "app/apps/web/src/routes/invite.tsx"]
journeys: null
profile: "full"
checks: ["scripts/check worker web"]
---
# Invitations and people

## Sub-features

Invite, accept, remove and manage membership.

## How to get to it (user POV)

Open Admin → People; create a user or invitation.

## Driving it with T3 preview or Playwright

Run `scripts/check feature:invitations-people`. Not migrated yet: the declared check preserves the current harness coverage.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Do not assume existing users, spaces or computers. Legacy checks may own fixed ports; do not kill another run to free them.
