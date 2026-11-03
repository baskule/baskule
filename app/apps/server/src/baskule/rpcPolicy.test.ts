import { ORCHESTRATION_V2_WS_METHODS as O, WS_METHODS as W } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { BASKULE_POLICY, baskuleRefusal } from "./rpcPolicy.ts";

describe("hosted client RPC policy", () => {
  it.each([
    W.projectsListEntries,
    W.projectsReadFile,
    W.projectsWriteFile,
    W.serverGetConfig,
    W.subscribeServerConfig,
    W.serverReportClientActivity,
    W.scheduledTasksSubscribe,
    W.scheduledTasksListWebhookDeliveries,
    W.scheduledTasksGetWebhookDelivery,
    W.previewOpen,
    W.previewAdjust,
    W.previewResize,
    W.previewReportStatus,
    W.subscribePreviewEvents,
    O.getArchivedShellSnapshot,
    O.subscribeThread,
    O.forceStopThread,
    W.reviewGetBranchCommits,
    W.reviewGetDiffPreview,
    W.reviewGetDiffFileContents,
  ])("allows %s used by hosted clients", (method) => {
    expect(baskuleRefusal(BASKULE_POLICY, method, {})).toBeUndefined();
  });

  it("refuses operations managed by the installation", () => {
    for (const patch of [
      { pinned: true },
      { pinned: false },
      { archived: true },
      { archived: false },
    ]) {
      expect(
        baskuleRefusal(BASKULE_POLICY, W.projectsMutate, {
          type: "project.update",
          projectId: "project",
          commandId: "organize",
          ...patch,
        }),
      ).toBeUndefined();
    }
    for (const mutation of [
      { type: "project.create" },
      { type: "project.delete" },
      { type: "project.update", workspaceRoot: "/other" },
      { type: "project.update", scripts: [] },
    ]) {
      expect(baskuleRefusal(BASKULE_POLICY, W.projectsMutate, mutation)).toContain(
        "Only project pin and archive",
      );
    }
    expect(baskuleRefusal(BASKULE_POLICY, W.projectsCreateFromThread, {})).toContain("unsupported");
    expect(baskuleRefusal(BASKULE_POLICY, W.serverUpdateSettings, {})).toContain("unsupported");
    expect(baskuleRefusal(BASKULE_POLICY, O.dispatchCommand, { type: "thread.settle" })).toContain(
      "unsupported",
    );
  });
});
