// Profiler — where the trace spends its time, and what each optional feature would cost.
//
// TWO questions the other labs can't answer:
//   1. In the DEFAULT pipeline, which stage is the long pole? Timed via traceImage's
//      `onStage` hook (a pure side channel — segment / paint / trace / beautify / materialize).
//   2. For each Feature-A/B flag that ships OFF (or that ships ON and could be dropped), what
//      does toggling it actually COST per trace? So "enable it by default?" is a measured call.
//
// Timing is NOISY (JS, one thread, GC), so every number is the BEST (min) of `runs` INTERLEAVED
// traces after a warm-up, run on the MAIN THREAD (traceImage directly, not the worker) so the
// clock brackets compute, not postMessage.
//
// Caching, HONESTLY. A timing isn't deterministic like a trace, so a cached number is a PAST
// reading, not a truth. But it is still keyed the same way the other labs key their results —
// by ENGINE_HASH (a tracer/scoring edit re-measures automatically) plus the settings — so
// reopening the lab is instant instead of re-churning 150s. The banner says when you're looking
// at cached numbers, and "Re-measure" (a bump to a persisted nonce in the key) forces a fresh
// reading whenever you want one.

import { useMemo } from 'react'
import { RotateCw } from 'lucide-react'
import { labImageData } from './resvgRaster'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../../lib/trace'
import type { VectorizeOptions } from '../../types'
import type { PlanarFitOptions } from '../../lib/trace/planarFit'
import { AB_CORPUS, abUrl } from '../../devtest/abCorpus'
import { LabPage, LabSelect, LabCheck } from './LabPage'
import { useLabState } from './useLabState'
import { useLabRun } from './useLabRun'

interface Case {
  id: string
  name: string
  kind: 'png' | 'svg'
  src: string
}

// A spread the timing should be read across: a flat logo, dense multi-region flat art, the
// high-frequency checker, a nested/gradient photo, crossings, and a gradient-bg case.
const CASE_IDS = ['summit', 'petals', 'checker', 'nebula', 'bloom', 'gradient-flat']
const CASES: Case[] = CASE_IDS.map((id) => {
  const c = AB_CORPUS.find((x) => x.id === id)!
  return { id, name: c.name.replace(/^⟐\s*/, '').split(' — ')[0], kind: c.kind, src: abUrl(c.path) }
})

/** The DEFAULT pipeline's stages, in execution order, each with a bar colour. */
const STAGES = [
  { key: 'segment', label: 'segment', color: '#6366f1' },
  { key: 'paint', label: 'paint', color: '#f59e0b' },
  { key: 'trace', label: 'trace', color: '#14b8a6' },
  { key: 'beautify', label: 'beautify', color: '#a855f7' },
  { key: 'materialize', label: 'materialize', color: '#64748b' },
] as const
const OTHER = { key: 'other', label: 'other', color: '#94a3b8' }

/** Feature-A/B flags, each measured against the shipped default. `defaultOn` features (arcSnap,
 *  cornerVeto) are timed by turning them OFF, so `cost` is always "ms this feature adds to a
 *  trace" — positive means it costs that much, whichever direction the default sits. */
interface Feature {
  label: string
  note: string
  defaultOn: boolean
  planarFit?: Partial<PlanarFitOptions>
  opts?: Partial<VectorizeOptions>
}
const FEATURES: Feature[] = [
  { label: 'localScaleK = 0.15', note: '§10.1 scale-relative snap ε', defaultOn: false, planarFit: { localScaleK: 0.15 } },
  { label: 'refineJunctions', note: 'sub-pixel + G¹ junction weld (§9.3)', defaultOn: false, planarFit: { refineJunctions: true } },
  { label: 'junctionReseat', note: '§10.4 junction re-seat + converged-pair weld — ships ON; cost of keeping it', defaultOn: true, planarFit: { junctionReseat: false } },
  { label: 'arcSnap (co-circular)', note: 'ring arc snap — ships ON; cost of keeping it', defaultOn: true, planarFit: { arcSnap: false } },
  { label: 'cornerVeto (§9.8)', note: 'corner-turn veto — ships ON; cost of keeping it', defaultOn: true, planarFit: { cornerVeto: false } },
]

interface Prof {
  width: number
  height: number
  total: number
  stages: { key: string; ms: number }[]
  features: { label: string; note: string; cost: number; pct: number }[]
}

