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
    await adminPage.getByRole("link", { name: "Add your own", exact: true }).click();
    await adminPage.getByLabel("Plugin file", { exact: true }).setInputFiles({ name: "portable-skills.zip", mimeType: "application/zip", buffer: skillsArchive() });
    await adminPage.getByRole("button", { name: "Review plugin", exact: true }).click();
    await adminPage.getByLabel("Name", { exact: true }).fill(name);
    await expect(adminPage.getByRole("checkbox", { name: /Everyone/ })).toBeChecked();
    await adminPage.getByRole("button", { name: "Save plugin", exact: true }).click();
    await expect(adminPage.getByRole("heading", { name, exact: true })).toBeVisible();
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
  oauth.state.dcr = false;
  const options = test.info().project.name === "phone" ? phoneOptions : { viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true };
  const adminContext = await browser.newContext(options);
  const adminPage = await adminContext.newPage();
  const secondContext = await browser.newContext(options);
  const secondPage = await secondContext.newPage();
  const name = `Discovery ${crypto.randomUUID().slice(0, 8)}`;
  let plugin;
  let team;
  try {
    plugin = await api.admin.json("POST", "/api/baskule/admin/plugins", { groups: ["everyone"], plugin: { name, description: "", source: { type: "custom" }, skills: [], omitted: [], servers: [{ name: "remote", url: oauth.resource, credential: "none" }] } });
    await api.admin.json("PATCH", `/api/baskule/admin/plugins/${plugin.id}`, { plugin: { name, description: "", source: { type: "custom" }, skills: [], omitted: [], servers: [{ name: "remote", url: oauth.resource, credential: "user-oauth", oauth: { staticClient: true } }] } });
    team = await api.teamSpace(api.admin, name, [people.alice, people.bob]);
    await api.admin.json("PATCH", `/api/baskule/spaces/${team}/members/${people.alice.me.user.id}`, { role: "owner" });
    await api.admin.json("DELETE", `/api/baskule/spaces/${team}/members/${api.admin.me.user.id}`);
    await people.alice.json("PUT", `/api/baskule/spaces/${team}/plugins`, { personalPluginsAllowed: true, disabled: [] });
    const members = [people.alice, people.bob].sort((a, b) => a.me.user.id < b.me.user.id ? -1 : a.me.user.id > b.me.user.id ? 1 : 0);
    const client = await members[0].rpc(team);
    try {
      const shell = api.watchShell(client);
      await expect.poll(() => shell.ready, { message: "team runtime is booted before connecting" }).toBe(true);
    } finally { client.close(); await client.closed; }

    await secondContext.addCookies(members[1].cookie.split("; ").map(cookie => {
      const [name, ...value] = cookie.split("=");
      return { name, value: value.join("="), url: stack.urls.front };
    }));
    await secondPage.goto(`${stack.urls.front}/settings/plugins`);
    await expect(secondPage.getByText("Your administrator needs to finish setting it up", { exact: true })).toBeVisible();
    await secondPage.screenshot({ path: test.info().outputPath("plugin-needs-vendor-setup.png") });
    await adminContext.addCookies(api.admin.cookie.split("; ").map(cookie => {
      const [name, ...value] = cookie.split("=");
      return { name, value: value.join("="), url: stack.urls.front };
    }));
    await adminPage.goto(`${stack.urls.front}/admin/plugins/installed/${plugin.id}`);
    await adminPage.getByLabel("Client ID", { exact: true }).fill("fake-client");
    await adminPage.getByLabel("Client secret", { exact: true }).fill("fake-secret");
    await adminPage.getByRole("button", { name: "Save setup", exact: true }).click();
    await expect(adminPage.getByText("Saved", { exact: true })).toBeVisible();
    await adminPage.screenshot({ path: test.info().outputPath("plugin-vendor-setup-saved.png") });
    await secondPage.reload();
    await secondPage.getByRole("button", { name: `Connect your ${name} account`, exact: true }).click();
    await secondPage.getByRole("button", { name: "Connect account", exact: true }).click();
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
    await secondContext.close();
    await adminContext.close();
    await oauth.close();
  }
});

