---
paths: ["platform/src/space/**", "computerd/**", "app/apps/web/src/components/chat/**", "app/apps/web/src/baskule/WorkspaceFileDownload.tsx"]
journeys: null
profile: "full"
checks: ["scripts/check space:files-and-attachments"]
---
# Files and attachments

## Sub-features

Upload, download, file tree, isolation.

## How to get to it (user POV)

Open a chat → Toggle right panel; attach a file in the composer.

## Driving it with T3 preview or Playwright

Run `scripts/check feature:files-attachments`. Not migrated yet: the declared check preserves the current harness coverage.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Do not assume existing users, spaces or computers. Legacy checks may own fixed ports; do not kill another run to free them.
