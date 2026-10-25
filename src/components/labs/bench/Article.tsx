import { Link } from 'react-router-dom'
import { ExternalLink } from '../../ui/icons'
import { TOOL_REFS, toolInfo, toolRef } from './benchData'
import { Figure, Section } from './articleParts'
import { SHOWCASE as data } from './showcase.generated'
import type { ShowExample, ShowMetrics } from './showcaseTypes'

/**
 * The Overview tab of /labs/bench: why the published image-to-SVG benchmarks cannot tell a
 * good SVG from a bad one, argued with real outputs. /benchmark redirects here.
 *
 * It is the one tab that works on the hosted site. Everything in it is a frozen slice of one
 * bench/compare run: the SVGs in public/benchmark/ and the numbers in showcase.generated.ts,
 * both written by bench/compare/showcase.ts. Nothing is traced or scored here; the other tabs
 * read a local run in full. The node dots and the red rings are the anchors and the tangent
 * breaks the scorer counted (overlay.ts), so a ring on the picture is a unit in the table.
 */

type Example = ShowExample

const label = (tool: string) => toolInfo(tool).label
const byslug = (slug: string): Example => {
  const e = data.examples.find((x) => x.slug === slug)
  if (!e) throw new Error(`showcase: no example ${slug}`)
  return e
}

interface Row {
  key: string
  label: string
  better: 'lower' | 'higher'
  digits: number
}

const shush = byslug('shushing-face')
const crystal = byslug('crystal-ball')
const n = (m: ShowMetrics, k: string): number | null => (typeof m[k] === 'number' ? (m[k] as number) : null)
/** How many times tool `b`'s metric is tool `a`'s, to one decimal — the prose quotes the data. */
const times = (e: Example, k: string, a = 0, b = 1): string =>
  ((n(e.tools[b].metrics, k) ?? Number.NaN) / (n(e.tools[a].metrics, k) ?? Number.NaN)).toFixed(1)
/** A tool's median over the run, as the results table prints it. */
const medianOf = (tool: string, k: string): string => {
  const v = data.summary.find((s) => s.tool === tool)?.median[k]
  return typeof v === 'number' ? String(Math.round(v)) : '—'
}
const dino = (e: Example, i: number): string => (n(e.tools[i].metrics, 'sbDino') ?? Number.NaN).toFixed(4)

