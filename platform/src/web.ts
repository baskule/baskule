import type { WebEnv } from "./env";
import { withCacheControl } from "./shared/cache";
import { WELL_KNOWN_PATH } from "./shared/contract";
import { json } from "./shared/http";

export function isBackendPath(path: string): boolean {
  return path === "/auth" || path.startsWith("/auth/") || path === WELL_KNOWN_PATH ||
    path === "/api" || path.startsWith("/api/") || path === "/s" || path.startsWith("/s/") || path.startsWith("/hooks/");
}

export default {
  async fetch(req: Request, env: WebEnv): Promise<Response> {
    try {
      const path = new URL(req.url).pathname;
      // Service bindings follow redirects by default; preserve authentication redirects and cookies.
      if (isBackendPath(path)) return await env.BACKEND.fetch(req, { redirect: "manual" });
      const response = await env.ASSETS.fetch(req);
      const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      const immutable = (req.method === "GET" || req.method === "HEAD") && response.ok &&
        /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9.]+$/.test(path) &&
        contentType && contentType !== "text/html" && contentType !== "application/xhtml+xml";
      return withCacheControl(response, immutable ? "public, max-age=31536000, immutable" : "no-store");
    } catch (error) {
      console.error("web worker error", error);
      return withCacheControl(json({ error: "internal_error" }, 500), "no-store");
    }
  },
};