/** Hand the event loop back so the tab paints and stays interactive between rounds. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/**
 * Time the baseline + every feature config, INTERLEAVED: each round traces all configs back to
 * back, and we keep the MINIMUM total each config ever hit across the `runs` rounds. Min (not
 * mean/median) is the right statistic for compute time — GC pauses, a background tab and thermal
 * throttling only ever ADD milliseconds, so the fastest observed run is the cleanest estimate of
 * the work itself. Interleaving means baseline and a feature are measured under near-identical
 * machine conditions within a round, so their delta cancels slow drift instead of blaming it on
 * whichever config happened to run while the CPU was busy — the flaw that made a genuinely free
 * flag (localScaleK) read as +10%. Stage times come from the base config's fastest round.
 */
async function analyze(c: Case, raster: number, gradients: boolean, runs: number): Promise<Prof> {
  const svgText = c.kind === 'svg' ? await (await fetch(c.src)).text() : undefined
  const image = await labImageData(c.src, raster, svgText)
  const base: VectorizeOptions = { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients }
  const configs: VectorizeOptions[] = [base, ...FEATURES.map((f) => ({ ...base, ...(f.opts ?? {}), planarFit: { ...(f.planarFit ?? {}) } }))]

  for (const cfg of configs) await traceImage(image, cfg) // warm-up each config once (JIT + first-touch)

  const mins = configs.map(() => Infinity)
  let bestStages: Record<string, number> = {}
  for (let r = 0; r < runs; r++) {
    for (let ci = 0; ci < configs.length; ci++) {
      const stages: Record<string, number> | undefined = ci === 0 ? {} : undefined
      const sink = stages ? (n: string, x: number) => { stages[n] = (stages[n] ?? 0) + x } : undefined
      const t0 = performance.now()
      await traceImage(image, configs[ci], undefined, undefined, undefined, sink)
      const dt = performance.now() - t0
      if (dt < mins[ci]) {
        mins[ci] = dt
        if (stages) bestStages = stages
      }
    }
    await tick() // let the tab paint between rounds
  }

  const baseline = mins[0]
  const features: Prof['features'] = FEATURES.map((f, i) => {
    const toggled = mins[i + 1]
    const cost = f.defaultOn ? baseline - toggled : toggled - baseline
    return { label: f.label, note: f.note, cost, pct: baseline > 0 ? (cost / baseline) * 100 : 0 }
  })

  return {
    width: image.width,
    height: image.height,
    total: baseline,
    stages: STAGES.map((s) => ({ key: s.key, ms: bestStages[s.key] ?? 0 })),
    features,
  }
}

const ms = (v: number): string => (v >= 100 ? v.toFixed(0) : v.toFixed(1))

/** A horizontal stacked bar of stage durations, widths proportional to the case total. */
function StageBar({ stages, total }: { stages: { key: string; ms: number }[]; total: number }) {
  const summed = stages.reduce((s, x) => s + x.ms, 0)
  const segs = [...stages.map((s) => ({ ...STAGES.find((d) => d.key === s.key)!, ms: s.ms })), { ...OTHER, ms: Math.max(0, total - summed) }]
  return (
    <div className="flex h-5 w-full overflow-hidden rounded bg-line-strong" role="img" aria-label="stage timing">
      {segs.map((s) => {
        const pct = total > 0 ? (s.ms / total) * 100 : 0
        if (pct < 0.4) return null
        return <div key={s.key} title={`${s.label} · ${ms(s.ms)}ms · ${pct.toFixed(0)}%`} style={{ width: `${pct}%`, background: s.color }} />
      })}
    </div>
  )
}

