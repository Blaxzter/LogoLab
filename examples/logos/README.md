# Ground-truth logo corpus

A local set of ~150 real, authored brand-logo **SVGs** used as the "answer sheet"
for the vectorizer: each is rasterized, traced, and the tracer's output is scored
against the original. Cases the tracer can't handle well yet (heavy strokes,
gradients, letterforms, filters) are deliberately included as future targets.

## The `.svg` files are not committed — fetch them on demand

Only [`manifest.json`](./manifest.json) and the fetcher
([`scripts/fetch-logos.mjs`](../../scripts/fetch-logos.mjs)) live in git. The
brand-mark artwork itself is **not redistributed** in this public repo — the marks
are trademarks of their owners and the copyright status of many is unclear. Instead,
rehydrate the set locally from the recorded sources:

```bash
npm run fetch:logos                    # download everything listed in manifest.json
node scripts/fetch-logos.mjs --force   # re-download even if files already exist
node scripts/fetch-logos.mjs bmw visa  # only entries matching a filter
```

The files land next to this README in `examples/logos/`, which is git-ignored
(`/examples/logos/*.svg`), so they never get committed back.

## manifest.json

One object per logo:

```json
{
  "file": "bmw.svg",
  "company": "BMW",
  "source_url": "https://commons.wikimedia.org/wiki/File:BMW.svg",
  "license": "Public domain",
  "notes": "gradient, stroked, clip/mask, complex"
}
```

- **source_url** — where to re-download / verify the file. svgl.app and
  vectorlogo.zone URLs point straight at the `.svg`; Wikimedia Commons URLs point
  at the `File:` description page (the fetcher resolves it to the raw file via
  `Special:FilePath`).
- **license** — as stated by the source. Wikimedia entries carry the real per-file
  licence (e.g. `Public domain`, `CC BY 2.5`, `MPL 2`); svgl/vlz entries are
  `unknown (brand trademark; via …)` — keep `source_url` to check later.
- **notes** — auto-detected traits: `gradient`, `stroked`, `filter`, `clip/mask`,
  `wordmark`/`full logo`, colour count, and a rough complexity tier
  (`simple` / `medium` / `complex`).

## Sources & composition (~152 entries)

| Source | Count | Character |
|--------|-------|-----------|
| [svgl.app](https://svgl.app) | ~70 | curated full-colour tech/brand marks, spread across categories |
| [vectorlogo.zone](https://www.vectorlogo.zone) | ~45 | recognizable brands, biased to full logos (mark + wordmark) |
| [Wikimedia Commons](https://commons.wikimedia.org) | ~37 | famous cross-industry brands (automotive, food, finance, apparel, logistics, media) |

Rough spread: simple ~68 / medium ~38 / complex ~46; ~40 with gradients, ~15
stroked, ~17 with clip/mask, ~51 wordmark/letterform. Note that authored logos
outline their text to paths (no live `<text>` elements) — which is also what keeps
the rasterized ground truth font-independent and deterministic.

## Licensing note

These files are collected for **private, local** benchmarking of the tracer, not for
redistribution. Local analytical use of a trademarked logo does not implicate
trademark law (no use in commerce, no implied endorsement). Publishing the bulk
artwork would be a different matter — which is exactly why only the manifest and
fetcher are tracked here.
