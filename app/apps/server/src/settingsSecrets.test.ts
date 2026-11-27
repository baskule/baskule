import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  mapSettingsSecrets,
  SECRET_REDACTED,
  withoutRedirectedSecrets,
} from "./settingsSecrets.ts";

describe("released forge credential compatibility", () => {
  it("redacts saved credentials using the existing secret-store keys after adapters are removed", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      sourceControlHosts: {
        github: { tokens: { "GitHub.Example": "fake-gh-token" }, accounts: "saved-account" },
        bitbucket: { accessToken: "fake-access-token", apiToken: "fake-api-token" },
        gitcafe: { token: "fake-gitcafe-token" },
      },
    };
    const credentials = new Map<string, string>();
    const redacted = mapSettingsSecrets(settings, (secret) => {
      if (secret.secretName.startsWith("source-control-")) {
        credentials.set(secret.secretName, secret.value);
      }
      return { value: secret.value, redacted: true };
    });
    expect(Object.fromEntries(credentials)).toEqual({
      "source-control-Z2l0aHVi-dG9rZW5z-Z2l0aHViLmV4YW1wbGU": "fake-gh-token",
      "source-control-Yml0YnVja2V0-YWNjZXNzVG9rZW4": "fake-access-token",
      "source-control-Yml0YnVja2V0-YXBpVG9rZW4": "fake-api-token",
      "source-control-Z2l0Y2FmZQ-dG9rZW4": "fake-gitcafe-token",
    });
    expect(redacted.sourceControlHosts).toEqual({
      github: { tokens: { "github.example": SECRET_REDACTED }, accounts: "saved-account" },
      bitbucket: { accessToken: SECRET_REDACTED, apiToken: SECRET_REDACTED },
      gitcafe: { token: SECRET_REDACTED },
    });
    expect(settings.sourceControlHosts.github.tokens["GitHub.Example"]).toBe("fake-gh-token");
  });
});

it("keeps a saved OpenCode password at its configured destination", () => {
  const id = ProviderInstanceId.make("opencode-remote");
  const settings = (serverUrl: string, serverPassword: string): ServerSettings => ({
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [id]: {
        driver: ProviderDriverKind.make("opencode"),
        config: { serverUrl, serverPassword },
      },
    },
  });
  const current = settings("https://agent.example/session/", "saved-password");
  const read = (serverUrl: string, password: string) =>
    withoutRedirectedSecrets(current, settings(serverUrl, password)).providerInstances[id]?.config;

  expect(read("https://agent.example/session", SECRET_REDACTED)).toMatchObject({
    serverPassword: SECRET_REDACTED,
  });
  expect(read("https://agent.example/different", SECRET_REDACTED)).toMatchObject({
    serverPassword: "",
  });
  expect(read("https://agent.example/different", "replacement")).toMatchObject({
    serverPassword: "replacement",
  });
});
