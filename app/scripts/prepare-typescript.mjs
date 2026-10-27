import { spawnSync } from "node:child_process";
import {
  constants,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const appRoot = join(import.meta.dirname, "..");
const compiler = join(appRoot, "node_modules/typescript");

// Effect replaces the compiler binary. Keep that package and its native binary
// private to this checkout, even when pnpm shares the rest of the installation.
if (lstatSync(compiler).isSymbolicLink()) {
  const manifest = require.resolve("typescript/package.json");
  const nativeName = `@typescript/typescript-${process.platform}-${process.arch}`;
  const native = createRequire(manifest).resolve(`${nativeName}/package.json`);
  const temporary = mkdtempSync(join(dirname(compiler), ".typescript-"));
  try {
    cpSync(dirname(manifest), temporary, { recursive: true, mode: constants.COPYFILE_FICLONE });
    const nativeTarget = join(temporary, "node_modules", nativeName);
    mkdirSync(dirname(nativeTarget), { recursive: true });
    cpSync(dirname(native), nativeTarget, { recursive: true, mode: constants.COPYFILE_FICLONE });
    rmSync(compiler);
    renameSync(temporary, compiler);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const effectManifest = require.resolve("@effect/tsgo/package.json");
const effect = JSON.parse(readFileSync(effectManifest, "utf8"));
const result = spawnSync(
  process.execPath,
  [join(dirname(effectManifest), effect.bin["effect-tsgo"]), "patch", "--typescript"],
  { cwd: appRoot, stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
