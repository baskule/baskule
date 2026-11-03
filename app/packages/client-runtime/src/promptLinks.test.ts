import {
  ProviderDriverKind,
  ProviderInstanceId,
  type RepositoryIdentity,
} from "@t3tools/contracts";

import { describe, expect, it } from "vite-plus/test";

import { findPromptLinkProjects, resolvePromptLinkModelSelection } from "./promptLinks.ts";

const identity = (canonicalKey: string, origin?: string): RepositoryIdentity => ({
  canonicalKey,
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: `https://${canonicalKey}` },
  ...(origin ? { origin: { canonicalKey: origin } } : {}),
});

describe("findPromptLinkProjects", () => {
  it("keeps exact matches in order and never a fork of the repository", () => {
    const projects = [
      {
        id: "fork",
        repositoryIdentity: identity("github.com/pingdotgg/t3code", "github.com/me/t3code"),
      },
      { id: "none", repositoryIdentity: null },
      { id: "recent", repositoryIdentity: identity("github.com/PingDotGG/T3Code") },
      { id: "older", repositoryIdentity: identity("github.com/pingdotgg/t3code") },
    ];
    const ids = (owner: string, name: string) =>
      findPromptLinkProjects(projects, { owner, name }).map((project) => project.id);
    expect(ids("pingdotgg", "t3code")).toEqual(["recent", "older"]);
    expect(ids("me", "t3code")).toEqual(["fork"]);
    expect(ids("gitlab", "x")).toEqual([]);
  });

  it("matches a checkout of the repository's GitCafe mirror", () => {
    const projects = [
      { id: "gitcafe", repositoryIdentity: identity("git.cafe/pingdotgg/t3code") },
      { id: "staging", repositoryIdentity: identity("staging.git.cafe/pingdotgg/t3code") },
      { id: "gitlab", repositoryIdentity: identity("gitlab.com/pingdotgg/t3code") },
    ];
    expect(
      findPromptLinkProjects(projects, { owner: "pingdotgg", name: "t3code" }).map(
        (project) => project.id,
      ),
    ).toEqual(["gitcafe", "staging"]);
  });
});

describe("resolvePromptLinkModelSelection", () => {
  const provider = (
    instanceId: string,
    driver: string,
    status: "ready" | "warning" | "error" | "disabled" = "ready",
  ) => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    status,
    models: [
      { slug: "small", name: "Small" },
      { slug: "big", name: "Big", aliases: ["opus"], isDefault: true },
    ],
  });

  it("maps the requested provider and model onto a usable instance", () => {
    const providers = [provider("broken", "claudeAgent", "error"), provider("work", "claudeAgent")];
    expect(
      resolvePromptLinkModelSelection(providers, { provider: "claude", model: "small" }),
    ).toEqual({
      selection: { instanceId: "work", model: "small" },
      exact: true,
    });
    expect(
      resolvePromptLinkModelSelection(providers, { provider: "claudeagent", model: "opus" }),
    ).toEqual({
      selection: { instanceId: "work", model: "big" },
      exact: true,
    });
  });

  it("uses the instance default for an unknown model, and nothing for a missing provider", () => {
    const providers = [provider("codex", "codex")];
    expect(
      resolvePromptLinkModelSelection(providers, { provider: "codex", model: "nope" }),
    ).toEqual({
      selection: { instanceId: "codex", model: "big" },
      exact: false,
    });
    expect(
      resolvePromptLinkModelSelection(providers, { provider: "cursor", model: null }),
    ).toBeNull();
  });
});
