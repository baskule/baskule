import { describe, expect, it } from "vitest";
import type { PluginInput } from "../../../app/packages/contracts/src/baskule-plugins";
import { ControlService } from "../../src/control/service";
import { asAdmin, call, makeService, personalSpaceOf } from "../support/harness";

const root = "/api/baskule/admin/plugins";
const input: PluginInput = { name: "Skills", description: "", source: { type: "custom" }, servers: [], omitted: [],
  skills: ["hello", "goodbye"].map(name => ({ name, description: name, instructions: `Say ${name}.`, files: [] })),
};

describe("persistent skill IDs", () => {
  it("upgrades existing skills without rewriting their files and keeps IDs across restarts, edits, order and restores", async () => {
    const h = await makeService(); const a = await asAdmin(h); const admin = { creds: a.creds };
    const created = await call(h, "POST", root, { ...admin, body: { plugin: input, groups: ["everyone"] } });
    const pluginId = created.body.id;
    const files = h.storage.sql.exec("select skill_files from plugin where id=?", pluginId).toArray()[0].skill_files;
    // Recreate the previous schema and migration cursor with an already-installed skill bundle.
    h.storage.sql.exec("drop table plugin_skill");
    h.storage.sql.exec("delete from __drizzle_migrations where created_at=(select max(created_at) from __drizzle_migrations)");
    const upgraded = new ControlService(h.storage, h.env, async () => Response.json({ ok: true }));
    await upgraded.init();
    expect(h.storage.sql.exec("select * from plugin_skill").toArray()).toEqual([]);
    const space = personalSpaceOf(h, a.userId);
    const before = (await upgraded.plugins.settings(space)).skills;
    expect(before).toHaveLength(2);
    for (const skill of before) expect(skill.id).toMatch(/^[\w-]{21}$/);
    expect(new Set(before.map(s => s.id)).size).toBe(2);
    expect(h.storage.sql.exec("select skill_files from plugin where id=?", pluginId).toArray()[0].skill_files).toBe(files);
    const restarted = new ControlService(h.storage, h.env, async () => Response.json({ ok: true }));
    await restarted.init();
    expect((await restarted.plugins.settings(space)).skills).toEqual(before);
    const edited = { ...input, skills: input.skills.toReversed().map(s => ({ ...s, instructions: "Updated instructions." })) };
    expect((await call(h, "PATCH", `${root}/${pluginId}`, { ...admin, body: { plugin: edited } })).status).toBe(200);
    expect((await restarted.plugins.settings(space)).skills.map(s => s.id)).toEqual(before.map(s => s.id).toReversed());
    await call(h, "PATCH", `${root}/${pluginId}`, { ...admin, body: { plugin: { ...input, skills: [input.skills[1]] } } });
    expect((await restarted.plugins.settings(space)).skills.map(s => s.id)).toEqual([before[1].id]);
    expect((await call(h, "POST", `${root}/${pluginId}/versions/1/revert`, admin)).status).toBe(200);
    expect((await restarted.plugins.settings(space)).skills).toEqual(before);
    const copied = await call(h, "POST", root, { ...admin, body: { plugin: input, groups: ["everyone"] } });
    const all = (await restarted.plugins.settings(space)).skills;
    expect(new Set(all.map(s => s.id)).size).toBe(4);
    expect(all.filter(s => s.pluginId === pluginId)).toEqual(before);
    expect(all.filter(s => s.pluginId === copied.body.id).map(s => s.name)).toEqual(input.skills.map(s => s.name));
    await call(h, "DELETE", `${root}/${pluginId}`, admin);
    expect(h.storage.sql.exec("select * from plugin_skill where plugin_id=?", pluginId).toArray()).toEqual([]);
  });
});
