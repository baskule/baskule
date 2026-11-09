import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.mjs";

test("browser approval connects the initiating native client", { tag: ["@feature:sign-in-sessions", "@profile:light"] }, async ({ page, stack, api }) => {
  const person = await api.person("Native", randomUUID());
  await page.context().addCookies(person.cookie.split("; ").map((part) => {
    const separator = part.indexOf("=");
    return { name: part.slice(0, separator), value: part.slice(separator + 1), url: stack.urls.front };
  }));

  const started = await fetch(`${stack.urls.loopback}/api/baskule/native-login/request`, { method: "POST" });
  expect(started.ok).toBe(true);
  const { id, secret } = await started.json();
  const poll = () => fetch(`${stack.urls.loopback}/api/baskule/native-login/poll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, secret }),
  });
  expect(await (await poll()).json()).toEqual({ token: null });

  await page.goto(`${stack.urls.front}/api/baskule/native-login?request=${id}`);
  const approval = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/baskule/native-login/approve" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Connect app", exact: true }).click();
  const approved = await approval;
  expect(approved.status()).toBe(200);
  expect(await approved.request().headerValue("origin")).toBe(new URL(stack.urls.front).origin);
  await expect(page.getByRole("heading", { name: "App connected", exact: true })).toBeVisible();

  const completed = await poll();
  expect(completed.ok).toBe(true);
  const { token } = await completed.json();
  expect(token).toEqual(expect.any(String));
  const me = await fetch(`${stack.urls.loopback}/api/baskule/me`, { headers: { authorization: `Bearer ${token}` } });
  expect(me.ok).toBe(true);
  expect((await me.json()).user.id).toBe(person.me.user.id);
  expect((await poll()).status).toBe(404);
});
