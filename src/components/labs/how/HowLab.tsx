import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { usePanZoom } from '../../../hooks/usePanZoom'
import { ExternalLink } from '../../ui/icons'
import { ZoomControls } from '../../ui/ZoomControls'
import { MAX_ZOOM } from '../CaseRow'
import { LabZoomContext } from '../LabPage'
import { Panel } from '../Panel'
import { Figure, Section } from '../bench/articleParts'
import { type CaseMode, DRAWING_ROWS, type ScoreRow, SvgArt } from '../bench/figure'
import { HOW } from './howItWorks.generated'
import type { HowRule } from './howTypes'
import type { ShowPaired } from '../bench/showcaseTypes'

/**
 * /labs/how: how the tracer works, one rule at a time.
 *
 * Every rule the page names is shown the same way: one case traced with that rule switched
 * off and as shipped, and under it what the rule is worth over the 100 held-out benchmark
 * emoji, as a paired difference. All of it is frozen by bench/compare/howItWorks.ts from the
 * benchmark run and one ablation run per rule (`run.ts --fit <rule>=false`), so the numbers
 * are the benchmark's scorer and the prose quotes them rather than restating them.
 */

const RULE_NAME: Record<string, string> = {
  subpixelEdges: 'Sub-pixel edges',
  cornerVeto: 'Corner veto',
  fillets: 'Rounded polygons',
  throughPairs: 'Through junctions',
  junctionReseat: 'Junction re-seat',
  lineTangents: 'Line tangents',
}

/** `digits` for one case's value, `mean` for an average over cases (a count averages to a
 *  fraction, and a tiny mean needs one more place than any single case). */
const METRIC: Record<
  string,
  { label: string; digits: number; mean: number; unit?: string; better: 'lower' | 'higher' }
> = {
  meanDeltaE: { label: 'Colour error (ΔE)', digits: 2, mean: 3, better: 'lower' },
  chamfer: { label: 'Edge error', digits: 2, mean: 3, unit: 'px', better: 'lower' },
  docNodes: { label: 'Nodes', digits: 0, mean: 1, better: 'lower' },
  tangentBreaks: { label: 'Kinks on smooth curves', digits: 0, mean: 1, better: 'lower' },
  cornersInvented: { label: 'Invented corners', digits: 0, mean: 2, better: 'lower' },
  cornersRecovered: { label: 'Corners kept', digits: 0, mean: 2, better: 'higher' },
}

/** The view each figure opens in: a placement change shows in the difference map, and the
 *  checkerboard's 4000 nodes would bury the picture. */
const OPEN_IN: Record<string, CaseMode> = { subpixelEdges: 'diff', cornerVeto: 'picture' }

/** The ablations are scored without SVG-Bench, so a figure's table is the drawing half, and the
 *  corner veto's also says how many authored corners survived. */
const CORNERS_ROW: ScoreRow = { key: 'cornersRecovered', label: 'Corners kept', better: 'higher', digits: 0 }

const rule = (key: string): HowRule | undefined => HOW.rules.find((r) => r.rule === key)
const metricOf = (r: HowRule, k: string): number | null => {
  const v = r.example.tools.find((t) => t.tool === 'on')?.metrics[k]
  return typeof v === 'number' ? v : null
}
const offOf = (r: HowRule, k: string): number | null => {
  const v = r.example.tools.find((t) => t.tool === 'off')?.metrics[k]
  return typeof v === 'number' ? v : null
}
/** How much better a score is with `rule` OFF, as a positive number (the cost of the rule).
 *  The direction is in the prose around it; bench/compare/howItWorks.ts PROSE checks it. */
const better = (r: string, k: string): string => {
  const c = rule(r)?.census.find((x) => x.metric === k)
  return c?.meanDiff === undefined ? '—' : Math.abs(c.meanDiff).toFixed(METRIC[k].mean)
}
/** On how many held-out cases switching `rule` off changes metric `k`. */
const moved = (r: string, k: string): number | string => rule(r)?.census.find((x) => x.metric === k)?.moved ?? '—'
/** How much worse a score is with `rule` ON (the same number, named for the other side). */
const worse = better
const fmt = (v: number | null, d: number): string => (v === null ? '—' : v.toFixed(d))
const sign = (v: number, d: number): string =>
  Math.abs(v) < 0.5 * 10 ** -d ? '≈0' : `${v > 0 ? '+' : ''}${v.toFixed(d)}`
