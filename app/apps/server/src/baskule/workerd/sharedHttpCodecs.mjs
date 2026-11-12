import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// Codec closures hold schema metadata only; request handlers and service contexts remain per Space.
export const sharedHttpCodecs = {
  name: "baskule-shared-http-codecs",
  setup(build) {
    let rewritten = false;
    build.onStart(() => {
      rewritten = false;
    });
    build.onEnd((result) => {
      if (!result.errors.length && !rewritten)
        throw new Error("Shared HTTP codecs did not rewrite HttpApiBuilder.js");
    });
    build.onLoad({ filter: /\/effect\/dist\/http-api\/HttpApiBuilder\.js$/ }, ({ path }) => {
      let contents = NodeFS.readFileSync(path, "utf8");
      const start = contents.indexOf(
        "  const annotations =",
        contents.indexOf("function handlerToHttpEffect("),
      );
      const end = contents.indexOf("  return applyMiddleware(", start);
      const body = contents.slice(start, end);
      if (start < 0 || end < 0 || !body.includes("const payloadBy =")) {
        throw new Error("Review shared HTTP codec compatibility: handlerToHttpEffect changed");
      }
      if (/\b(context|handler)\b/.test(body.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ""))) {
        throw new Error("Shared HTTP codecs must not capture a handler or context");
      }
      const names = [
        "encodeSuccess",
        "encodeError",
        "decodeParams",
        "decodeHeaders",
        "decodeQuery",
        "encodeStream",
        "encodeWithHeaders",
        "upgrade",
        "upgradeOnly",
        "encodeUpgradeHeaders",
        "payloadBy",
      ];
      const declared = [...body.matchAll(/^  const (\w+) =/gm)].map((match) => match[1]).sort();
      const expected = [...names, "annotations", "options", "shouldParsePayload"].sort();
      // The pinned factory body must be reviewed before lifting any changed lexical dependencies.
      if (
        JSON.stringify(declared) !== JSON.stringify(expected) ||
        NodeCrypto.createHash("sha256").update(body).digest("hex") !==
          "9f94dd15feddfa4117e7d010f924f66532e9ce6b455ff45871d77e940484bfc2"
      ) {
        throw new Error(
          "Review shared HTTP codec factory body: declarations or captured dependencies changed",
        );
      }
      const helper = `
const hostedHttpCodecs = new WeakMap();
function getHostedHttpCodecs(api, group, endpoint, isRaw) {
  let groups = hostedHttpCodecs.get(api);
  if (!groups) hostedHttpCodecs.set(api, groups = new WeakMap());
  let endpoints = groups.get(group);
  if (!endpoints) groups.set(group, endpoints = new WeakMap());
  let modes = endpoints.get(endpoint);
  if (!modes) endpoints.set(endpoint, modes = new Map());
  if (modes.has(isRaw)) return modes.get(isRaw);
${body}
  const codecs = { ${names.join(", ")} };
  modes.set(isRaw, codecs);
  return codecs;
}
`;
      contents =
        contents.slice(0, start) +
        `  const codecs = () => getHostedHttpCodecs(api, group, endpoint, isRaw);\n` +
        contents.slice(end);
      const before = "return applyMiddleware(group, endpoint, context, Effect.gen(function* () {";
      if (contents.split(before).length !== 2)
        throw new Error("Review shared HTTP codec middleware boundary");
      contents = contents.replace(
        before,
        before +
          `\n    const { ${names.filter((n) => n !== "encodeError").join(", ")} } = codecs();`,
      );
      const error = "Effect.catch(encodeError(error), schemaError =>";
      if (contents.split(error).length !== 2)
        throw new Error("Review shared HTTP codec error boundary");
      contents = contents.replace(
        error,
        "Effect.catch(codecs().encodeError(error), schemaError =>",
      );
      rewritten = true;
      return { contents: helper + contents, loader: "js", resolveDir: NodePath.dirname(path) };
    });
  },
};
