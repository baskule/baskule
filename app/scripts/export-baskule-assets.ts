#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- standalone asset/code generation uses native filesystem and CLI output.
// The outlines in brand/ are the source for every shipped Baskule logo and icon (docs/branding.md).
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import sharp from "sharp";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const check = process.argv.includes("--check");
const stale: string[] = [];
async function write(file: string, data: string | Buffer) {
  if (check) {
    const current = await NodeFSP.readFile(file).catch(() => null);
    if (current === null || !current.equals(Buffer.from(data))) stale.push(file);
  } else {
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.writeFile(file, data);
  }
}
async function copy(source: string, target: string) {
  await write(target, await NodeFSP.readFile(source));
}
const root = NodePath.resolve(import.meta.dirname, "../..");
const source = NodePath.join(root, "brand");
const output = NodePath.join(root, "app/assets/baskule");

const INK = "#111111";
const INK_INVERSE = "#F5F5F5";
const ACCENT = "#B8902A";
const WHITE = "#FFFFFF";

for (const name of ["wordmark", "wordmark-inverse", "mark", "mark-inverse"]) {
  await copy(NodePath.join(source, `${name}.svg`), NodePath.join(output, `${name}.svg`));
}

const mark = await NodeFSP.readFile(NodePath.join(source, "mark.svg"), "utf8");
const [markWidth, markHeight] = mark
  .match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)!
  .slice(1)
  .map(Number) as [number, number];
const markPaths = (e: string, l: string) =>
  mark
    .replace(/^<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .replace(`fill="${INK}"`, `fill="${e}"`)
    .replace(`fill="${ACCENT}"`, `fill="${l}"`);

const round = (value: number) => Number(value.toFixed(2));
// The mark's bounding box is centred and spans `markFraction` of the canvas width. A tile covers
// `tileFraction` of the canvas; a rounded tile has corner radius 0.2237 of its side.
function compose(options: {
  readonly markFraction: number;
  readonly e: string;
  readonly l: string;
  readonly tile?: string;
  readonly tileFraction?: number;
  readonly rounded?: boolean;
}) {
  const canvas = markWidth / options.markFraction;
  const x = markWidth / 2 - canvas / 2;
  const y = markHeight / 2 - canvas / 2;
  const side = canvas * (options.tileFraction ?? 1);
  const inset = (canvas - side) / 2;
  const tile = options.tile
    ? `<rect x="${round(x + inset)}" y="${round(y + inset)}" width="${round(side)}" height="${round(side)}"${options.rounded ? ` rx="${round(side * 0.2237)}"` : ""} fill="${options.tile}"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${[x, y, canvas, canvas].map(round).join(" ")}">${tile}${markPaths(options.e, options.l)}</svg>\n`;
}
const png = (svg: string, size: number, opaque = false) => {
  const image = sharp(Buffer.from(svg.replace("<svg ", `<svg width="${size}" height="${size}" `)));
  return (opaque ? image.removeAlpha() : image).png().toBuffer();
};

// App icon: light mark on a dark rounded tile, 58% of the tile width.
const icon = compose({ markFraction: 0.58, e: INK_INVERSE, l: ACCENT, tile: INK, rounded: true });
await write(NodePath.join(output, "icon.svg"), icon);
await write(
  NodePath.join(output, "icon-light.svg"),
  compose({ markFraction: 0.58, e: INK, l: ACCENT, tile: WHITE, rounded: true }),
);
for (const size of [16, 32, 192, 512, 1024]) {
  await write(NodePath.join(output, `icon-${size}.png`), await png(icon, size));
}
await write(
  NodePath.join(output, "icon.ico"),
  encodePngIco(
    await Promise.all(
      WINDOWS_ICON_SIZES.map(async (size) => ({ size, contents: await png(icon, size) })),
    ),
  ),
);
// iOS and apple-touch icons are opaque squares; the system draws the corners.
const square = compose({ markFraction: 0.58, e: INK_INVERSE, l: ACCENT, tile: INK });
for (const size of [180, 1024]) {
  await write(NodePath.join(output, `icon-square-${size}.png`), await png(square, size, true));
}
// PWA maskable icons keep the mark inside the 80% safe circle.
const maskable = compose({ markFraction: 0.54, e: INK_INVERSE, l: ACCENT, tile: INK });
for (const size of [192, 512]) {
  await write(NodePath.join(output, `icon-maskable-${size}.png`), await png(maskable, size, true));
}
// macOS before Tahoe: an 824px body inset 100px in a 1024px canvas.
await write(
  NodePath.join(output, "icon-macos-1024.png"),
  await png(
    compose({
      markFraction: (0.58 * 824) / 1024,
      e: INK_INVERSE,
      l: ACCENT,
      tile: INK,
      tileFraction: 824 / 1024,
      rounded: true,
    }),
    1024,
  ),
);

// Android shows the central 72dp of the 108dp adaptive canvas, and the Android 12 splash the
// central 192dp of 288dp; the mark keeps the app icon's 58% of that visible width.
const adaptive = (72 / 108) * 0.58;
await write(
  NodePath.join(output, "android-foreground.png"),
  await png(compose({ markFraction: adaptive, e: INK_INVERSE, l: ACCENT }), 432),
);
await write(
  NodePath.join(output, "android-monochrome.png"),
  await png(compose({ markFraction: adaptive, e: WHITE, l: WHITE }), 432),
);
await write(
  NodePath.join(output, "android-notification.png"),
  await png(compose({ markFraction: (0.8 * markWidth) / markHeight, e: WHITE, l: WHITE }), 96),
);
const splash = (192 / 288) * 0.58;
await write(
  NodePath.join(output, "splash.png"),
  await png(compose({ markFraction: splash, e: INK, l: ACCENT }), 1152),
);
await write(
  NodePath.join(output, "splash-inverse.png"),
  await png(compose({ markFraction: splash, e: INK_INVERSE, l: ACCENT }), 1152),
);

for (const name of ["wordmark", "wordmark-inverse"]) {
  await write(
    NodePath.join(output, `${name}.png`),
    await sharp(await NodeFSP.readFile(NodePath.join(source, `${name}.svg`)), { density: 72 })
      .resize({ width: 1200 })
      .png()
      .toBuffer(),
  );
}

const publicDir = NodePath.join(root, "app/apps/web/public");
for (const [file, target] of Object.entries({
  "icon.ico": "favicon.ico",
  "icon-16.png": "favicon-16x16.png",
  "icon-32.png": "favicon-32x32.png",
  "icon-square-180.png": "apple-touch-icon.png",
  "icon-192.png": "icon-192.png",
  "icon-512.png": "icon-512.png",
  "icon-maskable-192.png": "icon-maskable-192.png",
  "icon-maskable-512.png": "icon-maskable-512.png",
  "icon.svg": "baskule-icon.svg",
  "wordmark.svg": "baskule-wordmark.svg",
  "wordmark-inverse.svg": "baskule-wordmark-inverse.svg",
}))
  await copy(NodePath.join(output, file), NodePath.join(publicDir, target));

await write(
  NodePath.join(root, "app/apps/server/src/mcp/baskuleIcon.ts"),
  `// Generated by export-baskule-assets.ts from brand/mark.svg.\nexport const BASKULE_MCP_ICON =\n  ${JSON.stringify("data:image/svg+xml;base64," + Buffer.from(icon).toString("base64"))};\n`,
);
if (stale.length) throw new Error(`Stale Baskule assets:\n${stale.join("\n")}`);
console.log(
  check ? "Baskule assets are current." : "Updated Baskule web, desktop, mobile and MCP assets.",
);
