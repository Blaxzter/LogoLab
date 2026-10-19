import { useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink } from '../../ui/icons'
import { toolInfo } from './benchData'
import { NodePanels, ScoreTable } from './figure'
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

const n = (m: ShowMetrics, k: string): number | null => (typeof m[k] === 'number' ? (m[k] as number) : null)

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
          icons that comparison saturates: files that differ three- or four-fold in nodes, with visibly different
          curves, get the same score. So we also score the <em>drawing</em>, against the vector art that produced the
          image. Every example below is a real output, and two of them are cases LogoLab gets wrong.
        </p>

        <Figure
          example={hero}
          initialNodes
          caption={
            <>
              Three traces of the same emoji. The DINO score, the headline metric of StarVector’s SVG-Bench, calls them
              0.9999, 0.9998 and 0.9996, so by that score the three are interchangeable. The artist drew it with{' '}
              {hero.authoredNodes.length / 2} nodes; the traces use{' '}
              {hero.tools.map((t) => n(t.metrics, 'docNodes')).join(', ')}, and VTracer puts{' '}
              {n(hero.tools[1].metrics, 'tangentBreaks')} kinks (red rings) on curves the artist drew smooth. StarVector
              uses the fewest nodes, and its outline is the furthest from the drawing. Click a panel to zoom.
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
            All four ask whether the rendered picture looks like the source picture. For a photo that is enough. For a
            vector file it leaves out most of what matters: none of them can see how many nodes the file has, whether a
            circle is still a circle, whether two curves meet smoothly or with a kink, or whether the colours are right.
            DINO in particular was trained to recognise objects, and it will recognise a bat in grey or in black.
          </p>
        </Section>

        <Section title="Same score, worse drawing">
          <p>
            On the shushing face, DINO cannot separate the two traces (0.9997 each) and LPIPS slightly prefers
            VTracer’s. Measured against the authored outline, VTracer’s edges are three times further off, and its file
            has 54 kinks on curves that have none.
          </p>
          <Figure example={byslug('shushing-face')} />
          <p>
            The crystal ball goes further: DINO <em>and</em> LPIPS both rank VTracer first, on a trace with 3.3× the
            nodes and 3.6× the edge error.
          </p>
          <Figure example={byslug('crystal-ball')} />
        </Section>

        <Section title="A black silhouette scores 0.967">
          <p>
            SVG-Bench runs Potrace the way Potrace works: the image is cut to black and white first. Every colour on
            this leg is wrong (ΔE 15, where 1 is barely visible), and DINO still gives it 0.967. That is higher than
            StarVector’s median across the whole set (0.930). StarVector’s own trace scores 0.998 while its outline sits
            3.3 px from the drawing.
          </p>
          <Figure example={byslug('leg')} />
        </Section>

        <Section title="Where LogoLab loses">
          <p>
            On the bat, LogoLab merged the two greys into one silhouette and lost the wings; VTracer gets it right. On
            the camera, it dropped the grey parts entirely (ΔE 5.8 against VTracer’s 0.4). Both are failures of the step
            that decides how many inks an image has, and they are why LogoLab’s average edge error is not significantly
            better than VTracer’s even though its median is.
          </p>
          <Figure example={byslug('bat')} />
          <p>
            DINO ranks Potrace’s black outline of the bat (0.970) above LogoLab’s flat grey silhouette (0.963). Both
            traces are wrong in different ways, and the score gives no hint of either.
          </p>
          <Figure example={byslug('camera')} />
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
              size, but you will when you scale the file up or edit it.
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
              best of a 54-configuration sweep on these cases. StarVector uses the generation settings from its own
              repository; the 8B model does not fit in 16 GB of GPU memory. Potrace gets a binarised image, as in
              SVG-Bench.
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
              the SVG-Bench numbers sit beside ours and why the losses are shown.
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-14">
      <h2 className="text-xl font-bold tracking-tight text-ink">{title}</h2>
      <div className="mt-3 space-y-3 text-[0.92rem] leading-relaxed text-ink-2 [&_code]:rounded [&_code]:bg-surface-3 [&_code]:px-1 [&_code]:text-[0.85em] [&_li]:mt-1 [&_ul]:list-disc [&_ul]:pl-5 [&>p]:max-w-[72ch] [&>ul]:max-w-[72ch]">
        {children}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// One example: the authored drawing and each tool's SVG, the real files, side by side.

function Figure({
  example,
  caption,
  initialNodes = false,
}: {
  example: Example
  caption?: ReactNode
  initialNodes?: boolean
}) {
  const [nodes, setNodes] = useState(initialNodes)
  const base = `/benchmark/${example.slug}`
  const count = (anchors: number[], breaks: number[]) =>
    nodes ? (
      <>
        {anchors.length / 2} nodes
        {breaks.length > 0 && <span className="text-bad"> · {breaks.length / 3} kinks</span>}
      </>
    ) : undefined
  const panels = [
    {
      key: 'authored',
      title: 'Drawn by the artist',
      note: count(example.authoredNodes, []),
      src: `${base}/authored.svg`,
      anchors: example.authoredNodes,
      breaks: [],
    },
    ...example.tools.map((t) => ({
      key: t.tool,
      title: label(t.tool),
      note: count(t.anchors, t.breaks),
      src: `${base}/${t.tool}.svg`,
      anchors: t.anchors,
      breaks: t.breaks,
    })),
  ]
  return (
    // Panels stay about icon-sized however many there are: the figure is as wide as its
    // panels, not as wide as the page.
    <figure className="my-6" style={{ maxWidth: panels.length * 250 }}>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-muted">
        <span className="font-mono text-[0.7rem] text-faint">
          {example.caseId.slice(example.caseId.indexOf('/') + 1)}
        </span>
        <label className="inline-flex cursor-pointer select-none items-center gap-1.5">
          <input
            type="checkbox"
            checked={nodes}
            onChange={(e) => setNodes(e.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--color-accent)]"
          />
          Show nodes and kinks
        </label>
      </div>
      <NodePanels panels={panels} width={example.width} height={example.height} nodes={nodes} />
      <ScoreTable columns={example.tools.map((t) => ({ tool: t.tool, metrics: t.metrics }))} />
      {caption && (
        <figcaption className="mt-3 max-w-[72ch] text-[0.85rem] leading-relaxed text-muted">{caption}</figcaption>
      )}
    </figure>
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
      Paired case by case, VTracer minus LogoLab (mean, 95% interval): DINO {s('sbDino', 4)}, in VTracer’s favour; LPIPS{' '}
      {s('sbLpips', 4)}, no difference. So on the SVG-Bench metrics the two tools tie, with a slight edge to VTracer. On
      the drawing VTracer is worse: ΔE {s('meanDeltaE', 2)}, nodes {s('docNodes', 0)}, kinks {s('tangentBreaks', 0)}.
      Edge error is the exception at {s('chamfer', 2)}: LogoLab’s median is better, but its failures (the bat, the
      camera) keep the mean difference inside the noise.
    </p>
  )
}
