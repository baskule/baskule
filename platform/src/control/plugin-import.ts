import { checkMcpUrl } from "../shared/plugin-outbound";
import { Gunzip, Unzip, UnzipInflate } from "fflate";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { PluginFile, PluginServer } from "../../../app/packages/contracts/src/baskule-plugins";
import { HttpError, pluginError } from "../shared/http";

export const IMPORT_LIMITS = { archive: 10 * 1024 * 1024, expanded: 20 * 1024 * 1024, files: 2000, skillFile: 1024 * 1024, stored: 4 * 1024 * 1024, totalStored: 32 * 1024 * 1024, plugins: 100 };
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
export function safePath(path: string): string {
  const p = path.replace(/^\.\//, "").replace(/\/$/, "");
  if (!p || p.length > 512 || /[\\\x00-\x1f:]/.test(p) || p.startsWith("/") || p.split("/").some(s => !s || s === "." || s === ".."))
    throw pluginError(400, "unsafe_plugin_path");
  return p;
}
export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function fromBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw pluginError(400, "invalid_archive");
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, x => x.toString(16).padStart(2, "0")).join("");
}
function concat(chunks: Uint8Array[]) {
  const out = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

/** In-memory only: no archive paths ever reach a host filesystem. Links and special files are rejected. */
export function unpackArchive(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.length > IMPORT_LIMITS.archive) throw pluginError(413, "plugin_too_large");
  const files = new Map<string, Uint8Array>();
  let expanded = 0;
  const add = (name: string, data: Uint8Array) => {
    const path = safePath(name);
    if (files.has(path)) throw pluginError(400, "duplicate_plugin_path");
    if (files.size >= IMPORT_LIMITS.files) throw pluginError(413, "too_many_plugin_files");
    files.set(path, data);
  };
  try {
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      // Unix mode is in the central directory; fflate deliberately does not interpret it.
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let end = bytes.length - 22;
      while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--;
      if (end < 0 || end < bytes.length - 65557 || end + 22 + view.getUint16(end + 20, true) !== bytes.length || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw pluginError(400, "invalid_archive");
      const entries = view.getUint16(end + 10, true);
      if (entries > IMPORT_LIMITS.files) throw pluginError(413, "too_many_plugin_files");
      let central = view.getUint32(end + 16, true);
      for (let n = 0; n < entries; n++) {
        const i = central;
        if (i + 46 > end || view.getUint32(i, true) !== 0x02014b50) throw pluginError(400, "invalid_archive");
        const mode = view.getUint32(i + 38, true) >>> 16;
        if ((mode & 0xf000) && ![0x8000, 0x4000].includes(mode & 0xf000)) throw pluginError(400, "plugin_links_unsupported");
        central += 46 + view.getUint16(i + 28, true) + view.getUint16(i + 30, true) + view.getUint16(i + 32, true);
      }
      if (central !== end) throw pluginError(400, "invalid_archive");
      let unfinished = 0;
      const unzip = new Unzip(file => {
        safePath(file.name);
        if (file.name.endsWith("/")) return;
        unfinished++;
        const chunks: Uint8Array[] = [];
        file.ondata = (error, chunk, final) => {
          if (error) throw error;
          expanded += chunk.length;
          if (expanded > IMPORT_LIMITS.expanded) throw pluginError(413, "plugin_too_large");
          chunks.push(chunk);
          if (final) { add(file.name, concat(chunks)); unfinished--; }
        };
        file.start();
      });
      unzip.register(UnzipInflate);
      for (let i = 0; i < bytes.length; i += 1024) unzip.push(bytes.subarray(i, i + 1024), i + 1024 >= bytes.length);
      if (unfinished) throw pluginError(400, "invalid_archive");
    } else if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const chunks: Uint8Array[] = [];
      const gunzip = new Gunzip(chunk => {
        expanded += chunk.length;
        if (expanded > IMPORT_LIMITS.expanded) throw pluginError(413, "plugin_too_large");
        chunks.push(chunk);
      });
      for (let i = 0; i < bytes.length; i += 1024) gunzip.push(bytes.subarray(i, i + 1024), i + 1024 >= bytes.length);
      const tar = concat(chunks);
      const field = (at: number, n: number) => utf8.decode(tar.subarray(at, at + n)).split("\0")[0];
      let nextPath: string | undefined;
      for (let at = 0; at + 512 <= tar.length; ) {
        if (tar.subarray(at, at + 512).every(b => b === 0)) break;
        const size = parseInt(field(at + 124, 12).trim(), 8);
        if (!Number.isSafeInteger(size) || size < 0 || at + 512 + size > tar.length) throw pluginError(400, "invalid_archive");
        const data = tar.slice(at + 512, at + 512 + size);
        const type = field(at + 156, 1);
        const name = nextPath ?? [field(at + 345, 155), field(at, 100)].filter(Boolean).join("/");
        nextPath = undefined;
        if (type === "x" || type === "g") {
          const pax = utf8.decode(data);
          if (/\blinkpath=/.test(pax)) throw pluginError(400, "plugin_links_unsupported");
          const p = /(?:^|\n)\d+ path=([^\n]+)/.exec(pax)?.[1];
          if (p) nextPath = safePath(p);
        } else if (type === "L") nextPath = safePath(utf8.decode(data).split("\0")[0]);
        else if (type === "5") { if (name !== "./" && name !== ".") safePath(name); }
        else if (type === "0" || type === "") add(name, data);
        else throw pluginError(400, "plugin_links_unsupported");
        at += 512 + Math.ceil(size / 512) * 512;
      }
    } else throw pluginError(400, "unsupported_archive", "Upload a ZIP or tar.gz archive");
  } catch (e) { if (e instanceof HttpError) throw e; throw pluginError(400, "invalid_archive"); }
  if (!files.size) throw pluginError(400, "empty_plugin_archive");
  return files;
}

