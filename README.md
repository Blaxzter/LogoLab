<div align="center">

# 🔬 LogoLab

### Drop in a logo → preview it in real-world contexts → clean it up, vectorize it, and export a production-ready icon set.

**100% in your browser. No uploads, no backend, no sign-up.**

[**GitHub repo**](https://github.com/Blaxzter/LogoLab) · [Report an issue](https://github.com/Blaxzter/LogoLab/issues)

![LogoLab preview](docs/hero.png)

</div>

---

You just generated an app icon / logo with Midjourney, Gemini, DAL·E, or your favourite
vector tool — but does it actually *work*? Is it legible at 16px? Does that white line-art
mark disappear on a light nav bar? How does it look as an iOS app icon, or cropped into a
circular avatar?

**LogoLab** answers all of that in one place, then helps you ship the asset: remove the
junk background, trace it to a clean SVG, and export every favicon / PWA icon you need.

> No logo handy? Hit **Try an example logo** in the sidebar to load one of the built-in
> samples and play with every tool right away.

## ✨ Features

### 🖼️ Preview in real contexts
See your logo composited into **real device screenshots** (drag it into any app slot), plus
a desktop website nav, browser tabs & favicons, an app splash screen, an App Store listing,
a circular social avatar, and a size-&-contrast matrix (16 → 128px on light *and* dark).

- **Background card** — give a white / line-art logo a colored backplate (color, shape,
  radius, shadow). The classic "my logo vanishes on white" fix.
- **Recolor (tint)** — repaint a monochrome mark in any brand color via its alpha, plus
  one-click invert.
- **Light / dark** context toggle and a custom page background.
- **🎯 Live favicon** — the logo you're working on becomes this tab's favicon in real time.

### 🧽 Cleanup — background remover
A magic-wand / flood-fill eraser **plus hand brushes and an AI cutout** for AI-generated icons
that ship with a baked background.

![Cleanup](docs/cleanup.png)

- **One-click removers:** **Auto-remove** (floods the four corners) and **🤖 AI auto-remove** —
  a Hugging Face segmentation model (`briaai/RMBG-1.4`) that runs **entirely in your browser**
  and handles tricky backgrounds and the enclosed holes the corner flood can't reach. The model
  (~tens of MB) downloads on first use, then is cached & offline — nothing is ever uploaded.
- **Manual tools:** **Magic** (flood-fill a connected region), **By color** (key out one color
  everywhere), and **Erase / Restore** brushes — drag to rub out leftovers by hand or paint the
  original back where you went too far, with an adjustable brush size.
- **Tolerance** + **edge-softness** (anti-aliased cuts) + **defringe**, full **undo / redo**
  (incl. `Ctrl/⌘+Z` · `Ctrl/⌘+Shift+Z`) and **reset**.
- **Flip background** toggles the canvas between a light and dark transparency checkerboard, so
  white / light line-art logos stay visible while you work.
- **Apply** feeds the clean transparent PNG straight into preview, vectorize, and export.

### ✏️ Vectorize — a small in-browser vector studio
Professional **potrace**-based tracing (the same engine family behind classic
Illustrator/Affinity-style image trace) plus a node editor — all client-side.

![Vectorize](docs/vectorize.png)

- **Clean curves, not staircases:** color quantization → anti-aliasing cleanup → stacked
  per-color masks → potrace curve fitting per layer. Adjacent regions overlap instead of
  leaving hairline seams.
- **Color** or **mono** tracing with **colors**, **smoothing** (curve-fitting tolerance) and
  **despeckle** dials, optional **force color** and **remove background**.
- **Studio layout:** full-height workspace with **Split / Traced / Original / Overlay**
  (ghost) views, synced pan & zoom, and a paths panel (select, recolor, hide, delete).
- **Node editing, Affinity-style:** drag anchors & Bézier handles (smooth nodes mirror,
  `Alt` breaks symmetry), double-click a segment to add a node, double-click an anchor to
  toggle corner ↔ smooth, `Del` to remove, full **undo / redo**.
- Already-vector uploads can be **cleaned & edited directly** or re-traced from pixels.
- **Download** or **copy** the optimized SVG (precision control included).

### 📦 Export — favicons & PWA icons
Generate a complete, production-ready icon set as a single `.zip`.

![Export](docs/export.png)

- Favicons (incl. a real multi-size **`favicon.ico`**), Apple touch, Android / Chrome,
  **maskable** icons (with safe-zone), and Windows tiles.
- A `manifest.webmanifest` and a copy-paste `<head>` snippet.
- Presets (**Web essentials / Full PWA / Everything**) and a live preview that follows your
  sidebar appearance (card color, shape, radius, padding, scale, tint).

## 🚀 Getting started

```bash
pnpm install
pnpm dev        # http://localhost:5173
pnpm build      # type-check + production build → ./dist
pnpm preview    # preview the production build
```

> Uses **pnpm**, but `npm` / `yarn` work too.

## ☁️ Deploy to Cloudflare Pages

It's a static SPA — the build output is `dist/`.

**Dashboard (Git):** Workers & Pages → Create → Pages → Connect to Git, then:
- **Framework preset:** Vite
- **Build command:** `pnpm build`
- **Build output directory:** `dist`

**Wrangler (direct upload):**

```bash
pnpm build
pnpm dlx wrangler pages deploy dist --project-name logolab
```

No environment variables or server routes required.

## 🛠️ Tech

- **React 19** + **TypeScript** (strict) + **Vite 8**
- **Tailwind CSS v4** (CSS-first `@theme` design tokens)
- **Zustand** for state
- **esm-potrace-wasm** (potrace tracing engine, GPL-2.0, lazily `import()`-ed) · **JSZip**
  (export) · **lucide-react** (icons)
- **@huggingface/transformers** (Transformers.js) for the in-browser AI background remover —
  lazily `import()`-ed so it never weighs down the initial bundle.
- Everything runs client-side via the Canvas & DOM APIs.

## 📁 Project structure

```
src/
  components/
    scenes/        # preview mockups (DeviceMock, DesktopBrowser, AppStoreListing, …)
    panels/        # CleanupPanel, VectorizePanel, ExportPanel
    vectorize/     # the vectorize studio (EditorCanvas node editor, paths panel, controls)
    ui/            # Button + form controls
    LogoMark.tsx   # the single source of truth for rendering a logo (card/shape/tint)
  lib/
    bgRemove.ts    # flood-fill / color-key removal + erase/restore brushes
    aiRemove.ts    # lazy in-browser AI cutout (Transformers.js · RMBG-1.4)
    trace/         # potrace tracing pipeline (quantize → stacked masks → potrace WASM)
    path/          # editable vector model: SVG/path-d parser, serializer, Bézier node ops
    svgClean.ts    # SVG path rounding / optimization
    pwaExport.ts   # icon rendering, favicon.ico, manifest, zip
    image.ts       # loading, SVG rasterization, render sources
  hooks/
    useLiveFavicon.ts
  store.ts         # Zustand store (logo, appearance, environment, device placements)
public/mockups/    # device frames + screenshots used by the device previews
public/examples/   # built-in sample logos for the "Try an example" gallery
```

### How the device mockups work
Real device-frame PNGs have an opaque black screen, so LogoLab detects the screen region
(flood-fill from the center), **knocks it out** so the screenshot shows through, renders the
**bezel on top**, and draws a synthetic notch / punch-hole. Your logo is overlaid as a
draggable, resizable app icon. Drop in any frame + screenshot and it adapts — tune the
default icon placement in `defaultMockups` (`src/store.ts`).

## 📄 License

MIT — see [LICENSE](LICENSE).

---

<div align="center">
<sub>Built with <a href="https://claude.com/claude-code">Claude Code</a>.</sub>
</div>