test("the curated catalog adds assigned services and opens shared vendor setup", { tag: ["@feature:plugins"] }, async ({ browser, stack, people, api }) => {
  const options = test.info().project.name === "phone" ? phoneOptions : { viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true };
  const adminContext = await browser.newContext(options);
  const memberContext = await browser.newContext(options);
  const adminPage = await adminContext.newPage();
  const memberPage = await memberContext.newPage();
  const installed = [];
  try {
    for (const [context, person] of [[adminContext, api.admin], [memberContext, people.alice]]) {
      await context.addCookies(person.cookie.split("; ").map(cookie => {
        const [name, ...value] = cookie.split("=");
        return { name, value: value.join("="), url: stack.urls.front };
      }));
    }
    await adminPage.goto(`${stack.urls.front}/admin/plugins/catalog`);
    await expect(adminPage.getByRole("heading", { name: "Work management", exact: true })).toBeVisible();
    await expect(adminPage.getByRole("searchbox")).toHaveCount(0);
    for (const name of ["Figma", "Shopify", "Docusign"]) await expect(adminPage.getByRole("button", { name: `Add ${name}`, exact: true })).toHaveCount(0);
    await adminPage.screenshot({ path: test.info().outputPath("plugin-curated-catalog.png"), fullPage: true });
    for (const name of ["Linear", "Gmail"]) {
      await adminPage.goto(`${stack.urls.front}/admin/plugins/catalog`);
      await adminPage.getByRole("button", { name: `Add ${name}`, exact: true }).click();
      await expect(adminPage.getByRole("checkbox", { name: /Everyone/ })).toBeChecked();
      await adminPage.getByRole("button", { name: "Add plugin", exact: true }).click();
      const id = name.toLowerCase();
      await expect.poll(async () => (await api.admin.json("GET", "/api/baskule/admin/plugins")).plugins.some(p => p.id === id), { message: `${name} is installed from the catalog` }).toBe(true);
      installed.push(id);
    }
    await memberPage.goto(`${stack.urls.front}/settings/plugins`);
    await expect(memberPage.getByRole("button", { name: "Connect your Linear account", exact: true })).toBeVisible();
    await expect(memberPage.getByText("Your administrator needs to finish setting it up", { exact: true })).toBeVisible();
    await memberPage.screenshot({ path: test.info().outputPath("plugin-catalog-member-status.png") });
    await adminPage.goto(`${stack.urls.front}/admin/plugins/catalog`);
    await adminPage.getByText("Set up Google", { exact: true }).click();
    await expect(adminPage.getByLabel("Client ID", { exact: true })).toBeVisible();
    await expect(adminPage.getByText("Your app at Google", { exact: true })).toBeVisible();
    await expect(adminPage.getByRole("link", { name: "Setup instructions", exact: true })).toBeVisible();
    await adminPage.getByLabel("Client ID", { exact: true }).scrollIntoViewIfNeeded();
    await adminPage.screenshot({ path: test.info().outputPath("plugin-catalog-google-setup.png") });
  } finally {
    for (const id of installed) await api.admin.json("DELETE", `/api/baskule/admin/plugins/${id}`);
    await adminContext.close();
    await memberContext.close();
  }
});


test("named accounts select the requested identity and use a changed default", { tag: ["@feature:plugins"] }, async ({ browser, stack, people, api }) => {
  const oauth = await fakeOAuth();
  const options = test.info().project.name === "phone" ? phoneOptions : { viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true };
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const person = people.alice;
  const name = `Accounts ${crypto.randomUUID().slice(0, 8)}`;
  let plugin;
  try {
    plugin = await api.admin.json("POST", "/api/baskule/admin/plugins", { groups: ["everyone"], plugin: { name, description: "", source: { type: "custom" }, skills: [], omitted: [], servers: [{ name: "remote", url: oauth.resource, credential: "none" }] } });
    await api.admin.json("PATCH", `/api/baskule/admin/plugins/${plugin.id}`, { plugin: { name, description: "", source: { type: "custom" }, skills: [], omitted: [], servers: [{ name: "remote", url: oauth.resource, credential: "user-oauth" }] } });
    await context.addCookies(person.cookie.split("; ").map(cookie => {
      const [name, ...value] = cookie.split("=");
      return { name, value: value.join("="), url: stack.urls.front };
    }));
    await page.goto(`${stack.urls.front}/settings/plugins`);
    for (const label of ["Work", "Second"]) {
      oauth.state.identity = label;
      await page.getByRole("button", { name: label === "Work" ? `Connect your ${name} account` : `Add another ${name} account`, exact: true }).click();
      await page.getByLabel("Account name", { exact: true }).fill(label);
      await page.getByRole("button", { name: "Connect account", exact: true }).click();
      await expect(page.getByRole("list", { name: `Your ${name} accounts`, exact: true }).getByText(label, { exact: true })).toBeVisible();
    }
    const list = page.getByRole("list", { name: `Your ${name} accounts`, exact: true });
    await expect(list.getByRole("listitem").filter({ hasText: "Work" }).getByText("Default", { exact: true })).toBeVisible();
    await list.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("plugin-two-accounts.png") });
    const reply = async args => {
      const client = await test.step("Open the personal space RPC", () => person.rpc(api.personalSpace(person)));
      const shell = api.watchShell(client);
      try {
        await expect.poll(() => shell.ready, { message: "personal RPC is ready before launching the account call" }).toBe(true);
        const projectId = (await client.ok("projects.ensureScratch", {})).projectId;
        const id = await api.launch(client, projectId, `Look up the private document [[fake:tool *fixture_lookup ${JSON.stringify(args)}]]`, "Named plugin accounts", { generateTitle: false });
        const state = api.watchThread(client, id);
        await api.waitRun(state);
        const answer = state.assistantText();
        state.stop();
        return answer;
      } finally { shell.stop(); client.close(); await client.closed; }
    };
    expect(await reply({ baskule_account: "Second" })).toContain("Account used: Second.");
    expect(oauth.calls).toHaveLength(1);
    expect(oauth.calls[0]).toMatchObject({ identity: "Second", arguments: {} });
    expect(oauth.calls[0].arguments).not.toHaveProperty("baskule_account");
    await list.getByRole("button", { name: "Make Second the default account", exact: true }).click();
    await expect(list.getByRole("listitem").filter({ hasText: "Second" }).getByText("Default", { exact: true })).toBeVisible();
    await list.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("plugin-default-changed.png") });
    expect(await reply({})).toContain("Account used: Second.");
    expect(oauth.calls).toHaveLength(2);
    expect(oauth.calls[1]).toMatchObject({ identity: "Second", arguments: {} });
  } finally {
    if (plugin) await api.admin.json("DELETE", `/api/baskule/admin/plugins/${plugin.id}`);
    await context.close();
    await oauth.close();
  }
});


