import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render, stubGlobal } from "../../../test/render";
import { DesktopServerForm } from "./DesktopServerForm";

import "~/index.css";

it("reviews an OS connection destination before invoking the desktop connection IPC", async () => {
  const connect = vi.fn().mockRejectedValue(new Error("The connection link expired."));
  using _bridge = stubGlobal("desktopBridge", { connectBaskuleServer: connect });
  await using screen = await render(
    <DesktopServerForm initialAddress="baskule://connect?server=https%3A%2F%2Finstallation.example&code=once" />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Review connection" }));
  await expect
    .element(screen.getByText("https://installation.example", { exact: true }))
    .toBeVisible();
  expect(connect).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Confirm connection" }));
  await expect.element(screen.getByRole("alert")).toHaveTextContent("The connection link expired.");
  expect(connect).toHaveBeenCalledExactlyOnceWith("https://installation.example/link#code=once");
  await userEvent.click(screen.getByRole("button", { name: "Use another connection" }));
  await expect.element(screen.getByRole("textbox")).toBeVisible();
});

it("receives a connection inside the desktop form without submitting its parent form", async () => {
  const connect = vi.fn().mockRejectedValue(new Error("Server unavailable"));
  using _bridge = stubGlobal("desktopBridge", { connectBaskuleServer: connect });
  await using screen = await render(
    <DesktopServerForm initialAddress="https://original.example" />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Scan or import a connection" }));
  const dialog = page.getByRole("dialog", { name: "Connect this device" });
  await userEvent.fill(dialog.getByRole("textbox"), "https://received.example/link#code=once");
  await userEvent.click(dialog.getByRole("button", { name: "Review connection" }));
  await expect.element(dialog.getByText("https://received.example", { exact: true })).toBeVisible();
  expect(connect).not.toHaveBeenCalled();
  await userEvent.click(dialog.getByRole("button", { name: "Confirm connection" }));
  await expect.element(dialog.getByRole("alert")).toHaveTextContent("Server unavailable");
  expect(connect).toHaveBeenCalledExactlyOnceWith("https://received.example/link#code=once");
  await userEvent.click(dialog.getByRole("button", { name: "Close", exact: true }));
  await expect.element(screen.getByRole("textbox")).toHaveValue("https://original.example");
});
