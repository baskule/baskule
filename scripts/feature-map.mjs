import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
export const root = fileURLToPath(new URL("../", import.meta.url));
export const directory = ".agents/skills/verify-baskule/features";
export function features() {
  return readdirSync(join(root, directory)).filter((f) => f.endsWith(".md") && f !== "README.md").map((file) => {
    const header = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(root, directory, file), "utf8"))?.[1];
    if (!header) throw new Error(`${file}: missing front matter`);
    const values = Object.fromEntries(header.split("\n").map((line) => { const i = line.indexOf(":"); return [line.slice(0, i), JSON.parse(line.slice(i + 1))]; }));
    const name = file.slice(0, -3);
    return { name, journeys: values.checks?.length ? null : `@feature:${name}`, ...values };
  });
}
export function touchedFeatures(files) { return features().filter((f) => files.some((file) => f.paths.some((glob) => matchesGlob(file, glob)))); }
function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]); }
export function journeyTags(source, filename) {
  const ts = createRequire(join(root, "e2e/package.json"))("typescript");
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const journeys = [];
  function visit(node) {
    const call = ts.isCallExpression(node) ? node.expression.getText(tree) : "";
    const first = ts.isCallExpression(node) ? node.arguments[0] : null;
    const last = ts.isCallExpression(node) ? node.arguments.at(-1) : null;
    const title = first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first) || ts.isTemplateExpression(first));
    const callback = last && (ts.isArrowFunction(last) || ts.isFunctionExpression(last));
    const options = ts.isCallExpression(node) && node.arguments[1];
    const conditional = /^test\.(skip|fixme)$/.test(call) && !title && !callback && !(options && ts.isObjectLiteralExpression(options));
    if (ts.isCallExpression(node) && !conditional && (call === "test" || /^test\.(only|skip|fixme)$/.test(call))) {
      const options = node.arguments[1];
      const property = options && ts.isObjectLiteralExpression(options) ? options.properties.find((p) => p.name?.getText(tree) === "tag") : null;
      const value = property && ts.isPropertyAssignment(property) ? property.initializer : null;
      const tags = value && ts.isArrayLiteralExpression(value) ? value.elements.filter(ts.isStringLiteral).map((e) => e.text) : value && ts.isStringLiteral(value) ? [value.text] : [];
      journeys.push(tags.filter((t) => t.startsWith("@feature:")).map((t) => t.slice(9)));
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return journeys;
}
export function validateFeatures(map, journeys) {
  const errors = [], tags = new Set();
  for (const { file, features: names } of journeys) {
    if (!names.length) errors.push(`${file}: journey has no feature tag`);
    for (const name of names) { tags.add(`@feature:${name}`); if (!map.some((f) => f.name === name)) errors.push(`${file}: unknown feature ${name}`); }
  }
  for (const f of map) {
    if (!f.paths?.length || !f.profile) errors.push(`${f.name}: paths and profile required`);
    if (!f.journeys && !f.checks?.length) errors.push(`${f.name}: neither journeys nor checks`);
    if (f.journeys && !tags.has(f.journeys)) errors.push(`${f.name}: no journey for ${f.journeys}`);
  }
  return errors;
}
export function lintFeatures() {
  const map = features();
  const journeys = walk(join(root, "e2e/journeys")).filter((f) => /\.spec\.(mjs|ts)$/.test(f)).flatMap((file) => journeyTags(readFileSync(file, "utf8"), file).map((names) => ({ file, features: names })));
  const errors = validateFeatures(map, journeys);
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(`Feature map: ${map.length} features, ${journeys.length} journeys`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) lintFeatures();
