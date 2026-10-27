// WP-F checks, in order. Each: {name, capability, fn(ctx) → detail string}. ctx.state carries people/spaces.
import { launch, waitFor, watchShell, watchThread, world } from "./lib.mjs";
import { chatChecks } from "./cap1-chat.mjs";
import { delegationChecks } from "./cap4-delegation.mjs";

export const checks = [
  {
    name: "baseline-turn",
    capability: "0-baseline",
    fn: async (ctx) => {
      const s = await world(ctx);
      const shell = watchShell(s.cb);
      const threadId = await launch(s.ca, s.projectId, "Hello WPF [[fake:text pong-wpf]]", "Baseline");
      const t = watchThread(s.ca, threadId);
      await waitFor("answer", () => t.assistantText().includes("pong-wpf"), 90_000);
      await waitFor("bob sees the chat", () => shell.threads.has(threadId), 20_000);
      t.stop();
      shell.stop();
      s.baselineThread = threadId;
      return `team ${s.team}: answer streamed through embedded OpenCode; Bob's shell shows the chat`;
    },
  },
];

checks.push(...chatChecks);
checks.push(...delegationChecks);

import { scheduleChecks } from "./cap3-schedules.mjs";
checks.push(...scheduleChecks);

import { appChecks } from "./cap5-app.mjs";
checks.push(...appChecks);

import { pluginChecks } from "./cap6-plugins.mjs";
checks.push(...pluginChecks);
