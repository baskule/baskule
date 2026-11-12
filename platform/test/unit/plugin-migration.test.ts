import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../../src/control/migrations/migrations.js";
import { fakeStorage } from "../support/fake-storage";

const tables = (storage: ReturnType<typeof fakeStorage>) => storage.sql.exec("select name from sqlite_master where type='table' order by name").toArray().map(r => r.name as string);

describe("migration 0013", () => {
  it("wipes every plugin of the old system and keeps groups and other settings", async () => {
    const storage = fakeStorage();
    const db = drizzle(storage as never);
    const before = { ...migrations, journal: { ...migrations.journal, entries: migrations.journal.entries.filter(e => e.idx < 13) } };
    await migrate(db as never, before);
    const run = (q: string, ...p: unknown[]) => storage.sql.exec(q, ...p).toArray();
    run("insert into user(id,name,email,created_at,updated_at) values ('u','U','u@x.test',0,0)");
    run("insert into permission_group(id,name,builtin,can_create_spaces) values ('everyone','Everyone','everyone',1)");
    run("insert into plugin(id,definition,skill_files,stored_bytes) values ('p','{}','[]',0)");
    run("insert into group_plugin(group_id,plugin_id) values ('everyone','p')");
    run("insert into plugin_skill(plugin_id,name,id) values ('p','s','abc')");
    run("insert into plugin_version(plugin_id,version,skill_files,stored_bytes,saved_at) values ('p',1,'[]',0,0)");
    run("insert into plugin_secret(plugin_id,server,data) values ('p','s','sealed')");
    run("insert into plugin_connection(id,user_id,plugin_id,server,label,is_default,data,created_at) values ('c','u','p','s','Work',1,'sealed',0)");
    run("insert into plugin_oauth_state(state_hash,user_id,plugin_id,server,data,expires_at) values ('h','u','p','s','sealed',0)");
    run("insert into vendor_setup(vendor,data) values ('google','sealed')");
    run("insert into kv(key,value) values ('plugin_folder','{}'),('auth_secret','keep')");
    await migrate(db as never, migrations);
    for (const gone of ["plugin_skill", "plugin_version", "plugin_secret", "space_disabled_plugin", "space_plugin_settings", "vendor_setup"]) expect(tables(storage)).not.toContain(gone);
    for (const table of ["plugin", "group_plugin", "plugin_value", "oauth_client", "plugin_provider", "member_plugin", "plugin_connection", "plugin_oauth_state"]) {
      expect(tables(storage)).toContain(table);
      expect(run(`select count(*) as n from ${table}`)[0]!.n).toBe(0);
    }
    expect(run("select key from kv order by key").map(r => r.key)).toEqual(["auth_secret"]);
    expect(run("select id,can_create_spaces from permission_group")).toEqual([{ id: "everyone", can_create_spaces: 1 }]);
    expect(run("pragma table_info(plugin_connection)").map(r => r.name)).toEqual(["user_id", "plugin_id", "server_id", "data", "account", "connected_at", "state"]);
  });
});