/** Decimals for a paired cell: a significant change gets places until neither its mean nor its
 *  interval ends round to zero, or a bold cell would read "≈0 [-0.001, -0.000]". */
const placesFor = (c: ShowPaired, d: number): number => {
  if (!c.significant) return d
  const vals = [c.meanDiff, c.lo, c.hi].filter((v): v is number => typeof v === 'number')
  let p = d
  while (p < d + 3 && vals.some((v) => Math.abs(v) < 0.5 * 10 ** -p)) p++
  return p
}

const A = ({ href, children }: { href: string; children: ReactNode }) => (
  <a className="text-accent underline-offset-2 hover:underline" href={href} target="_blank" rel="noreferrer">
    {children}
  </a>
)

export default function HowLab() {
  const p = HOW.pipeline
  return (
    <article className="mx-auto max-w-5xl px-4 pb-16 pt-6 sm:px-6">
      <p className="text-xs font-semibold uppercase tracking-wide text-accent">Labs</p>
      <h1 className="mt-2 max-w-[24ch] text-3xl font-bold tracking-tight text-ink sm:text-4xl">
        How the vectorizer works
      </h1>
      <p className="mt-4 max-w-[68ch] text-[0.95rem] leading-relaxed text-ink-2">
        LogoLab turns a picture of flat art, such as an icon, a logo or an emoji, into an SVG. It tries to recover the
        drawing the picture was made from: the same shapes, corners where the artist drew corners, smooth curves where
        the artist drew them smooth, and not many more nodes than the artist used. There is no trained model in it. Each
        step is an explicit rule that can be switched off and measured, and this page does that for the main ones. The
        same code runs in your browser and in the <code>logolab</code> npm package.
      </p>

      <PipelineFigure />

      <Section title="1. Regions first">
        <p>
          The tracer starts by deciding which pixels belong together. A probe looks at the image and picks one of three
          ways to do it:
        </p>
        <ul>
          <li>
            Most icons are a handful of solid colours. For those the tracer finds the palette and gives each pixel to
            one of its colours; an anti-aliased pixel along an edge is a mix of two colours and goes to one of the two.
          </li>
          <li>
            A black mark on white, or any single colour on a plain ground, is cut into ink and paper. The cut is made on
            coverage: a pixel half covered by ink is exactly on the edge, and art on a transparent background is first
            composited over the paper, so a thin line keeps its drawn width. A small image is enlarged before the cut,
            by up to 3× for its size and up to 4× when its thinnest strokes are under about 3 px wide.
          </li>
          <li>
            Art with shading or gradients goes through a smoothness segmentation in the spirit of{' '}
            <A href="https://doi.org/10.1002/cpa.3160420503">Mumford and Shah (1989)</A>: the image is approximated by
            regions that are smooth inside and separated by sharp edges. Each region then gets the simplest paint that
            explains it: a flat colour, a linear gradient or a radial one.
          </li>
        </ul>
        <p>
          The probe’s choice is shown in the studio under the Mode control, with the reason, and a click overrides it
          for that image.
        </p>
      </Section>

      <Section title="2. Every boundary is drawn once">
        <p>
          The region map becomes a planar graph. Where two regions touch, their boundary is one edge. Where three or
          more meet, the edges end at a shared vertex. Each edge is fitted once, and both regions on either side of it
          refer to that same edge, so two shapes cannot leave a gap or overlap between them, and moving an edge in the
          editor moves both neighbours. In the figure above, the face has {p.regions} regions (one per colour, and a
          region can be several pieces), {p.edges} edges and {p.vertices} vertices.
        </p>
        <p>
          VTracer and AutoTrace trace each colour region as its own closed shape and stack the shapes, so a boundary
          between two colours is traced twice, once for each side. Potrace traces a single colour. The closest published
          structure to LogoLab’s graph is the{' '}
          <A href="https://doi.org/10.1145/2601097.2601169">vector graphics complex</A> of Dalstein, Ronfard and van de
          Panne (2014). A layered SVG, with shapes painted on top of each other, is derived from the graph at the end
          (section 9), without tracing anything again.
        </p>
      </Section>

      <RuleSection
        k="subpixelEdges"
        title="3. Edges between the pixels"
        intro={
          <p>
            The region map puts every boundary on the pixel grid, but the true edge is usually somewhere inside a pixel.
            The source’s anti-aliased pixels record how much of each pixel the shape covered. Before any curve is
            fitted, each boundary point is moved along the boundary’s normal to where the coverage between the two
            colours crosses one half. Near corners and at the border of the image that reading is unreliable, and there
            the point stays on the grid.
          </p>
        }
      />

      <RuleSection
        k="cornerVeto"
        title="4. Corners where the art has them"
        intro={
          <>
            <p>
              A corner is a turn of at least 60° along the boundary. Its tip is rebuilt from the two straight arms that
              meet there, and the rebuilt tip is checked against the source image: it may not reach further than the
              coverage the pixels show, so a rounded tip is not sharpened into a spike.
            </p>
            <p>
              After fitting, a tidy-up pass snaps outlines that are within tolerance of a circle or an ellipse to that
              shape. The corner veto stops it from rounding a shape that has sharp corners into a disc.
            </p>
          </>
        }
        after={
          <p>
            On the emoji it changes {moved('cornerVeto', 'meanDeltaE')} of the {HOW.heldOutCases} traces, and there it
            costs a little: with it on they carry slightly more kinks and colour error. It exists for art like this
            checkerboard: with it off, the small cells in the lower-right quarter are close enough to circles for the
            snap to take them for circles.
          </p>
        }
      />

      <RuleSection
        k="fillets"
        title="5. Rounded shapes are lines and arcs"
        intro={
          <p>
            A rounded rectangle, a pill or a map pin is straight sides joined by circular arcs, each arc tangent to the
            sides next to it. The general curve fitter cannot say that: it fits a line to each side and a curve to each
            corner, and where they meet there is a small kink. So before the general fit, every closed outline is tested
            as lines joined by tangent arcs. If the whole outline fits that reading, it is written as exactly those
            lines and arcs, each join smooth. If any part does not fit, the outline goes to the general fitter
            unchanged.
          </p>
        }
        after={
          <p>
            The smooth joins cost nodes: with the rule on, an icon carries {worse('fillets', 'docNodes')} more nodes on
            average.
          </p>
        }
      />

      <RuleSection
        k="throughPairs"
        title="6. Outlines that run through a junction"
        intro={
          <p>
            Where three regions meet, two of the edges often belong to one outline that carries on straight through the
            point, like the line of a mouth passing a cheek. Fitted on their own, those two edges leave the junction in
            slightly different directions, and the outline gets a dent there. When exactly one pair of edges continues
            through, the junction is placed on that pair’s common line and both edges are fitted to leave it along one
            tangent. The shape whose outline stops at the junction keeps its corner.
          </p>
        }
      />

      <RuleSection
        k="junctionReseat"
        title="7. Junctions on the fitted lines"
        intro={
          <p>
            A junction found on the pixel grid can be several pixels from where the shapes really meet, especially where
            two boundaries cross at a shallow angle. After fitting, such a junction is moved to the intersection of the
            two strongest fitted curves that meet there, and the short pieces next to it are fitted again from those
            curves.
          </p>
        }
        after={
          <p>
            On the held-out emoji this rule does not pay for itself. With it off, colour error is better by{' '}
            {better('junctionReseat', 'meanDeltaE')} ΔE and edge error by {better('junctionReseat', 'chamfer')} px per
            icon, both tiny, and nodes and kinks stay within noise. It helps on in-sample cases like these petals, so it
            stays on, and it is a candidate for a narrower trigger.
          </p>
        }
      />

      <RuleSection
        k="lineTangents"
        title="8. A line hands its direction to the next curve"
        intro={
          <p>
            Where a straight piece of outline runs into a curve, the curve should leave in the line’s direction, or the
            join kinks by a few degrees. So the end of every fitted line offers its direction to the curve beside it.
            The corner test still decides whether the join is a corner; if it is, it stays one.
          </p>
        }
        after={<p>The price is a little edge error, {better('lineTangents', 'chamfer')} px per icon on average.</p>}
      />

      <Section title="9. Layered output">
        <p>
          The graph tiles the picture: every region is exactly the area it covers, holes and all. A designer usually
          draws in layers instead, with a whole circle behind a shape that covers part of it. The studio and the npm
          package give you that version by default, built from the same graph. Two rules decide it:
        </p>
        <ul>
          <li>
            A hole whose inside is filled entirely by solid shapes painted later is dropped, so the shape behind paints
            solid underneath them.
          </li>
          <li>
            Where one outline runs straight through a junction and the other stops there, the stopped shape is completed
            underneath its neighbour, either along edges that already exist or along a new hidden edge that stays under
            the shape in front.
          </li>
        </ul>
        <p>
          Neither rule may change the rendered picture, and a completion may only add to its shape. The Layering control
          under Color switches back to the tiled version.
        </p>
      </Section>

      <Section title="10. Line art as strokes">
        <p>
          A drawing made of lines is better as strokes than as outlines of strokes. With Strokes on, the ink cut goes to
          a second engine that finds the middle of every line, measures its width, and writes it as a stroked path. Ink
          that no stroke explains, such as a filled dot or a note head, is traced as a filled shape by the planar
          tracer. In colour, all the inks are traced together as one drawing, so a red line crossing a blue one stays
          two whole lines, and each stroke is coloured afterwards by the ink under it.
        </p>
      </Section>

      <Section title="What each rule is worth">
        <p>
          Every rule above was switched off on its own and the benchmark run again on the {HOW.heldOutCases} held-out
          emoji. The table gives the mean change per icon with the rule off, and a 95% interval from a paired bootstrap.
          The arrow on each column says which way is better, and a rule helps where switching it off moves a score
          against the arrow. Bold marks a change whose interval excludes zero, and the small number after the interval
          is how many of the {HOW.heldOutCases} emoji that score changes on.
        </p>
        <WorthTable />
        <p>
          The held-out set is the emoji test split of{' '}
          <Link className="text-accent underline-offset-2 hover:underline" to="/labs/bench">
            the benchmark
          </Link>
          . Most rules were built against the in-sample test cases, so on these emoji a rule can move fewer cases than
          it was written for, or none. Two were not: through junctions and line tangents were reviewed and accepted on
          these same emoji, so their rows are not out-of-sample evidence.
        </p>
      </Section>

      <Section title="How a change is checked">
        <p>
          The truth gate traces test cases whose SVG source is known and scores each trace against that source: edge
          distance, nodes, regions recovered, corners recovered, corners invented, and kinks of 5° or more on curves
          drawn smooth.
        </p>
        <p>
          Before a tracer change, a snapshot of every test case is frozen. The{' '}
          <Link className="text-accent underline-offset-2 hover:underline" to="/labs/ab">
            A/B lab
          </Link>{' '}
          then shows which cases moved and where, which is how a fix for one shape is caught changing another.
        </p>
        <p>
          The{' '}
          <Link className="text-accent underline-offset-2 hover:underline" to="/labs/bench">
            benchmark
          </Link>{' '}
          runs LogoLab and other tracers on the same images, with the published image metrics next to the drawing
          metrics.
        </p>
      </Section>

      <Section title="Related work">
        <ul className="[&_li]:mt-2">
          <li>
            P. Selinger.{' '}
            <A href="https://potrace.sourceforge.net/potrace.pdf">Potrace: a polygon-based tracing algorithm</A>. 2003.
            The standard one-colour tracer.
          </li>
          <li>
            D. Mumford, J. Shah.{' '}
            <A href="https://doi.org/10.1002/cpa.3160420503">
              Optimal approximations by piecewise smooth functions and associated variational problems
            </A>
            . Communications on Pure and Applied Mathematics, 1989.
          </li>
          <li>
            J. Kopf, D. Lischinski. <A href="https://doi.org/10.1145/2010324.1964994">Depixelizing pixel art</A>. ACM
            TOG (SIGGRAPH), 2011.
          </li>
          <li>
            B. Dalstein, R. Ronfard, M. van de Panne.{' '}
            <A href="https://doi.org/10.1145/2601097.2601169">Vector graphics complexes</A>. ACM TOG (SIGGRAPH), 2014.
          </li>
          <li>
            J.-D. Favreau, F. Lafarge, A. Bousseau.{' '}
            <A href="https://doi.org/10.1145/3130800.3130888">
              Photo2ClipArt: image abstraction and vectorization using layered linear gradients
            </A>
            . ACM TOG (SIGGRAPH Asia), 2017.
          </li>
          <li>
            S. Hoshyari, E. A. Dominici, A. Sheffer, N. Carr, Z. Wang, D. Ceylan, I.-C. Shen.{' '}
            <A href="https://doi.org/10.1145/3197517.3201312">
              Perception-driven semi-structured boundary vectorization
            </A>
            . ACM TOG (SIGGRAPH), 2018. The closest in aim: corners and regularity in clip art as people see them.
          </li>
          <li>
            E. A. Dominici, N. Schertler, J. Griffin, S. Hoshyari, L. Sigal, A. Sheffer.{' '}
            <A href="https://doi.org/10.1145/3386569.3392401">
              PolyFit: perception-aligned vectorization of raster clip-art via intermediate polygonal fitting
            </A>
            . ACM TOG (SIGGRAPH), 2020.
          </li>
          <li>
            T.-M. Li, M. Lukáč, M. Gharbi, J. Ragan-Kelley.{' '}
            <A href="https://doi.org/10.1145/3414685.3417871">
              Differentiable vector graphics rasterization for editing and learning
            </A>{' '}
            (DiffVG). ACM TOG (SIGGRAPH Asia), 2020.
          </li>
          <li>
            X. Ma et al. <A href="https://arxiv.org/abs/2206.04655">Towards layer-wise image vectorization</A> (LIVE).
            CVPR, 2022.
          </li>
          <li>
            J. A. Rodriguez et al.{' '}
            <A href="https://arxiv.org/abs/2312.11556">
              StarVector: generating scalable vector graphics code from images and text
            </A>
            . CVPR, 2025.
          </li>
          <li>
            Y. Yang et al.{' '}
            <A href="https://arxiv.org/abs/2504.06263">OmniSVG: a unified scalable vector graphics generation model</A>.
            NeurIPS, 2025.
          </li>
        </ul>
        <p>
          The source is on{' '}
          <A href="https://github.com/Blaxzter/LogoLab/tree/main/src/lib/trace">
            GitHub <ExternalLink size={11} className="inline" />
          </A>
          . The tracer lives in <code>src/lib/trace/</code>, and the measurements for every rule are written up in{' '}
          <code>docs/vectorization-benchmarks.md</code>.
        </p>
      </Section>

      <div className="mt-12 flex flex-wrap items-center gap-3">
        <Link to="/vectorize" className="btn btn-primary h-10 px-4 text-sm">
          Try the vectorizer
        </Link>
        <Link to="/labs/bench" className="btn btn-ghost h-10 px-4 text-sm">
          See the benchmark
        </Link>
      </div>

      <p className="mt-10 border-t border-line pt-4 text-[0.7rem] leading-relaxed text-faint">
        Emoji: Twemoji, Copyright 2019 Twitter, Inc and other contributors, licensed under{' '}
        <A href="https://creativecommons.org/licenses/by/4.0/">CC-BY 4.0</A> (
        <A href="https://github.com/jdecked/twemoji">github.com/jdecked/twemoji</A>), via StarVector’s SVG-Bench. The
        traces are modified versions: rasterized and re-vectorized. Measured with {HOW.version} at {HOW.res} px, run{' '}
        {HOW.base} and its ablation runs, {new Date(HOW.date).toISOString().slice(0, 10)}. The test fixtures are
        LogoLab’s own.
      </p>
    </article>
  )
}

