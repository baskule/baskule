// node:url with the two helpers celld leaves unimplemented ("node:url.pathToFileURL is not implemented in celld").
// The OpenCode SDK imports them by name (`import { pathToFileURL } from "node:url"`), which a runtime patch of the
// module object cannot reach, so scripts/build.mjs resolves every `url`/`node:url` import of the bundle to this file
// (POSIX paths only: the cell never sees Windows paths).
export * from "node:url";
import * as real from "node:url";

export function pathToFileURL(p) {
  const abs = String(p).startsWith("/") ? String(p) : `/${p}`;
  return new URL("file://" + abs.split("/").map(encodeURIComponent).join("/"));
}

export function fileURLToPath(u) {
  const url = typeof u === "string" ? new URL(u) : u;
  if (url.protocol !== "file:") throw new TypeError("The URL must be of scheme file");
  return decodeURIComponent(url.pathname);
}

export default { ...(real.default ?? real), pathToFileURL, fileURLToPath };
