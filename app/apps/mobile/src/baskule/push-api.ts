import { fetch } from "expo/fetch";
import {
  decodePushAvailability,
  decodePushRegistration,
  type PushAvailability,
  type PushRegistration,
} from "@t3tools/contracts/baskulePush";
import { BaskuleApiError } from "./api";

export interface PushSession {
  readonly serverUrl: string;
  readonly token: string;
  readonly userId: string;
}
async function request(
  session: PushSession,
  path: string,
  method: string,
  body?: PushRegistration,
  fetchFn: typeof fetch = fetch,
) {
  const response = await fetchFn(`${session.serverUrl}/api/baskule/push/${path}`, {
    method,
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok)
    throw new BaskuleApiError(
      response.status === 401 ? "signed-out" : "server",
      `Push request failed (${response.status}).`,
    );
  return response;
}
export async function fetchPushAvailability(session: PushSession): Promise<PushAvailability> {
  const value: unknown = await (await request(session, "status", "GET")).json();
  return decodePushAvailability(value);
}
export async function putPushDevice(
  session: PushSession,
  deviceId: string,
  registration: PushRegistration,
) {
  await request(
    session,
    `devices/${encodeURIComponent(deviceId)}`,
    "PUT",
    decodePushRegistration(registration),
  );
}
export async function deletePushDevice(session: PushSession, deviceId: string) {
  await request(session, `devices/${encodeURIComponent(deviceId)}`, "DELETE");
}
