// OpenCode configuration of the embedded agent (OpenCode 2.1.3 schema): the agent runs in the SpaceCell, shell/file
// tools run on the space's computer (OpenShell sandbox, computer/v2), the browser is T3's preview tools.

import { BASKULE_AI_PROVIDERS } from "../../../app/packages/contracts/src/baskule";
import type { SpacePlugins } from "../../../app/packages/contracts/src/baskule-plugins";
import type { UsagePrices } from "../../../app/packages/contracts/src/baskule-usage";
import { PLUGIN_SKILLS_PATH } from "./plugin-skills";
import type { ProductSettings } from "../control/settings";
import type { Models } from "./session";

export interface AgentEnv {
  /** Resolved from ControlCell, never deployment variables. */
  AI: ProductSettings["ai"] & { apiKey: string };
  PLUGINS?: SpacePlugins;
  COMPUTERD_URL?: string;
  COMPUTERD_TOKEN?: string;
  /** Idle time (seconds) after which OpenCode is closed so the cell can be evicted (default 300). */
  BASKULE_AGENT_IDLE_S?: string;
  /** "1": enables /_baskule/debug/* routes (test runner only; never in deployments). */
  BASKULE_AGENT_DEBUG?: string;
}

export const TEST_PATCH_MODEL = "gpt-fake-patch";

export const ASSISTANT_PROMPT = `You are Baskule, a capable assistant for knowledge work: research, writing, analysis, data, documents and automation.

You have your own Linux computer and a web browser:
- A shell with internet access, Python 3, Node.js, Bun, git, curl, jq and ripgrep. You may install more tools, at user level only (there is no sudo or apt): \`pip install --user <pkg>\` or a virtualenv, \`npm install -g <pkg>\` (installs into ~/.local), \`bun add -g <pkg>\`. Installs and files under /sandbox/space persist; the rest of the system does not.
- File tools to read, write and edit files.
- Web search (websearch) and web fetch (webfetch): prefer them for quick lookups and reading pages.
- A real headless web browser (the preview_* tools): use it for interactive pages, filling forms and taking screenshots. The people in this space can watch the same browser and take control. Respect human ownership; wait until control is returned before acting.

Your computer:
- Each chat has its own folder, /sandbox/space/chats/<chat>; it is your working directory. Create files there, never elsewhere, unless the user asks.
- /sandbox/space is shared by everyone in this space and kept between chats; your home directory is /sandbox/space/home.
- The computer starts when you first use a tool and sleeps when idle: the first command may take a few seconds.

How you work:
- Answer directly in the chat. Questions, explanations, short texts, summaries and drafts belong in your reply, not in a file.
- Create files only when the user asks for one (a document, spreadsheet, image, archive, export…) or when the result is clearly better as a file (long reports, data, code meant to be run, anything the user will download). Create them in the chat's folder.
- Whenever you create or change files, list each one in your reply as a Markdown link to its path relative to the chat's folder, for example [report.md](report.md) or [chart.png](out/chart.png), so the user can open or download it with one click.
- Act, don't ask: never ask for confirmation for routine actions such as running commands, installing packages, browsing or creating files. Ask a question only when the request is genuinely ambiguous and a wrong guess would waste significant work.
- Verify your results (run the code, check the file, re-read the page) before saying you are done.
- Answer in the user's language. Be concise: briefly say what you did and what you found, without narrating every step. Use Markdown when it helps.
- Be honest about failures and limits; never invent facts, sources or file contents.`;

export function opencodeConfig(env: AgentEnv, keyEnv: string, sampleMcpUrl?: string, pluginServers: Record<string, unknown> = {}): Record<string, unknown> {
  const { providerId, model } = env.AI;
  const provider = BASKULE_AI_PROVIDERS[providerId];
  const models = [model];
  if (env.BASKULE_AGENT_DEBUG === "1") models.push({ ...models[0]!, id: TEST_PATCH_MODEL });
  return {
    model: `${providerId}/${model.id}`,
    default_agent: "assistant",
    share: "disabled",
    update: "disable",
    // Preselect keyless search so users never receive OpenCode's first-use provider form.
    websearch: { provider: "random" },
    providers: {
      [providerId]: {
        name: provider.name,
        // OpenCode echoes settings in /api/model: private keys stay in env; keyless providers use its public token.
        package: provider.package,
        env: provider.keyless ? [] : [keyEnv],
        settings: { baseURL: env.AI.baseUrl, ...(provider.keyless ? { apiKey: "public" } : {}) },
        models: Object.fromEntries(models.map(m => [m.id, {
          name: m.name, settings: m.settings,
          capabilities: { tools: true, input: ["text", ...(m.image ? ["image"] : []), ...(m.pdf ? ["pdf"] : [])], output: ["text"] },
          ...(m.cost ? { cost: { input: m.cost.input, output: m.cost.output,
            cache: { read: m.cost.cache_read, write: m.cost.cache_write } } } : {}), limit: m.limit,
        }])),
      },
    },
    // Only the installation's provider is usable.
    policies: [
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: providerId, effect: "allow" },
    ],
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
    agents: {
      assistant: {
        mode: "primary",
        description: "General knowledge-work assistant with its own Linux computer and web browser",
        system: ASSISTANT_PROMPT,
      },
      // T3 selects the built-in "build" (and "plan") agents: give them the same prompt so a chat never falls back to
      // OpenCode's coding prompt.
      build: { system: ASSISTANT_PROMPT },
      plan: { system: ASSISTANT_PROMPT },
    },
    skills: env.PLUGINS?.skills.length ? [PLUGIN_SKILLS_PATH] : [],
    mcp: { servers: { ...pluginServers, ...(sampleMcpUrl ? { decision: { type: "remote", url: sampleMcpUrl, oauth: false, codemode: false } } : {}) } },
  };
}

/** The `provider/model` pairs of an OpenCode config, and its default model as the fallback. */
export function configModels(config: Record<string, unknown>): Models {
  const providers = config.providers as Record<string, { models: Record<string, unknown> }>;
  const offered = new Set(Object.entries(providers).flatMap(([p, { models }]) => Object.keys(models).map((m) => `${p}/${m}`)));
  const ref = config.model as string;
  const slash = ref.indexOf("/");
  return { offered, fallback: { providerID: ref.slice(0, slash), id: ref.slice(slash + 1) } };
}

/** Prices for every configured model, snapshotted at turn start for usage reporting. */
export function configPrices(config: Record<string, unknown>): Record<string, UsagePrices> {
  const providers = config.providers as Record<string, { models: Record<string, { cost?: { input: number; output: number; cache?: { read?: number; write?: number } } }> }>;
  return Object.fromEntries(Object.entries(providers).flatMap(([provider, { models }]) => Object.entries(models).map(([model, { cost }]) => [
    `${provider}/${model}`, cost ? { input: cost.input, output: cost.output, cacheRead: cost.cache?.read, cacheWrite: cost.cache?.write } : { input: 0, output: 0 },
  ])));
}