export interface InspectedPlugin {
  name: string;
  description: string;
  servers: PluginServer[];
  skills: { name: string; description: string; files: PluginFile[] }[];
  ignored: string[];
  storedBytes: number;
}
const metadata = z.object({ name: z.string().min(1).max(100), description: z.string().max(4000).default("") });
export function inspectBundle(input: Map<string, Uint8Array>, options: { path?: string; stripRoot?: boolean; skillPaths?: string[] } = {}): InspectedPlugin {
  let files = input;
  if (options.stripRoot) {
    const roots = new Set([...files.keys()].map(p => p.split("/")[0]));
    if (roots.size === 1 && [...files.keys()].every(p => p.includes("/")) && !["skills", ".claude-plugin", ".codex-plugin"].includes([...roots][0])) files = new Map([...files].map(([p, b]) => [p.slice(p.indexOf("/") + 1), b]));
  }
  const root = options.path ? safePath(options.path) + "/" : "";
  const licenses = [...files].filter(([p]) => /(?:^|\/)(?:LICENSE(?:\.txt)?|NOTICE)$/i.test(p) && !p.startsWith(root) && root.startsWith(p.slice(0, p.lastIndexOf("/") + 1)));
  files = new Map([...files].filter(([p]) => p.startsWith(root)).map(([p, b]) => [p.slice(root.length), b]));
  for (const [i, [, data]] of licenses.entries()) files.set(`LICENSE.parent-${i}`, data);
  const ignored: string[] = [];
  const readObject = (p: string): Record<string, unknown> => {
    try { return z.record(z.string(), z.unknown()).parse(JSON.parse(utf8.decode(files.get(p)!))); }
    catch { throw pluginError(400, "invalid_plugin_manifest", p); }
  };
  let manifest: Record<string, unknown> = {};
  const manifestPath = ["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"].find(p => files.has(p));
  if (manifestPath) manifest = readObject(manifestPath);
  if (manifest.$schema && manifest.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") throw pluginError(400, "unsupported_plugin_version");
  if (manifestPath) {
    const m = metadata.safeParse(manifest);
    if (!m.success) throw pluginError(400, "invalid_plugin_manifest");
    for (const key of Object.keys(manifest)) if (!["$schema", "name", "description", "version", "author", "homepage", "repository", "license", "keywords"].includes(key)) ignored.push(`manifest field: ${key}`);
  }
  const servers: PluginServer[] = [];
  const mcpPath = ["mcp.json", ".mcp.json"].find(p => files.has(p));
  const mcp = mcpPath ? readObject(mcpPath) : (manifestPath?.startsWith(".") && typeof manifest.mcpServers === "object" ? { mcpServers: manifest.mcpServers } : {});
  const definitions = z.record(z.string(), z.unknown()).safeParse(mcp.mcpServers ?? {});
  if (!definitions.success) ignored.push("invalid MCP configuration");
  else for (const [name, raw] of Object.entries(definitions.data)) {
    const p = z.object({ url: z.string(), type: z.enum(["http", "streamable-http", "sse"]).optional(), oauth: z.unknown().optional(), headers: z.unknown().optional() }).safeParse(raw);
    if (!p.success || !name.trim() || name.length > 100 || (typeof raw === "object" && raw !== null && "command" in raw)) { ignored.push(`MCP server ${name}: stdio or unsupported configuration`); continue; }
    try {
      const credential = p.data.oauth ? "user-oauth" : p.data.headers ? "organization" : "none";
      servers.push({ name, url: checkMcpUrl(p.data.url, "private").href, credential, transport: p.data.type === "sse" ? "sse" : "streamable-http" });
      if (p.data.headers) ignored.push(`MCP server ${name}: bundled headers omitted; configure a write-only organization secret`);
      if (p.data.oauth) ignored.push(`MCP server ${name}: client OAuth configuration omitted; connect through Baskule`);
    } catch { ignored.push(`MCP server ${name}: invalid or templated URL`); }
  }
  const paths = options.skillPaths?.map(p => safePath(p)) ?? (files.has("SKILL.md") ? [""] : [...files.keys()].filter(p => /^skills\/[^/]+\/SKILL\.md$/.test(p)).map(p => p.slice(0, -9)));
  const skills: InspectedPlugin["skills"] = [];
  let storedBytes = 0;
  for (const path of paths) {
    const prefix = path ? path + "/" : "";
    const skill = files.get(prefix + "SKILL.md");
    if (!skill) { ignored.push(`skill ${path}: missing SKILL.md`); continue; }
    const inherited = [...files].filter(([p]) => /(?:^|\/)(?:LICENSE(?:\.txt)?(?:\.parent-\d+)?|NOTICE)$/i.test(p) && !p.startsWith(prefix) && (!p.includes("/") || prefix.startsWith(p.slice(0, p.lastIndexOf("/") + 1))));
    // A bare skill is also the package root: component configuration must not become computer files.
    const retained = [...files].filter(([p]) => p.startsWith(prefix) && (prefix !== "" ||
      (!["mcp.json", ".mcp.json", "plugin.json"].includes(p) && !/^\.(?:claude|codex)-plugin\//.test(p))));
    if ([...retained, ...inherited].some(([p, b]) => /LICENSE/i.test(p) && /governed by your agreement with\s+Anthropic|proprietary|non-commercial/i.test(new TextDecoder().decode(b)))) {
      ignored.push(`skill ${path}: proprietary license; not imported`); continue;
    }
    try {
      const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(utf8.decode(skill));
      if (!fm) throw new Error("frontmatter");
      const m = metadata.extend({ name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64), description: z.string().min(1).max(1024) }).parse(parseYaml(fm[1], { maxAliasCount: 20 }));
      if (skills.some(s => s.name === m.name)) throw pluginError(400, "duplicate_skill_name");
      if (path && path.split("/").at(-1) !== m.name) throw new Error("skill name must match directory");
      const content = [...retained.map(([p, b]) => [p.slice(prefix.length), b] as const), ...inherited.map(([p, b], i) => [`licenses/${i}-${p.split("/").at(-1)}`, b] as const)].map(([p, b]) => {
        if (b.length > IMPORT_LIMITS.skillFile) throw pluginError(413, "plugin_skill_file_too_large");
        storedBytes += b.length;
        if (storedBytes > IMPORT_LIMITS.stored) throw pluginError(413, "plugin_too_large");
        return { path: safePath(p), content: base64(b), encoding: "base64" as const };
      });
      skills.push({ ...m, files: content });
    } catch (e) { if (e instanceof HttpError) throw e; ignored.push(`skill ${path || "SKILL.md"}: invalid frontmatter`); }
  }
  const understood = new Set(["skills", "plugin.json", ".claude-plugin", ".codex-plugin", "mcp.json", ".mcp.json", "SKILL.md", "LICENSE", "LICENSE.txt", "README.md", "CHANGELOG.md", ...paths.map(p => p.split("/")[0])]);
  for (const p of new Set([...files.keys()].map(p => p.split("/")[0]))) if (!understood.has(p) && !files.has("SKILL.md")) ignored.push(`unsupported bundle part: ${p}`);
  for (const p of files.keys()) if (/^\.(?:claude|codex)-plugin\//.test(p) && !p.endsWith("/plugin.json")) ignored.push(`unsupported client file: ${p}`);
  if (!servers.length && !skills.length) throw pluginError(400, "empty_plugin", ignored.join("; ") || "No usable skills or remote MCP servers");
  return { name: typeof manifest.name === "string" ? manifest.name : skills[0]?.name ?? "Plugin", description: typeof manifest.description === "string" ? manifest.description : skills[0]?.description ?? "", servers, skills, ignored, storedBytes };
}
