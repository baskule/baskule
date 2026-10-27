// baskule: the identity the Baskule front (the celld Worker) forwards with every request to a
// space (ground rules, "Worker → SpaceCell"). The Worker strips any inbound copy and has already
// checked Origin, session and membership, so the cell trusts the header as is.
import * as Schema from "effect/Schema";

export const BASKULE_IDENTITY_HEADER = "x-baskule-identity";
export const BASKULE_BASE_HEADER = "x-baskule-base";

export const BaskuleIdentity = Schema.Struct({
  userId: Schema.NonEmptyString,
  name: Schema.String,
  email: Schema.String,
  role: Schema.Literals(["admin", "member"]),
  sessionId: Schema.NonEmptyString,
  spaceRole: Schema.Literals(["owner", "member"]),
});
export type BaskuleIdentity = typeof BaskuleIdentity.Type;

const decodeIdentity = Schema.decodeUnknownOption(Schema.fromJsonString(BaskuleIdentity));

const base64UrlToUtf8 = (value: string): string | undefined => {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) return undefined;
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (c) => c.charCodeAt(0)),
    );
  } catch {
    return undefined;
  }
};

/** Decodes the header value; anything malformed is no identity at all. */
export const parseBaskuleIdentity = (
  header: string | undefined | null,
): BaskuleIdentity | undefined => {
  if (!header || header.length > 4096) return undefined;
  const json = base64UrlToUtf8(header.trim());
  if (json === undefined) return undefined;
  const decoded = decodeIdentity(json);
  return decoded._tag === "Some" ? decoded.value : undefined;
};

export const encodeBaskuleIdentity = (identity: BaskuleIdentity): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(identity));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

/** The space's base path from `x-baskule-base` (`/s/<spaceId>`), for URLs the server builds. */
export const parseBaskuleBase = (header: string | undefined | null): string => {
  const value = header?.trim() ?? "";
  return /^\/s\/[A-Za-z0-9_-]{1,128}$/.test(value) ? value : "";
};
