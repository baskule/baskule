import * as Base64 from "effect/encoding/Base64";

const DOCUMENT_POLICY =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline' data: blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export async function localHtmlDocument(uri: string, signal: AbortSignal): Promise<string> {
  if (!uri.startsWith("file:")) throw new Error("A local document is required.");
  signal.throwIfAborted();
  const { File } = await import("expo-file-system");
  const html = await new File(uri.split("#", 1)[0]!).text();
  signal.throwIfAborted();
  const document = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${DOCUMENT_POLICY}">${html}`;
  return `data:text/html;charset=utf-8;base64,${Base64.encode(new TextEncoder().encode(document))}`;
}
