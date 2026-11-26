import { decodeHTMLStrict } from "entities";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";

/** A link destination as written, with its character references and escapes resolved. */
export function decodeMarkdownLinkEscapes(href: string): string {
  const decoded = href.includes("&") ? decodeHTMLStrict(href) : href;
  return isWindowsAbsolutePath(decoded) ? decoded : decoded.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}
