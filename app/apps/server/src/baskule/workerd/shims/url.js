// celld's node:url lacks pathToFileURL / fileURLToPath.
export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;
export const pathToFileURL = (p) =>
  new globalThis.URL("file://" + String(p).split("/").map(encodeURIComponent).join("/"));
export const fileURLToPath = (u) => decodeURIComponent(new globalThis.URL(String(u)).pathname);
export const format = (u) => String(u);
export const parse = (s) => new globalThis.URL(s, "http://localhost");
export const domainToASCII = (d) => d;
export default { URL, URLSearchParams, pathToFileURL, fileURLToPath, format, parse, domainToASCII };
