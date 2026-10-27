import {
  decodePushNotification,
  decodePushRegistration,
  type PushNotification,
  type PushRegistration,
  type PushAvailability,
} from "../../../app/packages/contracts/src/baskulePush";
import type { SpaceCaller, StorageLike } from "./service";
import { HttpError, json, readJson } from "../shared/http";
import { pushCredentialsSchema, sendPush, type PushCredentials } from "./push-provider";

const deviceIdPattern = /^[a-zA-Z0-9_-]{16,128}$/;
const preferences = {
  approval: "notifyOnApproval",
  input: "notifyOnInput",
  completion: "notifyOnCompletion",
  failure: "notifyOnFailure",
} as const;
export class Push {
  constructor(
    private storage: StorageLike,
    private callSpace: SpaceCaller,
    private authenticated: boolean,
    private send = sendPush,
  ) {}
  private rows(query: string, ...params: unknown[]) {
    return this.storage.sql.exec(query, ...params).toArray();
  }
  private credentials(): PushCredentials {
    const value = this.rows("select value from kv where key='push_credentials'")[0]?.value;
    return value
      ? pushCredentialsSchema.parse(JSON.parse(String(value)))
      : { apns: null, fcm: null };
  }
  status(): PushAvailability {
    const c = this.credentials();
    return {
      available: this.authenticated && !!(c.apns || c.fcm),
      ios:
        this.authenticated && c.apns
          ? { appId: c.apns.appId, environments: c.apns.environments }
          : null,
      android: this.authenticated && c.fcm ? { appId: c.fcm.appId } : null,
      reason: !this.authenticated
        ? "Background push requires authenticated sessions"
        : !c.apns && !c.fcm
          ? "Push providers are not configured"
          : null,
    };
  }
  async settings(req: Request) {
    if (req.method === "PUT" || req.method === "PATCH") {
      const input = await readJson(req);
      const parsed = (
        req.method === "PATCH" ? pushCredentialsSchema.partial() : pushCredentialsSchema
      ).safeParse(input);
      if (!parsed.success) throw new HttpError(400, "invalid_push_credentials");
      this.rows(
        "insert into kv(key,value) values ('push_credentials',?) on conflict(key) do update set value=excluded.value",
        JSON.stringify({ ...this.credentials(), ...parsed.data }),
      );
    }
    return json(this.status());
  }
  async device(req: Request, deviceId: string, identity: { userId: string; sessionId: string }) {
    if (!deviceIdPattern.test(deviceId)) throw new HttpError(400, "invalid_device_id");
    if (req.method === "DELETE") {
      this.rows(
        "delete from push_device where id=? and user_id=? and session_id=?",
        deviceId,
        identity.userId,
        identity.sessionId,
      );
      return json({ ok: true });
    }
    if (!this.authenticated) throw new HttpError(409, "push_unavailable");
    let registration: PushRegistration;
    try {
      registration = decodePushRegistration(await readJson(req));
    } catch {
      throw new HttpError(400, "invalid_push_registration");
    }
    if (registration.platform === "ios")
      registration = { ...registration, token: registration.token.toLowerCase() };
    const c = this.credentials();
    if (
      registration.appId.length > 200 ||
      registration.token.length > 4096 ||
      (registration.platform === "ios" && !/^[0-9a-f]{64}$/.test(registration.token))
    )
      throw new HttpError(400, "invalid_push_registration");
    if (
      registration.platform === "ios"
        ? !c.apns ||
          c.apns.appId !== registration.appId ||
          !c.apns.environments.includes(registration.apnsEnvironment)
        : !c.fcm || c.fcm.appId !== registration.appId
    )
      throw new HttpError(409, "push_unavailable");
    const tokenIdentity = JSON.stringify([
      registration.platform,
      registration.appId,
      registration.platform === "ios" ? registration.apnsEnvironment : "",
      registration.token,
    ]);
    const tokenKey = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokenIdentity)),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    const data = JSON.stringify(registration);
    const version = this.storage.transactionSync(() => {
      if (
        !this.rows(
          "select 1 from session s join user u on u.id=s.user_id where s.id=? and s.user_id=? and s.expires_at>? and coalesce(u.banned,0)=0",
          identity.sessionId,
          identity.userId,
          Date.now(),
        ).length
      )
        throw new HttpError(401, "unauthenticated");
      const existing = this.rows(
        "select user_id, session_id, token_key, token_version from push_device where id=?",
        deviceId,
      )[0];
      const version =
        existing?.token_key === tokenKey &&
        existing.user_id === identity.userId &&
        existing.session_id === identity.sessionId
          ? String(existing.token_version)
          : crypto.randomUUID();
      this.rows("delete from push_device where token_key=? and id!=?", tokenKey, deviceId);
      this.rows(
        "insert into push_device(id,user_id,session_id,token_key,token_version,registration) values (?,?,?,?,?,?) on conflict(id) do update set user_id=excluded.user_id, session_id=excluded.session_id, token_key=excluded.token_key, token_version=excluded.token_version, registration=excluded.registration",
        deviceId,
        identity.userId,
        identity.sessionId,
        tokenKey,
        version,
        data,
      );
      return version;
    });
    return json({ registered: true, tokenVersion: version });
  }
  private live(
    deviceId: string,
    version: string,
    spaceId: string,
    userId: string,
    kind: PushNotification["kind"],
  ) {
    return (
      this.rows(
        `select 1 from push_device d join session s on s.id=d.session_id and s.user_id=d.user_id join user u on u.id=d.user_id join space_member m on m.user_id=d.user_id and m.space_id=? where d.id=? and d.token_version=? and d.user_id=? and s.expires_at>? and coalesce(u.banned,0)=0 and json_extract(d.registration,'$.preferences.notificationsEnabled')=1 and json_extract(d.registration,?)=1`,
        spaceId,
        deviceId,
        version,
        userId,
        Date.now(),
        `$.preferences.${preferences[kind]}`,
      ).length > 0
    );
  }
  async deliver(req: Request) {
    const body = await readJson<{ spaceId: string; environmentId: string; notification: unknown }>(
      req,
    );
    if (typeof body.environmentId !== "string" || !body.environmentId)
      throw new HttpError(400, "invalid_environment_id");
    const n = decodePushNotification(body.notification);
    if (!this.authenticated || n.expiresAt <= Date.now()) return json({ ok: true });
    const credentials = this.credentials();
    const devices = this.rows(
      "select id,token_version,registration from push_device where user_id=?",
      n.userId,
    );
    let failed = false;
    for (const row of devices) {
      const id = String(row.id),
        version = String(row.token_version);
      const device = decodePushRegistration(JSON.parse(String(row.registration)));
      if (!device.preferences.notificationsEnabled || !device.preferences[preferences[n.kind]])
        continue;
      if (
        this.rows(
          "select 1 from push_receipt where space_id=? and event_id=? and device_id=? and token_version=?",
          body.spaceId,
          n.eventId,
          id,
          version,
        ).length
      )
        continue;
      const eligible = async () => {
        if (n.expiresAt <= Date.now() || !this.live(id, version, body.spaceId, n.userId, n.kind))
          return false;
        const current = await this.callSpace(body.spaceId, "/_baskule/push/check", {
          method: "POST",
          body: JSON.stringify({ eventId: n.eventId, threadId: n.threadId }),
        });
        if (!current.ok) throw new HttpError(503, "push_retry");
        const status: unknown = await current.json();
        if (
          status === null ||
          typeof status !== "object" ||
          !("current" in status) ||
          typeof status.current !== "boolean"
        )
          throw new HttpError(503, "push_retry");
        return (
          status.current &&
          n.expiresAt > Date.now() &&
          this.live(id, version, body.spaceId, n.userId, n.kind)
        );
      };
      try {
        if (!(await eligible())) continue;
        const result = await this.send({
          credentials,
          registration: device,
          deviceId: id,
          notification: n,
          spaceId: body.spaceId,
          environmentId: body.environmentId,
          eligible,
        });
        if (result === "skipped") continue;
        this.storage.transactionSync(() => {
          this.rows(
            "insert or ignore into push_receipt(space_id,event_id,device_id,token_version,expires_at) values (?,?,?,?,?)",
            body.spaceId,
            n.eventId,
            id,
            version,
            n.expiresAt,
          );
          if (result === "invalid")
            this.rows("delete from push_device where id=? and token_version=?", id, version);
        });
      } catch {
        failed = true;
      }
    }
    this.rows("delete from push_receipt where expires_at<?", Date.now() - 86400000);
    if (failed) throw new HttpError(503, "push_retry");
    return json({ ok: true });
  }
}
