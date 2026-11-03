import {
  ProjectId,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  legacyThreadPullRequestKey,
  threadPullRequestSearchTerms,
  threadPullRequestKeysEqual,
} from "./threadPullRequests.ts";

// Remove ES2023 array methods to match Hermes on mobile.
beforeEach(() => {
  const methods = ["toSorted", "toReversed", "toSpliced"] as const;
  const descriptors = methods.map((method) =>
    Object.getOwnPropertyDescriptor(Array.prototype, method),
  );
  for (const method of methods) Reflect.deleteProperty(Array.prototype, method);
  return () => {
    for (const [index, method] of methods.entries()) {
      const descriptor = descriptors[index];
      if (descriptor) Reflect.defineProperty(Array.prototype, method, descriptor);
    }
  };
});

function snapshot(input: Partial<ThreadPullRequestSnapshot> = {}): ThreadPullRequestSnapshot {
  return {
    state: "open",
    title: "Change",
    headBranch: "feature",
    baseBranch: "main",
    isDraft: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    syncedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  };
}

function link(
  number: number,
  input: Partial<Omit<ThreadPullRequestLink, "number">> = {},
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "pingdotgg/t3code",
    number,
    url: `https://github.com/pingdotgg/t3code/pull/${number}`,
    source: "manual",
    linkedAt: `2026-01-01T00:00:${String(number).padStart(2, "0")}.000Z`,
    snapshot: null,
    stack: null,
    ...input,
  };
}

describe("threadPullRequestKeysEqual", () => {
  it("recovers Forgejo ports from old stored URLs and keeps separate servers distinct", () => {
    const old = link(1, {
      host: "forge.example",
      repository: "team/repo",
      url: "http://forge.example:3000/team/repo/pulls/1",
    });
    expect(threadPullRequestKeysEqual(old, { ...old, host: "forge.example:3000" })).toBe(true);
    expect(
      threadPullRequestKeysEqual(old, {
        host: "forge.example:3000",
        repository: "team/repo",
        number: 1,
      }),
    ).toBe(true);
    expect(
      threadPullRequestKeysEqual(old, {
        ...old,
        url: "http://forge.example:4000/team/repo/pulls/1",
      }),
    ).toBe(false);
  });

  it("recovers Azure repository keys from stored URLs", () => {
    const own = link(7, {
      host: "dev.azure.com",
      repository: "org-a/project/_git/web",
      url: "https://dev.azure.com/org-a/project/_git/web/pullrequest/7",
    });
    expect(legacyThreadPullRequestKey({ ...own, repository: "web" })).toEqual({
      host: "dev.azure.com",
      repository: "org-a/project/_git/web",
      number: 7,
    });
    expect(
      threadPullRequestKeysEqual(own, {
        host: "org-a.visualstudio.com",
        repository: "DefaultCollection/project/_git/web",
        number: 7,
      }),
    ).toBe(true);
  });
});

describe("threadPullRequestSearchTerms", () => {
  it("includes completed and unsynced links but excludes dismissed links", () => {
    const terms = threadPullRequestSearchTerms({
      pullRequests: [
        link(12, { snapshot: snapshot({ title: "Fix login", state: "merged" }) }),
        link(34),
        link(56, { source: "stack-dismissed" }),
      ],
    });
    expect(terms).toContain("#12");
    expect(terms).toContain("pingdotgg/t3code#12");
    expect(terms).toContain("https://github.com/pingdotgg/t3code/pull/12");
    expect(terms).toContain("Fix login");
    expect(terms).toContain("#34");
    expect(terms.join(" ")).not.toContain("56");
  });
});

it("searches the legacy projection when old environments decode to an empty links list", () => {
  const linkedPullRequest = {
    projectId: ProjectId.make("project"),
    repository: "pingdotgg/t3code",
    number: 12,
    url: "https://github.com/pingdotgg/t3code/pull/12",
  };
  expect(threadPullRequestSearchTerms({ pullRequests: [], linkedPullRequest })).toContain("#12");
  expect(
    threadPullRequestSearchTerms({ pullRequests: [link(34)], linkedPullRequest }),
  ).not.toContain("#12");
});
