import { createHash } from "node:crypto";

/** Space IDs accepted by the API. */
export const SPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * OpenShell sandbox names are DNS-1123 labels of at most 19 characters. `os-<spaceId>` when it fits,
 * otherwise `os-` + 16 hex chars of sha256(spaceId). Scoped names hash the encoded instance/space pair
 * to avoid ambiguous separators and fit both name limits. The per-space volume uses the same suffix.
 */
export function namesFor(spaceId: string, instance = ""): { sandbox: string; volume: string } {
  let suffix = spaceId;
  if (instance || !/^[a-z0-9]([a-z0-9-]{0,14}[a-z0-9])?$/.test(spaceId)) {
    suffix = createHash("sha256").update(instance ? JSON.stringify([instance, spaceId]) : spaceId).digest("hex").slice(0, 16);
  }
  return { sandbox: `os-${suffix}`, volume: `baskule-space-${suffix}` };
}
