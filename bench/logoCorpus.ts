// The private ground-truth BRAND-LOGO corpus — real, authored company logos used as an
// "answer sheet" for the tracer (rasterize → trace → compare to the art that made the pixels).
//
// The .svg files live in examples/logos/ and are GIT-IGNORED (brand trademarks, not
// redistributed — see examples/logos/README.md). They are pulled in here with
// import.meta.glob, exactly like AbLab's snapshot bundle:
//
//   • locally, after `npm run fetch:logos`, the glob bundles every file → the corpus is full;
//   • in a clean / CI / production build the directory is empty, the glob yields {} → the
//     corpus is EMPTY and the Logo-corpus lab gates itself off. No 404, no runtime fetch of
//     brand art from a public deployment.
//
// So this is a DEV-ONLY corpus by construction: present when a developer has fetched it,
// absent everywhere it would otherwise get published.

export interface LogoEntry {
  file: string
  company: string
  source_url: string
  license: string
  notes: string
}

export interface LogoCase extends LogoEntry {
  /** Raw authored SVG markup (bundled via import.meta.glob `?raw`). */
  svg: string
}

const MANIFEST = import.meta.glob('/examples/logos/manifest.json', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const SVGS = import.meta.glob('/examples/logos/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const entries: LogoEntry[] = (() => {
  const raw = Object.values(MANIFEST)[0]
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as LogoEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
})()

/** Manifest entries paired with their bundled SVG text, in manifest (alphabetical) order.
 *  Entries whose file didn't bundle are dropped, so the list is always renderable. */
export const LOGO_CORPUS: LogoCase[] = entries
  .map((e): LogoCase | null => {
    const svg = SVGS[`/examples/logos/${e.file}`]
    return svg ? { ...e, svg } : null
  })
  .filter((c): c is LogoCase => c !== null)

/** False in any build where the git-ignored corpus wasn't fetched (CI, production). */
export const LOGO_CORPUS_AVAILABLE = LOGO_CORPUS.length > 0
