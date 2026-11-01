import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render, type Screen } from "../../../test/render";
import { BaskuleApiError, baskuleApi } from "../api";
import { SetupView } from "./SetupView";

const fill = async (screen: Screen, fields: Record<string, string>) => {
  for (const [label, value] of Object.entries(fields)) {
    await userEvent.fill(screen.getByLabelText(label, { exact: true }), value);
  }
};

it("removes the token from the address bar and explains where a missing one comes from", async () => {
  using _status = vi
    .spyOn(baskuleApi, "setupStatus")
    .mockResolvedValue({ required: true, password: true });
  const previous = window.location.href;
  window.history.replaceState(null, "", `${window.location.pathname}#token=`);
  try {
    await using screen = await render(<SetupView token={null} />);
    expect(window.location.hash).toBe("");
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("This link has no setup token in it. Copy the whole link.");
    await expect.element(screen.getByLabelText("Command")).toHaveValue("docker compose logs setup");
  } finally {
    window.history.replaceState(null, "", previous);
  }
});

it("sends an already set-up installation to sign in", async () => {
  using _status = vi
    .spyOn(baskuleApi, "setupStatus")
    .mockResolvedValue({ required: false, password: true });
  await using screen = await render(<SetupView token="secret" />);
  await expect.element(screen.getByRole("heading", { name: "Already set up" })).toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "Sign in" }))
    .toHaveAttribute("href", "/login");
});

it("retries when the installation could not be checked", async () => {
  using _status = vi
    .spyOn(baskuleApi, "setupStatus")
    .mockRejectedValueOnce(new BaskuleApiError(0, "Can't reach the server.", "network"))
    .mockResolvedValue({ required: true, password: true });
  await using screen = await render(<SetupView token="secret" />);
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Can't reach the server.");
  await screen.getByRole("button", { name: "Try again" }).click();
  await expect.element(screen.getByLabelText("Confirm password")).toBeVisible();
});

it("creates an SSO-only administrator without a password, then sends them to sign in", async () => {
  using _status = vi
    .spyOn(baskuleApi, "setupStatus")
    .mockResolvedValue({ required: true, password: false });
  using complete = vi.spyOn(baskuleApi, "completeSetup").mockResolvedValue({});
  await using screen = await render(<SetupView token="secret" />);
  await expect.element(screen.getByLabelText("Your name")).toBeVisible();
  expect(screen.getByLabelText("Password", { exact: true }).query()).toBeNull();
  await fill(screen, { "Your name": " Ada ", Email: "ada@example.com" });
  await screen.getByRole("button", { name: "Create account" }).click();
  expect(complete).toHaveBeenCalledWith({
    token: "secret",
    name: "Ada",
    email: "ada@example.com",
  });
  await expect.element(screen.getByText(/as ada@example\.com/)).toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "Sign in" }))
    .toHaveAttribute("href", "/login?next=%2Fadmin%2Fai%2Fmodels");
});

describe("a refused password-mode setup", () => {
  it.each([
    {
      refusal: new BaskuleApiError(429, "rate limited", "rate_limited"),
      heading: "Set up Baskule",
      alert: "Too many attempts. Wait a minute and try again.",
    },
    {
      refusal: new BaskuleApiError(0, "Can't reach the server.", "network"),
      heading: "Set up Baskule",
      alert: "Can't reach the server.",
    },
    {
      refusal: new BaskuleApiError(403, "bad token", "bad_token"),
      heading: "Setup link unavailable",
      alert: "This setup link is not valid. Use the latest link from the setup logs.",
    },
    {
      refusal: new BaskuleApiError(409, "already set up", "already_set_up"),
      heading: "Already set up",
      alert: null,
    },
  ])("answered $refusal.status", async ({ refusal, heading, alert }) => {
    using _status = vi
      .spyOn(baskuleApi, "setupStatus")
      .mockResolvedValue({ required: true, password: true });
    using complete = vi.spyOn(baskuleApi, "completeSetup").mockRejectedValue(refusal);
    await using screen = await render(<SetupView token="secret" />);
    await fill(screen, {
      "Your name": "Ada",
      Email: "ada@example.com",
      Password: "correct horse",
      "Confirm password": "correct horse",
    });
    await screen.getByRole("button", { name: "Create account" }).click();
    expect(complete).toHaveBeenCalledWith({
      token: "secret",
      name: "Ada",
      email: "ada@example.com",
      password: "correct horse",
    });
    await expect.element(screen.getByRole("heading", { name: heading })).toBeVisible();
    if (alert) await expect.element(screen.getByRole("alert")).toHaveTextContent(alert);
  });
});
