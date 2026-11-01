import { z } from "zod";
import type { Group } from "../../../app/packages/contracts/src/baskule-plugins";
import { pluginError, json, notFound, readJson } from "../shared/http";
import type { StorageLike } from "./service";

export const EVERYONE_GROUP_ID = "everyone";
const ids = z.array(z.string().min(1).max(100)).max(1000).transform(v => [...new Set(v)]);
const input = z.object({
  name: z.string().trim().min(1).max(100), members: ids,
  permissions: z.object({ canCreateSpaces: z.boolean() }).strict(), plugins: ids,
}).strict();

export function resolveGroupPermissions(userId: string, groups: readonly Group[]) {
  const applicable = groups.filter(g => g.builtin === "everyone" || g.members.includes(userId));
  return {
    canCreateSpaces: applicable.some(g => g.permissions.canCreateSpaces),
    plugins: [...new Set(applicable.flatMap(g => g.plugins))],
  };
}

export class Groups {
  constructor(private storage: StorageLike) {}
  private rows(q: string, ...p: unknown[]) { return this.storage.sql.exec(q, ...p).toArray(); }

  init() {
    this.rows("insert or ignore into permission_group(id, name, builtin, can_create_spaces) values (?, 'Everyone', 'everyone', 0)", EVERYONE_GROUP_ID);
  }

  list(): Group[] {
    const users = this.rows("select id from user order by id").map(r => r.id as string);
    const members = this.rows("select group_id, user_id from group_member order by user_id");
    const plugins = this.rows("select group_id, plugin_id from group_plugin order by plugin_id");
    return this.rows("select * from permission_group order by builtin desc, name").map(r => ({
      id: r.id as string, name: r.name as string,
      ...(r.builtin === "everyone" ? { builtin: "everyone" as const } : {}),
      members: r.builtin === "everyone" ? users : members.filter(m => m.group_id === r.id).map(m => m.user_id as string),
      permissions: { canCreateSpaces: !!r.can_create_spaces },
      plugins: plugins.filter(p => p.group_id === r.id).map(p => p.plugin_id as string),
    }));
  }

  permissions(userId: string) { return resolveGroupPermissions(userId, this.list()); }

  async handle(req: Request, path: string): Promise<Response> {
    const match = /^\/admin\/groups(?:\/([^/]+))?$/.exec(path);
    if (!match) return notFound();
    const id = match[1];
    const current = id ? this.list().find(g => g.id === id) : undefined;
    if (id && !current) return notFound();
    if (req.method === "GET") return json(id ? current : { groups: this.list() });
    if (id && req.method === "DELETE") {
      if (current!.builtin) throw pluginError(409, "builtin_group");
      this.rows("delete from permission_group where id=?", id);
      return json({ ok: true });
    }
    if ((!id && req.method === "POST") || (id && req.method === "PATCH")) {
      const parsed = (id ? input.partial() : input).safeParse(await readJson(req));
      if (!parsed.success) throw pluginError(400, "invalid_group", parsed.error.message);
      const data = { ...current, ...parsed.data } as z.infer<typeof input>;
      if (current?.builtin && (parsed.data.members !== undefined || (parsed.data.name !== undefined && parsed.data.name !== current.name)))
        throw pluginError(409, "builtin_group", "Everyone membership and name are automatic");
      if (this.rows("select id from permission_group where name=? and id<>?", data.name, id ?? "").length)
        throw pluginError(409, "group_exists");
      for (const uid of data.members) if (!this.rows("select id from user where id=?", uid).length) throw pluginError(400, "user_not_found");
      for (const pid of data.plugins) if (!this.rows("select id from plugin where id=?", pid).length) throw pluginError(400, "plugin_not_found");
      const gid = id ?? crypto.randomUUID();
      this.storage.transactionSync(() => {
        this.rows("insert into permission_group(id,name,can_create_spaces) values (?,?,?) on conflict(id) do update set name=excluded.name,can_create_spaces=excluded.can_create_spaces", gid, data.name, Number(data.permissions.canCreateSpaces));
        this.rows("delete from group_member where group_id=?", gid);
        if (!current?.builtin) for (const uid of data.members) this.rows("insert into group_member(group_id,user_id) values (?,?)", gid, uid);
        this.rows("delete from group_plugin where group_id=?", gid);
        for (const pid of data.plugins) this.rows("insert into group_plugin(group_id,plugin_id) values (?,?)", gid, pid);
      });
      return json(this.list().find(g => g.id === gid), id ? 200 : 201);
    }
    return notFound();
  }
}
