import type { Fix, Omission, ServerInput, SkillInput } from "./baskule-plugins.js";

export type ServerSecrets = Record<string, Record<string, string>>;
export interface ParsedServers {
  servers: ServerInput[];
  secrets: ServerSecrets;
  fixes: Fix[];
  omitted: Omission[];
}

export function addressPlaceholders(url: string): string[] {
  return [...new Set(url.match(/\$?\{[^}]+\}/g) ?? [])];
}

export function parseServersJson(text: string): ParsedServers | { error: "invalid_json" } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "invalid_json" };
  }
  if (!isObject(parsed)) return { error: "invalid_json" };
  const definitions = parsed.mcpServers ?? parsed.servers;
  if (!isObject(definitions)) return { error: "invalid_json" };
  const result: ParsedServers = { servers: [], secrets: {}, fixes: [], omitted: [] };
  for (const [name, raw] of Object.entries(definitions)) {
    if (isObject(raw) && "command" in raw) {
      result.omitted.push({ code: "local_program", subject: name });
      continue;
    }
    if (
      !isObject(raw) ||
      typeof raw.url !== "string" ||
      !name.trim() ||
      name.length > 100 ||
      (raw.type !== undefined && !["http", "streamable-http", "sse"].includes(String(raw.type)))
    ) {
      result.omitted.push({ code: "invalid_server", subject: name });
      continue;
    }
    const headers: Record<string, string> = {};
    const expected: string[] = [];
    if (isObject(raw.headers))
      for (const [header, value] of Object.entries(raw.headers)) {
        if (typeof value !== "string") continue;
        expected.push(header);
        if (!/\$\{[^}]+\}/.test(value)) headers[header] = value;
      }
    const credential = "oauth" in raw ? "user-oauth" : expected.length ? "organization" : "none";
    result.servers.push({
      name,
      url: raw.url,
      transport: raw.type === "sse" ? "sse" : "streamable-http",
      credential,
      ...(credential === "organization" ? { keyHeaders: expected } : {}),
    });
    if (credential === "user-oauth") result.fixes.push({ server: name, need: "sign_in" });
    if (expected.length) result.fixes.push({ server: name, need: "key", headers: expected });
    if (Object.keys(headers).length) result.secrets[name] = headers;
    const placeholders = addressPlaceholders(raw.url);
    if (placeholders.length) result.fixes.push({ server: name, need: "address", placeholders });
  }
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function serversJson(servers: ServerInput[]): string {
  return JSON.stringify(
    {
      mcpServers: Object.fromEntries(
        servers.map((server) => [
          server.name,
          {
            url: server.url,
            type: server.transport === "sse" ? "sse" : "http",
            ...(server.credential === "user-oauth" ? { oauth: {} } : {}),
            ...(server.credential === "organization"
              ? {
                  headers: Object.fromEntries(
                    (server.keyHeaders?.length ? server.keyHeaders : ["Authorization"]).map(
                      (header) => [
                        header,
                        `\${${header.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}}`,
                      ],
                    ),
                  ),
                }
              : {}),
          },
        ]),
      ),
    },
    null,
    2,
  );
}

export type SkillFieldError =
  | "name_format"
  | "name_too_long"
  | "name_taken"
  | "description_empty"
  | "description_too_long";
export function skillFieldErrors(
  skill: Pick<SkillInput, "name" | "description">,
  otherNames: string[],
): SkillFieldError[] {
  const errors: SkillFieldError[] = [];
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name)) errors.push("name_format");
  if (skill.name.length > 64) errors.push("name_too_long");
  if (otherNames.includes(skill.name)) errors.push("name_taken");
  if (!skill.description.trim()) errors.push("description_empty");
  if (skill.description.length > 1024) errors.push("description_too_long");
  return errors;
}

export const serverFingerprint = (server: ServerInput) =>
  JSON.stringify([
    server.url,
    server.transport ?? "streamable-http",
    server.credential,
    server.oauth ?? null,
  ]);

export type SkillWarning =
  | "slash_command"
  | "claude_only_tool"
  | "software_install"
  | "secret_in_file";
export function skillWarnings(skill: SkillInput): { warning: SkillWarning; path: string }[] {
  const sources = [
    { path: "SKILL.md", text: `${skill.frontmatter ?? ""}\n${skill.instructions}` },
    ...skill.files.map((file) => {
      try {
        return {
          path: file.path,
          text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
            Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0)),
          ),
        };
      } catch {
        return { path: file.path, text: "" };
      }
    }),
  ];
  return sources.flatMap(({ path, text }) => {
    const warnings: SkillWarning[] = [];
    if (
      /^commands\//.test(path) ||
      /(?:^|[\s`"'(\[])\/[a-z][a-z0-9-]*(?=$|[\s`"'.,;:!?)\]])/i.test(text)
    )
      warnings.push("slash_command");
    if (
      /\b(?:TodoWrite|TaskCreate|TaskUpdate|AskUserQuestion|EnterPlanMode|ExitPlanMode)\b/.test(
        text,
      )
    )
      warnings.push("claude_only_tool");
    if (
      /\b(?:(?:npm|pnpm|yarn|pip3?|uv|brew|apt(?:-get)?)\s+(?:add|install|i)\b|npx\s+\S)/i.test(
        text,
      )
    )
      warnings.push("software_install");
    if (
      /(?:^|\/)(?:\.env(?:\.[^/]*)?|credentials(?:\.json)?|[^/]+\.pem)$/i.test(path) ||
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|password)["']?\s*[:=]\s*["']?(?!\$\{|\{|<)[^\s"'{}<>]{8,}/i.test(
        text,
      )
    )
      warnings.push("secret_in_file");
    return warnings.map((warning) => ({ warning, path }));
  });
}
