// Plugin directory parsing and the catalog completeness gate, adapted from Rakazo (Apache-2.0).
// No repository code is executed; only text components are read.
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { PluginFile, PluginPreview, PluginVariable, SkippedKind } from "../../../../app/packages/contracts/src/baskule-plugins";
import { pluginError } from "../../shared/http";
import { displayName } from "./ranking";

export const LIMITS = { treeEntries: 5000, files: 200, bytes: 4_000_000, fileBytes: 100_000, skillFiles: 40, skillBytes: 400_000 };
/** Content markers for paths that are listed but not readable as text. */
export const OVERSIZED = "\u0000";
export const LINK = "\u0001";
const MANIFESTS = ["plugin.json", ".cursor-plugin/plugin.json", ".grok-plugin/plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"];
const MCP_FILES = ["mcp.json", ".mcp.json"];
const EDITOR_DIRS = new Set(["rules", "hooks", "automations"]);
const EDITOR_FILES = new Set([".lsp.json"]);
const AGENT_FILE = /^agents\/([^/]+)\.md$/;
// Underscore files beside commands are shared notes, not commands of their own.
const COMMAND_FILE = /^commands\/([^/_][^/]*)\.md$/;
const SKILL_FILE = /^skills\/([^/]+)\/SKILL\.md$/;
const SKILL_COMPANION = /^skills\/[^/]+\/(?!SKILL\.md$).+/;
const SKILL_TEXT = /\.(md|mdx|txt|json|ya?ml|csv)$/i;
const NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
/** `${NAME}` or `${env:NAME}`; variables are declared by these placeholders. */
export const VARIABLE = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_.-]{0,63})\}/g;
export const hasVariable = (text: string) => new RegExp(VARIABLE.source).test(text);
const VENDOR_DOMAINS = ["cursor.com", "cursor.sh", "grok.com", "x.ai"];
const VENDOR_HEADER = /^x-(cursor|grok|xai)-/i;
const FORBIDDEN_HEADERS = new Set(["host", "cookie", "content-length", "connection", "transfer-encoding", "content-type", "accept"]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,200}$/;

