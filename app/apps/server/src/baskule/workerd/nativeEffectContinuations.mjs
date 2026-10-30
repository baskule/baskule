import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// AsyncResource restores ALS but not celld's native event token. An Effect callback invoked by another request
// otherwise moves the fiber to that request; a later native Promise can retain its already-retired event (`celld #258`).
// Apply only to workerd artifacts, leaving the Node runtimes and shared installed dependencies untouched.
export const nativeEffectContinuations = {
  name: "celld-effect-continuations",
  setup(build) {
    build.onLoad({ filter: /\/effect\/dist\/internal\/effect\.js$/ }, ({ path }) => {
      const { version } = JSON.parse(
        NodeFS.readFileSync(NodePath.resolve(NodePath.dirname(path), "../../package.json"), "utf8"),
      );
      if (!["4.0.1", "4.0.5"].includes(version))
        throw new Error(`Review native Effect continuation compatibility for ${version}`);
      let contents = NodeFS.readFileSync(path, "utf8");
      const before = `      let resumed = false;
      let yielded = false;`;
      const after = `      let resumed = false;
      let yielded = false;
      let cancelled = false;
      let resumeInOrigin;
      new Promise(resolve => { resumeInOrigin = resolve; }).then(effect => {
        if (!cancelled) fiber.evaluate(effect);
      });`;
      const resume = `        if (yielded) {
          fiber.evaluate(effect);`;
      const cancel = `      fiber._yielded = () => {
        resumed = true;`;
      for (const fragment of [before, resume, cancel]) {
        if (contents.split(fragment).length !== 2)
          throw new Error(`Effect ${version} callback implementation changed: ${path}`);
      }
      contents = contents
        .replace(before, after)
        .replace(
          resume,
          `        if (yielded) {
          resumeInOrigin(effect);`,
        )
        .replace(
          cancel,
          `${cancel}
        cancelled = true;`,
        );
      return { contents, loader: "js", resolveDir: NodePath.dirname(path) };
    });
  },
};
