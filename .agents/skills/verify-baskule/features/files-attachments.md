---
paths: ["platform/src/space/**", "computerd/**", "app/apps/web/src/components/chat/**", "app/apps/web/src/baskule/WorkspaceFileDownload.tsx"]
journeys: null
profile: "full"
checks: ["scripts/check space:files-and-attachments"]
---
# Files and attachments

## Sub-features

Upload, download, file tree, isolation.

## Open the feature

Open a chat → Toggle right panel; attach a file in the composer.

## Verification

This feature has no dedicated journey; `feature:files-attachments` runs the SpaceCell files and attachments check.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Use disposable accounts, spaces, and computers created for the check. If a port is busy, identify the process using it; never stop another run or worktree to free it.
