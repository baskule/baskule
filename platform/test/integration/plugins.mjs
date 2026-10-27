import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { zipSync } from "fflate";
import { checkConnections } from "./connections.mjs";

/** Worker→ControlCell wiring and celld's actual JS-only archive/YAML execution. No external registry calls. */
export async function checkPlugins(req, check, admin, alice) {
  const API = "/api/baskule";
  const A = { cookie: admin.cookie };
  const U = { cookie: alice.cookie };
  const files = { "hello/SKILL.md": new Uint8Array(readFileSync(new URL("../fixtures/plugins/portable/skills/hello/SKILL.md", import.meta.url))) };
  const archive = zipSync(files);
  const installed = await req("POST", `${API}/admin/plugins`, { ...A, body: { source: { type: "archive", sha256: createHash("sha256").update(archive).digest("hex") }, archive: Buffer.from(archive).toString("base64") } });
  check("plugin archive imported disabled on celld", installed.status === 201 && installed.json.enabled === false && installed.json.skills[0]?.name === "hello", installed.text);
  const id = installed.json.id;
  const grant = await req("PATCH", `${API}/admin/groups/everyone`, { ...A, body: { plugins: [id], permissions: { canCreateSpaces: true } } });
  check("Everyone group grants a plugin and space creation", grant.status === 200 && grant.json.members.includes(alice.userId), grant.text);
  const me = await req("GET", `${API}/me`, U);
  check("me resolves space creation from groups", me.json.user.canCreateSpaces === true);
  check("users cannot install plugins", (await req("POST", `${API}/admin/plugins`, { ...U, body: { source: { type: "url", url: "https://example.test/mcp" } } })).status === 403);
  check("user enables an allowed plugin", (await req("PUT", `${API}/plugins/${id}/enabled`, { ...U, body: { enabled: true } })).status === 200);
  const mine = await req("GET", `${API}/plugins`, U);
  check("user plugin list includes enablement without skill contents", mine.json.plugins[0]?.userEnabled === true && !mine.text.includes("Say hello"));
  check("Everyone cannot be deleted", (await req("DELETE", `${API}/admin/groups/everyone`, A)).status === 409);
  await req("DELETE", `${API}/admin/plugins/${id}`, A);
  const after = await req("GET", `${API}/plugins`, U);
  check("plugin deletion cascades user preferences and group grants", after.json.plugins.length === 0 && (await req("GET", `${API}/admin/groups/everyone`, A)).json.plugins.length === 0);
  await req("PATCH", `${API}/admin/groups/everyone`, { ...A, body: { permissions: { canCreateSpaces: false } } });
  await checkConnections(req, check, admin, alice);
}
