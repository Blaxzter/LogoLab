// A content fingerprint of the tracing + scoring source. Any edit to the vectorizer or the
// scoring modules changes this string, which PREFIXES every lab cache key (see labCache.ts) —
// so a code change silently invalidates every cached result instead of ever serving a stale
// number. This is the "hash over the whole vectorizer" the cache is stamped with.
//
// Runtime, not a hand-bumped constant: `import.meta.glob(?raw)` hands us the SOURCE TEXT of
// every module (the same trick AbLab already uses for the snapshot manifest). In dev it updates
// via HMR the moment you edit a tracer file — the update bubbles through this module (it has no
// accept handler) and re-executes it, so you always see FRESH traces while iterating, which is
// the whole point of the labs. In a production build the glob folds to one deterministic
// constant. The raw source lands only in the lazy lab chunk (every lab is a React.lazy route),
// so the product bundle a visitor downloads is untouched.
//
// Scope is a deliberate SUPERSET — all of src/lib + src/devtest + the lab view layer, not just
// src/lib/trace: over-broad invalidation merely recomputes occasionally, but a MISSED
// invalidation serves a stale result, the one unacceptable outcome. So we err toward hashing too
// much. (src/devtest carries the scoring — geomScore, scoreboard, truthCorpus — whose output the
// labs also cache.)
//
// src/components/labs is in scope because the cached value is not just the raw trace/score: the
// labs bake PRESENTATION into it too — the panel-art SVG strings (wire.ts's `traceSvg`, the
// authored-node overlay, the raster/drop data URLs) are computed in `analyze()` and stored in
// the cache. When that generation changes but this hash does not, a browser holding an older
// cache entry renders the OLD art shape (e.g. a renamed field → an empty panel, or a
// non-scaling wireframe after the markers were made zoom-scaled). Clearing the cache hides it;
// widening the hash fixes it at the source. `.tsx` is included so the view components count.

const SOURCES = {
  ...import.meta.glob('/src/lib/**/*.ts', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob('/src/devtest/**/*.ts', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob('/src/components/labs/**/*.{ts,tsx}', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
} as Record<string, string>

/** FNV-1a over a string → 8 hex chars. The same hash devtest/metrics.ts uses for `hashDoc`. */
export function fnv1a(str: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * The vectorizer/scoring fingerprint — stable within a build, changes on any source edit.
 * Sorted by path so it is order-independent, then hashed over `path\0source\0…`.
 */
export const ENGINE_HASH: string = fnv1a(
  Object.keys(SOURCES)
    .sort()
    .map((p) => p + '\0' + SOURCES[p])
    .join('\0'),
)
