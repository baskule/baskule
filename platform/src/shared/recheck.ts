// The 60 s socket recheck (review H5 backstop), for SpaceCell (WP-B). Push revocation (`/_baskule/revoke`) is the
// primary path; this catches what pushes cannot: session expiry, a lost revoke call, a cell that was asleep.
//
// Contract: every RECHECK_INTERVAL_MS (60 s) while the space has open client sockets, the SpaceCell sends
//   env.CONTROL.getByName("control").fetch("http://control/_baskule/check",
//     { method: "POST", headers: { "x-baskule-internal": "1", "content-type": "application/json" },
//       body: JSON.stringify({ spaceId, sessions: [{ userId, sessionId }, …] }) })
// and closes (code 4401) every socket whose sessionId is not in the answer's `valid` list. One indexed query per
// socket in ControlCell. If ControlCell cannot be reached, sockets are kept (fail-open on availability only; the
// Worker still checks every new request and upgrade).
import { CONTROL_CELL_NAME, CONTROL_CHECK_PATH, INTERNAL_HEADER, type CheckResponse } from "./contract";

export const RECHECK_INTERVAL_MS = 60_000;
export const REVOKED_CLOSE_CODE = 4401;

export interface TrackedSocket {
  userId: string;
  sessionId: string;
  close(code: number, reason: string): void;
}

export interface ControlNamespace {
  getByName(name: string): { fetch(req: Request): Promise<Response> };
}

/** Rechecks the given sockets of one space; returns how many were checked and closed. */
export async function recheckSockets(control: ControlNamespace, spaceId: string, sockets: TrackedSocket[]): Promise<{ checked: number; closed: number }> {
  if (!sockets.length) return { checked: 0, closed: 0 };
  const uniq = new Map<string, { userId: string; sessionId: string }>();
  for (const s of sockets) uniq.set(`${s.userId}\u0000${s.sessionId}`, { userId: s.userId, sessionId: s.sessionId });
  const res = await control.getByName(CONTROL_CELL_NAME).fetch(
    new Request(`http://control${CONTROL_CHECK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", [INTERNAL_HEADER]: "1" },
      body: JSON.stringify({ spaceId, sessions: [...uniq.values()] }),
    }),
  );
  if (!res.ok) throw new Error(`recheck failed: ${res.status}`);
  const valid = new Set(((await res.json()) as CheckResponse).valid);
  let closed = 0;
  for (const s of sockets)
    if (!valid.has(s.sessionId)) {
      try { s.close(REVOKED_CLOSE_CODE, "revoked"); } catch {}
      closed++;
    }
  return { checked: sockets.length, closed };
}
