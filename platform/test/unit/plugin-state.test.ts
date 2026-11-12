import { describe, expect, it } from "vitest";
import type { ServerAuth } from "../../../app/packages/contracts/src/baskule-plugins";
import { callDecision, fill, memberConnection, pluginStatus, serverSetup, type CallFacts, type StoredServer } from "../../src/control/plugins/state";

const server = (auth: ServerAuth, variables: StoredServer["variables"] = []): StoredServer => ({ id: "s", name: "s", url: "https://x.test/mcp", transport: "streamable-http", headers: {}, auth, variables });
const facts = (values: string[] = [], clients: string[] = [], providers: ("composio" | "pipedream")[] = []) => ({ values: new Set(values), clients: new Set(clients), providers: new Set(providers) });
const google: ServerAuth = { kind: "oauth", issuer: "https://accounts.google.com", registration: "client" };

describe("server setup", () => {
  it("asks for values, then an OAuth client, then the provider, in that order", () => {
    const url = { name: "URL", secret: false, where: "url" as const };
    expect(serverSetup(server(google, [url]), facts())).toEqual({ state: "needs_values", variables: ["URL"] });
    expect(serverSetup(server(google, [url]), facts(["URL"]))).toEqual({ state: "needs_oauth_client", issuer: "https://accounts.google.com" });
    expect(serverSetup(server(google, [url]), facts(["URL"], ["https://accounts.google.com"]))).toEqual({ state: "ready" });
    expect(serverSetup(server({ kind: "oauth", issuer: "https://a.test", registration: "dynamic" }), facts())).toEqual({ state: "ready" });
    expect(serverSetup(server({ kind: "oauth", issuer: null, registration: "dynamic" }), facts())).toEqual({ state: "ready" });
    const app: ServerAuth = { kind: "provider", provider: "pipedream", app: "slack" };
    expect(serverSetup(server(app), facts())).toEqual({ state: "needs_provider", provider: "pipedream" });
    expect(serverSetup(server(app), facts([], [], ["pipedream"]))).toEqual({ state: "ready" });
  });
  it("derives plugin status and each member's connection", () => {
    expect(pluginStatus(false, [{ state: "ready" }])).toBe("paused");
    expect(pluginStatus(true, [{ state: "ready" }, { state: "needs_values", variables: ["A"] }])).toBe("needs_setup");
    expect(pluginStatus(true, [])).toBe("ready");
    const row = { state: "connected" as const, account: "ada@example.com", connectedAt: 0 };
    expect(memberConnection(google, { state: "needs_oauth_client", issuer: "x" }, row)).toEqual({ state: "unavailable" });
    expect(memberConnection({ kind: "headers", headers: ["Authorization"] }, { state: "ready" }, undefined)).toEqual({ state: "not_required" });
    expect(memberConnection(google, { state: "ready" }, undefined)).toEqual({ state: "not_connected" });
    expect(memberConnection(google, { state: "ready" }, { ...row, state: "expired" })).toEqual({ state: "expired" });
    expect(memberConnection(google, { state: "ready" }, row)).toEqual({ state: "connected", account: "ada@example.com", connectedAt: "1970-01-01T00:00:00.000Z" });
  });
  it("fills placeholders from values", () => expect(fill("https://${HOST}/${env:PATH}", { HOST: "h.test", PATH: "mcp" })).toBe("https://h.test/mcp"));
});

describe("runtime policy", () => {
  const allowed: CallFacts = { user: { banned: false }, member: true, access: true, plugin: { enabled: true, ready: true }, server: { auth: google }, on: true,
    connection: { state: "connected", account: null, connectedAt: 0 } };
  it.each([
    ["allowed", {}, null],
    ["unknown user", { user: null }, "not_allowed"],
    ["banned user", { user: { banned: true } }, "not_allowed"],
    ["not a space member", { member: false }, "not_allowed"],
    ["no access", { access: false }, "not_allowed"],
    ["removed plugin", { plugin: null }, "not_allowed"],
    ["removed server", { server: null }, "not_allowed"],
    ["paused", { plugin: { enabled: false, ready: true } }, "plugin_off"],
    ["switched off", { on: false }, "plugin_off"],
    ["setup incomplete", { plugin: { enabled: true, ready: false } }, "setup_incomplete"],
    ["not signed in", { connection: null }, "sign_in_required"],
    ["expired sign-in", { connection: { state: "expired", account: null, connectedAt: 0 } }, "sign_in_expired"],
    ["header server without a connection", { server: { auth: { kind: "headers", headers: ["X"] } }, connection: null }, null],
  ] as const)("%s", (_name, change, expected) => expect(callDecision({ ...allowed, ...change } as CallFacts)).toBe(expected));
});
