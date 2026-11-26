import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { buildHomeProjectScopes, type HomeProjectScope } from "../home/homeThreadList";
import {
  getProjectScopeSelectionTarget,
  isSameRepository,
  newTaskDestination,
  newTaskFilteredProject,
  resolveDraftProjectSelection,
  resolveEnvironmentProjectMatch,
  resolveNewTaskScratchOption,
} from "./new-task-project-selection";

function makeProject(
  id: string,
  environmentId = "environment",
  options: {
    readonly title?: string;
    readonly workspaceRoot?: string;
    readonly repositoryKey?: string;
  } = {},
): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make(environmentId),
    id: ProjectId.make(id),
    title: options.title ?? id,
    workspaceRoot: options.workspaceRoot ?? `/work/${id}`,
    repositoryIdentity: options.repositoryKey
      ? {
          canonicalKey: options.repositoryKey,
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: `https://${options.repositoryKey}.git`,
          },
        }
      : null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeScope(projects: ReadonlyArray<EnvironmentProject>): HomeProjectScope {
  return {
    key: "github.com/t3tools/t3code",
    title: "T3 Code",
    representative: projects[0]!,
    projects,
    projectRefs: projects.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    })),
    pinned: false,
    archived: false,
  };
}

describe("getProjectScopeSelectionTarget", () => {
  it("chooses an open copy of a repository over an archived copy on the preferred machine", () => {
    const repo = { repositoryKey: "github.com/t3tools/t3code" };
    const archived = {
      ...makeProject("archived-copy", "mac", repo),
      archivedAt: "2026-07-02T00:00:00.000Z",
    };
    const open = makeProject("open-copy", "server", repo);
    const [scope] = buildHomeProjectScopes({
      projects: [archived, open],
      environmentId: null,
      projectGroupingMode: "repository",
    });
    if (!scope || scope.archived) throw new Error("Expected a pickable repository group");

    expect(
      getProjectScopeSelectionTarget(
        scope,
        archived.environmentId,
        new Set([archived.environmentId, open.environmentId]),
      ).id,
    ).toBe(open.id);
  });

  it("prefers a connected copy of a project that spans environments", () => {
    const mac = makeProject("t3code", "mac");
    const server = makeProject("t3code", "server");
    const target = (connected: ReadonlyArray<string>, preferred: string | null = null) =>
      getProjectScopeSelectionTarget(
        makeScope([mac, server]),
        preferred === null ? null : EnvironmentId.make(preferred),
        new Set(connected.map((id) => EnvironmentId.make(id))),
      );
    expect(target(["server"])).toBe(server);
    expect(target(["server"], "mac")).toBe(server);
    expect(target(["mac", "server"], "server")).toBe(server);
    expect(target(["mac", "server"])).toBe(mac);
    // With nothing connected, the usual order still applies.
    expect(target([], "server")).toBe(server);
    expect(target([])).toBe(mac);
  });

  it("starts in the repository root over an earlier sub-folder in the same environment", () => {
    const identity = (project: EnvironmentProject) => ({
      ...project.repositoryIdentity!,
      rootPath: "/work/workspace",
    });
    const base = makeProject("old-tool", "mac", {
      workspaceRoot: "/work/workspace/_archive/old-tool",
      repositoryKey: "github.com/owner/workspace",
    });
    const subfolder = { ...base, repositoryIdentity: identity(base) };
    const root = {
      ...makeProject("workspace", "mac", { workspaceRoot: "/work/workspace" }),
      repositoryIdentity: identity(base),
    };
    expect(
      getProjectScopeSelectionTarget(
        { ...makeScope([subfolder, root]), representative: root },
        EnvironmentId.make("mac"),
        new Set([EnvironmentId.make("mac")]),
      ),
    ).toBe(root);
  });
});

describe("newTaskFilteredProject", () => {
  it("never starts in an archived copy of the filtered project", () => {
    const mac = { ...makeProject("t3code", "mac"), archivedAt: "2026-01-01T00:00:00.000Z" };
    const server = makeProject("t3code", "server");
    expect(
      newTaskFilteredProject(
        makeScope([mac, server]),
        null,
        new Set([mac.environmentId, server.environmentId]),
        { environmentId: "mac", projectId: "t3code" },
      ),
    ).toEqual({ environmentId: "server", projectId: "t3code" });
  });

  it("prefers the remembered copy of the filtered project", () => {
    const mac = makeProject("t3code", "mac");
    const server = makeProject("t3code", "server");
    const connected = new Set([mac.environmentId, server.environmentId]);
    const filtered = (last?: { readonly environmentId: string; readonly projectId: string }) =>
      newTaskFilteredProject(makeScope([mac, server]), null, connected, last);
    expect(filtered({ environmentId: "server", projectId: "t3code" })).toEqual({
      environmentId: "server",
      projectId: "t3code",
    });
    expect(filtered({ environmentId: "server", projectId: "other" })).toEqual({
      environmentId: "mac",
      projectId: "t3code",
    });
  });
});

