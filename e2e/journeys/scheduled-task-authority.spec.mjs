import { test, expect, signIn } from "./fixtures.mjs";

test("scheduled task controls retain the author's authority", { tag: ["@feature:schedules-webhooks", "@profile:light"] }, async ({ page, stack, people, api }) => {
  const alice = await people.alice.rpc(people.team);
  const bob = await people.bob.rpc(people.team);
  const admin = await api.admin.rpc(people.team);
  try {
    const projectId = (await bob.ok("projects.ensureScratch", {})).projectId;
    const input = {
      commandId: crypto.randomUUID(),
      title: "Bob's scheduled work",
      prompt: "Check progress [[fake:text Bob completed scheduled work]]",
      enabled: false,
      schedule: { type: "interval", everyMs: 60_000 },
      projectId,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "opencode", model: "custom/fake-model" },
      runtimeMode: "full-access",
      interactionMode: "default",
    };
    const { task } = await bob.ok("scheduledTasks.upsert", input);
    expect(task.author.id).toBe(people.bob.me.user.id);
    const read = async () => (await bob.ok("scheduledTasks.list", {})).tasks.find((t) => t.id === task.id);
    const unchanged = await read();
    for (const [method, payload] of [
      ["upsert", { ...input, id: task.id, prompt: "Use Bob's accounts" }],
      ["upsert", { ...input, prompt: "Idempotent overwrite" }],
      ["upsert", { ...input, id: task.id, threadId: "thread:attacker" }],
      ["setEnabled", { id: task.id, enabled: true }],
      ["runNow", { id: task.id }],
      ["delete", { id: task.id }],
    ]) {
      const refused = await alice.call(`scheduledTasks.${method}`, payload);
      expect(refused._tag).toBe("Failure");
      expect(JSON.stringify(refused)).toContain("Only the task's author");
      expect(await read()).toEqual(unchanged);
    }
    const hookInput = { ...input, commandId: crypto.randomUUID(), title: "Bob's webhook", schedule: { type: "webhook" } };
    const hook = (await bob.ok("scheduledTasks.upsert", hookInput)).task;
    const hookBefore = (await bob.ok("scheduledTasks.list", {})).tasks.find((t) => t.id === hook.id);
    for (const [method, payload] of [
      ["rotateWebhookToken", { id: hook.id }],
      ["upsert", { ...hookInput, id: hook.id, schedule: { type: "webhook", signature: { header: "x-signature", encoding: "hex", prefix: "", secret: "attacker-secret" } } }],
    ]) {
      const refused = await alice.call(`scheduledTasks.${method}`, payload);
      expect(refused._tag).toBe("Failure");
      expect(JSON.stringify(refused)).toContain("Only the task's author");
      expect((await bob.ok("scheduledTasks.list", {})).tasks.find((t) => t.id === hook.id)).toEqual(hookBefore);
    }
    expect((await alice.ok("scheduledTasks.list", {})).tasks.find((t) => t.id === hook.id).webhook).toBeUndefined();
    const rotated = (await bob.ok("scheduledTasks.rotateWebhookToken", { id: hook.id })).task;
    expect(rotated.webhook.path).not.toBe(hook.webhook.path);

    // Exercise the visible actions as a different signed-in member.
    await signIn(page, people.alice, stack);
    await page.goto(`${stack.urls.front}/settings/scheduled-tasks`);
    await expect(page.getByText(task.title, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: `Actions for ${task.title}`, exact: true })).toBeDisabled();
    await page.screenshot({ path: test.info().outputPath("non-author-controls.png") });

    // The agent tool must pass Alice's initiating author to the same service.
    const attack = await api.launch(alice, projectId, `Try updating the schedule [[fake:tool *_schedule_task ${JSON.stringify({ scheduledTaskId: task.id, prompt: "Agent overwrite" })}]]`);
    const attackState = api.watchThread(alice, attack);
    try {
      await api.waitFor("agent tool refusal", () => attackState.settled());
      expect(attackState.assistantText()).toContain("Only the task's author");
      expect(await read()).toEqual(unchanged);
    } finally { attackState.stop(); }

    const edited = (await bob.ok("scheduledTasks.upsert", { ...input, id: task.id, title: "Bob's updated work", threadId: attack })).task;
    expect(edited.author).toEqual(task.author);
    const run = (await bob.ok("scheduledTasks.runNow", { id: task.id })).task;
    expect(run.lastRunStatus).toBe("succeeded");
    const projection = await bob.ok("orchestration.getThreadProjection", { threadId: attack });
    expect(projection.messages.find((m) => m.scheduledTaskId === task.id).author).toEqual(task.author);
    await bob.ok("scheduledTasks.setEnabled", { id: task.id, enabled: true });
    const stopped = (await admin.ok("scheduledTasks.setEnabled", { id: task.id, enabled: false })).task;
    expect(stopped.author).toEqual(task.author);
    const reenable = await admin.call("scheduledTasks.setEnabled", { id: task.id, enabled: true });
    expect(reenable._tag).toBe("Failure");
    await admin.ok("scheduledTasks.delete", { id: task.id });
    await bob.ok("scheduledTasks.delete", { id: hook.id });
  } finally {
    for (const client of [alice, bob, admin]) client.close();
    await Promise.all([alice.closed, bob.closed, admin.closed]);
  }
});
