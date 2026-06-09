<div align="center">

# 🔬 LogoLab

### Drop in a logo → preview it in real-world contexts → clean it up, vectorize it, and export a production-ready icon set.

**100% in your browser. No uploads, no backend, no sign-up.**

![LogoLab preview](docs/hero.png)

</div>

---

You just generated an app icon / logo with Midjourney, Gemini, DAL·E, or your favourite
vector tool — but does it actually *work*? Is it legible at 16px? Does that white line-art
mark disappear on a light nav bar? How does it look as an iOS app icon, or cropped into a
circular avatar?

**LogoLab** answers all of that in one place, then helps you ship the asset: remove the
junk background, trace it to a clean SVG, and export every favicon / PWA icon you need.

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
A magic-wand / flood-fill eraser for AI-generated icons that ship with a baked background.

![Cleanup](docs/cleanup.png)

- **Auto-remove** (samples the corners), **Magic** (flood-fill a region), and **By color**
  (key out one color everywhere).
- **Tolerance** + **edge-softness** (anti-aliased cuts) + **defringe**, with undo / reset.
- **Apply** feeds the clean transparent PNG straight into preview, vectorize, and export.

### ✏️ Vectorize — raster → clean SVG
In-browser tracing (no server round-trip) with path simplification and cleanup.

![Vectorize](docs/vectorize.png)

- **Color** or **mono** tracing, **simplify** + **precision** controls, optional **force color**
  and **remove background**.
- Side-by-side original / traced preview with path count, color count, and before → after size.
- **Download** or **copy** the optimized SVG.

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
- **imagetracerjs** (vectorize) · **JSZip** (export) · **lucide-react** (icons)
- Everything runs client-side via the Canvas & DOM APIs.

## 📁 Project structure

```
src/
  components/
    scenes/        # preview mockups (DeviceMock, DesktopBrowser, AppStoreListing, …)
    panels/        # CleanupPanel, VectorizePanel, ExportPanel
    ui/            # Button + form controls
    LogoMark.tsx   # the single source of truth for rendering a logo (card/shape/tint)
  lib/
    bgRemove.ts    # flood-fill / color-key background removal
    vectorize.ts   # imagetracerjs wrapper
    svgClean.ts    # SVG path rounding / optimization
    pwaExport.ts   # icon rendering, favicon.ico, manifest, zip
    image.ts       # loading, SVG rasterization, render sources
  hooks/
    useLiveFavicon.ts
  store.ts         # Zustand store (logo, appearance, environment, device placements)
public/mockups/    # device frames + screenshots used by the device previews
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