export interface RepoFile { path: string; content: string }
export interface ParsedServer { name: string; url: string; transport: "streamable-http" | "sse"; headers: Record<string, string>; variables: PluginVariable[] }
export interface ParsedSkill { name: string; description: string; files: PluginFile[] }
export interface ParsedPackage {
  name: string;
  displayName: string;
  description: string;
  homepage: string | null;
  logo: string | null;
  category: string | null;
  keywords: string[];
  servers: ParsedServer[];
  skills: ParsedSkill[];
  skipped: PluginPreview["skipped"];
  digest: string;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const controls = (value: string) => [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

export function safePath(path: string): string {
  if (!path || path.length > 512 || path.startsWith("/") || /[\\%#?]/.test(path) || path.split("/").some(p => !p || p === "." || p === "..") || controls(path))
    throw pluginError(400, "source_unreadable", "Plugin paths must stay inside the plugin directory");
  return path;
}

export const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "plugin";

/** github.com URLs: `owner/repo[.git][@ref][#subdir]` or GitHub's `/tree/<ref>/<subdir>`. */
export function parseGithubUrl(input: string): { repo: string; ref?: string; path?: string } {
  let url: URL;
  try { url = new URL(input.trim().replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "https://github.com/")); }
  catch { throw pluginError(400, "source_not_github"); }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port || url.search)
    throw pluginError(400, "source_not_github");
  let path = url.pathname.replace(/\/$/, "");
  let subdir = decodeURIComponent(url.hash.slice(1)) || undefined;
  let ref: string | undefined;
  const at = path.indexOf("@");
  if (at >= 0) { ref = path.slice(at + 1); path = path.slice(0, at); }
  const tree = /^\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?$/.exec(path);
  if (tree) { path = `/${tree[1]}/${tree[2]}`; ref ??= tree[3]; subdir ??= tree[4] && decodeURIComponent(tree[4]); }
  path = path.replace(/\.git$/, "");
  if (!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path) || path.split("/").some(p => p === "." || p === "..")) throw pluginError(400, "source_not_github");
  if (ref !== undefined && (!ref || ref.length > 200 || ref.includes("..") || /[%#?\\\s]/.test(ref) || controls(ref))) throw pluginError(400, "source_not_github");
  if (subdir) safePath(subdir);
  return { repo: path.slice(1).toLowerCase(), ...(ref ? { ref } : {}), ...(subdir ? { path: subdir } : {}) };
}

export function isFetchedComponent(path: string): boolean {
  return MANIFESTS.includes(path) || MCP_FILES.includes(path) || SKILL_FILE.test(path) || (SKILL_COMPANION.test(path) && SKILL_TEXT.test(path)) ||
    AGENT_FILE.test(path) || COMMAND_FILE.test(path) || path === "SKILL.md";
}

function editorParts(paths: string[]): string[] {
  const parts = new Set<string>();
  for (const path of paths) {
    const first = path.split("/")[0]!;
    if (EDITOR_DIRS.has(first)) parts.add(`${first}/`);
    if (EDITOR_FILES.has(path)) parts.add(path);
  }
  return [...parts].sort();
}

function vendorOnly(url: string, headers: Record<string, string>): boolean {
  let host = "";
  try { host = new URL(url).hostname.replace(/\.$/, ""); } catch {}
  return VENDOR_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`)) || Object.keys(headers).some(key => VENDOR_HEADER.test(key));
}

const SECRET_NAME = /token|key|secret|password|credential|auth/i;

function variablesOf(url: string, headers: Record<string, string>, declared: Record<string, unknown>): PluginVariable[] {
  const found = new Map<string, PluginVariable>();
  const add = (text: string, where: PluginVariable["where"]) => {
    for (const [, name] of text.matchAll(VARIABLE)) {
      const spec = object(declared[name!]) ? declared[name!] as Record<string, unknown> : {};
      const description = [spec.description, spec.title].find(v => typeof v === "string" && v.trim()) as string | undefined;
      const previous = found.get(name!);
      found.set(name!, { name: name!, ...(description ? { description: description.slice(0, 2000) } : {}),
        secret: where === "header" || previous?.secret === true || SECRET_NAME.test(name!), where: previous?.where === "url" ? "url" : where });
    }
  };
  add(url, "url");
  for (const value of Object.values(headers)) add(value, "header");
  return [...found.values()];
}

/** A server URL with its placeholders filled must be HTTPS and keep credentials out of the query. */
export function templateUrlProblem(url: string): boolean {
  const bare = url.replace(VARIABLE, "");
  if (bare.includes("${") || /\s/.test(bare)) return true;
  // A leading placeholder supplies the scheme and host; the filled URL is checked when the value is saved.
  if (url.startsWith("${")) return false;
  try {
    const parsed = new URL(url.replace(VARIABLE, "x"));
    return parsed.protocol !== "https:" || !!parsed.username || !!parsed.password || !!parsed.hash || !!parsed.search;
  } catch { return true; }
}

export function validHeaders(headers: Record<string, string>): boolean {
  const names = Object.keys(headers).map(key => key.toLowerCase());
  return names.length <= 20 && new Set(names).size === names.length && Object.entries(headers).every(([key, value]) =>
    HEADER_NAME.test(key) && !FORBIDDEN_HEADERS.has(key.toLowerCase()) && typeof value === "string" && value.length <= 8192 && !/[\r\n\0]/.test(value));
}

export function collectMcpServers(doc: unknown, declared: Record<string, unknown> = {}): { servers: ParsedServer[]; skipped: PluginPreview["skipped"] } {
  const skipped: PluginPreview["skipped"] = [];
  const skip = (kind: SkippedKind, subject: string) => skipped.push({ kind, subject });
  if (!object(doc) || !object(doc.mcpServers)) return { servers: [], skipped: [{ kind: "invalid_server", subject: "mcp.json" }] };
  const servers: ParsedServer[] = [];
  for (const [name, entry] of Object.entries(doc.mcpServers)) {
    if (!object(entry)) { skip("invalid_server", name); continue; }
    const type = entry.type ?? (entry.command ? "stdio" : entry.url ? "http" : undefined);
    if (type === "stdio" || entry.command) { skip("local_program", name); continue; }
    if (!["streamable-http", "http", "sse"].includes(String(type))) { skip("unsupported_transport", name); continue; }
    if (entry.url === "") { skip("blank_server", name); continue; }
    const headers = entry.headers ?? {};
    if (typeof entry.url !== "string" || entry.url.length > 2048 || !object(headers) || !validHeaders(headers as Record<string, string>) ||
        templateUrlProblem(entry.url) || name.length > 100 || controls(name)) { skip("invalid_server", name); continue; }
    if ("auth" in entry || vendorOnly(entry.url, headers as Record<string, string>)) { skip("editor_only", name); continue; }
    servers.push({ name, url: entry.url, transport: type === "sse" ? "sse" : "streamable-http", headers: headers as Record<string, string>,
      variables: variablesOf(entry.url, headers as Record<string, string>, declared) });
  }
  return { servers: servers.sort((a, b) => a.name.localeCompare(b.name)), skipped };
}

type Front = { name: string; description: string; body: string; rest: Record<string, unknown> };
function frontMatter(content: string): Front | null {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return null;
  let data: unknown;
  try { data = parseYaml(match[1]!); } catch { return null; }
  if (!object(data)) return null;
  const { name, description, ...rest } = data;
  const text = (v: unknown) => typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  return { name: text(name), description: text(description), body: content.slice(match[0].length), rest };
}

/** Name and description come first as JSON strings, so the runtime reads them without a YAML parser. */
export function skillMarkdown(name: string, description: string, body: string, rest: Record<string, unknown> = {}): string {
  const extra = Object.keys(rest).length ? stringifyYaml(rest).trimEnd() + "\n" : "";
  return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n${extra}---\n${body.replace(/^\r?\n/, "")}`;
}

const utf8 = new TextEncoder();
const base64 = (text: string) => {
  const bytes = utf8.encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
};
const skillFolder = (name: string) => name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 64);

function companionProblem(companions: [string, string][]): boolean {
  return companions.length > LIMITS.skillFiles || companions.some(([path, text]) => !SKILL_TEXT.test(path) || text === LINK || text === OVERSIZED) ||
    companions.reduce((sum, [, text]) => sum + utf8.encode(text).length, 0) > LIMITS.skillBytes;
}

function collectSkills(files: Map<string, string>, skipped: PluginPreview["skipped"]): ParsedSkill[] {
  const skills: ParsedSkill[] = [];
  const names = new Set<string>();
  const add = (name: string, description: string, markdown: string, companions: [string, string][] = []) => {
    const folder = skillFolder(name);
    if (!folder || names.has(folder) || name.length > 80 || description.length > 2000) return false;
    names.add(folder);
    skills.push({ name, description, files: [{ path: `${folder}/SKILL.md`, base64: base64(markdown) },
      ...companions.map(([path, text]) => ({ path: `${folder}/${path}`, base64: base64(text) }))] });
    return true;
  };
  for (const [path, content] of files) {
    const dir = path === "SKILL.md" ? "" : SKILL_FILE.exec(path)?.[1];
    if (dir === undefined) continue;
    const front = frontMatter(content);
    if (!front?.name || !front.description) { skipped.push({ kind: "invalid_skill", subject: path }); continue; }
    const folder = dir ? `skills/${dir}/` : "";
    const companions = dir ? [...files].filter(([p]) => p.startsWith(folder) && p !== path).map(([p, text]) => [p.slice(folder.length), text] as [string, string]) : [];
    if (companionProblem(companions) || !add(front.name, front.description, skillMarkdown(front.name, front.description, front.body, front.rest), companions))
      skipped.push({ kind: "invalid_skill", subject: front.name });
  }
  for (const [path, content] of files) {
    if (!AGENT_FILE.test(path)) continue;
    const front = frontMatter(content);
    if (!front?.name || !front.description) { skipped.push({ kind: "invalid_skill", subject: path }); continue; }
    add(front.name, front.description, skillMarkdown(front.name, front.description,
      `Use these instructions as a specialist helper. When you can delegate, give a helper the task and everything below.\n\n${front.body}`));
  }
  for (const [path, content] of files) {
    const name = COMMAND_FILE.exec(path)?.[1];
    if (!name) continue;
    const front = /^---\r?\n/.test(content) ? frontMatter(content) : null;
    const body = front?.body ?? content;
    const first = body.split("\n").map(line => line.replace(/^#+\s*/, "").trim()).find(Boolean);
    const description = (front?.description || first || name).slice(0, 2000);
    add(name, description, skillMarkdown(name, description, body.includes("$ARGUMENTS") ? `$ARGUMENTS is whatever the user wrote after /${name}.\n\n${body}` : body));
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

async function digestOf(files: RepoFile[]): Promise<string> {
  const canonical = files.map(f => [f.path, f.content]).sort(([a], [b]) => a! < b! ? -1 : a! > b! ? 1 : 0);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode(JSON.stringify(canonical))));
  return `sha256:${Array.from(hash, b => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function digestValue(value: unknown): Promise<string> {
  return digestOf([{ path: "", content: JSON.stringify(value) }]);
}

/** Pure parser over a fetched plugin directory; paths are relative to the plugin. */
export async function parsePluginDirectory(input: RepoFile[], fallbackName: string): Promise<ParsedPackage> {
  if (input.length > LIMITS.treeEntries) throw pluginError(413, "plugin_too_large");
  const files = new Map<string, string>();
  let bytes = 0;
  for (const file of input) {
    const path = safePath(file.path);
    bytes += utf8.encode(file.content).length;
    if (bytes > LIMITS.bytes) throw pluginError(413, "plugin_too_large");
    if (files.has(path)) throw pluginError(400, "source_unreadable");
    files.set(path, file.content);
  }
  const manifestPath = MANIFESTS.find(path => files.has(path) && files.get(path) !== LINK);
  let manifest: Record<string, unknown> = {};
  if (manifestPath) {
    try { manifest = JSON.parse(files.get(manifestPath)!); } catch { throw pluginError(400, "source_unreadable", "The plugin manifest is not valid JSON"); }
    if (!object(manifest)) throw pluginError(400, "source_unreadable", "The plugin manifest must be an object");
  }
  const rawName = typeof manifest.name === "string" ? manifest.name.trim() : "";
  const name = NAME.test(rawName) ? rawName : slug(rawName || fallbackName);
  const skipped: PluginPreview["skipped"] = editorParts([...files.keys()]).map(subject => ({ kind: "editor_only" as const, subject }));
  const declared = object(manifest.variables) && object(manifest.variables.properties) ? manifest.variables.properties : {};
  const inline = object(manifest.mcpServers) ? { mcpServers: manifest.mcpServers } : undefined;
  const mcpPath = MCP_FILES.find(path => files.has(path));
  let servers: ParsedServer[] = [];
  if (inline || mcpPath) {
    let doc: unknown = inline;
    if (!doc) { try { doc = JSON.parse(files.get(mcpPath!)!); } catch { doc = null; } }
    const collected = collectMcpServers(doc, declared);
    servers = collected.servers;
    skipped.push(...collected.skipped);
  }
  const skills = collectSkills(files, skipped);
  if (!servers.length && !skills.length) throw pluginError(400, "plugin_empty");
  const text = (key: string, max: number) => typeof manifest[key] === "string" ? (manifest[key] as string).trim().slice(0, max) : "";
  const logo = text("logo", 512).replace(/^\.\//, "");
  return {
    name,
    displayName: text("displayName", 120) || displayName(name),
    description: text("description", 4000) || skills[0]?.description || "",
    homepage: /^https:\/\//.test(text("homepage", 2048)) ? text("homepage", 2048) : null,
    logo: /^(?!\/)(?!.*\.\.)[\w./-]+\.(svg|png|jpe?g|webp)$/i.test(logo) ? logo : null,
    category: text("category", 60).toLowerCase() || null,
    keywords: Array.isArray(manifest.keywords) ? manifest.keywords.filter((k): k is string => typeof k === "string").slice(0, 50) : [],
    servers,
    skills,
    skipped,
    digest: await digestOf(input),
  };
}

export type Completeness = { hasServers: boolean; skillCount: number };

/** Whether every part of a listed plugin installs, from its file list and MCP config. Null: the config is needed. */
export function classifyPluginFiles(paths: string[], mcpConfig: string | undefined, sizes: ReadonlyMap<string, number>): Completeness | "incomplete" | null {
  if (editorParts(paths).length) return "incomplete";
  const fetched = paths.filter(isFetchedComponent);
  if (paths.length > LIMITS.treeEntries || fetched.length > LIMITS.files || fetched.reduce((sum, path) => sum + (sizes.get(path) ?? 0), 0) > LIMITS.bytes)
    return "incomplete";
  const skillDirs = new Map<string, string[]>();
  let skillCount = 0;
  for (const path of paths) {
    const skill = /^skills\/([^/]+)\/(.+)$/.exec(path);
    if (skill) skillDirs.set(skill[1]!, [...(skillDirs.get(skill[1]!) ?? []), skill[2]!]);
    if (AGENT_FILE.test(path) || COMMAND_FILE.test(path)) skillCount++;
  }
  for (const [dir, files] of skillDirs) {
    if (!files.includes("SKILL.md")) return "incomplete";
    const companions = files.filter(file => file !== "SKILL.md");
    const sizesOf = companions.map(file => sizes.get(`skills/${dir}/${file}`) ?? 0);
    if (companions.length > LIMITS.skillFiles || companions.some(f => !SKILL_TEXT.test(f)) || sizesOf.some(size => size > LIMITS.fileBytes) ||
        sizesOf.reduce((sum, size) => sum + size, 0) > LIMITS.skillBytes) return "incomplete";
    skillCount++;
  }
  const mcpPath = paths.find(path => MCP_FILES.includes(path));
  let servers = 0;
  if (mcpPath) {
    if (mcpConfig === undefined) return null;
    let doc: unknown;
    try { doc = JSON.parse(mcpConfig); } catch { return "incomplete"; }
    const collected = collectMcpServers(doc);
    if (collected.skipped.some(s => s.kind !== "blank_server")) return "incomplete";
    servers = collected.servers.length;
  }
  if (!servers && !skillCount) return "incomplete";
  return { hasServers: servers > 0, skillCount };
}

/** A registry's component index (xAI): hosted MCP servers and skill-like parts install; anything else does not. */
export function classifyIndexed(components: Record<string, { description?: string }[]>): Completeness | null {
  let skillCount = 0;
  let servers = 0;
  for (const [kind, parts] of Object.entries(components)) {
    if (["skills", "agents", "commands"].includes(kind)) skillCount += parts.length;
    else if (kind === "mcpServers" && parts.every(part => part.description === "http")) servers += parts.length;
    else if (parts.length) return null;
  }
  return servers || skillCount ? { hasServers: servers > 0, skillCount } : null;
}
