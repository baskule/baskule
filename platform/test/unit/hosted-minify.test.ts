import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("runs the native build with minification and shortened constructor names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hosted-minify-"));
  const platform = fileURLToPath(new URL("../../", import.meta.url).href);
  const entry = join(dir, "fixture.ts");
  try {
    await writeFile(entry, "class HostedMinificationFixture {}\nexport const observedName = new HostedMinificationFixture().constructor.name;\nexport default { fetch: () => new Response('healthy') };\n");
    execFileSync(process.execPath, [join(platform, "scripts/build.mjs")], {
      cwd: platform,
      env: { ...process.env, BASKULE_ENTRY: entry, BASKULE_OUT: dir, BASKULE_MINIFY: "1" },
      stdio: "pipe",
    });
    const output = join(dir, "runtime/index.js");
    const artifact = await import(/* @vite-ignore */ pathToFileURL(output).href);
    expect(artifact.observedName).not.toBe("HostedMinificationFixture");
    expect(await artifact.default.fetch().text()).toBe("healthy");
    expect(await readFile(output, "utf8")).not.toContain("__name(");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
