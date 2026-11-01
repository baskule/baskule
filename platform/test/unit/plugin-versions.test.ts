import { describe, expect, it } from "vitest";
import type { PluginInput, SkillInput } from "../../../app/packages/contracts/src/baskule-plugins";
import { skillWarnings } from "../../../app/packages/contracts/src/baskule-plugin-formats";
import { IMPORT_LIMITS } from "../../src/control/plugin-package";
import { asAdmin, call, makeService } from "../support/harness";

const root = "/api/baskule/admin/plugins";
const skill = (instructions = "Keep decisions with their next steps."): SkillInput => ({ name: "team-notes", description: "Write clear notes.", instructions, files: [] });
const input = (): PluginInput => ({ name: "Team notes", description: "", source: { type: "custom" }, servers: [{ name: "notes", url: "https://example.test/mcp", credential: "organization" }], skills: [skill()], omitted: [] });

describe("immutable skill versions", () => {
  it("archives earlier skills, reverts by saving a new version, and keeps server setup and plugin identity", async () => {
    const h = await makeService(); const a = await asAdmin(h); const admin = { creds: a.creds };
    const original = input();
    const created = await call(h, "POST", root, { ...admin, body: { plugin: original, groups: ["everyone"] } });
    const path = `${root}/${created.body.id}`;
    await call(h, "PUT", `${path}/secret`, { ...admin, body: { server: "notes", headers: { Authorization: "Bearer version-key" } } });
    expect((await call(h, "GET", `${path}/skills`, admin)).body.versions).toEqual([]);
    const edited = { ...original, name: "Renamed plugin", skills: [skill("Keep the owner and deadline together.")] };
    expect((await call(h, "PATCH", path, { ...admin, body: { plugin: edited } })).status).toBe(200);
    const earlier = h.storage.sql.exec("select skill_files from plugin_version where plugin_id=? and version=1", created.body.id).toArray()[0].skill_files;
    const history = await call(h, "GET", `${path}/skills`, admin);
    expect(history.body).toMatchObject({ editable: true, skills: edited.skills, versions: [{ version: 1, savedAt: expect.any(String), savedBy: expect.any(String) }] });
    const restored = await call(h, "POST", `${path}/versions/1/revert`, admin);
    expect(restored.status).toBe(200);
    expect(restored.body.skills).toEqual(original.skills);
    expect(restored.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(h.storage.sql.exec("select skill_files from plugin_version where plugin_id=? and version=1", created.body.id).toArray()[0].skill_files).toBe(earlier);
    expect(h.svc.plugins.get(created.body.id)).toMatchObject({ name: "Renamed plugin", servers: [{ url: original.servers[0].url, credential: "organization" }] });
    expect(await h.svc.plugins.organizationHeaders(created.body.id, "notes")).toEqual({ Authorization: "Bearer version-key" });
    expect((await call(h, "POST", `${path}/versions/100/revert`, admin)).body.error).toBe("version_not_found");
    await call(h, "PATCH", path, { ...admin, body: { plugin: { ...edited, skills: restored.body.skills } } });
    expect((await call(h, "GET", `${path}/skills`, admin)).body.versions).toHaveLength(2);
    for (let n = 0; n < 12; n++) await call(h, "PATCH", path, { ...admin, body: { plugin: { ...edited, skills: [skill(`Revision ${n}`)] } } });
    const capped = (await call(h, "GET", `${path}/skills`, admin)).body.versions;
    expect(capped).toHaveLength(10);
    expect(capped.map((v: { version: number }) => v.version)).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);
    expect((await call(h, "POST", `${path}/versions/1/revert`, admin)).body.error).toBe("version_not_found");
    await call(h, "DELETE", path, admin);
    expect(h.storage.sql.exec("select * from plugin_version where plugin_id=?", created.body.id).toArray()).toEqual([]);
  });
  it("copies pinned skill files independently and refuses edits and reverts on the original", async () => {
    const h = await makeService(); const a = await asAdmin(h); const admin = { creds: a.creds };
    const original = { ...input(), source: { type: "github" as const, repo: "https://github.com/example/skills", sha: "a".repeat(40) }, skills: [{ ...skill(), frontmatter: "license: MIT\n", files: [{ path: "LICENSE", content: btoa("MIT licence"), encoding: "base64" as const }] }] };
    const pinned = await call(h, "POST", root, { ...admin, body: { plugin: original, groups: [] } });
    const path = `${root}/${pinned.body.id}`;
    const history = (await call(h, "GET", `${path}/skills`, admin)).body;
    expect(history.editable).toBe(false);
    expect((await call(h, "PATCH", path, { ...admin, body: { plugin: { ...original, skills: [skill("Changed")] } } })).body.error).toBe("not_editable");
    expect((await call(h, "POST", `${path}/versions/1/revert`, admin)).body.error).toBe("not_editable");
    const copied: PluginInput = { ...input(), name: "My team notes", servers: [], skills: structuredClone(history.skills) };
    const copy = await call(h, "POST", root, { ...admin, body: { plugin: copied, groups: [] } });
    expect(copy.status).toBe(201); expect(copy.body.id).not.toBe(pinned.body.id);
    copied.skills[0].instructions = "My own instructions";
    await call(h, "PATCH", `${root}/${copy.body.id}`, { ...admin, body: { plugin: copied } });
    expect((await call(h, "GET", `${path}/skills`, admin)).body).toEqual(history);
    expect((await call(h, "GET", `${root}/${copy.body.id}/skills`, admin)).body.skills[0]).toMatchObject({ instructions: "My own instructions", files: original.skills[0].files, frontmatter: "license: MIT\n" });
  });
  it("counts earlier versions in the storage limit and rolls back a refused save", async () => {
    const h = await makeService(); const a = await asAdmin(h); const admin = { creds: a.creds };
    const large: PluginInput = { ...input(), skills: Array.from({ length: 4 }, (_, n) => ({ ...skill("x".repeat(900_000)), name: `notes-${n}` })) };
    const created = await call(h, "POST", root, { ...admin, body: { plugin: large, groups: [] } });
    expect(created.status).toBe(201);
    const path = `${root}/${created.body.id}`;
    await call(h, "PUT", `${path}/secret`, { ...admin, body: { server: "notes", headers: { Authorization: "Bearer retained-key" } } });
    for (let n = 0; n < 8; n++) {
      large.skills[0].description = `Revision ${n}`;
      expect((await call(h, "PATCH", path, { ...admin, body: { plugin: large } })).status).toBe(200);
    }
    const before = (await call(h, "GET", `${path}/skills`, admin)).body;
    large.skills[0].description = "Too much history";
    large.servers[0].url = "https://changed.example.test/mcp";
    expect((await call(h, "PATCH", path, { ...admin, body: { plugin: large } })).body.error).toBe("plugin_storage_limit");
    expect((await call(h, "GET", `${path}/skills`, admin)).body).toEqual(before);
    expect(before.versions).toHaveLength(8);
    expect(h.svc.plugins.get(created.body.id)!.servers[0].url).toBe("https://example.test/mcp");
    expect(await h.svc.plugins.organizationHeaders(created.body.id, "notes")).toEqual({ Authorization: "Bearer retained-key" });
    expect(Number(h.storage.sql.exec("select sum(stored_bytes) as n from plugin_version").toArray()[0].n)).toBeLessThan(IMPORT_LIMITS.totalStored);
  });
});

