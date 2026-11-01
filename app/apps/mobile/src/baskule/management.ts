import { t } from "../i18n";
import { Schema } from "effect";
import { fetch } from "expo/fetch";
import { openBrowserAsync } from "expo-web-browser";
import type { BaskuleManagementDestination } from "@t3tools/contracts/baskule";

import { readBaskuleSession, refreshBaskuleMe } from "./session";

const parseCode = Schema.decodeUnknownSync(
  Schema.Struct({ code: Schema.String, expiresAt: Schema.Number }),
);

export async function openBaskuleManagement(
  destination: BaskuleManagementDestination,
): Promise<void> {
  const captured = readBaskuleSession();
  if (captured.status !== "signed-in")
    throw new Error(t("Sign in before opening account settings."));
  let url = `${captured.serverUrl}${destination}`;
  if (captured.token) {
    const response = await fetch(`${captured.serverUrl}/auth/connect/code`, {
      method: "POST",
      headers: { authorization: `Bearer ${captured.token}`, "content-type": "application/json" },
      body: "{}",
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok) throw new Error(t("Could not sign the browser in. Try again."));
    const code = parseCode(await response.json());
    if (!code.code || code.expiresAt <= Date.now())
      throw new Error(t("The connection link expired. Try again."));
    url = `${captured.serverUrl}/link#${new URLSearchParams({ code: code.code, destination })}`;
  }
  const current = readBaskuleSession();
  if (
    current.status !== "signed-in" ||
    current.serverUrl !== captured.serverUrl ||
    current.token !== captured.token
  ) {
    throw new Error(t("Your account changed. Open settings again."));
  }
  try {
    await openBrowserAsync(url);
  } finally {
    void refreshBaskuleMe();
  }
}
