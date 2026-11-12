import type { PluginFile } from "../../../app/packages/contracts/src/baskule-plugins";
import type { Computerd } from "./computerd";

export const PLUGIN_SKILLS_PATH = "/sandbox/space/plugins";

/** Paths are `<plugin>/<skill>/<file>`; whole-set replacement also removes retired skills and the old system's files. */
export function planSkills(files: PluginFile[]) {
  const seen = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    if (parts.length < 3 || file.path.startsWith("/") || parts.some(s => !s || s === "." || s === ".." || /[\\\0]/.test(s))) throw new Error("Invalid skill path");
    if (seen.has(file.path)) throw new Error("Duplicate skill path");
    seen.add(file.path);
  }
  return files.map(f => ({ path: f.path, content: f.base64 })).sort((a, b) => a.path.localeCompare(b.path));
}

// The computer runs as uid 1000. Modes make the managed tree read-only for ordinary file tools; this is not a
// security boundary against a shell that deliberately chmods its own files.
const INSTALL = `import base64,json,os,pathlib,shutil,sys,tempfile
root=pathlib.Path(sys.argv[1])
stage=pathlib.Path(tempfile.mkdtemp(prefix='.plugins-',dir=root.parent))
try:
 for f in json.load(sys.stdin):
  p=stage/f['path']; p.parent.mkdir(parents=True,exist_ok=True)
  p.write_bytes(base64.b64decode(f['content'],validate=True)); p.chmod(0o444)
 for p in sorted(stage.rglob('*'),reverse=True):
  if p.is_dir(): p.chmod(0o555)
 stage.chmod(0o555)
 if root.is_symlink(): root.unlink()
 if root.exists():
  root.chmod(0o755)
  for p,ds,fs in os.walk(root,followlinks=False):
   os.chmod(p,0o755)
  shutil.rmtree(root)
 stage.rename(root)
finally:
 if stage.exists():
  stage.chmod(0o755)
  for p,ds,fs in os.walk(stage): os.chmod(p,0o755)
  shutil.rmtree(stage)
`;

export async function syncSkills(computer: Computerd, files: PluginFile[]) {
  const planned = planSkills(files);
  const res = await computer.exec({ argv: ["python3", "-c", INSTALL, PLUGIN_SKILLS_PATH], cwd: "/sandbox/space", stdin: Buffer.from(JSON.stringify(planned)).toString("base64"), timeoutMs: 30_000 });
  if (!res.ok) throw new Error(`Skill installation failed (${res.status})`);
  const frames = (await res.text()).trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as { t: string; code?: number });
  if (!frames.some(f => f.t === "x" && f.code === 0)) throw new Error("Skill installation failed on the computer");
}

/** ControlCell writes `name` and `description` first, as JSON strings, so no YAML parser is needed here. */
function front(markdown: string) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(markdown);
  const field = (key: string) => {
    const line = match?.[1]!.split("\n").find(l => l.startsWith(`${key}: `));
    try { return line ? JSON.parse(line.slice(key.length + 2)) as unknown : undefined; } catch { return undefined; }
  };
  return { name: field("name"), description: field("description"), body: match ? markdown.slice(match[0].length) : markdown };
}

/** Workerd disables disk config plugins; supply the same skill catalog directly to its location service. */
export function skillCatalog(files: PluginFile[]) {
  planSkills(files);
  const folders = new Map<string, PluginFile[]>();
  for (const file of files) {
    const folder = file.path.split("/").slice(0, 2).join("/");
    folders.set(folder, [...(folders.get(folder) ?? []), file]);
  }
  return [...folders].flatMap(([folder, entries]) => {
    const skill = entries.find(f => f.path === `${folder}/SKILL.md`);
    if (!skill) return [];
    const { name, description, body } = front(Buffer.from(skill.base64, "base64").toString("utf8"));
    if (typeof name !== "string" || typeof description !== "string") return [];
    const directory = `${PLUGIN_SKILLS_PATH}/${folder}`;
    return [{ files: entries.map(f => `${PLUGIN_SKILLS_PATH}/${f.path}`), id: folder, name, description, path: `${directory}/SKILL.md`, content: body }];
  });
}
