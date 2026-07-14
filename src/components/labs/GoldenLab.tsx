// Golden-corpus review — the pictures behind the regression gates.
//
// The regression suite (test/trace-regression.test.ts) asserts NUMBERS against the blessed
// records in test/golden/trace-baseline.json. Nobody had ever LOOKED at what those numbers
// correspond to. This lab renders, per golden case:
//
//   source │ current trace │ rasterizeDoc render │ ΔE error map │ seam map
//
// plus every HARD gate with its current value, its golden, its failing limit and the
// HEADROOM left — so "is this gate doing any work?" is answerable at a glance.
//
// Two properties make it trustworthy rather than decorative:
//   • the case list + trace options come from ../../devtest/traceCorpus — the SAME module the
//     Node gate imports, so it cannot silently trace something else;
//   • the gated numbers come from scoreDoc() — the SAME function recordCase() calls — so the
//     value shown IS the value asserted. Only the source pixels differ in origin (canvas
//     decode here, the local PNG decoder in Node); the lab measures that difference and warns
//     when it matters.

import { useMemo } from 'react'
import { GOLDEN_CORPUS, TOL, caseUrl, type GoldenCase, type GoldenRecord } from '../../devtest/traceCorpus'
import { LabPage, LabCheck, LabSelect } from './LabPage'
import { Panel, RawArt } from './Panel'
import { Badge, CaseRow, NoteBox, PendingRow } from './CaseRow'
import { GatePanel, GateTable, type GateBarRow } from './GateTable'
import { useLabState } from './useLabState'
import { useLabRun } from './useLabRun'
import { heatColor } from './heat'
import { rgbaToUrl } from './raster'
import { traceSvg } from './wire'
import { analyzeGolden, type GoldenAnalysis } from './goldenAnalysis'
// The blessed baseline, bundled rather than fetched: it lives outside public/, so the
// dev server served it and a production build would 404 — the lab would have shown an
// empty page in the one place a visitor could actually reach it.
import baselineJson from '../../../test/golden/trace-baseline.json?raw'
// Same problem for the corpus fixtures (examples/test-files, test/fixtures are outside
// public/). Importing them as URLs makes Vite emit them into the build, so the lab works
// deployed — and being in a lazy chunk, nobody who isn't looking at it pays for them.
const FIXTURES = import.meta.glob('/{examples/test-files,test/fixtures}/*.png', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>

const BASELINE = JSON.parse(baselineJson) as Record<string, GoldenRecord>

/** Full-scale of the ΔE heat ramp. 2.3 ΔE ≈ "just noticeable"; 40 shows structure. */
const HEAT_SCALES = [5, 10, 20, 40, 100]

/** The corpus's repo-relative path → a URL that works in dev AND in a build. Matched
 *  case-insensitively: the corpus says `schild.png`, the file on disk is `Schild.png`,
 *  and only a case-insensitive dev server ever made that work. */
function fixtureUrl(c: GoldenCase): string {
  const want = `/${c.path}`.toLowerCase()
  for (const [k, v] of Object.entries(FIXTURES)) if (k.toLowerCase() === want) return v
  return caseUrl(c)
}

const fmt = (v: number, d: number): string => (Number.isFinite(v) ? v.toFixed(d) : String(v))
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

/** Every pixel's ΔE, on the ramp. */
function heatUrl(a: GoldenAnalysis, scale: number): string {
  const n = a.width * a.height
  const px = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) {
    const [r, g, b] = heatColor(a.de[i] / scale)
    px[i * 4] = r
    px[i * 4 + 1] = g
    px[i * 4 + 2] = b
    px[i * 4 + 3] = 255
  }
  return rgbaToUrl(px, a.width, a.height)
}

/** The render, desaturated, with ONLY the scored seam pixels lit — and a crosshair on the
 *  argmax pixel, because that single pixel IS the gated seamMax. */
