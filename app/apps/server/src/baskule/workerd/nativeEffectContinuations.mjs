import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// Preserve callback origins and boot-owned macrotask scheduler dispatch on celld (#258).
// Macrotask yields are required for Code Mode interruption and host I/O.
// Apply only to workerd artifacts, leaving the Node runtimes and shared installed dependencies untouched.
export const nativeEffectContinuations = {
  name: "celld-effect-continuations",
  setup(build) {
    build.onLoad({ filter: /\/effect\/dist\/(?:internal\/effect|Scheduler)\.js$/ }, ({ path }) => {
      const { version } = JSON.parse(
        NodeFS.readFileSync(NodePath.resolve(NodePath.dirname(path), path.endsWith("/Scheduler.js") ? "../package.json" : "../../package.json"), "utf8"),
      );
      if (!["4.0.1", "4.0.5", "4.1.2"].includes(version))
        throw new Error(`Review native Effect continuation compatibility for ${version}`);
      let contents = NodeFS.readFileSync(path, "utf8");
      if (path.endsWith("/Scheduler.js")) {
        const before = "return new MixedSchedulerDispatcher(this.setImmediate);";
        if (contents.split(before).length !== 2)
          throw new Error(`Effect ${version} dispatcher implementation changed: ${path}`);
        const helper = JSON.stringify(NodePath.join(import.meta.dirname, "bootScheduler.mjs"));
        contents = `import { bindBootScheduler } from ${helper};\n` + contents.replace(before,
          'return new MixedSchedulerDispatcher(this.setImmediate === setImmediate ? bindBootScheduler(this.setImmediate) : this.setImmediate);');
        return { contents, loader: "js", resolveDir: NodePath.dirname(path) };
      }
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
      // 4.1.2's yieldWith stores the same _yielded cancellation callback.
      const cancel =
        version === "4.1.2"
          ? `      fiber.yieldWith(() => {
        resumed = true;`
          : `      fiber._yielded = () => {
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
