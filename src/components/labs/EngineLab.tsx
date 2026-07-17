// Engine scoreboard — potrace vs crisp.
//
// Runs both real trace engines over the corpus and reports the plan §5 metrics for each: L1
// CIELAB, mean/P95 ΔE, SSIM, seam max & P99.5, path/node/gradient counts, runtime, determinism —
// alongside the visual previews, so a number and the picture it describes are never more than one
// glance apart.
//
// Why it's its own lab rather than a Workbench corpus: this scores the render against the SOURCE
// PIXELS, not against authored geometry, so it answers a different question from the Workbench's
// one question. And it is the ONLY place potrace is measured at all — the same pure scoreboard code
// (../../devtest/scoreboard) runs under `node --test` for crisp, but potrace needs a browser (WASM +
// DOMParser), so its numbers can only come from here.

import { DEFAULT_VECTORIZE_OPTIONS } from '../../lib/trace'
import { serializeDoc } from '../../lib/path/model'
import { score, type ScoreRow, type SourceImage } from '../../devtest/scoreboard'
import { LabPage } from './LabPage'
import { Panel, RawArt } from './Panel'
import { CaseRow, NoteBox, PendingRow } from './CaseRow'
import { useLabState } from './useLabState'
import { useLabRun } from './useLabRun'
import { labImageData } from './resvgRaster'
import { labTrace } from './labTrace'

const MAX_DIM = 512
const ENGINES: ('potrace' | 'crisp')[] = ['potrace', 'crisp']

interface Case {
  name: string
  /** 'png' = raster source; 'svg' = hand-made ground truth, rasterized at MAX_DIM. */
  kind: 'png' | 'svg'
  src: string
  /** Optional visual reference (an Affinity export) shown at the end of the strip. */
  reference?: string
}

const CASES: Case[] = [
  { name: 'nebula', kind: 'png', src: '/examples/nebula.png', reference: '/examples/nebula.affinity.svg' },
  { name: 'petals', kind: 'png', src: '/examples/petals.png', reference: '/examples/petals.affinity.svg' },
  { name: 'aurora', kind: 'svg', src: '/examples/aurora.svg' },
  { name: 'orbit', kind: 'svg', src: '/examples/orbit.svg' },
  { name: 'outline', kind: 'svg', src: '/examples/outline.svg' },
  { name: 'summit', kind: 'svg', src: '/examples/summit.svg' },
  { name: 'bloom', kind: 'svg', src: '/examples/bloom.svg' },
]

interface EvalResult {
  width: number
  height: number
  rows: ScoreRow[]
  svgs: Record<string, string>
  refSvg?: string
}

async function analyze(c: Case): Promise<EvalResult> {
  const svgText = c.kind === 'svg' ? await (await fetch(c.src)).text() : undefined
  const image = await labImageData(c.src, MAX_DIM, svgText)
  const refSvg = c.reference ? await (await fetch(c.reference)).text() : undefined
  const source: SourceImage = image

  const rows: ScoreRow[] = []
  const svgs: Record<string, string> = {}
  for (const engine of ENGINES) {
    // score() re-traces internally (twice, for the determinism check) and stays free of the DOM;
    // the preview is a third, cheap trace so the picture matches the row exactly. labTrace runs
    // crisp in a worker; potrace needs DOMParser + WASM, so it alone still blocks the main thread —
    // which is inherent to scoring potrace at all.
    rows.push(
      await score(c.name, engine, source, () =>
        labTrace(image, { ...DEFAULT_VECTORIZE_OPTIONS, engine, gradients: true }),
      ),
    )
    const doc = await labTrace(image, { ...DEFAULT_VECTORIZE_OPTIONS, engine, gradients: true })
    svgs[engine] = serializeDoc(doc, 2)
  }

  return { width: image.width, height: image.height, rows, svgs, refSvg }
}

