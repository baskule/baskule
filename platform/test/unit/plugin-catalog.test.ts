import { describe, expect, it, vi } from "vitest";
import { CATALOG, CATALOG_VENDORS } from "../../../app/packages/contracts/src/baskule-catalog";
import { discoverOAuth } from "../../src/control/connection-oauth";
import { pluginFromCatalog } from "../../src/control/plugins";
import { checkOutbound } from "../../src/shared/plugin-outbound";
import { asAdmin, call, makeService } from "../support/harness";

const API = "/api/baskule";
describe("curated plugin catalog", () => {
  it("keeps reviewed entries unique, public and tied to a vendor recipe", () => {
    expect(new Set(CATALOG.map(s => s.id)).size).toBe(CATALOG.length);
    expect(new Set(CATALOG_VENDORS.map(v => v.id)).size).toBe(CATALOG_VENDORS.length);
    for (const vendor of CATALOG_VENDORS) {
      if (vendor.signIn.type === "account" && vendor.signIn.client === "static") {
        expect(vendor.signIn.issuer).toBeTruthy();
        expect(checkOutbound(vendor.signIn.issuer.replace("{tenant}", "00000000-0000-0000-0000-000000000001"), "public").protocol).toBe("https:");
        expect(new URL(vendor.signIn.docs).protocol).toBe("https:");
      }
    }
    for (const service of CATALOG) {
      const vendor = CATALOG_VENDORS.find(v => v.id === service.vendor)!;
      expect(vendor).toBeDefined();
      expect(service.reviewBy >= new Date().toISOString().slice(0, 10), service.id).toBe(true);
      for (const url of [service.icon, service.docs, ...service.servers.flatMap(s => [s.url, ...(s.resource ? [s.resource] : [])])]) expect(checkOutbound(url, "public").protocol).toBe("https:");
      for (const server of service.servers) if (server.resource) expect(new URL(server.resource).origin).toBe(new URL(server.url).origin);
      const plugin = pluginFromCatalog(service, vendor);
      expect(plugin).toMatchObject({ id: service.id, vendor: vendor.id, enabled: true, source: { type: "catalog" } });
      expect(plugin.servers).toHaveLength(service.servers.length);
      expect(plugin.servers.every(s => s.credential === "user-oauth")).toBe(true);
    }
    for (const id of ["shopify", "figma", "docusign", "outlook", "onedrive", "sharepoint", "teams"]) expect(CATALOG.find(s => s.id === id)?.notYet).toBeTruthy();
    for (const id of ["monday", "qonto", "shopify"]) expect(CATALOG.find(s => s.id === id)?.servers[0]).not.toHaveProperty("scopes");
  });
  it("uses the GitHub resource from the exact metadata URL advertised by its challenge", async () => {
    const service = CATALOG.find(s => s.id === "github")!;
    const vendor = CATALOG_VENDORS.find(v => v.id === service.vendor)!;
    const server = pluginFromCatalog(service, vendor).servers[0];
    const metadata = "https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/";
    const seen: string[] = [];
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input); seen.push(url);
      if (url === server.url) return new Response(null, { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${metadata}"` } });
      if (url === metadata) return Response.json({ resource: "https://api.githubcopilot.com/mcp/", authorization_servers: ["https://github.com/login/oauth"] });
      return Response.json({ issuer: "https://github.com/login/oauth", authorization_endpoint: "https://github.com/login/oauth/authorize", token_endpoint: "https://github.com/login/oauth/access_token", code_challenge_methods_supported: ["S256"], response_types_supported: ["code"] });
    };
    const discovery = await discoverOAuth(server.url, fetcher, "public", "https://github.com/login/oauth", server.oauth?.resourceUrl);
    expect(discovery.resource).toBe("https://api.githubcopilot.com/mcp/");
    expect(seen).toContain(metadata);
  });
  it("installs available services through the same save, assigns groups, refuses duplicates and holds", async () => {
    const h = await makeService(); const a = await asAdmin(h);
    for (const service of CATALOG) {
      const result = await call(h, "POST", `${API}/admin/plugins`, { creds: a.creds, body: { catalog: service.id, groups: ["everyone"] } });
      if (service.notYet) expect(result.body.error, service.id).toBe("catalog_not_available");
      else expect(result.body, service.id).toMatchObject({ id: service.id, source: { type: "catalog" } });
    }
    expect((await call(h, "POST", `${API}/admin/plugins`, { creds: a.creds, body: { catalog: "linear", groups: ["everyone"] } })).body.error).toBe("already_installed");
    expect((await call(h, "POST", `${API}/admin/plugins`, { creds: a.creds, body: { catalog: "missing", groups: [] } })).body.error).toBe("catalog_unknown");
    const mine = (await call(h, "GET", `${API}/plugins`, { creds: a.creds })).body.plugins;
    expect(mine.find((p: { id: string }) => p.id === "linear").status).toBe("connect");
    expect(mine.find((p: { id: string }) => p.id === "gmail").status).toBe("needs_setup");
    expect((await call(h, "GET", `${API}/admin/plugins/search`, { creds: a.creds })).status).toBe(404);
  });
  it("preserves shared setup when removing a catalog plugin and prevents recipe editing", async () => {
    using stub = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = String(input);
      if (url.includes("oauth-protected-resource")) return Response.json({ resource: "https://gmailmcp.googleapis.com/mcp/v1", authorization_servers: ["https://accounts.google.com/"] });
      if (url.includes("oauth-authorization-server")) return Response.json({ issuer: "https://accounts.google.com", authorization_endpoint: "https://accounts.google.com/authorize", token_endpoint: "https://accounts.google.com/token", response_types_supported: ["code"] });
      return new Response(null, { status: 401 });
    });
    const h = await makeService(); const a = await asAdmin(h);
    for (const catalog of ["gmail", "google-calendar"]) await call(h, "POST", `${API}/admin/plugins`, { creds: a.creds, body: { catalog, groups: ["everyone"] } });
    expect((await call(h, "PUT", `${API}/admin/vendors/google`, { creds: a.creds, body: { clientId: "own-client", clientSecret: "private-secret", tokenEndpointAuthMethod: "client_secret_post" } })).status).toBe(200);
    expect(stub).toHaveBeenCalled();
    expect((await call(h, "PATCH", `${API}/admin/plugins/gmail`, { creds: a.creds, body: { plugin: { name: "Changed", description: "", source: { type: "custom" }, servers: [{ name: "gmail", credential: "none", url: "https://other.test" }], skills: [], omitted: [] } } })).body.error).toBe("not_editable");
    await call(h, "DELETE", `${API}/admin/plugins/gmail`, { creds: a.creds });
    const installed = (await call(h, "GET", `${API}/admin/plugins`, { creds: a.creds })).body.plugins;
    expect(installed).toMatchObject([{ id: "google-calendar", vendorConfigured: true }]);
  });
});