export default function ProfilerLab() {
  const [ui, setUi] = useLabState('lab:profiler', { box: 300, raster: 512, gradients: false, runs: 5, nonce: 0 })

  const run = useLabRun(CASES, (c) => analyze(c, ui.raster, ui.gradients, ui.runs), {
    label: (c) => `Profiling ${c.name}`,
    done: (n) => `Done — ${n} cases · best of ${ui.runs} interleaved runs @ ${ui.raster}px · gradients ${ui.gradients ? 'on' : 'off'}. Timing is noisy; read the shape, not the last digit.`,
    deps: [ui.raster, ui.gradients, ui.runs, ui.nonce],
    // Cached like the other labs (ENGINE_HASH + settings), so reopening is instant. The `nonce`
    // (bumped by Re-measure, persisted so a reopen shows your LAST reading) rotates the key to
    // force a fresh measurement on demand. Prof is plain numbers — no serialize needed.
    cache: { id: 'profiler', key: (c) => c.id, optionsKey: `r${ui.raster}:g${ui.gradients}:n${ui.runs}:m${ui.nonce}` },
  })

  // All results served from the store (nothing re-measured this mount) ⇒ we're viewing a past
  // reading. Say so, and offer the fresh one.
  const allCached = !run.running && run.progress.total > 0 && run.progress.cached === run.progress.total

  const done = run.results.filter((r) => r.value).map((r) => r.value as Prof)

  // Aggregate: sum every stage + total across finished cases → the corpus-wide breakdown.
  const agg = useMemo(() => {
    const stages = STAGES.map((s) => ({ key: s.key, ms: done.reduce((a, p) => a + (p.stages.find((x) => x.key === s.key)?.ms ?? 0), 0) }))
    const total = done.reduce((a, p) => a + p.total, 0)
    const features = FEATURES.map((f) => {
      const cost = done.reduce((a, p) => a + (p.features.find((x) => x.label === f.label)?.cost ?? 0), 0)
      return { label: f.label, note: f.note, cost, pct: total > 0 ? (cost / total) * 100 : 0 }
    })
    return { stages, total, features }
  }, [done])

  // The observed noise floor is ~1–2% even with min + interleaving, so anything under it is
  // "free" — a feature only reads as a real cost once it clears the noise.
  const verdict = (pct: number): { text: string; tone: string } => {
    const a = Math.abs(pct)
    if (a < 2.5) return { text: 'negligible', tone: 'text-good' }
    if (a < 8) return { text: 'modest', tone: 'text-muted' }
    return { text: 'notable', tone: 'text-warn' }
  }

  return (
    <LabPage
      storageKey="lab:profiler"
      title="Profiler"
      subtitle="Where the trace spends its time, and what each optional feature costs"
      status={run.status}
      running={run.running}
      progress={run.progress}
      box={ui.box}
      onBox={(box) => setUi({ box })}
      about={<ProfilerAbout />}
      controls={
        <>
          <LabCheck label="Gradients" checked={ui.gradients} onChange={(gradients) => setUi({ gradients })} />
          <LabSelect label="Input px" value={ui.raster} onChange={(raster) => setUi({ raster })} options={[256, 512, 768].map((s) => ({ value: s, label: `${s}px` }))} />
          <LabSelect label="Runs" hint="Interleaved rounds; the fastest (min) of each config is reported. More = steadier, slower." value={ui.runs} onChange={(runs) => setUi({ runs })} options={[3, 5, 9].map((s) => ({ value: s, label: `${s}×` }))} />
          <button
            type="button"
            onClick={() => setUi({ nonce: ui.nonce + 1 })}
            disabled={run.running}
            title="Discard the cached reading and measure fresh"
            className="btn btn-secondary h-7 gap-1.5 px-2 text-xs disabled:opacity-50"
          >
            <RotateCw size={13} />
            Re-measure
          </button>
        </>
      }
    >
      <div className="mx-auto flex max-w-[1000px] flex-col gap-8 px-4 py-4">
        {allCached && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2 text-xs text-muted">
            <span>Cached reading — the tracer source is unchanged since these were measured, so nothing re-ran. Timings are a past sample.</span>
            <button type="button" onClick={() => setUi({ nonce: ui.nonce + 1 })} className="btn btn-secondary ml-auto h-6 gap-1 px-2 text-[0.7rem]">
              <RotateCw size={11} />
              Re-measure fresh
            </button>
          </div>
        )}
        {/* ── Section 1 — pipeline stage breakdown ──────────────────────────────── */}
        <section>
          <h2 className="mb-1 text-sm font-semibold text-ink">Where the default pipeline spends its time</h2>
          <p className="mb-3 text-xs text-muted">Stage durations from each case's fastest run, one bar per case. Hover a segment for its ms.</p>
          <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[0.7rem] text-muted">
            {[...STAGES, OTHER].map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>

          {agg.total > 0 && (
            <div className="mb-2 rounded-lg border border-line-strong bg-surface p-2.5">
              <div className="mb-1 flex items-baseline justify-between text-xs">
                <span className="font-semibold text-ink">all cases</span>
                <span className="font-mono tabular-nums text-muted">{ms(agg.total)}ms total</span>
              </div>
              <StageBar stages={agg.stages} total={agg.total} />
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            {run.results.map((r) => (
              <div key={r.case.id} className="rounded-lg border border-line bg-surface p-2.5">
                <div className="mb-1 flex items-baseline justify-between text-xs">
                  <span className="font-medium text-ink">{r.case.name}</span>
                  <span className="font-mono tabular-nums text-muted">
                    {r.value ? `${r.value.width}×${r.value.height} · ${ms(r.value.total)}ms` : r.error ? 'failed' : '…'}
                  </span>
                </div>
                {r.value && <StageBar stages={r.value.stages} total={r.value.total} />}
                {r.error && <p className="text-[0.7rem] text-warn">{r.error}</p>}
              </div>
            ))}
            {run.pending && <div className="rounded-lg border border-dashed border-line bg-surface p-2.5 text-xs text-muted">Profiling {run.pending.name}…</div>}
          </div>
        </section>

        {/* ── Section 2 — feature cost ──────────────────────────────────────────── */}
        <section>
          <h2 className="mb-1 text-sm font-semibold text-ink">What each optional feature costs</h2>
          <p className="mb-3 text-xs text-muted">
            Added ms per trace (best of {ui.runs} interleaved runs), summed across the {CASES.length} cases — so “enable it by default?” is a measured call. A flag that ships ON is timed by turning it OFF.
          </p>
          <div className="overflow-x-auto rounded-lg border border-line-strong bg-surface">
            <table className="w-full text-xs tabular-nums">
              <thead>
                <tr className="border-b border-line text-[0.68rem] uppercase tracking-wide text-muted">
                  <th className="px-3 py-2 text-left font-medium">feature</th>
                  <th className="px-3 py-2 text-right font-medium">cost (ms)</th>
                  <th className="px-3 py-2 text-right font-medium">% of trace</th>
                  <th className="px-3 py-2 text-left font-medium">verdict</th>
                </tr>
              </thead>
              <tbody>
                {agg.features.map((f) => {
                  const v = verdict(f.pct)
                  return (
                    <tr key={f.label} className="border-b border-line last:border-0">
                      <td className="px-3 py-2">
                        <div className="font-mono text-ink">{f.label}</div>
                        <div className="text-[0.68rem] text-faint">{f.note}</div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-ink">{agg.total > 0 ? (f.cost >= 0 ? '+' : '') + ms(f.cost) : '—'}</td>
                      <td className="px-3 py-2 text-right font-mono text-muted">{agg.total > 0 ? (f.pct >= 0 ? '+' : '') + f.pct.toFixed(1) + '%' : '—'}</td>
                      <td className={`px-3 py-2 ${v.tone}`}>{agg.total > 0 ? v.text : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[0.68rem] text-faint">
            A negative cost means removing the feature was measured as SLOWER — i.e. it’s inside the noise floor. Sub-1% rows are effectively free.
          </p>
        </section>
      </div>
    </LabPage>
  )
}

function ProfilerAbout() {
  return (
    <>
      <p className="mb-2 max-w-[96ch]">
        Two questions. <b>Section 1</b> times the DEFAULT pipeline stage by stage (segment → paint → trace → beautify →
        materialize) via a pure timing hook in <code>traceImage</code> — so you can see the long pole (usually
        segmentation, the Step-3c gradient merge inside it). <b>Section 2</b> times each Feature-A/B flag against the
        shipped default, so the cost of enabling <code>localScaleK</code> / <code>refineJunctions</code> (or of keeping{' '}
        <code>junctionReseat</code> / <code>arcSnap</code> / the <code>cornerVeto</code>) is a number, not a guess.
      </p>
      <p className="max-w-[96ch]">
        Every figure is the BEST (min) of the chosen number of INTERLEAVED runs after a warm-up, traced on the main thread
        (the clock brackets compute, not the worker round-trip). Min, because GC and background load only ever add time;
        interleaving baseline and features cancels slow drift, so a free flag reads as ~0, not noise. JS timing is still
        noisy — read the shape and the order of magnitude, not the last digit; bump <b>Runs</b> to 9× for a steadier
        reading. Results ARE cached (keyed by tracer version + settings) so reopening is instant — a banner flags when
        you're seeing a past reading, and <b>Re-measure</b> takes a fresh one.
      </p>
    </>
  )
}
