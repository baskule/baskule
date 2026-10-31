import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, expect, signIn, startChat, assistant, phoneOptions } from "./fixtures.mjs";

import { fakeOAuth } from "../../platform/test/fixtures/oauth.mjs";

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
  let team;
  try {
    await adminContext.addCookies(api.admin.cookie.split("; ").map(cookie => {
      const [name, ...value] = cookie.split("=");
      return { name, value: value.join("="), url: stack.urls.front };
    }));
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
    team = await api.teamSpace(api.admin, `Shared skills ${name}`, [people.alice, people.bob]);
    const skillDirectory = `/sandbox/space/plugins/${plugin.id}/hello`;
    const client = await people.bob.rpc(team);
    try {
      const projectId = (await client.ok("projects.ensureScratch", {})).projectId;
      const id = await api.launch(client, projectId, `Check shared files [[fake:tool shell ${JSON.stringify({ command: `test -f ${skillDirectory}/SKILL.md && echo TEAM_SKILL_PRESENT` })}]]`, "Shared skills", { generateTitle: false });
      const state = api.watchThread(client, id);
      await api.waitRun(state);
      expect(state.assistantText()).toContain("TEAM_SKILL_PRESENT");
      state.stop();
    } finally { client.close(); await client.closed; }
    expect(await filesOnComputer(stack, team)).toContain(`${plugin.id}/hello/SKILL.md`);
    await api.admin.json("POST", `/api/baskule/admin/users/${people.alice.me.user.id}/deactivate`, {});
    await expect.poll(() => filesOnComputer(stack, team), { message: "the deactivated contributor's skills leave the managed tree", timeout: 90_000 }).not.toContain(`${plugin.id}/hello/`);
  } finally {
    if (plugin) await api.admin.json("DELETE", `/api/baskule/admin/plugins/${plugin.id}`);
    if (group) await api.admin.json("DELETE", `/api/baskule/admin/groups/${group.id}`);
    if (team) await api.admin.json("POST", `/api/baskule/admin/spaces/${team}/stop`, {});
    await adminContext.close();
    await memberContext.close();
  }
});

test("a connected member supplies discovery while calls keep the turn author's account", { tag: ["@feature:plugins"] }, async ({ browser, stack, people, api }) => {
  const oauth = await fakeOAuth();
  const options = test.info().project.name === "phone" ? phoneOptions : { viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true };
  const firstContext = await browser.newContext(options);
  const secondContext = await browser.newContext(options);
  const firstPage = await firstContext.newPage();
  const secondPage = await secondContext.newPage();
  const name = `Discovery ${crypto.randomUUID().slice(0, 8)}`;
  let plugin;
  let team;
  try {
    plugin = await api.admin.json("POST", "/api/baskule/admin/plugins", { name, groups: ["everyone"], source: { type: "url", url: oauth.resource } });
    await api.admin.json("PATCH", `/api/baskule/admin/plugins/${plugin.id}`, { servers: [{ name: "remote", credential: "user-oauth", personal: true }] });
    team = await api.teamSpace(api.admin, name, [people.alice, people.bob]);
    await api.admin.json("PATCH", `/api/baskule/spaces/${team}/members/${people.alice.me.user.id}`, { role: "owner" });
    await api.admin.json("DELETE", `/api/baskule/spaces/${team}/members/${api.admin.me.user.id}`);
    await people.alice.json("PUT", `/api/baskule/spaces/${team}/plugins`, { personalPluginsAllowed: true, disabled: [] });
    const members = [people.alice, people.bob].sort((a, b) => a.me.user.id < b.me.user.id ? -1 : a.me.user.id > b.me.user.id ? 1 : 0);
    await signIn(firstPage, members[0], stack);
    const client = await members[0].rpc(team);
    try {
      const shell = api.watchShell(client);
      await expect.poll(() => shell.ready, { message: "team runtime is booted before connecting" }).toBe(true);
    } finally { client.close(); await client.closed; }

    await signIn(secondPage, members[1], stack);
    await secondPage.goto(`${stack.urls.front}/settings/plugins`);
    await secondPage.getByRole("button", { name: `Connect your ${name} account`, exact: true }).click();
    await expect(secondPage).toHaveURL(url => url.pathname === "/settings/plugins" && !url.searchParams.has("pluginConnection"));
    await expect(secondPage.getByText("Ready", { exact: true })).toBeVisible();
    await secondPage.screenshot({ path: test.info().outputPath("plugin-connected-discovery.png") });

    const reply = async (person, text) => {
      const client = await person.rpc(team);
      try {
        const projectId = (await client.ok("projects.ensureScratch", {})).projectId;
        const id = await api.launch(client, projectId, text, "Plugin account", { generateTitle: false });
        const state = api.watchThread(client, id);
        await api.waitRun(state);
        const answer = state.assistantText();
        state.stop();
        return answer;
      } finally { client.close(); await client.closed; }
    };
    expect(await reply(members[0], "Use the shared tool [[fake:tool *fixture_lookup {}]]")).toContain(`Connect your ${name} account`);
    expect(oauth.calls).toHaveLength(0);
    expect(await reply(members[1], "Use my connected tool [[fake:tool *fixture_lookup {}]]")).toContain("private fixture document");
    expect(oauth.calls).toHaveLength(1);
  } finally {
    if (plugin) await api.admin.json("DELETE", `/api/baskule/admin/plugins/${plugin.id}`);
    if (team) await api.admin.json("POST", `/api/baskule/admin/spaces/${team}/stop`, {});
    await firstContext.close();
    await secondContext.close();
    await oauth.close();
  }
});