function seamUrl(a: GoldenAnalysis, scale: number): string {
  const { width: w, height: h } = a
  const n = w * h
  const px = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    if (a.seam[i]) {
      const [r, g, b] = heatColor(a.de[i] / scale)
      px[o] = r
      px[o + 1] = g
      px[o + 2] = b
    } else {
      px[o] = px[o + 1] = px[o + 2] = a.ghost[i]
    }
    px[o + 3] = 255
  }
  if (a.seamArgmax) {
    const { x, y } = a.seamArgmax
    for (let d = -6; d <= 6; d++) {
      if (Math.abs(d) < 2) continue
      for (const [cx, cy] of [
        [x + d, y],
        [x, y + d],
      ] as [number, number][]) {
        if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue
        const o = (cy * w + cx) * 4
        px[o] = 255
        px[o + 1] = 0
        px[o + 2] = 255
        px[o + 3] = 255
      }
    }
  }
  return rgbaToUrl(px, w, h)
}

/** One gate as a headroom bar. The bar fills with the allowance ALREADY USED, so a nearly
 *  full bar = about to fail, an empty bar = miles of slack. */
function gateRows(a: GoldenAnalysis): GateBarRow[] {
  return a.gates.map((r): GateBarRow => {
    const tone = !r.pass ? 'fail' : r.headroom < 0.2 ? 'tight' : r.headroom < 0.5 ? 'warn' : 'ok'
    const band = r.lo !== undefined ? ` [${r.lo}, ${r.hi}]` : ''
    return {
      key: r.key,
      label: r.label,
      tone,
      cells: [r.rule, fmt(r.value, r.digits), fmt(r.golden, r.digits), `${fmt(r.limit, r.digits)}${band}`],
      // A zero-allowance gate (junctionClusters) has no bar to draw — it is pass/fail.
      fill: r.allowance === 0 ? null : clamp01(1 - r.headroom),
      emptyLabel: 'no tolerance',
      head: r.allowance === 0 ? (r.pass ? '—' : 'FAIL') : `${Math.round(r.headroom * 100)}%`,
    }
  })
}

function GoldenPanels({ a, c, heat }: { a: GoldenAnalysis; c: GoldenCase; heat: number }) {
  const heatMap = useMemo(() => heatUrl(a, heat), [a, heat])
  const seamMap = useMemo(() => seamUrl(a, heat), [a, heat])
  const trace = useMemo(() => traceSvg(a.doc, a.width, a.height), [a])
  // Every panel shows the SAME pixels, so every panel gets the same shape.
  const aspect = a.width / a.height
  return (
    <>
      <Panel
        label="source"
        note={`${a.width}×${a.height} — what the tracer is given`}
        aspect={aspect}
        pixelated
      >
        <img src={fixtureUrl(c)} alt="" />
      </Panel>
      <Panel
        label="current trace"
        note={`${a.score.paths}p · ${a.score.nodes}n · ${a.doc.topology?.vertices.length ?? 0}j`}
        aspect={aspect}
      >
        <RawArt html={trace} />
      </Panel>
      <Panel label="rasterizeDoc render" note="exactly what the metrics score" aspect={aspect} pixelated>
        <img src={a.renderUrl} alt="" />
      </Panel>
      <Panel label="ΔE error map" note={`CIE76, 0 → ${heat} ΔE`} aspect={aspect} pixelated dark>
        <img src={heatMap} alt="" />
      </Panel>
      <Panel
        label="seam map"
        note={`${a.seamCount} scored px · ✚ = the gated max`}
        aspect={aspect}
        pixelated
      >
        <img src={seamMap} alt="" />
      </Panel>
    </>
  )
}