export function Article({ onExplore }: { onExplore?: () => void }) {
  const hero = byslug('smiling-face')
  return (
    <div>
      <article className="mx-auto max-w-5xl px-4 pb-16 pt-6 sm:px-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-accent">Benchmark</p>
        <h1 className="mt-2 max-w-[22ch] text-3xl font-bold tracking-tight text-ink sm:text-4xl">
          Pixel scores can’t see the SVG
        </h1>
        <p className="mt-4 max-w-[68ch] text-[0.95rem] leading-relaxed text-ink-2">
          The published image-to-SVG benchmarks render each tool’s SVG back to pixels and compare pictures. On flat
          icons that comparison saturates: two files can differ three- or four-fold in nodes, with visibly different
          curves, and get the same score. So we also score the <em>drawing</em>, against the vector art the image was
          rendered from. Every example below is a real output, and two of them are cases LogoLab gets wrong.
        </p>

        <Figure
          example={hero}
          initialMode="nodes"
          caption={
            <>
              Three traces of the same emoji. The DINO score, the headline metric of StarVector’s SVG-Bench, gives them
              0.9999, 0.9998 and 0.9996. The artist drew it with {hero.authoredNodes.length / 2} nodes; the traces use{' '}
              {hero.tools.map((t) => n(t.metrics, 'docNodes')).join(', ')}, and VTracer puts{' '}
              {n(hero.tools[1].metrics, 'tangentBreaks')} kinks (red rings) on curves the artist drew smooth.{' '}
              {n(hero.tools[0].metrics, 'tangentBreaks')
                ? `LogoLab has ${n(hero.tools[0].metrics, 'tangentBreaks')}.`
                : 'LogoLab has none: where the mouth meets the blush, its outline runs through the point as drawn.'}{' '}
              StarVector uses the fewest nodes and has the outline furthest from the drawing. Scroll over a panel to
              zoom, and drag to look around.
            </>
          }
        />

        <Section title="What the standard benchmarks measure">
          <p>
            <a
              className="text-accent underline-offset-2 hover:underline"
              href="https://arxiv.org/abs/2312.11556"
              target="_blank"
              rel="noreferrer"
            >
              StarVector’s SVG-Bench
            </a>{' '}
            (CVPR 2025) is the benchmark image-to-SVG papers report against. It rasterizes the generated SVG and the
            source, and compares the two images with four numbers, plus the SVG’s token count:
          </p>
          <ul>
            <li>MSE and SSIM measure pixel and structural difference.</li>
            <li>LPIPS is a distance between deep-network features, tuned to how people judge similar photos.</li>
            <li>
              The DINO score is the cosine similarity of DINOv2 embeddings, from a network trained to recognise what is
              in an image.
            </li>
          </ul>
          <p>
            All four ask whether the rendered picture looks like the source picture, which is the right question for a
            photo. A vector file can pass it with three times the nodes it needs, a circle rebuilt as a lumpy polygon,
            or curves that meet at a kink, and none of the four numbers moves much. DINO was trained to recognise
            objects, and it will recognise a bat in grey or in black.
          </p>
        </Section>

        <Section title="Same score, worse drawing">
          <p>
            On the shushing face, DINO scores the two traces {dino(shush, 0)} and {dino(shush, 1)}, a difference too
            small to mean anything, and LPIPS is just as close. Measured against the authored outline, VTracer’s edges
            are {times(shush, 'chamfer')}× further off, and its file has {n(shush.tools[1].metrics, 'tangentBreaks')}{' '}
            kinks on curves that have none (LogoLab’s has {n(shush.tools[0].metrics, 'tangentBreaks')}).
          </p>
          <Figure example={shush} />
          <p>
            On the crystal ball, DINO and LPIPS both rank VTracer first, although its trace has{' '}
            {times(crystal, 'docNodes')}× the nodes and {times(crystal, 'chamfer')}× the edge error.
          </p>
          <Figure example={crystal} />
        </Section>

        <Section title="A black silhouette scores 0.967">
          <p>
            SVG-Bench runs Potrace the way Potrace works, on an image cut to black and white first. Every colour on this
            leg is wrong (ΔE 15, where 1 is barely visible), and DINO still gives it 0.967, higher than StarVector’s
            median across the whole set (0.930). StarVector’s own trace of the leg scores 0.998 with its outline 3.3 px
            from the drawing.
          </p>
          <Figure example={byslug('leg')} />
        </Section>

        <Section title="Where LogoLab loses">
          <p>
            Before it traces, LogoLab decides whether an image is one ink on a page, which it traces in Mono, or several
            colours. Its three largest edge errors on this set come from that decision. The Japanese flag is a pale grey
            rectangle on a white page, and LogoLab reads both as the page. The colours come out nearly right (ΔE 1.7),
            but the flag’s outline is missing: 18 px of edge error, against VTracer’s 0.5.
          </p>
          <Figure example={byslug('flag')} />
          <p>
            The shrimp is drawn in several shades of red, which LogoLab takes for one ink, so two of its four shapes are
            missing (ΔE 2.2 against VTracer’s 1.1). The worm fails the same way. Traced in colour, LogoLab gets all
            three right, with edge errors of 0.07, 0.35 and 0.36 px. These three cases are why LogoLab’s mean edge error
            is not significantly better than VTracer’s, although its median is.
          </p>
          <Figure example={byslug('shrimp')} />
          <p>
            LogoLab’s traces still have kinks: a median of {medianOf('logolab-auto', 'tangentBreaks')} per emoji,
            against VTracer’s {medianOf('vtracer-default', 'tangentBreaks')}. LogoLab traces an emoji as tiles that
            share their edges, so where three colours meet, every outline through that point has a node on it. At such a
            point the tracer works out which shape is in front and keeps that shape’s outline smooth, and where a
            straight edge runs into a curve, the curve leaves in the line’s direction. Most of the kinks left are at
            points where three colours meet on a pixel corner.
          </p>
        </Section>

        <Section title="What we measure instead">
          <p>
            Every case comes with the SVG the artist drew. Each tool traces a raster of it, and its output is scored
            against that drawing as well as against the picture:
          </p>
          <ul>
            <li>Colour error (ΔE) is the mean CIE colour difference of the render. Under 1 is invisible.</li>
            <li>
              Edge error is the mean distance between the traced outline and the authored one, measured both ways, in
              pixels of a 512 px render.
            </li>
            <li>
              Nodes are counted against the artist’s count, because they are what you edit and what the file weighs.
            </li>
            <li>
              A kink on a smooth curve is a corner of 5° or more where the drawing is smooth. You won’t see one at icon
              size, but you will when you scale the file up or edit it. A corner the artist drew, traced a few pixels
              from where it belongs, is not a kink: the edge error already counts it.
            </li>
            <li>
              Invented corners are sharp corners the art doesn’t have, and regions recovered counts the shapes that
              survived the trace.
            </li>
          </ul>
          <p>The SVG-Bench metrics are measured on the same renders and reported next to these.</p>
        </Section>

        <Section title={`Results on ${data.cases} held-out emoji`}>
          <p>
            Medians over {data.cases} Twemoji from SVG-Bench’s own <code>svg-emoji</code> test split, chosen by a fixed
            rule (fill-only, one per base emoji, in hash order). LogoLab was never tuned on them.
          </p>
          <ResultsTable />
          <PairedNote />
        </Section>

        <Section title="Tools compared">
          <ToolsList />
        </Section>

        <Section title="How it was run">
          <ul>
            <li>
              The data is <code>{data.dataset.id}</code> @ <code>{data.dataset.revision.slice(0, 12)}</code>,{' '}
              {data.dataset.split} split, parquet sha256 <code>{data.dataset.parquetSha256.slice(0, 16)}…</code>. Each
              SVG rendered with resvg on white at {data.res} px; every tool gets that same image.
            </li>
            <li>
              Tools:{' '}
              {Object.entries(data.versions)
                .map(([t, v]) => `${label(t)} (${v.replace(/\. Copyright.*?Selinger\./, '')})`)
                .join('; ')}
              .
            </li>
            <li>
              LogoLab runs as its MCP server ships, with no per-image tuning. VTracer runs at its defaults and at the
              best of a 54-configuration sweep picked on the in-sample cases only. StarVector uses the generation
              settings from its own repository; the 8B model does not fit in 16 GB of GPU memory. Potrace gets a
              binarised image, as in SVG-Bench.
            </li>
            <li>
              A file that fails to parse or render counts as a failure and stays in the results. Comparisons are paired
              by case, with 95% bootstrap intervals.
            </li>
            <li>
              These numbers can’t be compared with the paper’s table. SVG-Bench rendered with cairosvg and fed the
              classic tracers 128 px images; this run uses resvg at 512 px and a 100-case subset.
            </li>
            <li>
              Commercial vectorizers are left out. They can’t be pinned to a version and run locally, and at least one
              forbids benchmarking in its terms.
            </li>
            <li>
              We built LogoLab and chose these metrics, and the kink count in particular is our own measure. That is why
              the SVG-Bench numbers are shown next to ours, along with the cases LogoLab loses. The kink count includes
              bends at points where three shapes meet, wherever the drawing runs smooth through them. A first version of
              the count left those out, and that hid about half of LogoLab’s kinks.
            </li>
          </ul>
          <p>
            The harness, the case list and the scorer are open source in{' '}
            <a
              className="text-accent underline-offset-2 hover:underline"
              href="https://github.com/Blaxzter/LogoLab/tree/main/bench/compare"
              target="_blank"
              rel="noreferrer"
            >
              bench/compare <ExternalLink size={11} className="inline" />
            </a>
            , and <code>bench/compare/py/setup.sh</code> pins every tool and model. A full run needs one consumer GPU.
          </p>
        </Section>

        <div className="mt-12 flex flex-wrap items-center gap-3">
          <Link to="/vectorize" className="btn btn-primary h-10 px-4 text-sm">
            Try the vectorizer
          </Link>
          {onExplore && (
            <button type="button" onClick={onExplore} className="btn btn-ghost h-10 px-4 text-sm">
              Explore all 100 cases
            </button>
          )}
        </div>

        <p className="mt-10 border-t border-line pt-4 text-[0.7rem] leading-relaxed text-faint">
          Emoji: Twemoji, Copyright 2019 Twitter, Inc and other contributors, licensed under{' '}
          <a
            className="text-accent underline-offset-2 hover:underline"
            href="https://creativecommons.org/licenses/by/4.0/"
            target="_blank"
            rel="noreferrer"
          >
            CC-BY 4.0
          </a>{' '}
          (
          <a
            className="text-accent underline-offset-2 hover:underline"
            href="https://github.com/jdecked/twemoji"
            target="_blank"
            rel="noreferrer"
          >
            github.com/jdecked/twemoji
          </a>
          ), via StarVector’s SVG-Bench. The traces shown are modified versions: rasterized and re-vectorized by each
          tool. Run {data.run}, {new Date(data.date).toISOString().slice(0, 10)}.
        </p>
      </article>
    </div>
  )
}

