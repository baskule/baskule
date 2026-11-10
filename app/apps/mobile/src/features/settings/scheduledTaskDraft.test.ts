import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerConfig,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
} from "@t3tools/contracts";
import {
  createDraft,
  defaultScheduledTaskProject,
  resolveScheduledTaskSaveTarget,
  scheduledTaskDefaultModel,
  scheduledTaskWorkspaceStrategy,
  DEFAULT_SCHEDULE,
  scheduleDraftForTask,
  scheduleFromDraft,
} from "./scheduledTaskDraft";

describe("scheduleDraftForTask", () => {
  it("opens legacy sub-minute schedules at the writable minimum", () => {
    const draft = scheduleDraftForTask({ schedule: { type: "interval", everyMs: 30_000 } });
    expect(draft.intervalMinutes).toBe("1");
    expect(scheduleFromDraft(draft)).toEqual({ type: "interval", everyMs: 60_000 });
  });

  it("round-trips dedupe settings and rejects invalid windows", () => {
    const dedupe = {
      replayKey: "{{headers.delivery-id}}",
      coalesceKey: "{{body.id}}",
      coalesceWindowSeconds: 3600,
    };
    const draft = scheduleDraftForTask({ schedule: { type: "webhook", signature: null, dedupe } });
    expect(scheduleFromDraft(draft)).toMatchObject({ dedupe });
    expect(
      scheduleFromDraft({
        ...draft,
        replayKey: " \n ",
        coalesceKey: " \t ",
        coalesceWindowSeconds: "",
      }),
    ).toMatchObject({ dedupe: {} });
    expect(
      scheduleFromDraft({
        ...draft,
        replayKey: `  ${dedupe.replayKey}  `,
        coalesceKey: `\t${dedupe.coalesceKey}\n`,
      }),
    ).toMatchObject({ dedupe });
    expect(
      scheduleFromDraft({ ...draft, replayKey: "", coalesceKey: "", coalesceWindowSeconds: "" }),
    ).toMatchObject({ dedupe: {} });
    for (const coalesceWindowSeconds of ["9", "3601", "1.5", "abc"]) {
      expect(scheduleFromDraft({ ...draft, coalesceWindowSeconds })).toBeNull();
    }
  });

  it("keeps a webhook signature on save without sending a secret", () => {
    const signature = {
      header: "x-hub-signature-256",
      encoding: "hex" as const,
      prefix: "sha256=",
    };
    const saved = scheduleFromDraft(
      scheduleDraftForTask({ schedule: { type: "webhook", signature } }),
    );
    expect(saved).toEqual({ type: "webhook", signature, maxDeliveryAgeMinutes: null, dedupe: {} });
    expect(saved?.type === "webhook" && saved.signature && "secret" in saved.signature).toBe(false);
  });

  it("round-trips webhook filters and refuses an invalid one", () => {
    const filters = [
      { path: "headers.x-github-event", op: "equals", value: "pull_request" },
      { path: "body.label.name", op: "in", value: ["needs review", "agent:fix"] },
    ] as const;
    const draft = scheduleDraftForTask({ schedule: { type: "webhook", signature: null, filters } });
    // Untouched rows are left out, so the server keeps whatever is stored now.
    expect(scheduleFromDraft(draft)).not.toHaveProperty("filters");
    expect(scheduleFromDraft({ ...draft, filters: [] })).toMatchObject({ filters: [] });
    expect(scheduleFromDraft({ ...draft, filters: draft.filters.slice(1) })).toMatchObject({
      filters: filters.slice(1),
    });
    expect(
      scheduleFromDraft({ ...draft, filters: [{ id: "f1", path: "", op: "exists", value: "" }] }),
    ).toBeNull();
  });
});

describe("scheduleFromDraft", () => {
  it("rejects an empty day selection rather than silently scheduling every day", () => {
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE, weekdays: [] })).toBeNull();
  });

  it.each([
    ["1.5", 90_000],
    ["2,5", 150_000],
    [" 2,5 ", 150_000],
    [String(60_001 / 60_000), 60_001],
  ])("preserves a valid %s minute interval when saving", (intervalMinutes, everyMs) => {
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "interval", intervalMinutes })).toEqual({
      type: "interval",
      everyMs,
    });
  });

  it.each(["0,5", "2,5,0", "Infinity", "150119987580", ""])(
    "rejects invalid interval minutes: %s",
    (intervalMinutes) => {
      expect(
        scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "interval", intervalMinutes }),
      ).toBeNull();
    },
  );
});

