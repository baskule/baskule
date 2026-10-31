import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, expect, signIn, startChat, assistant, phoneOptions } from "./fixtures.mjs";

const portable = fileURLToPath(new URL("../../platform/test/fixtures/plugins/portable/", import.meta.url));
function skillsArchive() {
  return execFileSync("python3", ["-c", "import io,pathlib,sys,zipfile; root=pathlib.Path(sys.argv[1]); b=io.BytesIO(); z=zipfile.ZipFile(b,'w'); [z.write(p,p.relative_to(root)) for p in root.rglob('*') if p.is_file() and (p.relative_to(root).parts[0]=='skills' or p.name=='LICENSE')]; z.close(); sys.stdout.buffer.write(b.getvalue())", portable]);
}
async function filesOnComputer(stack, spaceId) {
  const response = await fetch(`http://127.0.0.1:${stack.ports.computerd}/v1/spaces/${spaceId}/exec`, {
    method: "POST", headers: { authorization: `Bearer ${stack.computerdToken}`, "content-type": "application/json" },
    body: JSON.stringify({ argv: ["find", "/sandbox/space/plugins", "-type", "f"] }),
  });
  expect(response.ok).toBe(true);
  let output = "";
  let code;
  for (const line of (await response.text()).split("\n").filter(Boolean)) {
    const frame = JSON.parse(line);
    if (frame.t === "o" || frame.t === "e") output += Buffer.from(frame.d, "base64").toString();
    if (frame.t === "x") code = frame.code;
  }
  expect(code).toBe(0);
  return output;
}

test("assigned skills are ready without activation and leave a team when its contributor is deactivated", { tag: ["@feature:plugins"] }, async ({ browser, stack, people, api, fakeLlm }) => {
  const options = test.info().project.name === "phone" ? phoneOptions : { viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true };
  const adminContext = await browser.newContext(options);
  const memberContext = await browser.newContext(options);
  const adminPage = await adminContext.newPage();
  const memberPage = await memberContext.newPage();
  const name = `Portable skills ${crypto.randomUUID()}`;
  let plugin;
  let group;
  try {
    await signIn(adminPage, api.admin, stack);
    await adminPage.goto(`${stack.urls.front}/admin/plugins/catalog`);
    await adminPage.getByRole("button", { name: "Add your own", exact: true }).click();
    await adminPage.getByRole("button", { name: "File", exact: true }).click();
    await adminPage.getByLabel("Plugin file", { exact: true }).setInputFiles({ name: "portable-skills.zip", mimeType: "application/zip", buffer: skillsArchive() });
    await adminPage.getByLabel("Name (optional)", { exact: true }).fill(name);
    await expect(adminPage.getByRole("checkbox", { name: /Everyone/ })).toBeChecked();
    await adminPage.getByRole("button", { name: "Add plugin", exact: true }).click();
    await expect(adminPage.getByRole("heading", { name: `${name} was added`, exact: true })).toBeVisible();
    plugin = (await api.admin.json("GET", "/api/baskule/admin/plugins")).plugins.find(p => p.name === name);
    expect(plugin.enabled).toBe(true);
    await adminPage.screenshot({ path: test.info().outputPath("plugin-upload-assigned.png") });
    await signIn(memberPage, people.alice, stack);
    await memberPage.goto(`${stack.urls.front}/settings/plugins`);
    await expect(memberPage.getByText(name, { exact: true })).toBeVisible();
    await expect(memberPage.getByText("Ready", { exact: true })).toBeVisible();
    await expect(memberPage.getByRole("switch", { name: /^Use / })).toHaveCount(0);
    await memberPage.screenshot({ path: test.info().outputPath("plugin-ready.png") });
    await memberPage.goto(stack.urls.front);
    await startChat(memberPage, `Use the assigned skill [[fake:tool skill {"id":"${plugin.id}/hello"}]]`);
    await expect(assistant(memberPage)).toContainText("Say hello.", { timeout: 90_000 });
    await expect.poll(async () => (await fakeLlm.requests()).some(r => r.messages.some(m => m.role === "tool" && typeof m.content === "string" && m.content.includes("Say hello."))), { message: "the model receives the assigned skill instructions" }).toBe(true);

    const everyone = await api.admin.json("GET", "/api/baskule/admin/groups/everyone");
    await api.admin.json("PATCH", "/api/baskule/admin/groups/everyone", { plugins: everyone.plugins.filter(id => id !== plugin.id) });
    group = await api.admin.json("POST", "/api/baskule/admin/groups", { name, members: [people.alice.me.user.id], permissions: { canCreateSpaces: false }, plugins: [plugin.id] });
    await signIn(memberPage, people.bob, stack);
    await startChat(memberPage, "Check shared files [[fake:tool shell {\"command\":\"find /sandbox/space/plugins -type f\"}]]", people.teamName);
    await expect(assistant(memberPage)).toContainText(`${plugin.id}/hello/SKILL.md`, { timeout: 90_000 });
    expect(await filesOnComputer(stack, people.team)).toContain(`${plugin.id}/hello/SKILL.md`);
    await api.admin.json("POST", `/api/baskule/admin/users/${people.alice.me.user.id}/deactivate`, {});
    await startChat(memberPage, "Check removed skills [[fake:tool shell {\"command\":\"find /sandbox/space/plugins -type f\"}]]", people.teamName);
    await expect(assistant(memberPage)).toContainText("shell=", { timeout: 90_000 });
    await expect.poll(() => filesOnComputer(stack, people.team), { message: "the deactivated contributor's skills leave the managed tree", timeout: 90_000 }).not.toContain(`${plugin.id}/hello/`);
  } finally {
    if (plugin) await api.admin.json("DELETE", `/api/baskule/admin/plugins/${plugin.id}`);
    if (group) await api.admin.json("DELETE", `/api/baskule/admin/groups/${group.id}`);
    await adminContext.close();
    await memberContext.close();
  }
});