// ---------------------------------------------------------------------------

function RuleSection({ k, title, intro, after }: { k: string; title: string; intro: ReactNode; after?: ReactNode }) {
  const r = rule(k)
  return (
    <Section title={title}>
      {intro}
      {r ? (
        <>
          <Figure
            example={r.example}
            base={`/how-it-works/${r.example.slug}`}
            labels={{ off: `${RULE_NAME[k]} off`, on: 'As shipped' }}
            initialMode={OPEN_IN[r.rule] ?? 'nodes'}
            rows={r.metric === 'cornersRecovered' ? [...DRAWING_ROWS, CORNERS_ROW] : DRAWING_ROWS}
            caption={<RuleCaption r={r} />}
          />
          <Census r={r} />
          {after}
        </>
      ) : (
        <p className="text-faint">(No ablation run for this rule yet.)</p>
      )}
    </Section>
  )
}

function RuleCaption({ r }: { r: HowRule }) {
  const m = METRIC[r.metric]
  const on = metricOf(r, r.metric)
  const off = offOf(r, r.metric)
  return (
    <>
      {RULE_NAME[r.rule]} off, then as shipped, on {r.example.caseId.slice(r.example.caseId.indexOf('/') + 1)}.{' '}
      {m.label}: {fmt(off, m.digits)}
      {m.unit ?? ''} with the rule off, {fmt(on, m.digits)}
      {m.unit ?? ''} as shipped. Nodes & kinks draws the anchors and the counted kinks (red rings); scroll over a panel
      to zoom.
    </>
  )
}