describe("scheduled task model defaults", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const projectId = ProjectId.make("project");
  const environmentSelection = {
    instanceId,
    model: "environment-model",
    options: [{ id: "reasoning", value: "high" }],
  };
  const projectSelection = { instanceId, model: "project-model" };
  const config = {
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: { [instanceId]: { driver: "opencode", enabled: true } },
      defaultModelSelection: environmentSelection,
    },
    providers: [
      {
        instanceId,
        driver: "opencode",
        displayName: "Codex",
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        models: [
          { slug: "first-model", name: "First", isCustom: false, capabilities: null },
          {
            slug: "catalog-default",
            name: "Default",
            isDefault: true,
            isCustom: false,
            capabilities: null,
          },
          { slug: "environment-model", name: "Environment", isCustom: false, capabilities: null },
          { slug: "project-model", name: "Project", isCustom: false, capabilities: null },
        ],
      },
    ],
  } as unknown as ServerConfig;
  const resolve = scheduledTaskDefaultModel;
  it("prefers the project's configured model", () => {
    expect(resolve(config, { id: projectId, defaultModelSelection: projectSelection })).toEqual(
      projectSelection,
    );
    expect(
      resolve(
        {
          ...config,
          settings: {
            ...config.settings,
            projectSettingsOverrides: {
              [projectId]: { defaultModelSelection: projectSelection },
            },
          },
        },
        { id: projectId },
      ),
    ).toEqual(projectSelection);
  });
  it("uses the advertised default instead of catalog order when no default is configured", () => {
    expect(
      resolve({ ...config, settings: { ...config.settings, defaultModelSelection: null } }, null),
    ).toEqual({ instanceId, model: "catalog-default" });
  });
  it("falls back to the environment default when the project provider is unavailable", () => {
    expect(
      resolve(config, {
        id: projectId,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("unavailable"),
          model: "missing",
        },
      }),
    ).toEqual(environmentSelection);
  });
  it("does not choose an implicit model on a disabled provider", () => {
    expect(
      resolve(
        {
          ...config,
          settings: {
            ...config.settings,
            providerInstances: {
              [instanceId]: { driver: ProviderDriverKind.make("opencode"), enabled: false },
            },
          },
          providers: config.providers.map((provider) => ({ ...provider, enabled: false })),
        },
        null,
      ),
    ).toBeNull();
  });
});

it("rejects dedupe keys without valid request placeholders", () => {
  expect(
    scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "webhook", replayKey: "literal" }),
  ).toBeNull();
  expect(
    scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "webhook", coalesceKey: "{{body.bad" }),
  ).toBeNull();
});

// Baskule hides project, model and checkout controls; these run with those flags off.
describe("Baskule scheduled task project", () => {
  const instanceId = ProviderInstanceId.make("opencode");
  const spaceModel = { instanceId, model: "space-model" };
  const scratchModel = { instanceId, model: "scratch-model" };
  const pinned = {
    id: ProjectId.make("pinned"),
    workspaceRoot: "/work/pinned",
    pinnedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
  };
  const scratch = { id: ProjectId.make("scratch"), workspaceRoot: "/scratch", archivedAt: null };
  const defaultModel = (project: { id: ProjectId }) =>
    project.id === scratch.id ? scratchModel : spaceModel;

  it("starts new tasks in the space's chat project, never another pinned project", () => {
    expect(
      defaultScheduledTaskProject([pinned, scratch], { scratchWorkspaceRoot: "/scratch" }),
    ).toBe(scratch);
    expect(defaultScheduledTaskProject([pinned], { scratchWorkspaceRoot: "/scratch" })).toBeNull();
  });

  it("opens the chat project of a fresh space on save, with its default model", async () => {
    const draft = createDraft(null, spaceModel);
    const opened: string[] = [];
    const target = await resolveScheduledTaskSaveTarget({
      draft,
      projects: [pinned],
      openScratchProject: async () => {
        opened.push("scratch");
        return scratch;
      },
      defaultModel,
    });
    expect(target).toEqual({ _tag: "ready", projectId: scratch.id, modelSelection: scratchModel });
    expect(opened).toEqual(["scratch"]);
  });

  it("reuses the chat project already in the draft without opening it again", async () => {
    const target = await resolveScheduledTaskSaveTarget({
      draft: createDraft(scratch.id, null),
      projects: [pinned, scratch],
      openScratchProject: () => Promise.reject(new Error("must not open")),
      defaultModel,
    });
    expect(target).toEqual({ _tag: "ready", projectId: scratch.id, modelSelection: scratchModel });
  });

  it("keeps an edited task's project and explicit model, and moves it only once the project is gone", async () => {
    const draft = {
      projectId: pinned.id,
      modelSelection: spaceModel,
      modelSelectionIsExplicit: true,
    };
    const openScratchProject = async () => scratch;
    await expect(
      resolveScheduledTaskSaveTarget({
        draft,
        projects: [pinned],
        openScratchProject,
        defaultModel,
      }),
    ).resolves.toEqual({ _tag: "ready", projectId: pinned.id, modelSelection: spaceModel });
    await expect(
      resolveScheduledTaskSaveTarget({ draft, projects: [], openScratchProject, defaultModel }),
    ).resolves.toEqual({ _tag: "ready", projectId: scratch.id, modelSelection: spaceModel });
  });

  it("reports a space that cannot open its chat project or has no model yet", async () => {
    await expect(
      resolveScheduledTaskSaveTarget({
        draft: createDraft(null, spaceModel),
        projects: [],
        openScratchProject: async () => null,
        defaultModel,
      }),
    ).resolves.toEqual({ _tag: "space-not-ready" });
    await expect(
      resolveScheduledTaskSaveTarget({
        draft: createDraft(null, null),
        projects: [],
        openScratchProject: async () => scratch,
        defaultModel: () => null,
      }),
    ).resolves.toEqual({ _tag: "space-not-ready" });
  });

  it("runs every task in the project root, including older worktree tasks", () => {
    for (const workspace of ["worktree", "existing_worktree", "root"] as const) {
      expect(
        scheduledTaskWorkspaceStrategy({
          workspace,
          checkoutPath: "",
          baseRef: "main",
          startFromOrigin: true,
        }),
      ).toEqual({ type: "root" });
    }
  });
});
