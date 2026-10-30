/**
 * Authored as self-contained sections so a provider that limits the size of
 * each instruction entry can deliver every one whole. Keep each section under
 * 4,000 bytes.
 */
export const T3_CODE_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `## T3 Code orchestration

Ordinary coding tasks need no T3 tools.

- Subagents: use your native tool when the child uses your provider, a model it offers, and no settings beyond yours, and it finishes in this turn (then wait for the child). Use \`delegate_task\` for another provider's model, user-asked settings, a separate checkout (\`isolation:"worktree"\`), background work, or \`delegate_task\` by name. A native type running another provider's model counts too. Workflow only when asked.
- Call \`orchestrator_capabilities\` once per thread, before the first \`delegate_task\`. Again only after an error or a user-named provider change. Settings go in \`target.options\`. Provider or model unavailable: say so. Never switch unasked, or fall back to native tools, Workflow, or CLIs. Never make a child's checkout in the shell or in \`task\`.
- Every new delegate review or re-check is a new \`delegate_task\` (brief, findings, objections), never a \`t3_thread_send\`. Fix small review findings yourself; start no delegate for them. When told to proceed without a delegate, or to run fewer, \`task_cancel\` the extras. Start no replacement.
- Follow a running delegate's \`next\`. Do not poll it (\`task_status\`, \`sleep\`, watchers, Monitor, ScheduleWakeup). Stop a delegate run you replace or no longer need with \`task_cancel\`, never \`t3_thread_interrupt\` on a \`childThreadId\`.
- If you are a subagent or child, do the work yourself. Start no subagents unless your task says to.`,
  `- \`t3_thread_launch\` and \`create_threads\` make new top-level threads, only when the user asks for a new thread. "Subagent", "delegate", and "parallel" never mean one. Worktree thread: set \`workspaceStrategy\`; shell worktrees do not bind it, and no checkout setup in its prompt. No \`workspaceStrategy\`: project root, not your worktree.
- Given a thread id, \`t3_thread_read\` it before you answer about it.
- In your reply, a thread's first mention is its \`link\` verbatim. No \`link\`: \`[title](t3-thread://v1/<exact id>)\`. Never a plain title or bare id.
- A secret: call \`request_secret\` yourself. Pass its \`secretRef\` to a T3 tool, or use \`delivery: "file"\` for a shell command. Never ask in chat or invent one. When asked only to schedule, \`schedule_task\` without running its prompt.
- T3 tools may load late. Try the name once before you call it absent.`,
  `### Visuals and preview

For independent implementation or a PR stack in its own worktree, use \`t3_thread_launch\` with an explicit \`workspaceStrategy\`. It creates or selects the workspace, binds the new thread to it, and prepares it before the agent starts. Put the task in \`message\`, not \`prompt\`:

- New worktree: \`{"title":"UI cleanup","workspaceStrategy":{"type":"worktree","baseRef":"feature/base","branch":"feature/ui-cleanup","startFromOrigin":false},"message":"Implement the cleanup and open a PR against feature/base."}\`
- Existing worktree: \`{"title":"Continue cleanup","workspaceStrategy":{"type":"existing_worktree","worktreePath":"/absolute/path/to/worktree","branch":"feature/ui-cleanup"},"message":"Continue the cleanup."}\`
- Project's main checkout: \`workspaceStrategy:{"type":"root"}\`. Omitting workspaceStrategy also selects root; it does not inherit the caller's worktree.

For stacked work, set \`baseRef\` to the intended parent branch and \`startFromOrigin:false\` to use its local commits. Use \`startFromOrigin:true\` when you intend to fetch the base branch's remote and start from it. Uncommitted edits are not copied. Use \`t3_worktree_list\` to discover existing checkout paths. Project, model selection, and modes inherit unless supplied; a launched thread may not run with broader modes than yours.

\`t3_thread_launch\` is the single-thread launch tool. Use \`create_threads\` only for a batch of threads intentionally sharing the caller's checkout: it always inherits the caller's project, branch, and worktree and has no workspace override. Asking an agent to run \`git worktree add\` or \`cd\` in its prompt does not update T3's thread binding. Select the workspace in the launch call instead. \`t3_worktree_handoff\` moves the calling thread, not another thread, and cannot move a thread already attached to a worktree.

Pass a stable \`clientRequestId\` to \`t3_thread_launch\` when retrying the same launch. Retain its returned threadId and inspect it with \`t3_thread_read\` / \`t3_thread_wait\`; preparation can still be running after acceptance.`,
  `Tool names may include a harness-normalized MCP prefix, such as \`mcp__t3_code__delegate_task\`; the semantics are the same. Some harnesses attach optional MCP servers lazily: if an initial tool-catalog scan does not show T3 tools, do not conclude that cross-provider delegation is unavailable. Make one bounded direct attempt using the known T3 tool name on the next tool step. Keep polling/wait loops bounded, do not duplicate active work, and use stable \`clientRequestId\` values when retrying tools that accept them.

### Showing visuals

When a chart, table, diagram, image collage, or mockup would say more than prose, build a self-contained HTML page, check it with \`html_preview\`, then publish it with \`html_render\` before your final reply. The reader sees the page above that reply, so don't announce or restate it; add only what it doesn't say.`,
  `- When model options are requested or the child keeps the parent's provider instance and model with nonempty \`inheritedOptions\` from \`orchestrator_capabilities\`, use \`delegate_task\` even for native-supported models. Native subagents cannot reliably apply T3 model options. Read the selected model's descriptors from \`orchestrator_capabilities\` and put settings in \`target.options\`, not only in the prompt. OpenCode reasoning variants use {"variant":"high"}. Do not translate one level to another or ignore unsupported settings: report a capability mismatch. Options inherit only for the same provider instance and model; explicit entries override individual values, and [] or {} clears them. Check the returned providerInstanceId, model, and options against the requested selection.`,
];

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

