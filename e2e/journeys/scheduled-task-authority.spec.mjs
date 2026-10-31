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
    const attack = await api.launch(alice, projectId, `Try controlling the schedule [[fake:tool *_schedule_task ${JSON.stringify({ scheduledTaskId: task.id, prompt: "Agent overwrite" })}]] [[fake:tool *_run_scheduled_task_now ${JSON.stringify({ taskId: task.id })}]] [[fake:tool *_delete_scheduled_task ${JSON.stringify({ scheduledTaskId: task.id })}]]`);
    const attackState = api.watchThread(alice, attack);
    try {
      await api.waitFor("agent tool refusal", () => attackState.settled());
      expect((attackState.assistantText().match(/Only the task's author/g) ?? []).length).toBe(3);
      expect(await read()).toEqual(unchanged);
    } finally { attackState.stop(); }

    const edited = (await bob.ok("scheduledTasks.upsert", { ...input, id: task.id, title: "Bob's updated work", threadId: attack, prompt: "Scheduled work [[fake:long 200]] [[fake:delay 30]]" })).task;
    expect(edited.author).toEqual(task.author);
    const run = (await bob.ok("scheduledTasks.runNow", { id: task.id })).task;
    expect(run.lastRunStatus).toBe("succeeded");
    const scheduledRun = await api.waitFor("scheduled provider running", async () => {
      const projection = await bob.ok("orchestration.getThreadProjection", { threadId: attack });
      const message = projection.messages.find((m) => m.scheduledTaskId === task.id);
      const active = projection.runs.find((r) => r.userMessageId === message?.id);
      expect(message?.author).toEqual(task.author);
      return active && projection.providerTurns.some((turn) => turn.runAttemptId === active.activeAttemptId && turn.status === "running") && active;
    });
    const beforeDelegation = await bob.ok("orchestration.getThreadProjection", { threadId: attack });
    const taskBeforeDelegation = await read();
    const delegatedInjection = await alice.call("orchestration.dispatchCommand", {
      type: "delegated_task.request", commandId: crypto.randomUUID(), createdBy: "agent", creationSource: "mcp",
      parentThreadId: attack, parentRunId: scheduledRun.id, parentNodeId: scheduledRun.rootNodeId,
      task: "Use Bob's connected accounts", modelSelection: input.modelSelection,
      runtimeMode: "full-access", interactionMode: "default",
    });
    expect(delegatedInjection._tag).toBe("Failure");
    expect(JSON.stringify(delegatedInjection)).toContain("unsupported in Baskule");
    const afterDelegation = await bob.ok("orchestration.getThreadProjection", { threadId: attack });
    expect(afterDelegation.subagents).toEqual(beforeDelegation.subagents);
    expect(afterDelegation.messages.map((message) => message.id)).toEqual(beforeDelegation.messages.map((message) => message.id));
    expect(await read()).toEqual(taskBeforeDelegation);
    const steer = await alice.call("orchestration.dispatchCommand", {
      commandId: crypto.randomUUID(), type: "message.dispatch", createdBy: "user", creationSource: "web",
      threadId: attack, messageId: crypto.randomUUID(), text: "Attacker steering", attachments: [],
      dispatchMode: { type: "steer_active", targetRunId: scheduledRun.id },
    });
    expect(steer._tag).toBe("Failure");
    expect(JSON.stringify(steer)).toContain("Only the run's author");
    await bob.ok("scheduledTasks.setEnabled", { id: task.id, enabled: true });
    const stopped = (await admin.ok("scheduledTasks.setEnabled", { id: task.id, enabled: false })).task;
    expect(stopped.author).toEqual(task.author);
    const reenable = await admin.call("scheduledTasks.setEnabled", { id: task.id, enabled: true });
    expect(reenable._tag).toBe("Failure");
    await admin.ok("scheduledTasks.delete", { id: task.id });
    await bob.ok("scheduledTasks.delete", { id: hook.id });

    const interactiveThread = await api.launch(bob, projectId, "Ready [[fake:text ready]]");
    const ready = api.watchThread(bob, interactiveThread);
    try { await api.waitFor("interactive thread ready", () => ready.settled()); } finally { ready.stop(); }
    const delegateArgs = { task: "Scheduled child <<fake:long 400>> <<fake:delay 30>>", title: "Scheduled child", mode: "async" };
    const delegatedInput = { ...input, commandId: crypto.randomUUID(), threadId: interactiveThread, title: "Delegating scheduled work", prompt: `Delegate [[fake:tool *_delegate_task ${JSON.stringify(delegateArgs)}]]` };
    const delegatedTask = (await bob.ok("scheduledTasks.upsert", delegatedInput)).task;
    await bob.ok("scheduledTasks.runNow", { id: delegatedTask.id });
    const delegated = await api.waitFor("scheduled child running", async () => {
      const parent = await bob.ok("orchestration.getThreadProjection", { threadId: interactiveThread });
      const childId = parent.subagents.find((child) => child.childThreadId)?.childThreadId;
      if (!childId) return;
      const child = await bob.ok("orchestration.getThreadProjection", { threadId: childId });
      const active = child.runs.find((run) => run.status === "running");
      return active && child.providerTurns.some((turn) => turn.runAttemptId === active.activeAttemptId && turn.status === "running") && { childId, active };
    });
    const childSteer = await alice.call("orchestration.dispatchCommand", {
      type: "message.dispatch", commandId: crypto.randomUUID(), createdBy: "user", creationSource: "web",
      threadId: delegated.childId, messageId: crypto.randomUUID(), text: "Attacker child instructions", attachments: [],
      dispatchMode: { type: "steer_active", targetRunId: delegated.active.id },
    });
    expect(childSteer._tag).toBe("Failure");
    expect(JSON.stringify(childSteer)).toContain("Only the run's author");
    await bob.ok("scheduledTasks.delete", { id: delegatedTask.id });
    const childState = api.watchThread(bob, delegated.childId);
    try { await api.waitFor("scheduled child completed", () => childState.settled()); } finally { childState.stop(); }

    const questionThread = await api.launch(bob, projectId, "Ready for questions [[fake:text ready]]");
    const questionReady = api.watchThread(bob, questionThread);
    try { await api.waitFor("question thread ready", () => questionReady.settled()); } finally { questionReady.stop(); }
    const questionArgs = { questions: [{ question: "Which report?", header: "Report", options: [{ label: "Daily", description: "Today's report" }] }] };
    const questionTask = (await bob.ok("scheduledTasks.upsert", { ...input, commandId: crypto.randomUUID(), threadId: questionThread, title: "Scheduled question", prompt: `Ask [[fake:tool question ${JSON.stringify(questionArgs)}]]` })).task;
    const questions = api.watchThread(bob, questionThread);
    try {
      await bob.ok("scheduledTasks.runNow", { id: questionTask.id });
      const request = await api.waitFor("scheduled question pending", () => [...questions.requests.values()].find((request) => request.kind === "user_input" && request.status === "pending"));
      const refused = await alice.call("orchestration.dispatchCommand", { type: "runtime-request.respond", commandId: crypto.randomUUID(), threadId: questionThread, requestId: request.id, author: { id: people.bob.me.user.id, name: "Forged Bob" }, answers: { q0: "Attacker instructions" } });
      expect(refused._tag).toBe("Failure");
      expect(JSON.stringify(refused)).toContain("Only the run's author");
      await api.dispatch(bob, { type: "runtime-request.respond", threadId: questionThread, requestId: request.id, answers: { q0: "Daily" } });
      await api.waitFor("author's answer accepted", () => questions.requests.get(request.id)?.status === "resolved");
    } finally { questions.stop(); }
    await bob.ok("scheduledTasks.delete", { id: questionTask.id });

  } finally {
    for (const client of [alice, bob, admin]) client.close();
    await Promise.all([alice.closed, bob.closed, admin.closed]);
  }
});
