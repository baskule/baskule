import { expect, it } from "vite-plus/test";
import { ThreadId, type AssetResource } from "@t3tools/contracts";
import { assetExportResource } from "./mediaActionsSource";

it.each(["report.csv", "archive.zip", "large-source.ts", "unknown.binary"])(
  "exports the original workspace or draft file as an attachment: %s",
  (name) => {
    const threadId = ThreadId.make("thread");
    for (const resource of [
      { _tag: "workspace-file", threadId, path: `/workspace/${name}` },
      { _tag: "draft-workspace-file", cwd: "/workspace", path: name },
    ] satisfies AssetResource[]) {
      expect(assetExportResource(resource)).toEqual({ ...resource, disposition: "attachment" });
    }
  },
);
