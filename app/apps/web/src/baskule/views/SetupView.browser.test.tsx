import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render, type Screen } from "../../../test/render";
import { BaskuleApiError, baskuleApi, type BaskuleMe } from "../api";
import { SetupView } from "./SetupView";

const admin = { id: "new-admin", email: "ada@example.com", name: "Ada" };

/** Puts `hash` in the test page's address, restoring the address afterwards. */
function atLink(hash: string): Disposable {
  const previous = window.location.href;
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${hash}`,
  );
  return { [Symbol.dispose]: () => window.history.replaceState(null, "", previous) };
}

/** Records the page loads the view starts and cancels them, so the test page stays. */
function captureLoads(): Disposable & { readonly paths: string[] } {
  const paths: string[] = [];
  const cancel = (event: NavigateEvent) => {
    if (event.destination.sameDocument) return;
    const url = new URL(event.destination.url);
    paths.push(`${url.pathname}${url.search}`);
    event.preventDefault();
  };
  navigation.addEventListener("navigate", cancel);
  return { paths, [Symbol.dispose]: () => navigation.removeEventListener("navigate", cancel) };
}

const meAs = (id: string): BaskuleMe => ({
  authentication: { mode: "authenticated", password: true, providers: [] },
  user: { id, name: id, email: `${id}@example.com`, role: "admin" },
  organizationName: null,
  spaces: [],
  canCreateSpaces: true,
  voiceInput: false,
});

const fill = async (screen: Screen, fields: Record<string, string>) => {
  for (const [label, value] of Object.entries(fields)) {
    await userEvent.fill(screen.getByLabelText(label, { exact: true }), value);
  }
};

const passwordForm = {
  "Your name": "Ada",
  Email: "ada@example.com",
  Password: "correct horse",
  "Confirm password": "correct horse",
};

it("removes the token from the address bar and explains where a missing one comes from", async () => {
  using _status = vi
    .spyOn(baskuleApi, "setupStatus")
    .mockResolvedValue({ required: true, password: true });
  using _link = atLink("#token=");
  await using screen = await render(<SetupView />);
  expect(window.location.hash).toBe("");
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("This link has no setup token in it. Copy the whole link.");
  await expect.element(screen.getByLabelText("Command")).toHaveValue("docker compose logs setup");
});

it("starts over with a token pasted into the address bar of an open setup page", async () => {
  using _status = vi
    .spyOn(baskuleApi, "setupStatus")
    .mockResolvedValue({ required: true, password: false });
  using complete = vi.spyOn(baskuleApi, "completeSetup").mockResolvedValue(admin);
  using _link = atLink("");
  await using screen = await render(<SetupView />);
  await expect
    .element(screen.getByRole("heading", { name: "Setup link unavailable" }))
    .toBeVisible();
  window.location.hash = "token=pasted";
  await expect.element(screen.getByLabelText("Your name")).toBeVisible();
  expect(window.location.hash).toBe("");
  await fill(screen, { "Your name": "Ada", Email: "ada@example.com" });
  await screen.getByRole("button", { name: "Create account" }).click();
  expect(complete).toHaveBeenCalledWith({ token: "pasted", name: "Ada", email: "ada@example.com" });
});

it("sends an already set-up installation to sign in", async () => {
  using _status = vi
    .spyOn(baskuleApi, "setupStatus")
    .mockResolvedValue({ required: false, password: true });
  using _link = atLink("#token=secret");
  await using screen = await render(<SetupView />);
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
  using _link = atLink("#token=secret");
  await using screen = await render(<SetupView />);
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Can't reach the server.");
  await screen.getByRole("button", { name: "Try again" }).click();
  await expect.element(screen.getByLabelText("Confirm password")).toBeVisible();
});

it("creates an SSO-only administrator without a password, then sends them to sign in", async () => {
  using _status = vi
    .spyOn(baskuleApi, "setupStatus")
    .mockResolvedValue({ required: true, password: false });
  using complete = vi.spyOn(baskuleApi, "completeSetup").mockResolvedValue(admin);
  using _link = atLink("#token=secret");
  await using screen = await render(<SetupView />);
  await expect.element(screen.getByLabelText("Your name")).toBeVisible();
  await expect.element(screen.getByLabelText("Your name")).toHaveAttribute("maxlength", "100");
  await expect.element(screen.getByLabelText("Email", { exact: true })).toHaveAttribute("maxlength", "254");
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

describe("a created password-mode administrator", () => {
  it.each([
    { session: admin.id, signsIn: false },
    // Another tab replaced the session between the setup answer and the check.
    { session: "someone-else", signsIn: true },
  ])("with the session of $session opens AI → Models", async ({ session, signsIn }) => {
    using _status = vi
      .spyOn(baskuleApi, "setupStatus")
      .mockResolvedValue({ required: true, password: true });
    using complete = vi.spyOn(baskuleApi, "completeSetup").mockResolvedValue(admin);
    using _me = vi.spyOn(baskuleApi, "me").mockResolvedValue(meAs(session));
    using signIn = vi.spyOn(baskuleApi, "signIn").mockResolvedValue({});
    using _link = atLink("#token=secret");
    await using screen = await render(<SetupView />);
    using loads = captureLoads();
    await fill(screen, passwordForm);
    await screen.getByRole("button", { name: "Create account" }).click();
    await vi.waitFor(() => expect(loads.paths).toEqual(["/admin/ai/models"]));
    expect(complete).toHaveBeenCalledWith({
      token: "secret",
      name: "Ada",
      email: "ada@example.com",
      password: "correct horse",
    });
    if (signsIn) {
      expect(signIn).toHaveBeenCalledWith({ email: "ada@example.com", password: "correct horse" });
    } else expect(signIn).not.toHaveBeenCalled();
  });
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
      refusal: new BaskuleApiError(403, "bad origin", "bad_origin"),
      heading: "Set up Baskule",
      alert: "Setup was blocked by the origin check. Configure BASKULE_TRUSTED_PROXIES or PUBLIC_ORIGINS. Reverse proxy configuration",
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
    using _link = atLink("#token=secret");
    await using screen = await render(<SetupView />);
    await fill(screen, passwordForm);
    await screen.getByRole("button", { name: "Create account" }).click();
    expect(complete).toHaveBeenCalledWith({
      token: "secret",
      name: "Ada",
      email: "ada@example.com",
      password: "correct horse",
    });
    await expect.element(screen.getByRole("heading", { name: heading })).toBeVisible();
    if (alert) await expect.element(screen.getByRole("alert")).toHaveTextContent(alert);
    if (refusal.code === "bad_origin") {
      await expect.element(screen.getByRole("link", { name: "Reverse proxy configuration" })).toHaveAttribute(
        "href",
        "https://github.com/baskule/baskule/blob/main/docs/install.md#your-own-reverse-proxy",
      );
    }
  });
});
