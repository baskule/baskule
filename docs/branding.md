# Baskule brand

Baskule uses a lowercase **baskule** wordmark with a gold leaning l and a **pivot** mark: three cards in gray,
ink, and Old gold. App icons use a white tile in both appearances.

| Light | Dark |
| --- | --- |
| ![baskule wordmark](../brand/wordmark.svg) | ![baskule wordmark on dark](../brand/wordmark-inverse.svg) |
| ![pivot mark](../brand/mark.svg) | ![pivot mark on dark](../brand/mark-inverse.svg) |

## Name and artwork

Only the logo is lowercase: **baskule**. Product copy, app names, installers, and documentation use **Baskule**.

The wordmark is outlined Inter Tight 800 with -0.03 em tracking. Its l leans 12° toward the e. The l remains
the wordmark's only colored element. Use the wordmark on sign-in screens, the sidebar header, and the boot screen.

The pivot replaces the former letter-based mark. Its cards rotate -34°, -7°, and 20° around (50, 50) in a
`0 0 100 100` square. The 6.8-unit gaps are transparent outlines, so the mark also works on themed surfaces
and as a monochrome silhouette. The source square includes the intended spacing. Preserve that spacing when
placing the mark on an app tile.

Use the outlined SVGs in `brand/`. They need no font. The inverse wordmark and pivot suit dark surfaces;
app icons keep the white tile. Do not stretch the artwork or recolor it outside the supported inverse and
platform-required monochrome variants. Keep clear space of at least the e's height around the wordmark.
The smallest shipped sizes are a 14 px wordmark and a 16 px mark.

## Colors

| Name | Hex | Role |
| --- | --- | --- |
| Ink | `#111111` | Light wordmark, middle pivot card, primary actions on light backgrounds |
| Paper | `#FFFFFF` | App tile and light background |
| Ink inverse | `#F5F5F5` | Dark wordmark and middle pivot card on dark surfaces |
| Gray | `#C9C9C9` | Rear pivot card |
| Old gold | `#C79A1E` | Wordmark l, front pivot card, dark focus ring and accent |
| Gold strong | `#856714` | Accessible focus ring and accent on light surfaces |

Old gold is a logo color and dark-surface accent. It is not suitable for text or focus indicators on white.
Gold strong is a darker shade of Old gold and remains the light theme's accessible accent. Primary actions,
checked controls, switches, selected states, and progress bars use ink. Content links use info blue (`#1447E6` light,
`#51A2FF` dark). Text selection keeps the operating system's highlight.

Default grays use Tailwind's neutral scale. Functional colors, terminal colors, and named built-in themes
keep their existing values. Gold does not replace error, warning, success, or info roles.

## Theme tokens

`app/apps/web/src/index.css` defines `--brand-muted: #c9c9c9`, `--brand-accent: #c79a1e`, and `--brand-accent-strong: #856714`.
The default focus ring uses Gold strong in light mode and Old gold in dark mode.

`app/packages/shared/src/themePalettes.ts` supplies web custom-theme completion, server-rendered HTML,
and mobile tokens. Its light `focus` and `accent` use `#856714`; the dark values are `#c79a1e`.
Primary action and message-action roles remain ink and inverse ink. Search matches use a pale gold tint
(`#ebdcae`) in light mode and a dark gold tint (`#544519`) in dark mode. The active match uses Old gold
with Ink text in both modes.

Mobile theme files are generated. From `app/`, run `pnpm --filter @t3tools/mobile run generate` to refresh
`generated-uniwind-*` and `clerk-theme.json`. Do not edit these outputs by hand. Android's notification accent
uses Old gold, subject to the operating system's contrast adjustments.

## Generate assets

The four outlined SVGs in `brand/` are the sources. From `app/`, run:

```sh
pnpm run icons:export
pnpm run icons:check
```

`app/scripts/export-baskule-assets.ts` generates web, desktop, mobile, MCP, DMG, and GitHub artwork.
`icons:check` fails when any generated file is missing or stale. Edit a source or the exporter, then regenerate.
The web and mobile `BaskuleMark` components draw the same three outlines. Keep those components aligned with
`brand/mark.svg`; their middle card follows the surrounding foreground color.

| Output | Geometry and use |
| --- | --- |
| `app/assets/baskule/icon.svg`, `icon-light.svg` | Pivot on a white tile, corner radius 0.2237 × side |
| `icon-16.png`, `icon-32.png`, `icon.ico` | Favicons and Windows icon, including ICO sizes 16 through 256 |
| `icon-192.png`, `icon-512.png`, `icon-1024.png` | PWA, Linux, Expo, and mobile brand image |
| `icon-square-180.png`, `icon-square-1024.png` | Opaque white squares for apple-touch and iOS; the system draws corners |
| `icon-maskable-192.png`, `icon-maskable-512.png` | Opaque white squares with the source scaled to 80%; cards remain inside the safe circle |
| `icon-macos-1024.png` | 824 px rounded white tile inset 100 px |
| `android-foreground.png` | Transparent 432 px canvas; source square fits the central 72 dp of the 108 dp canvas; white adaptive background |
| `android-monochrome.png` | White silhouette with transparent gaps, same adaptive geometry |
| `android-notification.png` | White silhouette on a transparent 96 px canvas |
| `splash.png`, `splash-inverse.png` | Transparent 1152 px canvas; `wordmark.svg` and `wordmark-inverse.svg` at 60 % width, inside the central 192 dp of a 288 dp canvas |
| `wordmark.png`, `wordmark-inverse.png` | 1200 px wide, for mobile |
| `app/apps/web/public/` brand images | Copies for favicons, the manifest, and boot-screen wordmarks |
| `app/apps/server/src/mcp/baskuleIcon.ts` | Embedded SVG app icon |
| `app/apps/desktop/resources/dmg/dmg-background-*.svg` | Pivot in the installer backgrounds |

The iOS widget uses `mark.svg` as a template image, which renders all three cards in one color. The outline
gaps preserve the pivot shape. Upstream T3 Code artwork in `app/assets/{dev,nightly,prod}` and unused mobile
assets remains for attribution and is not shipped by Baskule.

## GitHub artwork

The exporter also produces these opaque PNGs:

| File | Size | Destination |
| --- | --- | --- |
| [`brand/github-avatar.png`](../brand/github-avatar.png) | 1024 × 1024 | Organization profile picture, white background; safe for the circular crop |
| [`brand/github-social-preview.png`](../brand/github-social-preview.png) | 1280 × 640 | Repository social preview, pivot above the wordmark on white |

Upload the avatar in the Baskule organization's **Settings → Profile → Profile picture**. Upload the social
preview in the repository's **Settings → General → Social preview**. GitHub stores these settings separately
from Git; merging asset changes does not update them. The repository README uses the generated avatar and
the light and inverse wordmarks directly.

## Verification

Run `icons:check` after generation. Inspect the 16 px favicon, circular avatar crop, monochrome silhouette,
and maskable safe zone. Square and maskable PNGs must be opaque; transparent outputs must retain their gaps.

Run the focused theme palette, VS Code theme import, and mobile theme tests after token changes.
Use `scripts/check plan` for the affected client checks. Native runners verify desktop and mobile packaging;
web evidence does not prove a packaged client. See [the development workflow](development-workflow.md).