// ---------------------------------------------------------------------------

const TABLE: Row[] = [
  { key: 'sbDino', label: 'DINO score', better: 'higher', digits: 4 },
  { key: 'sbLpips', label: 'LPIPS', better: 'lower', digits: 4 },
  { key: 'sbSsim', label: 'SSIM', better: 'higher', digits: 3 },
  { key: 'meanDeltaE', label: 'ΔE', better: 'lower', digits: 2 },
  { key: 'chamfer', label: 'Edge px', better: 'lower', digits: 2 },
  { key: 'nodeRatio', label: 'Nodes ÷ artist', better: 'lower', digits: 1 },
  { key: 'tangentBreaks', label: 'Kinks', better: 'lower', digits: 0 },
  { key: 'bytes', label: 'KB', better: 'lower', digits: 1 },
]

function ResultsTable() {
  const cell = (k: string, v: number | null, d: number) =>
    v === null ? '—' : k === 'bytes' ? (v / 1024).toFixed(1) : v.toFixed(d)
  const best = new Map<string, number>()
  for (const r of TABLE) {
    const vals = data.summary
      .filter((s) => s.scored[r.key] >= data.cases / 2)
      .map((s) => s.median[r.key])
      .filter((v): v is number => v !== null)
    if (vals.length) best.set(r.key, r.better === 'lower' ? Math.min(...vals) : Math.max(...vals))
  }
  return (
    <div className="not-prose my-4 overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full min-w-[640px] text-xs tabular-nums">
        <thead className="bg-surface-2 text-[0.68rem] text-muted">
          <tr>
            <th />
            <th colSpan={3} className="border-l border-line px-2.5 pt-1.5 text-left font-medium">
              Picture (SVG-Bench)
            </th>
            <th colSpan={5} className="border-l border-line px-2.5 pt-1.5 text-left font-medium">
              Drawing (against the authored SVG)
            </th>
          </tr>
          <tr className="border-b border-line">
            <th className="px-2.5 py-1.5 text-left font-medium">Tool</th>
            {TABLE.map((r, i) => (
              <th
                key={r.key}
                className={`px-2.5 py-1.5 text-right font-medium ${i === 0 || i === 3 ? 'border-l border-line' : ''}`}
              >
                {r.label} {r.better === 'lower' ? '↓' : '↑'}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.summary.map((s) => (
            <tr key={s.tool} className={`border-t border-line ${s.tool === 'logolab-auto' ? 'bg-accent-soft/40' : ''}`}>
              <td className="whitespace-nowrap px-2.5 py-1.5 font-medium text-ink">{label(s.tool)}</td>
              {TABLE.map((r, i) => {
                const v = s.median[r.key]
                const scored = s.scored[r.key]
                const isBest = v !== null && v === best.get(r.key) && scored >= data.cases / 2
                return (
                  <td
                    key={r.key}
                    className={`px-2.5 py-1.5 text-right ${i === 0 || i === 3 ? 'border-l border-line' : ''} ${isBest ? 'font-semibold text-good' : 'text-ink-2'}`}
                  >
                    {cell(r.key, v, r.digits)}
                    {scored > 0 && scored < s.n && <sup className="ml-0.5 text-[0.55rem] text-faint">{scored}</sup>}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-line px-2.5 py-1.5 text-[0.68rem] text-faint">
        Medians over {data.cases} cases. A small number after a value is how many cases had a parseable outline
        (geometry can’t be measured on a file that doesn’t parse; those cases still count in the picture columns).
      </p>
    </div>
  )
}

/** Every tool in the frozen run once, with its configurations, its paper and its code. */
function ToolsList() {
  const rows = new Map<string, string[]>()
  for (const t of Object.keys(data.versions)) {
    const key = t.split('-')[0]
    if (!TOOL_REFS[key]) continue
    rows.set(key, [...(rows.get(key) ?? []), t])
  }
  return (
    <ul className="[&_li]:mt-2">
      {[...rows].map(([key, tools]) => {
        const ref = toolRef(tools[0])
        if (!ref) return null
        return (
          <li key={key}>
            <a
              className="font-medium text-accent underline-offset-2 hover:underline"
              href={ref.code}
              target="_blank"
              rel="noreferrer"
            >
              {ref.name}
            </a>{' '}
            <span className="text-faint">({ref.license})</span>, run as {tools.map((t) => label(t)).join(', ')}.{' '}
            {ref.paper &&
              (ref.paperUrl ? (
                <a
                  className="text-accent underline-offset-2 hover:underline"
                  href={ref.paperUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {ref.paper}
                </a>
              ) : (
                ref.paper
              ))}
            {!ref.paper && <span className="text-muted">No paper.</span>}
          </li>
        )
      })}
    </ul>
  )
}

function PairedNote() {
  const p = new Map(data.pairedVsVtracer.map((x) => [x.metric, x]))
  const s = (k: string, d: number) => {
    const x = p.get(k)
    if (!x || x.meanDiff === undefined) return '—'
    const sign = x.meanDiff > 0 ? '+' : ''
    return `${sign}${x.meanDiff.toFixed(d)} [${x.lo?.toFixed(d)}, ${x.hi?.toFixed(d)}]`
  }
  return (
    <p>
      Paired case by case, VTracer minus LogoLab (mean, 95% interval): DINO {s('sbDino', 4)}, LPIPS {s('sbLpips', 4)}.
      Both intervals include zero, so on the SVG-Bench metrics the two tools tie. On the drawing VTracer is worse: ΔE{' '}
      {s('meanDeltaE', 2)}, nodes {s('docNodes', 0)}, kinks {s('tangentBreaks', 0)}. Edge error is the exception at{' '}
      {s('chamfer', 2)}. LogoLab’s median is better, but its three failures (the flag, the shrimp and the worm) keep the
      mean difference inside the noise.
    </p>
  )
}
