import { Link } from 'react-router-dom'
import { LAB_VIEWS } from '../navItems'

/** The labs' landing page: what each harness answers, and why you'd open it. */
export default function LabsIndex() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold tracking-tight text-ink">Under the hood</h1>
      <p className="mt-2 max-w-[70ch] text-sm leading-relaxed text-ink-2">
        The harnesses the vectorizer is built and tested against. They run the real tracer, in your
        browser, on the same corpora and the same gates the test suite uses — so what you see here is
        what CI measures. Nothing is precomputed.
      </p>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {LAB_VIEWS.map((v) => (
          <Link
            key={v.to}
            to={v.to}
            className="scene-card group flex gap-3 p-4 transition-colors hover:border-accent"
          >
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-3 text-muted transition-colors group-hover:bg-accent-soft group-hover:text-accent">
              {v.icon}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-ink">{v.label}</span>
              <span className="mt-1 block text-xs leading-relaxed text-muted">{v.blurb}</span>
            </span>
          </Link>
        ))}
      </div>

      <p className="mt-6 max-w-[70ch] text-xs leading-relaxed text-faint">
        Tracing is real work: a corpus takes seconds to a minute, and the labs trace one case at a
        time so the page stays responsive while it fills in.
      </p>
    </div>
  )
}