function GoldenFooter({ a, g }: { a: GoldenAnalysis; g: GoldenRecord }) {
  const s = a.score

  // Does the browser reproduce the Node gate's numbers? If the canvas PNG decode differs
  // from the harness's decoder, the live values drift from the blessed ones and the headroom
  // shown here would be measuring the wrong thing. Say so loudly.
  const drift = Math.abs(s.meanDeltaE - g.meanDeltaE)
  const hashMoved = a.hash !== g.hash
  const sigMoved = a.geomSig !== g.geomSig

  const seamOnBorder =
    !!a.seamArgmax &&
    (a.seamArgmax.x === 0 ||
      a.seamArgmax.y === 0 ||
      a.seamArgmax.x === a.width - 1 ||
      a.seamArgmax.y === a.height - 1)

  return (
    <GatePanel>
      {drift > 0.02 ? (
        <NoteBox tone="bad">
          ⚠ This lab's live numbers differ from the blessed record (meanΔE {fmt(s.meanDeltaE, 3)} vs{' '}
          {g.meanDeltaE}). The browser's PNG decode does not match the Node harness's, so treat the
          headroom below as indicative, not exact.
        </NoteBox>
      ) : (
        <NoteBox tone="ok">
          ✓ Live numbers reproduce the blessed record exactly — the headroom below is what CI
          actually measures.
        </NoteBox>
      )}

      <div className="mt-2">
        <GateTable
          columns={['rule', 'current', 'golden', 'fails at']}
          barLabel="allowance used"
          rows={gateRows(a)}
        />
      </div>

      <NoteBox tone="info">
        <b>seam diagnostic (not a gate):</b>{' '}
        {a.seamArgmax
          ? `worst seam pixel (${a.seamArgmax.x}, ${a.seamArgmax.y}) = ${fmt(a.seamArgmax.de, 1)} ΔE`
          : 'no seam pixels'}
        {seamOnBorder && (
          <>
            {' — '}
            <b className="text-bad">ON THE IMAGE BORDER</b>
          </>
        )}
        . Worst seam ignoring the 1px border: <b>{fmt(a.interiorSeamMax, 1)} ΔE</b>
        {a.interiorArgmax && ` at (${a.interiorArgmax.x}, ${a.interiorArgmax.y})`}.{' '}
        {seamOnBorder && (
          <>
            Because seamMax is a MAX pinned to a border pixel, the gate's limit (
            {fmt(g.seamMax + TOL.seamMax, 1)}) sits far above the worst genuine interior seam (
            {fmt(a.interiorSeamMax, 1)}) — a real interior seam could grow that far without failing.{' '}
          </>
        )}
        {a.seamCount} pixels scored.
      </NoteBox>

      <NoteBox tone="info">
        <b>RECORDED BUT NOT GATED</b> — free to drift: p95 ΔE <b>{fmt(s.p95DeltaE, 2)}</b> (g{' '}
        {g.p95DeltaE}) · clusterSpanMax <b>{fmt(s.clusterSpanMax, 2)}</b> (g {g.clusterSpanMax}) ·
        gradients <b>{s.gradients}</b> (g {g.gradientCount}) · junctions <b>{s.junctions}</b> (g{' '}
        {g.junctions}) · seam P99.5 <b>{fmt(s.seamP995, 1)}</b> (not recorded)
      </NoteBox>

      <NoteBox tone={hashMoved || sigMoved ? 'warn' : 'info'}>
        <b>SOFT (logged, never fails):</b> hash <code>{g.hash}</code> →{' '}
        <code className={hashMoved ? 'font-bold text-bad' : ''}>{a.hash}</code> · geomSig{' '}
        <code>{g.geomSig}</code> →{' '}
        <code className={sigMoved ? 'font-bold text-bad' : ''}>{a.geomSig}</code>
        {(hashMoved || sigMoved) && ' — output moved, build still green'}
      </NoteBox>
    </GatePanel>
  )
}

