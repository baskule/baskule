// Interface contracts between the Worker, ControlCell and SpaceCell.
// Coordinate wire changes across the Worker, ControlCell and SpaceCell.

/** Headers set by the Worker on requests forwarded to a SpaceCell. Any inbound `x-baskule-*` is stripped first. */
export const IDENTITY_HEADER = "x-baskule-identity";
export const BASE_HEADER = "x-baskule-base";
/** Set on webhook requests forwarded to a SpaceCell (no user identity). Value: "1". */
export const WEBHOOK_HEADER = "x-baskule-webhook";
export const BASKULE_HEADER_PREFIX = "x-baskule-";

/** DO names. */
export const CONTROL_CELL_NAME = "control";
/** Public discovery document of an installation (`{ product: "baskule", name }`), served by ControlCell. */
export const WELL_KNOWN_PATH = "/.well-known/baskule";

/** ControlCell → SpaceCell control routes (never reachable from clients: the Worker 404s /s/<id>/_baskule/*). */
export const SPACE_CONTROL = {
  revoke: "/_baskule/revoke", // POST {userId?, sessionId?}
  delete: "/_baskule/delete", // POST
  status: "/_baskule/status", // GET → SpaceStatus
  stop: "/_baskule/stop", // POST: interrupt runs, stop the computer, let the cell go idle
} as const;

/** SpaceCell → ControlCell, 60 s socket recheck (see platform/README.md, "Revocation"). */
export const CONTROL_CHECK_PATH = "/_baskule/check"; // POST CheckRequest → CheckResponse

export type UserRole = "admin" | "member";
export type SpaceRole = "owner" | "member";

export interface Identity {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  sessionId: string;
  spaceRole: SpaceRole;
}

export interface RevokeRequest {
  userId?: string;
  sessionId?: string;
}

export interface SpaceStatus {
  awake: boolean;
  sockets: number;
  activeRuns: number;
  computer: unknown;
}

/** Recheck: the SpaceCell sends the (userId, sessionId) pairs of its open sockets for one space. */
export interface CheckRequest {
  spaceId: string;
  sessions: { userId: string; sessionId: string }[];
}
/** `valid` lists the sessionIds that still hold a live session AND membership; close every other socket. */
export interface CheckResponse {
  valid: string[];
}

export function spaceBase(spaceId: string): string {
  return `/s/${spaceId}`;
}

/** Internal marker on Worker → ControlCell and SpaceCell → ControlCell calls (stripped from client requests). */
export const INTERNAL_HEADER = "x-baskule-internal";
/** Client address for Better Auth's rate limiter, set by the Worker (stripped from client requests). */
export const CLIENT_IP_HEADER = "x-baskule-client-ip";