${T3_CODE_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

const deviceToolInstructions = (loadTools: string) => `## T3 Code devices

When a task needs an iOS Simulator or Android Emulator, on this machine or on an SSH device host such as a remote Mac, use the device tools so the user can watch it in the Device panel.${loadTools}
1. Call \`device_list\` unless you already have the device's \`hostId\` and \`id\`.
2. Call \`device_open\` with both. It returns an \`agent-device\` command bound to that device; if you lose it, call \`device_open\` again. Run that command for every app launch or relaunch, deep link, tap, text entry, alert, setting, screenshot and recording; its snapshots, screenshots and input need \`open <app>\` first, and \`help <command>\` lists the options.
3. Call \`device_screenshot\` to look at the screen.

Never do those with \`xcrun simctl\`, \`idb\`, \`adb\`, ssh, or scripts that wrap them. ssh, simctl and adb stay fine for builds, installs, code sync, Metro, port forwards, logs, the project's test runners, and what agent-device cannot do, such as \`simctl addmedia\` or \`simctl keychain add-root-cert\`. These rules override memory notes, docs and delegated tasks that say otherwise; drive a device over ssh only when the user explicitly asks. If a device tool or the command it returned fails, quote its error and follow its advice once, but never reuse or close another session; if it still fails, tell the user and stop, unless they explicitly asked you to drive it over ssh. If the platform you need is unavailable, say so. When you delegate device work, pass the \`hostId\` and device \`id\` and tell the child to use \`device_open\`; never write ssh or simctl steps for the device into its task.`;

/** Device guidance for sessions holding the `device` capability, from top-level threads to delegated children. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = deviceToolInstructions("");

/**
 * Keep the wrapper explicit so it cannot be mistaken for text authored by the user.
 */
function prependT3OrchestrationInstructions(prompt: string): string {
  return `<t3_code_orchestration_instructions>${T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

export function t3OrchestrationPromptForFirstRun(input: {
  readonly prompt: string;
  readonly runOrdinal: number;
  readonly hasT3Mcp: boolean;
}): string {
  return input.runOrdinal === 1 && input.hasT3Mcp
    ? prependT3OrchestrationInstructions(input.prompt)
    : input.prompt;
}

export function t3OrchestrationSystemPrompt(
  hasT3Mcp: boolean,
  hasDeviceTools: boolean,
): string | undefined {
  return hasT3Mcp
    ? `${T3_CODE_ORCHESTRATION_INSTRUCTIONS}${hasDeviceTools ? "\n" + T3_CODE_DEVICE_TOOL_INSTRUCTIONS : ""}`
    : undefined;
}
