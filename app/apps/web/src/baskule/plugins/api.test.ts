// baskule: the plugin client's plain-language errors.
import { describe, expect, it } from "vite-plus/test";

import { BaskuleApiError } from "../api";
import { accountConnectionUrl, pluginErrorText } from "./api";
import { sourceLabel } from "./presentation";

describe("plugin wording", () => {
  it("explains backend refusals in plain words and uses the fallback for unknown codes", () => {
    expect(
      pluginErrorText(new BaskuleApiError(400, "placeholder", "address_placeholder"), "x"),
    ).toBe("Fill in every part of the address in braces first.");
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

  it("names a GitHub source by repository and folder, without its pinned commit", () => {
    expect(
      sourceLabel({
        type: "github",
        repo: "https://github.com/acme/plugins.git",
        sha: "0123456789abcdef0123456789abcdef01234567",
        path: "sales",
      }),
    ).toBe("From acme/plugins/sales on GitHub");
  });
});
