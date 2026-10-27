const testFile = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test\/|(?:^|\/)e2e\/)/;
const name = (node) => node.type === "Identifier" ? node.name : node.type === "MemberExpression" ? node.property.name ?? node.property.value : "";

export default {
  meta: { name: "baskule" },
  rules: {
    "no-fixed-sleep": {
      meta: { type: "problem", schema: [] },
      create(context) {
        if (!testFile.test(context.filename)) return {};
        const { sourceCode } = context;
        const timers = new Set(["sleep", "setTimeout"]);
        const execs = new Set(["execFileSync"]);
        const report = (node) => {
          const allowed = sourceCode.getAllComments().some((comment) =>
            comment.loc.start.line >= node.loc.start.line && comment.loc.start.line <= node.loc.end.line &&
            /^\s*no-fixed-sleep-allow:\s*\S.*\S\s*$/.test(comment.value));
          if (!allowed) context.report({ node, message: "Wait on a condition with a timeout, or add // no-fixed-sleep-allow: <reason> on this line." });
        };
        return {
          ImportDeclaration(node) {
            for (const specifier of node.specifiers) {
              if (specifier.imported?.name === "sleep" ||
                (/^(?:node:)?timers(?:\/promises)?$/.test(node.source.value) && specifier.imported?.name === "setTimeout")) timers.add(specifier.local.name);
              if (/^(?:node:)?child_process$/.test(node.source.value) && specifier.imported?.name === "execFileSync") execs.add(specifier.local.name);
            }
          },
          AwaitExpression(node) {
            const call = node.argument;
            if (call.type === "CallExpression" && timers.has(name(call.callee))) report(node);
            if (call.type !== "NewExpression" || name(call.callee) !== "Promise") return;
            // Inspect the executor's syntax, never strings or comments containing timer examples.
            const hasTimer = (child) => {
              if (!child || typeof child !== "object") return false;
              if (child.type === "CallExpression" && timers.has(name(child.callee))) return true;
              return Object.entries(child).some(([key, value]) => key !== "parent" && key !== "loc" &&
                (Array.isArray(value) ? value.some(hasTimer) : hasTimer(value)));
            };
            if (hasTimer(call.arguments[0])) report(node);
          },
          CallExpression(node) {
            if (name(node.callee) === "waitForTimeout" || (execs.has(name(node.callee)) && node.arguments[0]?.value === "sleep")) report(node);
          },
        };
      },
    },
  },
};
