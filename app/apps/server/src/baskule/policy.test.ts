// baskule: the deny-by-default surface of a space (E8) and message authorship.
import { WS_METHODS, WsRpcGroup } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { AttachmentToolkit } from "../mcp/toolkits/attachment/tools.ts";
import { HtmlToolkit } from "../mcp/toolkits/html/tools.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "../mcp/toolkits/preview/tools.ts";
import { PreviewControlsToolkit } from "../mcp/toolkits/previewControls/tools.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import { ThreadToolkit } from "../mcp/toolkits/thread/tools.ts";
import { stampCommandAuthor, stampLaunchAuthor } from "./author.ts";
import {
  BASKULE_ALLOWED_COMMANDS,
  BASKULE_ALLOWED_MCP_TOOLS,
  BASKULE_ALLOWED_METHODS,
  BASKULE_POLICY,
  baskuleRefusal,
} from "./rpcPolicy.ts";
import { classifyRoute } from "./workerd/routes.ts";

const registered = new Set(WsRpcGroup.requests.keys());

describe("Baskule RPC policy", () => {
  it("only names registered methods", () => {
    for (const method of BASKULE_ALLOWED_METHODS) expect(registered.has(method), method).toBe(true);
  });

  it("only names declared MCP tools", () => {
    const declared = new Set(
      [
        AttachmentToolkit,
        HtmlToolkit,
        OrchestratorToolkit,
        PreviewToolkit,
        PreviewControlsToolkit,
        ProjectToolkit,
        ThreadToolkit,
      ].flatMap((toolkit) => Object.keys(toolkit.tools)),
    );
    for (const tool of BASKULE_ALLOWED_MCP_TOOLS) expect(declared.has(tool), tool).toBe(true);
  });

  it("refuses host features and unselected commands", () => {
    for (const method of [
      WS_METHODS.terminalOpen,
      WS_METHODS.vcsPull,
      WS_METHODS.serverUpdateSettings,
      WS_METHODS.filesystemBrowse,
      WS_METHODS.pullRequestsList,
      WS_METHODS.deviceOpen,
      WS_METHODS.serverSignalProcess,
    ]) {
      expect(baskuleRefusal(BASKULE_POLICY, method, {})).toMatch(/unsupported in Baskule/);
    }
    for (const type of [
      "thread.settle",
      "thread.unsettle",
      "thread.auto-settle.set",
      "thread.pull-request.link",
      "delegated_task.request",
    ]) {
      expect(BASKULE_ALLOWED_COMMANDS.has(type)).toBe(false);
      expect(baskuleRefusal(BASKULE_POLICY, "orchestration.dispatchCommand", { type })).toMatch(
        /unsupported/,
      );
    }
    expect(
      baskuleRefusal(BASKULE_POLICY, "orchestration.dispatchCommand", {
        type: "message.dispatch",
      }),
    ).toBeUndefined();
    for (const type of ["thread.fork", "thread.merge_back", "checkpoint.rollback"]) {
      expect(
        baskuleRefusal(BASKULE_POLICY, "orchestration.dispatchCommand", { type }),
      ).toBeUndefined();
    }
    expect(baskuleRefusal(BASKULE_POLICY, WS_METHODS.scheduledTasksUpsert, {})).toBeUndefined();
  });
});

describe("Baskule routes", () => {
  it("serves the client's HTTP surface and refuses the rest", () => {
    expect(classifyRoute("GET", "/ws", true).allow).toBe(true);
    expect(classifyRoute("GET", "/api/auth/session", false).allow).toBe(true);
    expect(classifyRoute("POST", "/api/hooks/task/token", false).allow).toBe(true);
    expect(classifyRoute("GET", "/api/assets/abc", false).allow).toBe(true);
    for (const [method, path] of [
      ["POST", "/oauth/token"],
      ["POST", "/api/auth/browser-session"],
      ["GET", "/"],
      ["GET", "/api/connect/link-state"],
      ["POST", "/api/auth/pairing-token"],
    ] as const) {
      expect(classifyRoute(method, path, false).allow, path).toBe(false);
    }
    expect(classifyRoute("GET", "/other", true).allow).toBe(false);
  });
});

describe("message authorship", () => {
  const author = { id: "u-alice", name: "Alice" };
  const dispatch = {
    type: "message.dispatch" as const,
    commandId: "c1",
    threadId: "t1",
    messageId: "m1",
    text: "hi",
    attachments: [],
    createdBy: "user" as const,
    creationSource: "web" as const,
    dispatchMode: { type: "queue_after_active" as const },
  };

  it("stamps the socket's author on every user message and drops a client-sent one", () => {
    const forged = { ...dispatch, author: { id: "x", name: "Mallory" } } as never;
    expect((stampCommandAuthor(forged, author) as { author?: unknown }).author).toEqual(author);
    expect("author" in stampCommandAuthor(forged, undefined)).toBe(false);
    const other = { type: "thread.archive", commandId: "c2", threadId: "t1" } as never;
    expect(stampCommandAuthor(other, author)).toBe(other);
    const response = {
      type: "runtime-request.respond",
      commandId: "answer",
      threadId: "t1",
      requestId: "question",
      answers: { q: "Yes" },
    } as never;
    expect((stampCommandAuthor(response, author) as { author?: unknown }).author).toEqual(author);
    expect(
      "author" in
        stampCommandAuthor(
          { type: "runtime-request.respond", author: { id: "forged", name: "Forged" } } as never,
          undefined,
        ),
    ).toBe(false);
    expect(stampLaunchAuthor({ text: "x", attachments: [] }, author)).toEqual({ author });
    expect(stampLaunchAuthor(undefined, author)).toEqual({});
  });
});