test("an imported package is reviewed and repaired before save and exports for another installation", { tag: ["@feature:plugins"] }, async ({ browser, stack, people, api }) => {
  const options = test.info().project.name === "phone" ? phoneOptions : { viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true };
  const context = await browser.newContext(options);
  const memberContext = await browser.newContext(options);
  const page = await context.newPage();
  const member = await memberContext.newPage();
  const name = `Reviewed plugin ${crypto.randomUUID()}`;
  let plugin;
  try {
    await context.addCookies(api.admin.cookie.split("; ").map(cookie => {
      const [name, ...value] = cookie.split("="); return { name, value: value.join("="), url: stack.urls.front };
    }));
    await page.goto(`${stack.urls.front}/admin/plugins/add`);
    await expect(page.getByRole("heading", { name: "Import a plugin", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("plugin-add-your-own.png"), fullPage: true });
    const root = fileURLToPath(new URL("../../platform/test/fixtures/plugins/repair/", import.meta.url));
    const archive = execFileSync("python3", ["-c", "import io,pathlib,sys,zipfile; r=pathlib.Path(sys.argv[1]); b=io.BytesIO(); z=zipfile.ZipFile(b,'w'); [z.write(p,p.relative_to(r)) for p in r.rglob('*') if p.is_file()]; z.close(); sys.stdout.buffer.write(b.getvalue())", root]);
    await page.getByLabel("Plugin file", { exact: true }).setInputFiles({ name: "repair.zip", mimeType: "application/zip", buffer: archive });
    const before = (await api.admin.json("GET", "/api/baskule/admin/plugins")).plugins.length;
    await page.getByRole("button", { name: "Review plugin", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Included", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Not used, and why", exact: true })).toBeVisible();
    await expect(page.getByText(/A program that runs on someone's computer/)).toBeVisible();
    expect((await api.admin.json("GET", "/api/baskule/admin/plugins")).plugins.length).toBe(before);
    await page.screenshot({ path: test.info().outputPath("plugin-review-unresolved.png"), fullPage: true });
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("tenant", { exact: true }).fill("workspace");
    await page.getByLabel("Key", { exact: true }).fill("Bearer local-review-key");
    await expect(page.getByText("The package didn't include its sign-in details. Check this choice.", { exact: true })).toBeVisible();
    await page.getByRole("radio", { name: /No sign-in needed/ }).last().check();
    await expect(page.getByRole("checkbox", { name: /Everyone/ })).toBeChecked();
    await page.screenshot({ path: test.info().outputPath("plugin-review-ready.png"), fullPage: true });
    await page.getByRole("button", { name: "Save plugin", exact: true }).click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    plugin = (await api.admin.json("GET", "/api/baskule/admin/plugins")).plugins.find(p => p.name === name);
    expect(plugin.servers[0].url).toBe("https://workspace.example.com/mcp");
    expect(plugin.setup.find(s => s.server === "docs").done).toBe(true);
    expect(JSON.stringify(plugin)).not.toContain("local-review-key");
    await page.screenshot({ path: test.info().outputPath("plugin-import-saved.png"), fullPage: true });
    await signIn(member, people.alice, stack);
    await member.goto(`${stack.urls.front}/settings/plugins`);
    await expect(member.getByText(name, { exact: true })).toBeVisible();
    await expect(member.getByText("Ready", { exact: true })).toBeVisible();
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download as zip", exact: true }).click();
    const download = await downloaded;
    const file = test.info().outputPath("exported-plugin.zip");
    await download.saveAs(file);
    await page.goto(`${stack.urls.front}/admin/plugins/add`);
    await page.getByLabel("Plugin file", { exact: true }).setInputFiles(file);
    await page.getByRole("button", { name: "Review plugin", exact: true }).click();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(name);
    await expect(page.getByLabel("Key", { exact: true })).toHaveValue("");
    await expect(page.getByText("greeting", { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("plugin-export-reviewed.png"), fullPage: true });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await api.admin.json("GET", "/api/baskule/admin/plugins")).plugins.length).toBe(before + 1);
  } finally {
    if (!plugin) plugin = (await api.admin.json("GET", "/api/baskule/admin/plugins")).plugins.find(p => p.name === name);
    if (plugin) await api.admin.json("DELETE", `/api/baskule/admin/plugins/${plugin.id}`);
    await context.close(); await memberContext.close();
  }
});
