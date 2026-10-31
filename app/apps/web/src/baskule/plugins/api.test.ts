// baskule: the plugin client's plain-language errors.
import { describe, expect, it } from "vite-plus/test";

import { BaskuleApiError } from "../api";
import { accountConnectionUrl, pluginErrorText } from "./api";
import { sourceLabel } from "./presentation";

describe("plugin wording", () => {
  it("explains backend refusals in plain words and uses the fallback for unknown codes", () => {
    expect(pluginErrorText(new BaskuleApiError(400, "invalid commit", "invalid_commit"), "x")).toBe(
      "Enter the full commit ID: 40 letters and digits.",
    );
    expect(pluginErrorText(new BaskuleApiError(500, "Boom", "other"), "x")).toBe("x");
  });

  it("starts a new account with its name, or reconnects an existing account by its id", () => {
    expect(
      accountConnectionUrl("gmail", "mail", "/settings/plugins", {
        type: "new",
        label: "Work & co",
      }),
    ).toBe(
      "/api/baskule/plugins/gmail/connect?server=mail&returnTo=%2Fsettings%2Fplugins&label=Work+%26+co",
    );
    expect(
      accountConnectionUrl("gmail", "mail", "/settings/plugins", {
        type: "reconnect",
        account: "a1",
      }),
    ).toBe(
      "/api/baskule/plugins/gmail/connect?server=mail&returnTo=%2Fsettings%2Fplugins&account=a1",
    );
  });

  it("names a pinned git source by repository and short commit", () => {
    expect(
      sourceLabel({
        type: "git",
        repo: "https://github.com/acme/plugins.git",
        ref: "0123456789abcdef0123456789abcdef01234567",
      }),
    ).toBe("From acme/plugins at 0123456");
  });
});