function Census({ r }: { r: HowRule }) {
  const c = r.census.find((x) => x.metric === r.metric)
  const m = METRIC[r.metric]
  if (!c || c.meanDiff === undefined) return null
  return (
    <p>
      Over the {HOW.heldOutCases} held-out emoji, switching it off changes the {m.label.toLowerCase()} on {c.moved} of
      them, by {sign(c.meanDiff, placesFor(c, m.mean))}
      {m.unit ?? ''} per icon on average [{c.lo?.toFixed(placesFor(c, m.mean))}, {c.hi?.toFixed(placesFor(c, m.mean))}].
    </p>
  )
}

/** One census cell: the mean change with its interval and how many icons moved. */
function WorthCell({ r, k, stack = false }: { r: HowRule; k: string; stack?: boolean }) {
  const c = r.census.find((x) => x.metric === k)
  const d = METRIC[k].mean
  if (!c || c.meanDiff === undefined) return <span className="text-faint">—</span>
  if (c.moved === 0) return <span className="text-faint">no change</span>
  return (
    <span className={c.significant ? 'font-semibold text-ink' : 'text-ink-2'}>
      {sign(c.meanDiff, placesFor(c, d))}{' '}
      <span className={`text-[0.62rem] font-normal text-faint ${stack ? 'block' : ''}`}>
        [{c.lo?.toFixed(placesFor(c, d))}, {c.hi?.toFixed(placesFor(c, d))}] · {c.moved}
      </span>
    </span>
  )
}

