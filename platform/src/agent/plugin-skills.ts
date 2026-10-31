import type { SpacePlugins } from "../../../app/packages/contracts/src/baskule-plugins";
import type { Computerd } from "./computerd";

export const PLUGIN_SKILLS_PATH = "/sandbox/space/plugins";

/** Namespaced paths, deterministic payload, and whole-set replacement also remove retired skills. */
export function planSkills(skills: SpacePlugins["skills"]) {
  const files: { path: string; content: string }[] = [];
  const paths = new Set<string>();
  for (const skill of skills) {
    const directory = `${encodeURIComponent(skill.pluginId)}/${encodeURIComponent(skill.name)}`;
    if ([skill.pluginId, skill.name].some(s => !s || s === "." || s === "..")) throw new Error("Invalid skill identity");
    for (const file of skill.files) {
      if (!file.path || file.path.startsWith("/") || file.path.split(/[\\/]/).some(s => !s || s === "." || s === "..")) throw new Error("Invalid skill path");
      const path = `${directory}/${file.path}`;
      if (paths.has(path)) throw new Error("Duplicate skill path");
      paths.add(path);
      files.push({ path, content: file.content });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
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

export async function syncSkills(computer: Computerd, skills: SpacePlugins["skills"]) {
  const files = planSkills(skills);
  const res = await computer.exec({ argv: ["python3", "-c", INSTALL, PLUGIN_SKILLS_PATH], cwd: "/sandbox/space", stdin: Buffer.from(JSON.stringify(files)).toString("base64"), timeoutMs: 30_000 });
  if (!res.ok) throw new Error(`Skill installation failed (${res.status})`);
  const frames = (await res.text()).trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as { t: string; code?: number });
  if (!frames.some(f => f.t === "x" && f.code === 0)) throw new Error("Skill installation failed on the computer");
}

/** Workerd disables disk config plugins; supply the same skill catalog directly to its location service. */
export function skillCatalog(skills: SpacePlugins["skills"]) {
  planSkills(skills);
  return skills.map(skill => {
    const file = skill.files.find(f => f.path === "SKILL.md");
    if (!file) throw new Error("Skill has no SKILL.md");
    const directory = `${PLUGIN_SKILLS_PATH}/${encodeURIComponent(skill.pluginId)}/${encodeURIComponent(skill.name)}`;
    return { files: skill.files.map(f => `${directory}/${f.path}`), id: `${skill.pluginId}/${skill.name}`, name: skill.name, description: skill.description,
      path: `${directory}/SKILL.md`,
      content: Buffer.from(file.content, "base64").toString("utf8").replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "") };
  });
}
