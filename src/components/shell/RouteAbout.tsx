import { Fragment } from 'react'
import { ROUTE_PAGES } from '../../lib/seo/routeCopy.ts'

/** The copy's one tag: `<strong>Label:</strong> rest` → bold label, plain rest. */
function Rich({ html }: { html: string }) {
  return (
    <>
      {html.split(/<strong>(.*?)<\/strong>/).map((part, i) =>
        // split with one capture group alternates text, bold, text, …
        i % 2 ? (
          <strong key={i} className="font-medium text-ink-2">
            {part}
          </strong>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  )
}

/**
 * What this tool is, in words, under the panel: the same copy the build puts in
 * the route's static HTML (src/lib/seo/routeCopy.ts). That static copy is gone
 * once the app renders, and Google indexes the RENDERED page — mobile first, so
 * this follows the footer's visibility rather than having its own. Without it
 * a studio route reads as "drop a file" and little else.
 */
export function RouteAbout({ path, className = '' }: { path: string; className?: string }) {
  const page = ROUTE_PAGES.find((p) => p.path === path)
  if (!page) return null
  return (
    <section className={`mx-auto w-full max-w-2xl px-4 pt-10 pb-2 text-xs leading-relaxed text-muted ${className}`}>
      <h2 className="mb-2 text-sm font-semibold text-ink-2">{page.h1}</h2>
      <p>
        <Rich html={page.intro} />
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-4">
        {page.points.map((point) => (
          <li key={point}>
            <Rich html={point} />
          </li>
        ))}
      </ul>
    </section>
  )
}
