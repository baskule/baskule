import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { baskuleApi } from "../api";
import { ConnectLinkView } from "./ConnectLinkView";

it("requires confirmation before replacing a browser account and clears the fragment", async () => {
  using redeem = vi
    .spyOn(baskuleApi, "redeemConnectCode")
    .mockRejectedValue(new Error("Expired code"));
  const previous = window.location.href;
  window.history.replaceState(null, "", "/link#code=one-time&destination=%2Fsettings%2Fplugins");
  try {
    await using screen = await render(
      <ConnectLinkView code="one-time" destination="/settings/plugins" />,
    );
    await expect.element(screen.getByText(/replaces any account/)).toBeVisible();
    await expect.element(screen.getByText(/independently/)).toBeVisible();
    expect(window.location.hash).toBe("");
    expect(redeem).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Confirm connection" }).click();
    expect(redeem).toHaveBeenCalledWith("one-time");
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Expired code");
  } finally {
    window.history.replaceState(null, "", previous);
  }
});