export default function EngineLab() {
  const [ui, setUi] = useLabState('lab:engine', { box: 260 })

  const run = useLabRun(CASES, analyze, {
    label: (c) => `Tracing ${c.name} (${ENGINES.join(' + ')})`,
    done: (n) => `Done — ${n} cases × ${ENGINES.length} engines @ ${MAX_DIM}px.`,
    deps: [],
    // Fixed corpus and options — the whole result is deterministic except `runtimeMs`, which a
    // hit freezes at its first-measured value. Acceptable: it's a single noisy sample either way,
    // and skipping the double-retrace determinism check + potrace's main-thread block on every
    // open is the bigger win. A code change (new ENGINE_HASH) re-measures.
    cache: { id: 'engine', key: (c) => c.name, optionsKey: `${MAX_DIM}` },
  })

  const all = run.results.flatMap((r) => r.value?.rows ?? [])

  return (
    <LabPage
      storageKey="lab:engine"
      title="Engine scoreboard"
      subtitle="potrace vs crisp: ΔE, SSIM, seam, node counts, runtime, determinism"
      status={run.status}
      running={run.running}
      progress={run.progress}
      box={ui.box}
      onBox={(box) => setUi({ box })}
      about={<EngineAbout />}
    >
      {all.length > 0 && <Scoreboard rows={all} />}

      {run.results.map(({ case: c, value: r, error }) => {
        if (!r) {
          return (
            <CaseRow key={c.name} title={c.name}>
              <NoteBox tone="bad">Failed: {error}</NoteBox>
            </CaseRow>
          )
        }
        return (
          <CaseRow key={c.name} title={c.name} right={`${r.width}×${r.height}`}>
            <Panel label={`source · ${c.kind}`} note={`${r.width}×${r.height}`} aspect={r.width / r.height}>
              <img src={c.src} alt="" />
            </Panel>
            {ENGINES.map((engine) => {
              const row = r.rows.find((x) => x.engine === engine)
              if (!row) return null
              return (
                <Panel
                  key={engine}
                  label={engine}
                  aspect={r.width / r.height}
                  note={
                    <>
                      {row.runtimeMs.toFixed(0)} ms · {row.paths}p · {row.nodes}n · {row.gradients}g
                      <br />
                      ΔE {row.meanDeltaE.toFixed(2)} · SSIM {row.ssim.toFixed(3)} · seam{' '}
                      {row.seamMax.toFixed(0)} · {row.determinism}
                    </>
                  }
                >
                  <RawArt html={r.svgs[engine]} />
                </Panel>
              )
            })}
            {r.refSvg && (
              <Panel label="reference" note="Affinity export — flat" aspect={r.width / r.height}>
                <RawArt html={r.refSvg} />
              </Panel>
            )}
          </CaseRow>
        )
      })}
      {run.pending && <PendingRow title={run.pending.name} />}
    </LabPage>
  )
}

const HEAD = [
  'image',
  'engine',
  'L1 Lab',
  'meanΔE',
  'P95 ΔE',
  'SSIM',
  'seam max',
  'seam P99.5',
  'paths',
  'nodes',
  'grad',
  'ms',
  'det',
]

function Scoreboard({ rows }: { rows: ScoreRow[] }) {
  return (
    <div className="border-b border-line px-4 py-4">
      <div className="panel overflow-x-auto p-2">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="text-left text-[0.6rem] uppercase tracking-wide text-muted">
              {HEAD.map((h) => (
                <th key={h} className="whitespace-nowrap border-b border-line px-2 py-1 font-semibold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="font-mono text-[0.68rem] tabular-nums">
            {rows.map((r) => (
              <tr key={`${r.name}-${r.engine}`}>
                <td className="whitespace-nowrap border-b border-line/60 px-2 py-1 font-sans font-semibold text-ink">
                  {r.name}
                </td>
                <td className="border-b border-line/60 px-2 py-1 text-ink-2">{r.engine}</td>
                <td className="border-b border-line/60 px-2 py-1">{r.l1Lab.toFixed(2)}</td>
                <td className="border-b border-line/60 px-2 py-1">{r.meanDeltaE.toFixed(2)}</td>
                <td className="border-b border-line/60 px-2 py-1">{r.p95DeltaE.toFixed(1)}</td>
                <td className="border-b border-line/60 px-2 py-1">{r.ssim.toFixed(4)}</td>
                <td className="border-b border-line/60 px-2 py-1">{r.seamMax.toFixed(1)}</td>
                <td className="border-b border-line/60 px-2 py-1">{r.seamP995.toFixed(1)}</td>
                <td className="border-b border-line/60 px-2 py-1">{r.paths}</td>
                <td className="border-b border-line/60 px-2 py-1">{r.nodes}</td>
                <td className="border-b border-line/60 px-2 py-1">{r.gradients}</td>
                <td className="border-b border-line/60 px-2 py-1">{r.runtimeMs.toFixed(0)}</td>
                <td
                  className={`border-b border-line/60 px-2 py-1 ${
                    r.determinism === 'pass' ? 'text-good' : 'text-bad'
                  }`}
                >
                  {r.determinism}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function EngineAbout() {
  return (
    <>
      <p className="mb-2 max-w-[96ch]">
        Both engines trace every case, and every trace is scored: <b>L1 Lab</b> and <b>ΔE</b> are
        colour error against the source, <b>SSIM</b> is structural similarity, <b>seam</b> is the
        worst colour break across a boundary inside a smooth field (the artifact that makes a trace
        look "cut out"), and <b>det</b> says whether tracing the same pixels twice produced the same
        document — a tracer that isn't deterministic can't be regression-gated at all.
      </p>
      <p className="mb-2 max-w-[96ch]">
        This scores the render against the <b>source pixels</b>, not against authored geometry — a
        different question from the <b>Workbench</b>, which is why it lives here. It is also the only
        place <b>potrace</b> is measured: it needs a browser (WASM + DOMParser), so{' '}
        <code>node --test</code> can only score crisp.
      </p>
      <p className="max-w-[96ch]">
        Where a reference panel is present it's an Affinity Designer export of the same art: the bar a
        commercial tracer sets, flattened.
      </p>
    </>
  )
}
