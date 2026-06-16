# LogoLab — Launch Kit

Ready-to-paste copy for promoting LogoLab. The live URL
(**https://logolab.fabraham.dev**) is already filled into the copy below. Delete this
file whenever you like — it's just scaffolding.

Positioning pillars to keep hitting:
1. **Free + 100% in your browser** — no uploads, no backend, no sign-up.
2. **Solves a real, growing pain** — "I generated a logo with AI; now make it actually work and ship the icons."
3. **Real technical depth** — client-side reimplementations of published CG research (Adobe 2025 Image Trace, Mumford–Shah, RMBG-1.4, etc.).

---

## 0. Pre-launch checklist (do these first)

Every channel below links to a **live tool you can try in 2 seconds** and shows a
**link preview card** when pasted — those two things are the whole conversion
mechanism, so get them right before posting anywhere.

### A. Live demo URL — ✅ deployed
Live at **https://logolab.fabraham.dev** (Cloudflare Pages).
- [ ] Put the live link at the **top of the README** (it currently links the repo, not
      a runnable demo) and set the GitHub repo **"About" → Website** to it.
- [ ] Sanity-check the **AI background remover on the deployed origin** — Hugging Face
      hotlink-protection 404s model files when a third-party `Referer` is sent; the
      `<meta name="referrer" content="no-referrer">` fix is already in `index.html`, so
      just confirm an AI cutout actually runs on prod.

### B. Open Graph / Twitter Card tags — ⚠️ TODO (highest-leverage fix)
Without these, pasting the link on HN, Reddit, X, Bluesky, Discord, Slack or LinkedIn
shows a **bare text link with no image** — a big click-through killer for a visual tool.
Add to `index.html` `<head>`:

```html
<meta property="og:type" content="website" />
<meta property="og:url" content="https://logolab.fabraham.dev/" />
<meta property="og:title" content="LogoLab — preview, clean up & vectorize your logo, 100% in-browser" />
<meta property="og:description" content="Drop in a logo, preview it in real-world contexts, remove the background, trace it to clean SVG, and export PWA-ready icons. No uploads, no sign-up." />
<meta property="og:image" content="https://logolab.fabraham.dev/og.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="LogoLab — preview, clean up & vectorize your logo, 100% in-browser" />
<meta name="twitter:description" content="Preview a logo in real contexts, remove the background, vectorize to SVG, export favicons & PWA icons. Free, runs entirely in your browser." />
<meta name="twitter:image" content="https://logolab.fabraham.dev/og.png" />
<link rel="canonical" href="https://logolab.fabraham.dev/" />
```

- [ ] Create **`public/og.png` at 1200×630** (crop/pad `docs/hero.png` to that ratio).
- [ ] After deploying, validate the card with a debugger (opengraph.xyz, the X card
      validator) — preview caches are sticky, so check before the big posts.

### C. Privacy-friendly analytics — so you can measure the launch
**Cloudflare Web Analytics** is free, cookieless, needs no consent banner, and fits the
"no uploads, no tracking" ethos. Since it's already on Cloudflare Pages you can enable it
in the dashboard with no code.

### D. First-run friction
Cold traffic won't have a logo handy — the **"Try an example"** path is what converts
them. Make sure it's obvious and loads instantly.

### E. Mobile — ✅ done
The whole app is now responsive (phones + tablets, studios included) — this was a launch
blocker (a borked phone layout), now resolved. The `feat/mobile-responsive` work is
**merged into `main`** (PR #4).

### F. Hygiene / nice-to-haves
- [ ] Confirm the dev-only `vectorize-debug.html` / `vectorize-test.html` are **not** in
      the production `dist/` (default Vite only bundles `index.html`, so likely fine —
      just glance).
- [ ] Record a short **screen capture** (drop → AI-remove → vectorize → export) for the
      Product Hunt gallery and the X thread.
- [ ] Add the **GitHub repo topics** from §5 so it surfaces in search.

---

## 1. Hacker News — Show HN

**Title** (keep under 80 chars, no "free", no hype words — HN dislikes them):

```
Show HN: LogoLab – preview, clean up and vectorize logos, 100% in the browser
```

**URL:** `https://logolab.fabraham.dev`

**First comment** (post immediately after submitting):

```
Author here. I kept generating app icons / logos with AI image tools and then
hitting the same wall: is this legible at 16px? Does the white line-art vanish on
a light nav bar? How do I strip the baked-in background, and how do I turn it into
a clean SVG + a full favicon/PWA icon set? LogoLab does that whole chain in one
page.

Everything runs client-side — the image never leaves your machine. No backend, no
upload, no sign-up. The AI background remover (BRIA RMBG-1.4) runs in-browser via
Transformers.js (WebGPU, WASM fallback); the model downloads once (~tens of MB),
then caches and works offline.

The part I had the most fun with is the vectorizer. Instead of the classic
posterize-then-trace pipeline, it's "structure-first": segment by smoothness → fit
a paint model (solid / linear / radial / glow) per region via MDL → trace once →
beautify. It's a logo-scale reimplementation of Adobe's 2025 gradient-aware Image
Trace paper, plus a real-time discrete Mumford–Shah solver, Schneider Bézier
fitting with soft-corner detection, and shape-snapping. Full bibliography with
links is in the README.

Stack: React 19 + TS (strict), Vite, Tailwind v4, Zustand. MIT licensed.
Repo: https://github.com/Blaxzter/LogoLab

Happy to go into any of the algorithms — the discrete Mumford–Shah and the
translucent-layer decomposition were the trickiest to get right in the browser.
```

Tips: post Tue–Thu, ~8–10am ET. Stay in the thread for the first few hours and
answer every technical question — that's what keeps it on the front page.

---

## 2. Product Hunt

**Name:** LogoLab

**Tagline** (60 char max):

```
Preview, clean up & vectorize your logo — 100% in-browser
```

Alt taglines:
- `Make your AI-generated logo actually ship-ready` (47)
- `Clean up, vectorize & export logos, no upload needed` (52)

**Description:**

```
You generated a logo with Midjourney, Gemini or DALL·E — but does it actually work?
Is it legible at 16px? Does it disappear on a white nav bar? LogoLab answers that and
then ships the asset.

Drop in a logo and:
• Preview it in real device screenshots, browser tabs, an App Store listing, a
  circular avatar, and a 16→128px light/dark contrast matrix.
• Clean it up — magic-wand + brush erasers, color keying, and an in-browser AI
  background remover (RMBG-1.4) for AI icons with baked-in backgrounds.
• Vectorize it — a structure-first tracer that rebuilds gradients and translucency
  as real editable SVG layers, with an Affinity-style node editor.
• Export a complete favicon + PWA icon set (incl. a real multi-size favicon.ico),
  manifest, and copy-paste <head> snippet — as one zip.

Everything runs in your browser. No uploads, no backend, no sign-up. Open source (MIT).
```

**First comment / maker comment:**

```
Maker here 👋 I built LogoLab because every time I made an icon with an AI tool I had
to bounce between remove.bg, a vectorizer, and a favicon generator — all of which
upload your image to a server. LogoLab does the whole pipeline locally in the browser,
including the AI cutout (Transformers.js + WebGPU). It started as a "does my logo work
at small sizes" previewer and grew into a tiny vector studio.

The vectorizer is a client-side reimplementation of Adobe's 2025 gradient-aware Image
Trace paper — the README has the full list of papers behind it. Would love feedback,
especially on tricky logos. No account needed, just drop one in (or hit "Try an
example").
```

**Topics:** Design Tools, Developer Tools, Open Source, Artificial Intelligence,
Icons & Logos, Productivity

**Gallery:** lead with a short screen-recording GIF/MP4 of dropping a logo → AI
remove → vectorize → export, then the 4 doc screenshots (hero, cleanup, vectorize,
export).

Tips: launch 12:01am PT. Have a handful of people ready to try it and comment with
genuine feedback (not just "congrats").

---

## 3. Reddit

> Read each sub's self-promo rules first. Reddit punishes link-drops — these are
> written as stories, lead with the value, link once. Reply to comments fast.

### r/SideProject  /  r/webdev

**Title:**
```
I built a 100% in-browser tool to preview, clean up and vectorize logos (no uploads, open source)
```

**Body:**
```
I kept generating logos/app icons with AI and hitting the same chores: check if it's
legible at 16px, strip the baked-in background, trace it to a clean SVG, and spit out
every favicon/PWA icon. So I built LogoLab to do the whole chain in one page —
entirely client-side, so the image never leaves your machine. No backend, no sign-up.

- Preview in real device mockups, browser tabs, App Store, avatar, light/dark matrix
- Background remover: magic-wand + brushes + an in-browser AI cutout (RMBG-1.4 via
  Transformers.js / WebGPU)
- Vectorizer: structure-first tracer (a client-side take on Adobe's 2025 Image Trace
  paper) with a node editor
- Export: full favicon + PWA icon set + manifest as a zip

React 19 + Vite + Tailwind, MIT licensed. There's a "Try an example" button if you
don't have a logo handy.

Live: https://logolab.fabraham.dev
Code: https://github.com/Blaxzter/LogoLab

Would love feedback — particularly on logos that trace badly, so I can improve the
vectorizer.
```

### r/Midjourney  /  r/StableDiffusion  /  r/DALLE2  /  r/aiArt  (your sharpest audience)

**Title:**
```
Made a logo with AI? Here's a free browser tool to strip the background, check it's legible at small sizes, and export every favicon
```

**Body:**
```
AI logo generators are great until you try to *use* the output — it comes with a
baked-in background, you have no idea if it reads at 16px, and you still need a clean
SVG + favicons.

I made LogoLab to fix exactly that. Drop in your generated logo and:
- AI background remover that runs in your browser (nothing uploaded)
- See it composited into real phone/app/browser/avatar mockups + a tiny-size contrast
  grid so you know if it actually reads
- Trace it to a clean, editable SVG
- Export a full favicon / PWA icon pack as a zip

Free, no sign-up, open source. There's a built-in example logo to play with first.

https://logolab.fabraham.dev
```

### r/InternetIsBeautiful (interactive demos do great here)

**Title** (this sub wants the title to describe the thing plainly):
```
A free tool that previews your logo on real devices, removes its background with in-browser AI, and vectorizes it to SVG — all without uploading anything
```
**Body:** one or two lines + `https://logolab.fabraham.dev`. This sub is link-first; keep it short.

---

## 4. X / Twitter + Bluesky (thread)

**Post 1:**
```
I built LogoLab — drop in a logo and preview it on real devices, remove the
background with in-browser AI, vectorize it to clean SVG, and export every
favicon/PWA icon.

100% in your browser. No uploads, no sign-up. Open source.

🔗 https://logolab.fabraham.dev
[attach the demo GIF]
```

**Post 2:**
```
The fun part: the vectorizer doesn't posterize-then-trace. It's "structure-first" —
segment by smoothness, fit a paint model (solid/linear/radial/glow) per region, trace
once, beautify. A client-side reimplementation of Adobe's 2025 Image Trace paper.
```

**Post 3:**
```
The AI background remover (BRIA RMBG-1.4) runs locally via @huggingface
Transformers.js — WebGPU with a WASM fallback. Model downloads once, then caches &
works offline. Your image never touches a server.
```

**Post 4:**
```
Built with React 19, Vite, Tailwind v4, Zustand. MIT licensed.
Code 👉 https://github.com/Blaxzter/LogoLab
Feedback very welcome — especially logos that trace badly.
```

Tag/notify: @huggingface and the Transformers.js author — in-browser ML demos get
amplified there.

---

## 5. Directories / AlternativeTo

**Short description (~60 chars):**
```
Free in-browser logo previewer, background remover & vectorizer
```

**Listing blurb:**
```
LogoLab is a free, open-source, 100%-in-browser tool to preview a logo in real-world
contexts (devices, favicons, app store, avatars), remove its background (manual tools
+ in-browser AI), vectorize it to clean editable SVG, and export a complete favicon /
PWA icon set. No uploads, no backend, no sign-up.
```

**List it as an alternative to:** remove.bg, vectorizer.ai, favicon.io,
realfavicongenerator.net, Photopea (partial).

**Submit to:** AlternativeTo, BetaList, Peerlist, Uneed, TinyLaunch, SaaSHub,
Toolfolio, and any "free design tools" / "no-signup tools" roundups.

**GitHub repo polish:** set the "About" website to `https://logolab.fabraham.dev`; add topics:
`favicon-generator`, `vectorizer`, `background-removal`, `svg`, `pwa`,
`transformers-js`, `webgpu`, `client-side`, `react`, `image-tracing`.

---

## 6. dev.to / Hashnode — technical post (doubles as r/programming + HN fuel)

**Working titles:**
- `I reimplemented Adobe's 2025 Image Trace paper in the browser`
- `Structure-first image vectorization, client-side: segment → fit → trace → beautify`
- `Running a saliency segmentation model in the browser to remove logo backgrounds`

**Outline:**
1. The problem — AI-generated logos aren't ship-ready; tools that fix them upload your image.
2. Why client-side — privacy, offline, zero infra. The trade-offs.
3. The vectorizer pipeline, stage by stage (structure-first vs posterize-then-trace),
   with before/after images. Pull the references straight from the README's
   "Algorithms & papers" table.
4. The hard parts: real-time discrete Mumford–Shah in JS, translucent-layer
   decomposition, soft-corner Bézier fitting.
5. The in-browser AI cutout: Transformers.js + RMBG-1.4, WebGPU→WASM, the
   HF-referrer gotcha that broke it in prod and the one-line `<meta referrer>` fix.
6. Wrap-up + link to the live tool and repo.

Cross-post to dev.to, Hashnode, your blog → then submit the canonical post to HN as a
regular link and to r/programming / r/webdev.