/** The census as a table from `sm` up, and as one card per rule on a phone, where six
 *  columns of intervals cannot fit. */
function WorthTable() {
  const keys = Object.keys(METRIC)
  const arrow = (k: string) => (METRIC[k].better === 'lower' ? '↓' : '↑')
  return (
    <div className="not-prose my-4">
      <div className="space-y-2 sm:hidden">
        {HOW.rules.map((r) => (
          <div key={r.rule} className="rounded-lg border border-line bg-surface text-xs tabular-nums">
            <div className="border-b border-line bg-surface-2 px-3 py-1.5 font-medium text-ink">
              {RULE_NAME[r.rule] ?? r.rule} off
            </div>
            <dl className="divide-y divide-line">
              {keys.map((k) => (
                <div key={k} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
                  <dt className="text-muted">
                    {METRIC[k].label} {arrow(k)}
                  </dt>
                  <dd className="whitespace-nowrap text-right">
                    <WorthCell r={r} k={k} />
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
      <div className="hidden overflow-x-auto rounded-lg border border-line bg-surface sm:block">
        <table className="w-full min-w-[560px] text-xs tabular-nums">
          <thead className="border-b border-line bg-surface-2 text-[0.68rem] text-muted">
            <tr>
              <th className="px-2.5 py-1.5 text-left align-bottom font-medium">Rule switched off</th>
              {keys.map((k) => (
                <th key={k} className="px-2.5 py-1.5 text-right align-bottom font-medium leading-tight">
                  {METRIC[k].label} {arrow(k)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {HOW.rules.map((r) => (
              <tr key={r.rule} className="border-t border-line">
                <td className="whitespace-nowrap px-2.5 py-1.5 align-top font-medium text-ink">
                  {RULE_NAME[r.rule] ?? r.rule}
                </td>
                {keys.map((k) => (
                  <td key={k} className="whitespace-nowrap px-2.5 py-1.5 text-right align-top">
                    <WorthCell r={r} k={k} stack />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The pipeline: the stages of one trace, on one pan/zoom camera.

function PipelineFigure() {
  const p = HOW.pipeline
  const pz = usePanZoom({ maxScale: MAX_ZOOM })
  const claimed = useRef(false)
  const zoom = useMemo(() => ({ pz, claimed }), [pz])
  const row = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState(200)
  useEffect(() => {
    const el = row.current
    if (!el) return undefined
    const fit = () => {
      const cols = el.clientWidth < 520 ? 2 : 4
      setBox(Math.max(120, Math.floor((el.clientWidth - 12 * (cols - 1)) / cols)))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const base = '/how-it-works/pipeline'
  const aspect = p.width / p.height
  return (
    <figure className="my-6 wires" style={{ maxWidth: 4 * 250 }}>
      <div className="mb-2 flex items-center text-xs text-muted">
        <ZoomControls pz={pz} className="ml-auto" />
      </div>
      <LabZoomContext.Provider value={zoom}>
        <div
          ref={row}
          className="flex flex-wrap items-stretch"
          style={{ gap: 12, '--lab-box': `${box}px` } as CSSProperties}
        >
          <Panel
            label="1. Pixels"
            note={`${p.width}×${p.height}`}
            aspect={aspect}
            pixelated
            grid={{ w: p.width, h: p.height }}
          >
            <img src={`${base}/pixels.png`} alt="The source pixels, an emoji at 512 px" />
          </Panel>
          <Panel label="2. Regions" note={`${p.regions} regions`} aspect={aspect} pixelated>
            <img src={`${base}/regions.png`} alt="Each region in its own colour" />
          </Panel>
          <Panel label="3. Shared edges" note={`${p.edges} edges, ${p.vertices} vertices`} aspect={aspect}>
            <img src={`${base}/edges.svg`} alt="Each boundary as one edge, in its own colour" />
          </Panel>
          <Panel label="4. SVG" note={`${p.paths} paths, ${p.nodes} nodes`} aspect={aspect}>
            <SvgArt url={`${base}/trace.svg`} />
          </Panel>
        </div>
      </LabZoomContext.Provider>
      <figcaption className="mt-3 max-w-[72ch] text-[0.85rem] leading-relaxed text-muted">
        The stages of one trace: the pixels are grouped into regions, each region boundary becomes one shared edge
        (coloured one per edge here, with a dot where edges meet, inside or at the image border), and the fitted edges
        are written out as the SVG, its nodes drawn on top. This figure uses the tracer’s tiled defaults. Scroll over a
        panel to zoom; all four move together.
      </figcaption>
    </figure>
  )
}