describe("resolveEnvironmentProjectMatch", () => {
  it("follows the same repository onto the target machine", () => {
    const selected = makeProject("t3code", "mac", { repositoryKey: "github.com/t3tools/t3code" });
    const target = [
      makeProject("other", "server", { repositoryKey: "github.com/t3tools/other" }),
      makeProject("t3code-clone", "server", { repositoryKey: "github.com/t3tools/t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(target, selected)).toBe(target[1]);
    expect(isSameRepository(target[1]!, selected)).toBe(true);
  });

  it("falls back to workspace basename, then title, for unindexed projects", () => {
    const selected = makeProject("t3code", "mac", { workspaceRoot: "/Users/me/t3code" });
    const byBasename = [
      makeProject("other", "server"),
      makeProject("srv", "server", { workspaceRoot: "/home/me/t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(byBasename, selected)).toBe(byBasename[1]);
    expect(isSameRepository(byBasename[1]!, selected)).toBe(false);

    const byTitle = [
      makeProject("other", "server"),
      makeProject("srv", "server", { title: "t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(byTitle, selected)).toBe(byTitle[1]);
  });

  it("does not treat a known different repository as a basename or title match", () => {
    const selected = makeProject("t3code", "mac", {
      repositoryKey: "github.com/t3tools/t3code",
      workspaceRoot: "/Users/me/t3code",
    });
    const fork = makeProject("fork", "server", {
      repositoryKey: "github.com/someone/t3code",
      title: "t3code",
      workspaceRoot: "/home/me/t3code",
    });
    const unindexed = makeProject("unindexed", "server", { workspaceRoot: "/srv/t3code" });
    expect(resolveEnvironmentProjectMatch([fork, unindexed], selected)).toBe(unindexed);
    expect(resolveEnvironmentProjectMatch([fork], selected)).toBe(fork);
    expect(isSameRepository(fork, selected)).toBe(false);
  });
});

describe("resolveDraftProjectSelection", () => {
  it("preserves an explicit project selection", () => {
    const project = makeProject("t3code");
    expect(
      resolveDraftProjectSelection("environment:t3code", [project], [makeScope([project])], {
        incomingShareId: undefined,
        pickerClosed: false,
      }),
    ).toEqual({ kind: "preserve" });
  });

  it("waits for the Personal scratch flow even when a team is the only loaded project", () => {
    const project = makeProject("t3code");
    expect(
      resolveDraftProjectSelection(null, [project], [makeScope([project])], {
        incomingShareId: undefined,
        pickerClosed: false,
      }),
    ).toEqual({
      kind: "pick",
    });
  });

  it("does not automatically target a sole logical team project", () => {
    const projects = [makeProject("t3code"), makeProject("t3code-2"), makeProject("t3code-3")];
    expect(
      resolveDraftProjectSelection(null, projects, [makeScope(projects)], {
        incomingShareId: undefined,
        pickerClosed: false,
      }),
    ).toEqual({
      kind: "pick",
    });
  });

  it("preserves an explicit project while its catalog entry is unavailable", () => {
    const project = makeProject("t3code");
    expect(
      resolveDraftProjectSelection("environment:removed", [project], [makeScope([project])], {
        incomingShareId: undefined,
        pickerClosed: false,
      }),
    ).toEqual({
      kind: "preserve",
    });
  });

  it("opens the space picker for a share even when a previous project is saved", () => {
    const projects = [makeProject("t3code"), makeProject("t3code-2")];
    const scopes = projects.map((project) => makeScope([project]));
    expect(
      resolveDraftProjectSelection(null, projects, scopes, {
        incomingShareId: "share",
        pickerClosed: false,
        useLastProject: true,
        lastProject: { environmentId: "environment", projectId: "t3code-2" },
      }),
    ).toEqual({ kind: "pick" });
  });
});

describe("newTaskDestination", () => {
  const picker = { draft: { requestId: "request" } };

  function destination(options: {
    readonly useLastProject: boolean | undefined;
    readonly projects: ReadonlyArray<EnvironmentProject>;
    readonly current?: EnvironmentProject;
    readonly filtered?: EnvironmentProject;
    readonly last?: { readonly environmentId: string; readonly projectId: string };
  }) {
    return newTaskDestination({
      projects: options.projects,
      requestId: "request",
      useLastProject: options.useLastProject,
      currentProject: options.current && {
        environmentId: options.current.environmentId,
        projectId: options.current.id,
      },
      filteredProject: options.filtered && {
        environmentId: options.filtered.environmentId,
        projectId: options.filtered.id,
      },
      lastProject: options.last,
    });
  }

  it("starts in the current thread's project ahead of the filtered and remembered ones", () => {
    const projects = [makeProject("remembered"), makeProject("current", "other-environment")];
    expect(
      destination({
        useLastProject: true,
        projects,
        current: projects[1],
        filtered: projects[0],
        last: { environmentId: "environment", projectId: "remembered" },
      }),
    ).toEqual({
      draft: { requestId: "request", environmentId: "other-environment", projectId: "current" },
    });
  });

  it("starts in the thread list's filtered project ahead of the remembered one", () => {
    const projects = [makeProject("bravo"), makeProject("alpha")];
    expect(
      destination({
        useLastProject: true,
        projects,
        filtered: projects[1],
        last: { environmentId: "environment", projectId: "bravo" },
      }),
    ).toEqual({
      draft: { requestId: "request", environmentId: "environment", projectId: "alpha" },
    });
  });

  it("opens the picker for an archived last project, but keeps an archived current one", () => {
    const archived = { ...makeProject("archived"), archivedAt: "2026-01-01T00:00:00.000Z" };
    expect(
      destination({
        useLastProject: true,
        projects: [archived],
        last: { environmentId: "environment", projectId: "archived" },
      }),
    ).toEqual(picker);
    expect(destination({ useLastProject: true, projects: [archived], current: archived })).toEqual({
      draft: { requestId: "request", environmentId: "environment", projectId: "archived" },
    });
  });

  it("treats an unset preference as on", () => {
    const projects = [makeProject("first"), makeProject("current")];
    expect(destination({ useLastProject: undefined, projects, current: projects[1] })).toEqual({
      draft: { requestId: "request", environmentId: "environment", projectId: "current" },
    });
  });

  it("starts in the remembered project of its own environment when there is no current one", () => {
    const projects = [makeProject("chosen"), makeProject("chosen", "other-environment")];
    expect(
      destination({
        useLastProject: true,
        projects,
        last: { environmentId: "other-environment", projectId: "chosen" },
      }),
    ).toEqual({
      draft: { requestId: "request", environmentId: "other-environment", projectId: "chosen" },
    });
  });

  it("ignores a remembered project id from another environment", () => {
    expect(
      destination({
        useLastProject: true,
        projects: [makeProject("chosen")],
        last: { environmentId: "removed-environment", projectId: "chosen" },
      }),
    ).toEqual(picker);
  });

  it("opens the picker rather than the first project when nothing matches", () => {
    expect(
      destination({
        useLastProject: true,
        projects: [makeProject("first"), makeProject("second")],
        current: makeProject("removed"),
      }),
    ).toEqual(picker);
  });

  it("always opens the picker when the preference is off", () => {
    const only = makeProject("only");
    expect(
      destination({
        useLastProject: false,
        projects: [only],
        current: only,
        filtered: only,
        last: { environmentId: "environment", projectId: "only" },
      }),
    ).toEqual(picker);
  });
});

describe("resolveNewTaskScratchOption", () => {
  const environmentId = EnvironmentId.make("environment");
  const otherId = EnvironmentId.make("other");
  const configs = new Map([[environmentId, { scratchWorkspaceRoot: "/scratch" }]]);

  it("offers the option from the cached config while the environment is still connecting", () => {
    expect(
      resolveNewTaskScratchOption({
        environments: [{ environmentId, connectionState: "connecting" }],
        serverConfigs: configs,
        selectedEnvironmentId: null,
      }),
    ).toEqual({ environmentId, ready: false });
  });

  it("becomes ready without changing environment once connected", () => {
    expect(
      resolveNewTaskScratchOption({
        environments: [{ environmentId, connectionState: "connected" }],
        serverConfigs: configs,
        selectedEnvironmentId: null,
      }),
    ).toEqual({ environmentId, ready: true });
  });

  it("hides the option when no environment reports a scratch root", () => {
    expect(
      resolveNewTaskScratchOption({
        environments: [{ environmentId, connectionState: "connected" }],
        serverConfigs: new Map([[environmentId, {}]]),
        selectedEnvironmentId: null,
      }),
    ).toBeNull();
    expect(
      resolveNewTaskScratchOption({
        environments: [{ environmentId, connectionState: "connected" }],
        serverConfigs: new Map(),
        selectedEnvironmentId: null,
      }),
    ).toBeNull();
  });

  it("keeps the selected space while it reconnects", () => {
    expect(
      resolveNewTaskScratchOption({
        environments: [
          { environmentId, connectionState: "reconnecting" },
          { environmentId: otherId, connectionState: "connected" },
        ],
        serverConfigs: new Map([
          [environmentId, { scratchWorkspaceRoot: "/scratch" }],
          [otherId, { scratchWorkspaceRoot: "/other-scratch" }],
        ]),
        selectedEnvironmentId: environmentId,
      }),
    ).toEqual({ environmentId, ready: false });
  });

  it("keeps the selected environment when every offering environment is connected", () => {
    expect(
      resolveNewTaskScratchOption({
        environments: [
          { environmentId: otherId, connectionState: "connected" },
          { environmentId, connectionState: "connected" },
        ],
        serverConfigs: new Map([
          [environmentId, { scratchWorkspaceRoot: "/scratch" }],
          [otherId, { scratchWorkspaceRoot: "/other-scratch" }],
        ]),
        selectedEnvironmentId: environmentId,
      }),
    ).toEqual({ environmentId, ready: true });
  });
});
