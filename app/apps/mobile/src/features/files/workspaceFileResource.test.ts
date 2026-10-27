import { expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";

import { workspaceFileResource } from "./workspaceFileResource";
import { assetExportResource } from "../../lib/mediaActionsSource";

it.each(["report.csv", "source.ts", "archive.zip", "unknown.binary", "README", "movie.mp4"])(
  "exports the original bytes independently of preview eligibility for %s",
  (relativePath) => {
    const threadId = ThreadId.make("thread");
    for (const input of [
      { cwd: "/repo", relativePath, threadId },
      { cwd: "/repo", relativePath, threadId: null, draftCwd: "/repo" },
    ]) {
      const resource = workspaceFileResource(input);
      expect(resource).not.toBeNull();
      expect(assetExportResource(resource!)).toEqual(
        input.threadId === null
          ? {
              _tag: "draft-workspace-file",
              cwd: "/repo",
              path: relativePath,
              disposition: "attachment",
            }
          : {
              _tag: "workspace-file",
              threadId,
              path: `/repo/${relativePath}`,
              disposition: "attachment",
            },
      );
    }
  },
);

it("does not construct a resource without a workspace or selected file", () => {
  expect(workspaceFileResource({ cwd: null, relativePath: "a.csv", threadId: null })).toBeNull();
  expect(workspaceFileResource({ cwd: "/repo", relativePath: null, threadId: null })).toBeNull();
});
