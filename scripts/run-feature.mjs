import { spawnSync } from "node:child_process";
import { remainingFeatureChecks } from "./release-plan.mjs";
import { features, root } from "./feature-map.mjs";
const feature = features().find((f) => f.name === process.argv[2]);
if (!feature) throw new Error(`Unknown feature ${process.argv[2]}`);
if (feature.liveOnly && !process.argv.includes("--live")) throw new Error("Live-installation feature: explicitly configure the installation and pass --live");
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, JOURNEY_PROFILE: feature.profile } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (feature.journeys) run("pnpm", ["exec", "playwright", "test", "-c", "journeys/playwright.config.ts", "--grep", `(?:^| )${feature.journeys}(?: |$)`], `${root}e2e`);
const covered = process.argv.find((arg) => arg.startsWith("--covered="))?.slice(10).split(",") ?? [];
for (const command of remainingFeatureChecks(feature, covered)) run("bash", ["-c", command]);
