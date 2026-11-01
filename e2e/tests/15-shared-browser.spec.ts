// Actual two-client browser viewer ownership and front membership revocation.
import { expect, test, type Page } from '@playwright/test';
import { adminApi, newDevice, openChat, sendInCurrent, shot, signInBrowser, startChat, until, waitAnswer, waitComposer, world } from './lib';

async function showBrowser(page: Page) {
  const surface = page.locator('[data-server-browser-surface]').first();
  if (!await surface.isVisible()) {
    const toggle = page.getByRole('button', { name: 'Toggle right panel', exact: true });
    if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
    // Exact title excludes the preceding 'Close Example Domain' button. Wait for hydration.
    const tab = page.locator('[data-right-panel-tabbar]').getByRole('button', { name: 'Example Domain', exact: true });
    await expect(tab).toBeVisible({ timeout: 60000 });
    await tab.click();
  }
  await expect(surface).toBeVisible({ timeout: 60000 });
  await expect(surface.locator('canvas')).toBeVisible();
  return surface;
}

test('shared Browser: two viewers hand off control and membership revocation cuts the viewer', { tag: ['@browser', '@team', '@security'] }, async ({browser}) => {
  const w = await world();
  const admin = await adminApi();
  const alice = await newDevice(browser);
  const bob = await newDevice(browser);
  let removed = false;
  try {
    await signInBrowser(alice.page, w.alice);
    await waitComposer(alice.page);
    const id = await startChat(alice.page, 'Browser handoff [[fake:tool *preview_open {"url":"https://example.com"}]]', w.acme.name);
    await waitAnswer(alice.page, /Done: .*preview_open=/, 240000);
    const a = await showBrowser(alice.page);
    console.log("First viewer receives browser surface.");
    const viewers: {url:string;closed:boolean;frames:number}[] = [];
    bob.page.on('websocket', ws => {
      if (!ws.url().includes('/api/preview-stream/ws')) return;
      const record = {url:ws.url(),closed:false,frames:0}; viewers.push(record);
      ws.on('framereceived', frame => { if (typeof frame.payload !== 'string') record.frames++; });
      ws.on('close', () => record.closed = true);
    });
    await signInBrowser(bob.page, w.bob);
    await waitComposer(bob.page);
    await openChat(bob.page,id);
    const b = await showBrowser(bob.page);
    await until(() => viewers.some(v => v.frames > 0), 30000, 100, 'Bob receives browser JPEG frames');
    console.log("Joining viewer receives existing shared tab and JPEG frames.");
    await expect(a.getByRole('button',{name:'Take control',exact:true})).toBeEnabled();
    await a.getByRole('button',{name:'Take control',exact:true}).click();
    await expect(a.getByText('You have control',{exact:true})).toBeVisible();
    await expect(b.getByText('Another viewer has control',{exact:true})).toBeVisible();
    await expect(b.getByRole('button',{name:'Take control',exact:true})).toBeDisabled();
    await sendInCurrent(alice.page, 'Browser held [[fake:tool *preview_navigate {"url":"https://example.com/#blocked"}]]');
    await waitAnswer(alice.page, /human.*control|controls this tab/i, 120000);
    await expect(a.getByText('You have control',{exact:true})).toBeVisible();
    console.log("Human ownership rejects agent navigation.");
    await shot(alice.page,'15-shared-browser','01-alice-controls');
    await shot(bob.page,'15-shared-browser','02-bob-watches');
    await a.getByRole('button',{name:'Release control',exact:true}).click();
    await expect(b.getByRole('button',{name:'Take control',exact:true})).toBeEnabled();
    await b.getByRole('button',{name:'Take control',exact:true}).click();
    await expect(b.getByText('You have control',{exact:true})).toBeVisible();
    await expect(a.getByText('Another viewer has control',{exact:true})).toBeVisible();
    await b.getByRole('button',{name:'Release control',exact:true}).click();
    await sendInCurrent(alice.page, 'Browser resume [[fake:tool *preview_navigate {"url":"https://example.com/#resumed"}]]');
    await waitAnswer(alice.page,/Done: .*preview_navigate=/,120000);
    console.log("Two viewers hand off ownership; agent resumes after release.");
    await until(() => viewers.some(v=>!v.closed),30000,100,'Bob browser stream established');
    await b.getByRole('button',{name:'Take control',exact:true}).click();
    await expect(b.getByText('You have control',{exact:true})).toBeVisible();
    const existing = viewers.filter(v=>!v.closed);
    const response = await admin.req('DELETE',`/api/baskule/spaces/${w.acme.id}/members/${w.bob.id}`);
    expect(response.status).toBe(200); removed = true;
    await until(()=>existing.every(v=>v.closed),10000,100,'Bob browser stream revoked');
    await expect(a).toBeVisible();
    await expect(a.getByRole('button',{name:'Take control',exact:true})).toBeEnabled();
    console.log("Membership revocation closes the removed viewer's stream.");
    await shot(alice.page,'15-shared-browser','03-alice-after-revocation');
  } finally {
    if (removed) expect((await admin.post(`/api/baskule/spaces/${w.acme.id}/members`,{userId:w.bob.id,role:'member'})).status).toBeLessThan(300);
    await alice.context.close(); await bob.context.close();
  }
});