export default function GoldenLab() {
  const [ui, setUi] = useLabState('lab:golden', { box: 260, heat: 20, wire: false, slow: true })

  // The slow case (headphones-grad) is the perf-sensitive one CI skips unless
  // INCLUDE_SLOW=1 — the lab shows it by default, and says so on the row.
  const cases = useMemo(
    () => GOLDEN_CORPUS.filter((c) => (ui.slow || !c.slow) && BASELINE[c.name]),
    [ui.slow],
  )

  const run = useLabRun(cases, (c) => analyzeGolden(c, BASELINE[c.name], fixtureUrl(c)), {
    label: (c) => `Tracing ${c.name}`,
    done: (n) => `Done — ${n} cases. Drag to pan, wheel or pinch to zoom (every box moves together).`,
    deps: [cases],
  })

  return (
    <LabPage
      storageKey="lab:golden"
      title="Golden corpus"
      subtitle="The pictures behind the regression gates, and their headroom"
      status={run.status}
      running={run.running}
      box={ui.box}
      onBox={(box) => setUi({ box })}
      wires={ui.wire}
      controls={
        <>
          <LabSelect
            label="ΔE heat"
            value={ui.heat}
            onChange={(heat) => setUi({ heat })}
            options={HEAT_SCALES.map((s) => ({ value: s, label: `0–${s} ΔE` }))}
          />
          <LabCheck label="Nodes/edges" checked={ui.wire} onChange={(wire) => setUi({ wire })} />
          <LabCheck label="Slow cases" checked={ui.slow} onChange={(slow) => setUi({ slow })} />
        </>
      }
      about={<GoldenAbout />}
    >
      {run.results.map(({ case: c, value: a, error }, i) => {
        const g = BASELINE[c.name]
        if (!a) {
          return (
            <CaseRow key={c.name} title={c.name} badges={<Badge tone="bad">failed to render</Badge>}>
              <NoteBox tone="bad">{error}</NoteBox>
            </CaseRow>
          )
        }
        const failing = a.gates.filter((r) => !r.pass)
        return (
          <CaseRow
            key={c.name}
            title={c.name}
            badges={
              <>
                <Badge tone={c.slow ? 'warn' : 'ok'}>
                  {c.slow ? 'skipped unless INCLUDE_SLOW=1' : 'runs in default suite'}
                </Badge>
                <Badge tone={c.options.gradients ? 'accent' : 'neutral'}>
                  gradients {c.options.gradients ? 'on' : 'off'}
                </Badge>
                {failing.length > 0 && (
                  <Badge tone="bad">{failing.map((r) => r.label).join(', ')}</Badge>
                )}
              </>
            }
            right={`${a.width}×${a.height} · ${a.traceMs.toFixed(0)} ms · ${c.path}`}
            footer={<GoldenFooter a={a} g={g} />}
          >
            <GoldenPanels a={a} c={c} heat={ui.heat} />
          </CaseRow>
        )
      })}
      {run.pending && <PendingRow title={run.pending.name} />}
    </LabPage>
  )
}

function GoldenAbout() {
  return (
    <>
      <p className="mb-2 max-w-[96ch]">
        The regression suite asserts numbers against the blessed records in{' '}
        <code>test/golden/trace-baseline.json</code>. This page shows what those numbers are numbers{' '}
        <em>of</em>: the source, the trace, the render the metrics actually score, and the two error
        maps — plus every hard gate with its current value, its golden, the value at which it fails,
        and how much room is left. A gate with a full bar is about to fail; a gate with an empty one
        is doing no work.
      </p>
      <p className="mb-2 max-w-[96ch]">
        It measures its own trustworthiness. The gated numbers come from <code>scoreDoc()</code> —
        the same function the Node gate calls — but the source pixels are decoded by the browser
        here and by a local PNG decoder in Node. Each row says whether the two agree; if they don't,
        the headroom shown is indicative, not exact.
      </p>
      <p className="max-w-[96ch]">
        Remember what this corpus can and cannot tell you: it compares the tracer to its OWN previous
        output, so it catches drift but has no notion of <em>correct</em> — and its ±12% count bands
        actively forbid large improvements. For "is this right", see <b>Ground truth</b>.
      </p>
    </>
  )
}
