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
const ACCENT = "#C79A1E";
const WHITE = "#FFFFFF";

for (const name of ["wordmark", "wordmark-inverse", "mark", "mark-inverse"]) {
  await copy(NodePath.join(source, `${name}.svg`), NodePath.join(output, `${name}.svg`));
}

const mark = await NodeFSP.readFile(NodePath.join(source, "mark.svg"), "utf8");
const [markWidth, markHeight] = mark
  .match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)!
  .slice(1)
  .map(Number) as [number, number];
const markPaths = (foreground: string, accent: string, muted = "#C9C9C9") =>
  mark
    .replace(/^<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .replace(`fill="${INK}"`, `fill="${foreground}"`)
    .replace(`fill="${ACCENT}"`, `fill="${accent}"`)
    .replace(`fill="#C9C9C9"`, `fill="${muted}"`);

const round = (value: number) => Number(value.toFixed(2));
// The source square includes the pivot's spacing. `markFraction` scales that square; a tile covers
// `tileFraction` of the canvas; a rounded tile has corner radius 0.2237 of its side.
function compose(options: {
  readonly markFraction: number;
  readonly foreground: string;
  readonly accent: string;
  readonly muted?: string;
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
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${[x, y, canvas, canvas].map(round).join(" ")}">${tile}${markPaths(options.foreground, options.accent, options.muted)}</svg>\n`;
}
const png = (svg: string, size: number, opaque = false) => {
  const image = sharp(Buffer.from(svg.replace("<svg ", `<svg width="${size}" height="${size}" `)));
  return (opaque ? image.removeAlpha() : image).png().toBuffer();
};

// The selected pivot on a white tile, with the spacing drawn in brand/mark.svg.
const icon = compose({
  markFraction: 1,
  foreground: INK,
  accent: ACCENT,
  tile: WHITE,
  rounded: true,
});
await write(NodePath.join(output, "icon.svg"), icon);
await write(NodePath.join(output, "icon-light.svg"), icon);
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
const square = compose({ markFraction: 1, foreground: INK, accent: ACCENT, tile: WHITE });
for (const size of [180, 1024]) {
  await write(NodePath.join(output, `icon-square-${size}.png`), await png(square, size, true));
}
// PWA maskable icons keep the mark inside the 80% safe circle.
const maskable = compose({ markFraction: 0.8, foreground: INK, accent: ACCENT, tile: WHITE });
for (const size of [192, 512]) {
  await write(NodePath.join(output, `icon-maskable-${size}.png`), await png(maskable, size, true));
}
// macOS before Tahoe: an 824px body inset 100px in a 1024px canvas.
await write(
  NodePath.join(output, "icon-macos-1024.png"),
  await png(
    compose({
      markFraction: 824 / 1024,
      foreground: INK,
      accent: ACCENT,
      tile: WHITE,
      tileFraction: 824 / 1024,
      rounded: true,
    }),
    1024,
  ),
);

// Android shows the central 72dp of the 108dp adaptive canvas, and the Android 12 splash the
// central 192dp of 288dp; the source square fills that visible area.
const adaptive = 72 / 108;
await write(
  NodePath.join(output, "android-foreground.png"),
  await png(compose({ markFraction: adaptive, foreground: INK, accent: ACCENT }), 432),
);
await write(
  NodePath.join(output, "android-monochrome.png"),
  await png(
    compose({ markFraction: adaptive, foreground: WHITE, accent: WHITE, muted: WHITE }),
    432,
  ),
);
await write(
  NodePath.join(output, "android-notification.png"),
  await png(
    compose({
      markFraction: (0.8 * markWidth) / markHeight,
      foreground: WHITE,
      accent: WHITE,
      muted: WHITE,
    }),
    96,
  ),
);
// The splash shows the full wordmark. Android 12+ masks the splash icon to the central 192dp circle
// of its 288dp canvas; at 60% of the canvas width the wordmark's corners stay inside that circle.
const wordmarkSplash = async (name: string) => {
  const svg = await NodeFSP.readFile(NodePath.join(source, `${name}.svg`), "utf8");
  const [width, height] = svg
    .match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)!
    .slice(1)
    .map(Number) as [number, number];
  const canvas = width / 0.6;
  const viewBox = [width / 2 - canvas / 2, height / 2 - canvas / 2, canvas, canvas].map(round);
  return png(svg.replace(/viewBox="[^"]*"/, `viewBox="${viewBox.join(" ")}"`), 1152);
};
await write(NodePath.join(output, "splash.png"), await wordmarkSplash("wordmark"));
await write(NodePath.join(output, "splash-inverse.png"), await wordmarkSplash("wordmark-inverse"));

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
for (const channel of ["latest", "nightly"]) {
  const file = NodePath.join(root, `app/apps/desktop/resources/dmg/dmg-background-${channel}.svg`);
  const background = await NodeFSP.readFile(file, "utf8");
  const artwork = await NodeFSP.readFile(
    NodePath.join(source, channel === "nightly" ? "mark-inverse.svg" : "mark.svg"),
    "utf8",
  );
  await write(
    file,
    background.replace(
      /<svg x="32" y="23"[^>]*>[\s\S]*?<\/svg>/,
      artwork.trim().replace("<svg ", '<svg x="32" y="23" width="18" height="18" '),
    ),
  );
}

// GitHub organization avatar and repository social preview use opaque white artwork.
await write(NodePath.join(source, "github-avatar.png"), await png(square, 1024, true));
const wordmark = await NodeFSP.readFile(NodePath.join(source, "wordmark.svg"), "utf8");
const social = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640"><rect width="1280" height="640" fill="${WHITE}"/>${mark.trim().replace("<svg ", '<svg x="512" y="96" width="256" height="256" ')}${wordmark.trim().replace("<svg ", '<svg x="340" y="400" width="600" height="129" ')}</svg>`;
await write(
  NodePath.join(source, "github-social-preview.png"),
  await sharp(Buffer.from(social)).removeAlpha().png().toBuffer(),
);

if (stale.length) throw new Error(`Stale Baskule assets:\n${stale.join("\n")}`);
console.log(
  check ? "Baskule assets are current." : "Updated Baskule web, desktop, mobile and MCP assets.",
);