describe("skill compatibility warnings", () => {
  it.each([
    ["/review the notes", "slash_command"],
    ["Use AskUserQuestion to collect answers.", "claude_only_tool"],
    ["Run npm install markdown first.", "software_install"],
    ["Run npx -y package first.", "software_install"],
    ["Run npm i package first.", "software_install"],
    ["api_key = secretvalue12345", "secret_in_file"],
  ] as const)("warns about %s without including content in the warning", (instructions, warning) => {
    const value = skillWarnings(skill(instructions));
    expect(value).toEqual([{ warning, path: "SKILL.md" }]);
    expect(JSON.stringify(value)).not.toContain(instructions);
  });
  it("recognizes inline slash commands without treating URLs or file paths as commands", () => {
    expect(skillWarnings(skill("Run `/review` before saving."))).toEqual([{ warning: "slash_command", path: "SKILL.md" }]);
    expect(skillWarnings(skill("Open https://example.com/review and /sandbox/notes/file.md."))).toEqual([]);
    expect(skillWarnings(skill("Run (/review)."))).toEqual([{ warning: "slash_command", path: "SKILL.md" }]);
  });
  it("recognizes quoted secrets and passwords with punctuation", () => {
    for (const instructions of ['{"api_key":"private-key-value"}', "password='p@ssword!'"]) {
      expect(skillWarnings(skill(instructions))).toEqual([{ warning: "secret_in_file", path: "SKILL.md" }]);
    }
    expect(skillWarnings(skill('{"api_key":"${KEY}"}'))).toEqual([]);
  });
  it("warns about named secret files, allows placeholders and normal prose, and never blocks saving", async () => {
    expect(skillWarnings(skill("api_key = ${KEY}"))).toEqual([]);
    expect(skillWarnings(skill())).toEqual([]);
    const risky = { ...skill("Use AskUserQuestion."), files: [{ path: ".env", content: btoa("API_KEY=sample-only-key"), encoding: "base64" as const }] };
    expect(skillWarnings(risky)).toContainEqual({ warning: "secret_in_file", path: ".env" });
    const h = await makeService(); const a = await asAdmin(h);
    const saved = await call(h, "POST", root, { creds: a.creds, body: { groups: [], plugin: { ...input(), servers: [], skills: [risky] } } });
    expect(saved.status).toBe(201);
  });
});
