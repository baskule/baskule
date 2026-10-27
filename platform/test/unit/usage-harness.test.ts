import { expect, it } from "vitest";
import { TestControlCell } from "../../src/space/test/harness/control-cell";
import { fakeStorage } from "../support/fake-storage";

it("can reconstruct the component ControlCell over its persisted usage schema", async () => {
  const storage = fakeStorage();
  const ctx = { storage, blockConcurrencyWhile: (fn: () => Promise<void>) => fn() };
  const env = { TEST_PRODUCT_SETTINGS: "{}" };
  for (let boot = 0; boot < 2; boot++) {
    const control = new TestControlCell(ctx as never, env as never);
    const response = await control.fetch(new Request("http://control/_baskule/settings", {
      method: "POST", body: JSON.stringify({ spaceId: "usage-fixture" }),
    }));
    expect(await response.json()).toEqual({ usageLimits: { enabled: false, rules: [] }, plugins: { servers: [], skills: [] } });
  }
  storage.db.close();
});
