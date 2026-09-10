# LogoLab MCP server

The tracer and the icon exporter, handed to a coding agent.

An image model gives you `icon.png`. Something has to turn that into an app icon:
a clean SVG, then favicons, PWA icons with a maskable pair, a real `favicon.ico`,
maybe a Tauri or Android or iOS set. Resizing the PNG gives you a blurry 16×16 and
no SVG. This server runs the app's own pipeline instead — the same segmentation
and curve fitting the Vectorize tab runs, the same icon geometry the Export tab
renders — over stdio, locally, with nothing uploaded.

```
   icon.png ──▶ inspect_icon ──▶ trace_icon ──▶ export_icons ──▶ public/
                     │                │              │
                     └── make_app_icons (all three) ─┘
```

## Install

Published as [`logolab`](https://www.npmjs.com/package/logolab). Needs Node ≥ 22.18;
no clone, no build, nothing global — `npx` fetches it and your client runs it.

```bash
# Claude Code, this project only  (writes .mcp.json)
npx -y logolab install
# …or for every project
npx -y logolab install --scope user
# …or through the CLI
claude mcp add logolab -- npx -y logolab

# Cursor  (writes .cursor/mcp.json)
npx -y logolab install --client cursor

# VS Code  (writes .vscode/mcp.json)
npx -y logolab install --client vscode

# Anything else: print the JSON and change nothing
npx -y logolab install --client print
```

`--dir <path>` installs into another project; `--name <name>` renames the server.
The app has the same thing behind a button: **Export → Do this from your editor**
(Cursor gets a one-click deeplink).

Check it without a client at all:

```bash
npx -y logolab try ./icon.png ./out
```

### From a checkout

A contributor wants their client running their working tree, not the release. The
same commands work with the entry point in place of the package, and `install`
notices which way it was started and writes the matching config:

```bash
node src/mcp/server.ts install     # writes {"command":"node","args":["…/src/mcp/server.ts"]}
pnpm mcp:try public/examples/petals.png ./out
```

TypeScript runs directly there (Node's type stripping), so there is still no build
step in the loop. `pnpm mcp:build` compiles [`packages/mcp`](../packages/mcp) when
you want to test the thing that actually ships.

### WebP inputs

The optional `sharp` decoder is an *optional peer* and is NOT installed with the
package — it pulls a platform-specific libvips binary that dwarfs the server (an
install goes 30 MB → 47 MB) for a format most callers never pass. If you need it:
`npm install sharp`. PNG, JPEG, GIF, BMP and SVG need nothing.

## Tools

### `make_app_icons` — the one that does the job

Trace, then export. Give it the image and where to put the icons.

```jsonc
{ "image": "art/icon.png", "outDir": "public", "presets": ["pwa"], "appName": "Acme" }
```

### `trace_icon` — just the SVG

Vectorizes to a clean, editable SVG (real region shapes and fitted curves — not an
embedded bitmap, not a pixel outline). Writes next to the source unless you pass
`out`. Reports paths / nodes / colours and the decisions it made.

### `export_icons` — collections from an existing logo

Takes an SVG (best: every size is rendered analytically, so a 16px favicon is
*drawn*) or a raster, and writes one or more collections.

| preset | what lands where |
| --- | --- |
| `pwa` | `public/` — favicon PNGs + `favicon.ico`, apple-touch, 192/512, maskable pair, `manifest.webmanifest`, `<head>` snippet |
| `favicon` | `public/` — the 16/32/48 set, `favicon.ico`, apple-touch, snippet |
| `web` | `public/` — the full catalogue, Windows tiles included |
| `tauri` | `src-tauri/icons/` — what `tauri icon` generates: PNGs, `icon.ico`, `icon.icns`, Windows Store logos |
| `electron` | `build/` — `icon.icns`, `icon.ico`, `build/icons/*.png` (electron-builder's layout) |
| `android` | `res/mipmap-*/` — launcher, round and adaptive foreground at every density, the v26 XML, the 512 Play icon |
| `ios` | `AppIcon.appiconset/` — every iPhone/iPad size + 1024 marketing icon + `Contents.json`, forced opaque |
| `extension` | `icons/` — 16/32/48/128 + the MV3 manifest fragment |

Plus `sizes: [64, 300]` for anything else, and `appearance` for the card:
`background`, `shape`, `radiusPct`, `paddingPct`, `scale`, `tintColor`, `invert`.
The default is deliberately nothing: full-bleed, transparent, no padding — a
generated icon already *is* the icon. Ask for a background and padding to get the
studio's card look.

Maskable and adaptive icons ignore that padding and use their own floor. Android
keeps only the centre **72dp of 108dp** — a circle of ~66% diameter — and art that
fills its box sits at the box's half *diagonal*, so those targets are full-bleed
with the mark clamped inside that circle. Same numbers as the UI: both renderers
read `iconLayout` from `src/lib/iconSpec.ts`.

### `split_icon_sheet` — a grid of icons on one canvas

What models actually return for "a set of icons". Detects the tiles (grid or free
layout), crops each with the sheet's own paper colour, and traces each with its own
plan — a one-ink glyph goes mono (one clean shape), a shaded badge goes colour.
Caption text is detected and *reported*, but not read: OCR is browser-only, so the
tab names icons from captions and this names them by position.

### `inspect_icon` — what would happen

Size, format, transparency, and the plan the tracer would use, without tracing.

## The decisions it makes for you

Every tool takes the same overrides (`mode`, `gradients`, `flattenOnto`,
`removeBackground`, `detail`, `smoothing`, `despeckle`, `fidelity`) and reports what
it chose, so an agent can overrule one thing without hand-tuning the rest:

- **colour vs mono** — the ink probe counts distinct inks. One ink on paper traces
  mono: one shape, a fraction of the nodes, no anti-alias slivers. Light ink on dark
  paper flips the cut (`invert`) instead of tracing the paper around a hole.
- **gradients** — probed from the pixels. Flat art traces flat; real ramps become
  real SVG gradients.
- **resolution** — flat art traces at 2048 (crisp corners, sub-pixel edges), gradient
  art at 1024 (the segmentation merge is superlinear). `detail: "high"` lifts the flat
  cap to 4096.
- **enlargement** — a small mono source is upscaled before tracing, because its
  anti-aliasing encodes sub-pixel coverage a pixel-lattice tracer cannot otherwise use.

## Layout

```
src/mcp/
  server.ts     tool definitions + the CLI (serve / install / try)
  trace.ts      auto-plan → traceTile (the app's own tile pipeline)
  render.ts     icon composition → resvg (the canvas renderer's headless twin)
  presets.ts    the collections, as data
  export.ts     render every size once, write the collection
  image.ts      decode in / encode out (PNG · resvg · sharp for WebP)
  icns.ts       the Apple container
  install.ts    write the client config
  sheet.ts      detect → crop → trace, per tile
```

Shared with the app rather than reimplemented: `src/lib/trace` (the tracer),
`src/lib/sheet` (tile planning, detection, cropping), `src/lib/iconSpec.ts` (icon
geometry, manifest, `.ico`). Tests: `test/mcp-icons.test.ts` (geometry + containers,
measured on rendered pixels) and `test/mcp-server.test.ts` (the protocol, over the
SDK's in-memory transport).

## Limits

- **Input**: PNG, JPEG, WebP, GIF, BMP, SVG. WebP needs the optional `sharp`
  decoder — `pnpm install` in the checkout brings it.
- **No OCR**: caption naming on sheets is browser-only (`tesseract.js`).
- **No AI cutout / upscale**: `removeBackground` here is the tracer's background
  layer, not the RMBG matting model in the app.
