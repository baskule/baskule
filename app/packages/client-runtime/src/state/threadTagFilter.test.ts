import { EnvironmentId, type OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadKey } from "./entities.ts";
import { hiddenThreadKeys, NO_HIDDEN_THREADS, visibleLinkedThreads } from "./threadTagFilter.ts";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");

const thread = (
  id: string,
  tags: Array<string>,
  parent?: {
    readonly id: string;
    readonly relationship: "fork" | "subagent";
    readonly sideChat?: boolean;
  },
): Pick<OrchestrationV2ThreadShell, "id" | "tags" | "lineage"> => ({
  id: ThreadId.make(id),
  tags,
  lineage: {
    parentThreadId: parent === undefined ? null : ThreadId.make(parent.id),
    relationshipToParent: parent?.relationship ?? null,
    rootThreadId: ThreadId.make(parent?.id ?? id),
    ...(parent?.sideChat === undefined ? {} : { sideChat: parent.sideChat }),
  },
});

const localThreads = [
  thread("private", ["private"]),
  thread("private-subagent", [], { id: "private", relationship: "subagent" }),
  thread("private-side-chat", [], { id: "private", relationship: "fork", sideChat: true }),
  thread("private-fork", [], { id: "private", relationship: "fork" }),
  thread("plain", []),
  thread("plain-private-side-chat", ["private"], {
    id: "plain",
    relationship: "fork",
    sideChat: true,
  }),
];
const remoteThreads = [thread("remote-client", ["client"])];
const hiddenIds = (localTags: Array<string> | null, remoteTags: Array<string> | null) =>
  [
    ...hiddenThreadKeys([
      { environmentId: local, threads: localThreads, hiddenTags: localTags },
      { environmentId: remote, threads: remoteThreads, hiddenTags: remoteTags },
    ]),
  ].toSorted();
const key = (environmentId: EnvironmentId, id: string) =>
  threadKey({ environmentId, threadId: ThreadId.make(id) });

describe("hiddenThreadKeys", () => {
  it("hides nothing while every filter is off", () => {
    expect(hiddenIds(null, null)).toEqual([]);
    expect(
      hiddenThreadKeys([{ environmentId: local, threads: localThreads, hiddenTags: null }]),
    ).toBe(NO_HIDDEN_THREADS);
  });

  it("hides a tagged thread with its subagents and side chats, but not its forks", () => {
    expect(hiddenIds(["private"], null)).toEqual(
      [
        key(local, "private"),
        key(local, "private-subagent"),
        key(local, "private-side-chat"),
      ].toSorted(),
    );
  });

  it("judges an archive page against live hidden parents", () => {
    const archived = hiddenThreadKeys(
      [{ environmentId: local, threads: [localThreads[1]!], hiddenTags: null }],
      new Set([key(local, "private")]),
    );
    expect([...archived]).toEqual([key(local, "private-subagent")]);
  });

  it("hides a child whose parent is not loaded while any environment hides tags", () => {
    const orphan = thread("orphan-task", [], { id: "archived", relationship: "subagent" });
    const keys = (localTags: Array<string> | null, remoteTags: Array<string> | null) => [
      ...hiddenThreadKeys([
        { environmentId: local, threads: [orphan], hiddenTags: localTags },
        { environmentId: remote, threads: [], hiddenTags: remoteTags },
      ]),
    ];
    expect(keys(["private"], null)).toEqual([key(local, "orphan-task")]);
    expect(keys(null, ["client"])).toEqual([key(local, "orphan-task")]);
    expect(keys(null, null)).toEqual([]);
  });

  it("applies each environment's own tags", () => {
    expect(hiddenIds(null, ["client", "private"])).toEqual([key(remote, "remote-client")]);
  });

  it("keeps parent visibility scoped to its environment", () => {
    const hidden = hiddenThreadKeys([
      { environmentId: local, threads: [thread("parent", ["private"])], hiddenTags: ["private"] },
      {
        environmentId: remote,
        threads: [
          thread("parent", []),
          thread("child", [], { id: "parent", relationship: "subagent" }),
        ],
        hiddenTags: null,
      },
    ]);
    expect([...hidden]).toEqual([key(local, "parent")]);
  });

  it("judges loaded PR rows by visibility and leaves out unloaded rows while hiding", () => {
    const hidden = hiddenThreadKeys([
      { environmentId: local, threads: localThreads, hiddenTags: ["private"] },
    ]);
    const rows = [
      { id: ThreadId.make("private-subagent") },
      { id: ThreadId.make("plain-private-side-chat") },
      { id: ThreadId.make("off-shell") },
    ];
    const loaded = localThreads.map((entry) => ({ environmentId: local, threadId: entry.id }));
    const visible = (hiding: boolean) =>
      visibleLinkedThreads(rows, local, loaded, hidden, hiding).map((row) => row.id);
    expect(visible(true)).toEqual(["plain-private-side-chat"]);
    // Another machine hides tags while nothing here is hidden: unloaded rows still stay out.
    expect(
      visibleLinkedThreads(rows, local, loaded, NO_HIDDEN_THREADS, true).map((row) => row.id),
    ).toEqual(["private-subagent", "plain-private-side-chat"]);
    expect(visibleLinkedThreads(rows, local, loaded, NO_HIDDEN_THREADS, false)).toBe(rows);
  });

  it("lets a live hidden parent win over the same parent being loaded elsewhere", () => {
    const parentKey = key(local, "private");
    const archived = hiddenThreadKeys(
      [{ environmentId: local, threads: [localThreads[1]!], hiddenTags: null }],
      new Set([parentKey]),
      new Set([parentKey]),
    );
    expect([...archived]).toEqual([key(local, "private-subagent")]);
  });
});
