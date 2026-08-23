import { Columns2, Download, Eraser, Eye, FlaskConical, Gauge, Images, Layers, LayoutGrid, PenTool, Timer, Wand2 } from 'lucide-react'
import type { Tab } from '../store'

/** The panel tabs — shared by the desktop header nav and the mobile menu. */
export const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'preview', label: 'Preview', icon: <Eye size={15} /> },
  { id: 'cleanup', label: 'Cleanup', icon: <Eraser size={15} /> },
  { id: 'vectorize', label: 'Vectorize', icon: <Wand2 size={15} /> },
  // The general-purpose vector editor. It sits after Vectorize because that is
  // where its input usually comes from, but unlike every other tab it does NOT
  // work on the app's logo — it opens whatever you give it (see EditorPanel).
  { id: 'editor', label: 'Editor', icon: <PenTool size={15} /> },
  // A sheet is many logos at once, so it sits apart from the single-logo flow —
  // after the vectorizer it feeds, before the export it ends in.
  { id: 'sheet', label: 'Icon sheet', icon: <LayoutGrid size={15} /> },
  { id: 'export', label: 'Export', icon: <Download size={15} /> },
]

export const REPO_URL = 'https://github.com/Blaxzter/LogoLab'

/**
 * The vectorizer's harnesses — lazily-loaded React routes under `/labs` (see the
 * `<Suspense>` block in App.tsx; the chunks they pull in, tracer + scoring modules
 * included, stay out of the main bundle).
 *
 * ONE LAB, ONE QUESTION. The Workbench asks "is the trace correct?" of a switchable corpus
 * and never changes shape; anything that can't be asked of every corpus is its own lab
 * instead. (They were briefly a corpus × lens matrix — the available comparisons mutated
 * when you switched corpus, so the view's meaning changed under you. Don't do that again.)
 * Kept here so the header popover, the mobile menu and the labs index list the same set.
 */
export const LAB_VIEWS: { to: string; label: string; blurb: string; icon: React.ReactNode }[] = [
  {
    to: '/labs/pipeline',
    label: 'Pipeline debug',
    blurb: 'Every intermediate stage: smoothing, discontinuity, regions, paints.',
    icon: <Layers size={15} />,
  },
  {
    to: '/labs/ab',
    label: 'Feature A/B',
    blurb: 'Trace variants side by side, synced pan/zoom, nodes/edges overlay.',
    icon: <Columns2 size={15} />,
  },
  {
    to: '/labs/workbench',
    label: 'Workbench',
    blurb: 'Is it correct? Scored against the authored SVG — boundary error, node economy, dropped regions. Pick the corpus.',
    icon: <FlaskConical size={15} />,
  },
  {
    to: '/labs/gallery',
    label: 'Gallery',
    blurb: 'How the tracer renders art it can’t be scored on: the brand-logo set, and anything you drop in.',
    icon: <Images size={15} />,
  },
  {
    to: '/labs/scoreboard',
    label: 'Engine scoreboard',
    blurb: 'potrace vs crisp: ΔE, SSIM, seam, node counts, runtime, determinism.',
    icon: <Gauge size={15} />,
  },
  {
    to: '/labs/profiler',
    label: 'Profiler',
    blurb: 'Where the trace spends its time, and what each optional feature would cost to enable.',
    icon: <Timer size={15} />,
  },
]

/** Support links — surfaced together in the header's support popover. */
export const COFFEE_URL = 'https://www.buymeacoffee.com/fabraham'
export const SPONSOR_URL = 'https://github.com/sponsors/Blaxzter'

/** Brand-fidelity GitHub glyph (the lucide build here ships no Github icon). */
export function GithubMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z"
      />
    </svg>
  )
}
