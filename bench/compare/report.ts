// results.json → summary.md.
//
// What the summary leads with, and why:
//   • the HEADLINE LogoLab row is logolab-auto — what `npx logolab` users get, no per-case
//     knowledge. logolab-gate is printed as a labelled reference row (its gradient flag is an
//     oracle read off the authored SVG). Every row says which inputs it was given.
//   • raw distributions and PAIRED comparisons against that row (per-case win rates, a
//     paired bootstrap CI of the mean difference, significance), not a pass count. The
//     truth-gate pass count is printed LAST, against tool-neutral limits (TRUTH_TOL), with
//     where the limits came from.
//   • every median says the n behind it; a "common cases" line repeats the geometry medians
//     over the cases every main tool could be scored on, so survivorship cannot flatter the
//     weakest tool.
//   • every pixel median and SVG-Bench mean includes the failures (no output, or one resvg
//     cannot draw), scored as a blank white image (SVG-Bench's
//     rasterize_svg does the same).
//   • the paper's rows come with the caveat that they are a different protocol.
//   • a row with n < 10 is marked not comparable.

import { corpusKind, type ScoreRow } from './types.ts'

const HEADLINE = 'logolab-auto'
const ABLATION = /^logolab-abl-/
const MIN_N = 10

const LABEL: Record<string, string> = {
  'logolab-auto': 'logolab-auto ★',
  'logolab-gate': 'logolab-gate (oracle)',
}
const INPUTS: [string, string][] = [
  [
    'logolab-auto',
    'HEADLINE. `npx logolab` (MCP traceIcon) on the PNG: probes pick mono/colour and gradients. No per-case knowledge.',
  ],
  ['logolab-product', "the studio's starting settings (stacked, gradients on), PNG only."],
  [
    'logolab-gate',
    "REFERENCE, not a competitor row: the truth gate's dev config (tiled) with `gradients` read off the AUTHORED SVG — an oracle no other tool gets.",
  ],
  ['vtracer-default', 'VTracer 0.6.4, no flags, PNG only.'],
  ['vtracer-poster', 'VTracer `--preset poster` (its flat-colour preset), PNG only.'],
  ['vtracer-swept', 'VTracer, best of a frozen grid picked on the IN-SAMPLE corpora only (sweepVtracer.ts), PNG only.'],
  [
    'starvector-1b',
    'StarVector-1B im2svg, SVG-Bench HF generation config, seed 0; sees the 512px PNG (its processor resizes to 224).',
  ],
  [
    'logolab-strokes',
    'LINE HEADLINE. `npx logolab` (MCP traceIcon) on the PNG with mode=mono and `strokes` (the Strokes toggle): centreline strokes with a measured width.',
  ],
  ['logolab-outline', 'the same call without `strokes`: the filled outlines LogoLab draws with Strokes off.'],
  [
    'autotrace-centerline',
    'AutoTrace 0.40.0 `-centerline` on the luma<128 PBM (as Potrace gets it); writes 1-px strokes, no width.',
  ],
  [
    'potrace',
    'Potrace 1.16, MONO lane only (one dark ink on white), luma<128 cut, output painted in the case ink (-C).',
  ],
  [
    'potrace-bin',
    "Potrace 1.16 on EVERY case binarised at luma<128, output black as-is: SVG-Bench's protocol, a colour-blind baseline.",
  ],
]

const median = (xs: number[]): number | null => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const vals = (rows: ScoreRow[], k: keyof ScoreRow): number[] => rows.map((r) => r[k]).filter(isNum)
const fmt = (v: number | null, d = 2): string => (v === null ? '—' : v.toFixed(d))
const kfmt = (v: number | null): string => (v === null ? '—' : v >= 10000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0))
const med = (rows: ScoreRow[], k: keyof ScoreRow, d = 2): string => {
  const xs = vals(rows, k)
  return xs.length ? `${fmt(median(xs), d)} (${xs.length})` : '—'
}
const name = (t: string, n: number): string => `${LABEL[t] ?? t}${n < MIN_N ? ` ⚠n=${n}` : ''}`

/** Deterministic PRNG (mulberry32), so the CIs are reproducible run to run. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Paired bootstrap of mean(d) over cases, 95% percentile CI. */
export function pairedBootstrap(d: number[], B = 4000, seed = 1): { mean: number; lo: number; hi: number } {
  const n = d.length
  const r = rng(seed)
  const ms: number[] = []
  for (let b = 0; b < B; b++) {
    let s = 0
    for (let i = 0; i < n; i++) s += d[Math.floor(r() * n)]
    ms.push(s / n)
  }
  ms.sort((a, b) => a - b)
  return { mean: d.reduce((a, b) => a + b, 0) / n, lo: ms[Math.floor(0.025 * B)], hi: ms[Math.ceil(0.975 * B) - 1] }
}

// metric, lower is better?, digits
const PAIRED: [keyof ScoreRow, string, boolean, number][] = [
  ['meanDeltaE', 'ΔE mean', true, 2],
  ['chamfer', 'chamfer px', true, 2],
  ['docNodes', 'nodes', true, 0],
  ['tangentBreaks', 'tangent breaks', true, 1],
  ['sbDino', 'DINO', false, 4],
  ['sbLpips', 'LPIPS', true, 4],
  ['sbSsim', 'SSIM', false, 4],
  ['sbMse', 'MSE', true, 5],
]

/** Rows that carry pixel metrics: every row, a failure scored as white (score.ts scorePixels). */
const rendered = (rs: ScoreRow[]): ScoreRow[] => rs.filter((r) => r.meanDeltaE !== undefined)

export function summaryMarkdown(rows: ScoreRow[], meta: Record<string, unknown>): string {
  const out: string[] = []
  const tools = [...new Set(rows.map((r) => r.tool))]
  const main = tools.filter((t) => !ABLATION.test(t))
  out.push(`# Vectorizer comparison — ${meta.run}`)
  out.push('')
  out.push(
    `Scored at ${meta.res}px (resvg, white)` +
      (Array.isArray(meta.lineRes)
        ? `; line corpora at ${meta.lineRes.join(' / ')}px (the A/B line lane's flat cap)`
        : '') +
      `. LogoLab ${meta.logolab}. Tools: ${main.join(', ')}` +
      (tools.length > main.length ? `; ablation: ${tools.filter((t) => ABLATION.test(t)).join(', ')}.` : '.'),
  )
  out.push('')
  out.push('**What each row was given** (★ = the headline LogoLab row):')
  out.push('')
  for (const [t, s] of INPUTS) if (tools.includes(t)) out.push(`- \`${t}\`: ${s}`)
  out.push('')
  out.push('**How to read it.**')
  out.push('')
  out.push(
    "- Geometry columns are LogoLab's own truth-gate metrics against the AUTHORED SVG (chamfer, p95, parsimony, " +
      'corners invented, tangent breaks, regions) — designed by the authors of one of the tools under test. ' +
      "SVG-Bench columns are StarVector's released metric code (MSE / SSIM / LPIPS-vgg / DINOv2, StarCoder2 tokens). " +
      'ΔE is the shipped `deltaEField` (CIE76) mean.',
  )
  out.push(
    "- Medians print the n behind them as `value (n)`. Geometry is only defined where the tool's output and the " +
      'answer sheet are both readable (no clip / style / stroke); the "common cases" line repeats the medians over ' +
      'the cases where every main tool has geometry.',
  )
  out.push(
    '- Visible boundary only, for every tool: traced outline that is painted over (stacked output) is neither a ' +
      'query nor a match target. Parsimony leaves canvas-edge boundary out on both sides (a full-canvas background ' +
      'path is otherwise ~2k px of free length); `nodes ÷ GT` is the raw anchor ratio.',
  )
  out.push(
    '- Failures (no output, or one resvg cannot draw) are scored as a blank white image (SVG-Bench does the same) and still counted in `fail`.',
  )
  out.push(
    '- `ms` is wall time: in-process and warm for LogoLab; process spawn + PNG/SVG file I/O for VTracer / Potrace; ' +
      'GPU generation only for StarVector. Not comparable across those groups.',
  )
  out.push(
    "- Scope: svgemoji-v0 is held out from LogoLab's development, but it is selected INSIDE LogoLab's niche — Twemoji " +
      'only, fill-only, no gradients / clips / strokes (fetch_svgbench.py). The full 668-row split is a separate run.',
  )
  out.push('')

  const corpora = [...new Set(rows.map((r) => r.corpus))]
  for (const corpus of corpora) {
    const cr = rows.filter((r) => r.corpus === corpus)
    if (corpusKind(corpus) === 'line') {
      out.push(
        ...lineSection(
          corpus,
          cr,
          tools.filter((t) => !ABLATION.test(t) && cr.some((r) => r.tool === t)),
        ),
      )
      continue
    }
    const held = cr[0]?.heldOut ? 'held out' : 'IN-SAMPLE (development)'
    const cases = [...new Set(cr.map((r) => r.caseId))]
    out.push(`## ${corpus} — ${cases.length} cases, ${held}`)
    out.push('')
    const ct = main.filter((t) => cr.some((r) => r.tool === t))

    // ── distributions
    out.push(
      '| tool | n | fail | geom scored | ΔE mean p50 | chamfer p50 | p95 p50 | parsimony p50 | nodes ÷ GT p50 | nodes p50 | invented p50 | breaks p50 | regions all | bytes p50 | ms p50 |',
    )
    out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for (const t of ct) {
      const tr = cr.filter((r) => r.tool === t)
      const ok = tr.filter((r) => r.status === 'ok')
      const scored = ok.filter((r) => r.samples !== undefined).length
      const flat = rendered(tr).filter((r) => r.flat && (r.regionsTrue ?? 0) > 0)
      const regionsAll = flat.filter((r) => r.regionsRecovered === r.regionsTrue).length
      out.push(
        `| ${name(t, tr.length)} | ${tr.length} | ${tr.length - ok.length} | ${scored}/${tr.length} | ` +
          `${fmt(median(vals(rendered(tr), 'meanDeltaE')))} | ${med(ok, 'chamfer')} | ${med(ok, 'p95')} | ` +
          `${med(ok, 'parsimony', 1)} | ${med(ok, 'nodeRatio', 1)} | ${kfmt(median(vals(ok, 'docNodes')))} | ` +
          `${fmt(median(vals(ok, 'cornersInvented')), 0)} | ${fmt(median(vals(ok, 'tangentBreaks')), 0)} | ` +
          `${regionsAll}/${flat.length} | ${kfmt(median(vals(ok, 'bytes')))} | ${kfmt(median(vals(ok, 'ms')))} |`,
      )
    }
    // common cases: every main tool with ≥ MIN_N rows here has geometry on the case
    const big = ct.filter((t) => cr.filter((r) => r.tool === t).length >= MIN_N)
    const common = cases.filter((c) =>
      big.every((t) => cr.some((r) => r.tool === t && r.caseId === c && r.status === 'ok' && isNum(r.chamfer))),
    )
    if (big.length > 1) {
      out.push('')
      out.push(
        `Common cases (${common.length}/${cases.length}: every tool with n ≥ ${MIN_N} has geometry) — chamfer / p95 / nodes ÷ GT / breaks p50: ` +
          big
            .map((t) => {
              const rs = cr.filter((r) => r.tool === t && common.includes(r.caseId))
              return `${t} ${fmt(median(vals(rs, 'chamfer')))} / ${fmt(median(vals(rs, 'p95')))} / ${fmt(median(vals(rs, 'nodeRatio')), 1)} / ${fmt(median(vals(rs, 'tangentBreaks')), 0)}`
            })
            .join('; '),
      )
    }

    // ── paired vs the headline
    if (ct.includes(HEADLINE)) {
      out.push('')
      out.push(
        `Paired against **${HEADLINE}** (same cases): mean difference tool − ${HEADLINE} with a 95% paired-bootstrap CI ` +
          `(4000 resamples, seeded), and how often the tool is strictly better. ✔ = CI excludes 0. ` +
          `Negative is better for ΔE / chamfer / nodes / breaks / LPIPS / MSE, positive for DINO / SSIM.`,
      )
      out.push('')
      out.push(`| tool | ${PAIRED.map(([, l]) => l).join(' | ')} |`)
      out.push(`|---|${PAIRED.map(() => '---').join('|')}|`)
      const head = new Map(rendered(cr.filter((r) => r.tool === HEADLINE)).map((r) => [r.caseId, r]))
      for (const t of ct) {
        if (t === HEADLINE) continue
        const tr = rendered(cr.filter((r) => r.tool === t))
        const cells = PAIRED.map(([k, , lower, d]) => {
          const ds: number[] = []
          let wins = 0
          for (const r of tr) {
            const h = head.get(r.caseId)
            const a = r[k]
            const b = h?.[k]
            // geometry only where both are ok (a white render has none anyway)
            if (!isNum(a) || !isNum(b)) continue
            ds.push(a - b)
            if (lower ? a < b : a > b) wins++
          }
          if (ds.length < 3) return '—'
          const ci = pairedBootstrap(ds)
          const sig = ci.lo > 0 || ci.hi < 0 ? ' ✔' : ''
          const f = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(d)
          return `${f(ci.mean)} [${f(ci.lo)}, ${f(ci.hi)}]${sig} · ${wins}/${ds.length}`
        })
        out.push(`| ${name(t, tr.length)} | ${cells.join(' | ')} |`)
      }
    }

    // ── SVG-Bench
    out.push('')
    out.push(
      'SVG-Bench metrics (means over every row, failures as a white render; ↑ better: DINO, SSIM; ↓ better: LPIPS, MSE). ' +
        '`tokens` is StarCoder2 on the SVG FILE as scored; for StarVector that is the post-processed file (cairosvg-repaired ' +
        "on `cleaned` rows), so `model tok` is the model's own generated-token count (its StarCoder tokenizer, raw text):",
    )
    out.push('')
    out.push('| tool | n | DINO ↑ | LPIPS ↓ | SSIM ↑ | MSE ↓ | tokens (file) | model tok |')
    out.push('|---|---|---|---|---|---|---|---|')
    for (const t of ct) {
      const rs = rendered(cr.filter((r) => r.tool === t))
      out.push(
        `| ${name(t, vals(rs, 'sbSsim').length)} | ${vals(rs, 'sbSsim').length} | ${fmt(mean(vals(rs, 'sbDino')), 3)} | ${fmt(mean(vals(rs, 'sbLpips')), 3)} | ` +
          `${fmt(mean(vals(rs, 'sbSsim')), 3)} | ${fmt(mean(vals(rs, 'sbMse')), 4)} | ${kfmt(mean(vals(rs, 'sbTokens')))} | ` +
          `${t.startsWith('starvector') ? kfmt(mean(vals(rs, 'genTokens'))) : '—'} |`,
      )
    }
    for (const t of ct.filter((t) => t.startsWith('starvector'))) {
      const rs = rendered(cr.filter((r) => r.tool === t))
      const by = (s: string) => rs.filter((r) => (r.notes ?? '').split(' ')[0] === s)
      const part = (s: string) => {
        const g = by(s)
        return g.length
          ? `${s} n=${g.length}: DINO ${fmt(mean(vals(g, 'sbDino')), 3)}, SSIM ${fmt(mean(vals(g, 'sbSsim')), 3)}, file tok ${kfmt(mean(vals(g, 'sbTokens')))}, model tok ${kfmt(mean(vals(g, 'genTokens')))}`
          : null
      }
      out.push('')
      out.push(`- ${t} by output status — ${['valid', 'cleaned', 'placeholder'].map(part).filter(Boolean).join('; ')}`)
    }
    if (corpus.startsWith('svgemoji')) {
      out.push('')
      out.push(
        '*Paper rows — context only, NOT the same protocol:* StarVector arXiv 2312.11556v4 Table 1, SVG-Emoji — a different ' +
          'case mix (Twemoji + OpenMoji + Noto, all rows; ours is ' +
          (corpus === 'svgemoji'
            ? 'the same 668 rows but rendered with resvg, not cairosvg'
            : 'Twemoji-only, fill-only') +
          '), rendered with cairosvg, VTracer and Potrace fed 128px input (ours: 512px). Do not read a gap to these rows as a reproduction error or a win.',
      )
      out.push('')
      out.push('| paper row | DINO ↑ | LPIPS ↓ | SSIM ↑ | MSE ↓ | tokens |')
      out.push('|---|---|---|---|---|---|')
      for (const [n, d, l, s, m, tk] of PAPER_SVG_EMOJI) out.push(`| *${n}* | ${d} | ${l} | ${s} | ${m} | ${tk} |`)
    }

    // ── gates, last, tool-neutral
    out.push('')
    out.push(
      `Truth-gate all-pass against TOOL-NEUTRAL limits — TRUTH_TOL (chamfer ≤ 1.0, p95 ≤ 2.5 px, parsimony ≤ 3.0: tier 0's ` +
        `hand-set absolute bars, not fitted to any tool's output) plus the zero-tolerance gates (regions, ink kept ≥ 50%, ` +
        `corners invented, tangent breaks, corner / circle recovery), every per-case allowance off. Not TIER_TOL[2]: that ` +
        `was fitted just above the p90 of LogoLab's own traces. Only rows with geometry can all-pass: ` +
        ct
          .map((t) => {
            const ok = cr.filter((r) => r.tool === t && r.status === 'ok')
            const all = ok.filter(
              (r) => r.samples !== undefined && (r.gatesApplicable ?? 0) > 0 && r.gatesPassed === r.gatesApplicable,
            ).length
            return `${t} ${all}/${cr.filter((r) => r.tool === t).length}`
          })
          .join(', ') +
        '. Most-failed gates: ' +
        ct
          .map((t) => {
            const h = new Map<string, number>()
            for (const r of cr.filter((r) => r.tool === t))
              for (const g of r.failedGates ?? []) h.set(g, (h.get(g) ?? 0) + 1)
            const top = [...h].sort((a, b) => b[1] - a[1]).slice(0, 3)
            return `${t} ${top.map(([g, n]) => `${g}×${n}`).join(' ') || '—'}`
          })
          .join('; ') +
        '.',
    )

    // ── LogoLab auto's mono decisions
    const monos = cr.filter((r) => r.tool === HEADLINE && /^mono\b/.test(r.notes ?? ''))
    if (monos.length) {
      const gate = new Map(cr.filter((r) => r.tool === 'logolab-gate').map((r) => [r.caseId, r]))
      out.push('')
      out.push(
        `- ${HEADLINE} chose MONO on ${monos.length}/${cr.filter((r) => r.tool === HEADLINE).length} cases (ΔE auto vs gate): ` +
          monos
            .map(
              (r) =>
                `${r.caseId.split('/')[1]} ${fmt(r.meanDeltaE ?? null)} vs ${fmt(gate.get(r.caseId)?.meanDeltaE ?? null)}`,
            )
            .join('; '),
      )
    }

    // ── ablation
    const abl = tools.filter((t) => ABLATION.test(t) && cr.some((r) => r.tool === t))
    if (abl.length) {
      out.push('')
      out.push(
        'LogoLab ablation, layering × gradients with no oracle (stacked + gradients on = logolab-product; on svgemoji tiled + off = logolab-gate):',
      )
      out.push('')
      out.push(
        '| config | n | ΔE mean p50 | ΔE mean mean | regions all | gradient defs (rows with any) | chamfer p50 |',
      )
      out.push('|---|---|---|---|---|---|---|')
      for (const t of ['logolab-product', ...abl, 'logolab-gate'].filter((t) => cr.some((r) => r.tool === t))) {
        const rs = rendered(cr.filter((r) => r.tool === t))
        const flat = rs.filter((r) => r.flat && (r.regionsTrue ?? 0) > 0)
        out.push(
          `| ${t} | ${rs.length} | ${fmt(median(vals(rs, 'meanDeltaE')))} | ${fmt(mean(vals(rs, 'meanDeltaE')))} | ` +
            `${flat.filter((r) => r.regionsRecovered === r.regionsTrue).length}/${flat.length} | ` +
            `${rs.filter((r) => (r.gradientDefs ?? 0) > 0).length} | ${med(
              rs.filter((r) => r.status === 'ok'),
              'chamfer',
            )} |`,
        )
      }
    }

    // ── footnotes
    const failed = cr.filter((r) => r.status !== 'ok')
    const na = cr.filter((r) => r.status === 'ok' && r.geomRefusal)
    const gtNa = cr.filter((r) => r.gtRefusal)
    const degraded = cr.filter((r) => r.notes && /placeholder|truncated/.test(r.notes))
    if (failed.length || na.length || gtNa.length || degraded.length) {
      out.push('')
      const reasons = (rs: ScoreRow[], f: (r: ScoreRow) => string): string => {
        const h = new Map<string, number>()
        for (const r of rs) h.set(f(r), (h.get(f(r)) ?? 0) + 1)
        return [...h].map(([k, v]) => `${k} ×${v}`).join('; ')
      }
      if (failed.length)
        out.push(
          `- failures (pixel metrics from a white render, or the output's own where only the geometry scorer failed): ${reasons(failed, (r) => `${r.tool} ${r.status}: ${r.error ?? ''}`.slice(0, 120))}`,
        )
      if (na.length)
        out.push(`- trace geometry n/a: ${reasons(na, (r) => `${r.tool} ${(r.geomRefusal ?? '').split(' — ')[0]}`)}`)
      if (degraded.length)
        out.push(`- placeholder / truncated outputs (scored as-is): ${reasons(degraded, (r) => r.tool)}`)
      if (gtNa.length)
        out.push(`- ground truth refused (pixel metrics only): ${new Set(gtNa.map((r) => r.caseId)).size} cases`)
    }
    out.push('')
  }
  return out.join('\n')
}

// ── LINE corpora (strokes-oss) ───────────────────────────────────────────────────────────
//
// Their own section, never a column of the fill table: the answer sheet is a set of
// centrelines with widths, and a chamfer against an outline would be a different question.
// The headline row is logolab-strokes (the Strokes toggle). Outline tracers get pixel
// metrics only — their centreline cells read 'no strokes', and the n behind every median
// says how many rows had strokes to score.

const LINE_HEADLINE = 'logolab-strokes'

/** One tool's line-corpus row: the medians the stroke table prints (exported for tests). */
export interface LineStats {
  tool: string
  n: number
  fail: number
  /** Rows with a centreline score (the output had strokes). */
  scored: number
  deltaE: number | null
  centre: number | null
  centreP95: number | null
  missed: number | null
  widthErr: number | null
  /** Median |ends Δ| and |paths Δ|: a stroke broken in two and two fused are both wrong. */
  ends: number | null
  paths: number | null
  /** Rows with no turn / every centreline gate passed, over the scored rows. */
  noTurns: number
  allPass: number
  nodes: number | null
}

export function lineStats(tool: string, rs: ScoreRow[]): LineStats {
  const ok = rs.filter((r) => r.status === 'ok')
  const sc = ok.filter((r) => isNum(r.clCentre))
  const abs = (k: keyof ScoreRow) =>
    sc
      .map((r) => r[k])
      .filter(isNum)
      .map(Math.abs)
  return {
    tool,
    n: rs.length,
    fail: rs.length - ok.length,
    scored: sc.length,
    deltaE: median(vals(rendered(rs), 'meanDeltaE')),
    centre: median(vals(sc, 'clCentre')),
    centreP95: median(vals(sc, 'clCentreP95')),
    missed: median(vals(sc, 'clMissed')),
    widthErr: median(vals(sc, 'clWidthErr')),
    ends: median(abs('clEndsDelta')),
    paths: median(abs('clPathsDelta')),
    noTurns: sc.filter((r) => r.clTurns === 0).length,
    allPass: sc.filter((r) => (r.gatesApplicable ?? 0) > 0 && r.gatesPassed === r.gatesApplicable).length,
    nodes: median(vals(ok, 'docNodes')),
  }
}

const LINE_PAIRED: [keyof ScoreRow, string, number][] = [
  ['meanDeltaE', 'ΔE mean', 2],
  ['clCentre', 'centre px', 2],
  ['clMissed', 'missed px', 2],
  ['clWidthErr', 'width err', 3],
  ['docNodes', 'nodes', 0],
]

function lineSection(corpus: string, cr: ScoreRow[], ct: string[]): string[] {
  const out: string[] = []
  const cases = [...new Set(cr.map((r) => r.caseId))]
  const res = [...new Set(cr.map((r) => r.res))].join(' / ')
  out.push(
    `## ${corpus} — ${cases.length} cases, ${cr[0]?.heldOut ? 'held out' : 'IN-SAMPLE (development)'}, LINE corpus (centrelines) at ${res}px`,
  )
  out.push('')
  out.push(
    '- The answer sheet is the authored STROKES (bench/lineArtGround.ts): `centre` = traced centreline → nearest ' +
      'authored one (precision), `missed` = authored centreline not under the traced ink → nearest traced one ' +
      '(recall; a mean over the MISSED samples only, so one absent stroke reads large), `width err` = relative ' +
      'width error, `|ends Δ|` / `|paths Δ|` = topology against the authored strokes joined end to end, `no turns` = ' +
      'rows where no traced path leaves one authored stroke for another (bench/centerlineScore.ts). Pixel values are ' +
      `raw px at ${res}px; a 24-unit icon's 2-unit stroke is ${res === '2048' ? '~171' : 'w'} px wide here.`,
  )
  out.push(
    '- A row with no stroked path (every outline tracer) has no centreline score — `cl scored` counts the rows that ' +
      'did — and keeps its pixel metrics. `gates` = every centreline gate of test/centerline-gate.test.ts with its ' +
      'pixel limits scaled to the raster (centerlineTol), ΔE from the resvg render.',
  )
  out.push('')
  out.push(
    '| tool | n | fail | cl scored | ΔE mean p50 | centre p50 | centre p95 p50 | missed p50 | width err p50 | |ends Δ| p50 | |paths Δ| p50 | no turns | gates all-pass | nodes p50 |',
  )
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  const stats = ct.map((t) =>
    lineStats(
      t,
      cr.filter((r) => r.tool === t),
    ),
  )
  for (const s of stats) {
    const sc = s.scored
    const c = (v: number | null, d = 2) => (sc ? fmt(v, d) : 'no strokes')
    out.push(
      `| ${name(s.tool, s.n)} | ${s.n} | ${s.fail} | ${sc}/${s.n} | ${fmt(s.deltaE)} | ${c(s.centre)} | ${c(s.centreP95)} | ` +
        `${c(s.missed)} | ${sc ? fmt(s.widthErr, 3) : '—'} | ${sc ? fmt(s.ends, 0) : '—'} | ${sc ? fmt(s.paths, 0) : '—'} | ` +
        `${sc ? `${s.noTurns}/${sc}` : '—'} | ${sc ? `${s.allPass}/${sc}` : '—'} | ${kfmt(s.nodes)} |`,
    )
  }

  // ── per icon set, for the stroke tools: the sets draw differently (Tabler closes circles
  // as open arcs, Feather writes dots as zero-length lines) and a pooled median hides that.
  const sets = [...new Set(cases.map((c) => c.split('/')[1]?.split('-')[0] ?? ''))]
  const strokeTools = stats.filter((s) => s.scored > 0).map((s) => s.tool)
  if (sets.length > 1 && strokeTools.length) {
    out.push('')
    out.push('By icon set (centre p50 / missed p50 / gates all-pass, over the scored rows):')
    out.push('')
    out.push(`| tool | ${sets.join(' | ')} |`)
    out.push(`|---|${sets.map(() => '---').join('|')}|`)
    for (const t of strokeTools) {
      const cells = sets.map((set) => {
        const s = lineStats(
          t,
          cr.filter((r) => r.tool === t && r.caseId.startsWith(`${corpus}/${set}-`)),
        )
        return s.scored ? `${fmt(s.centre)} / ${fmt(s.missed)} / ${s.allPass}/${s.scored}` : '—'
      })
      out.push(`| ${t} | ${cells.join(' | ')} |`)
    }
  }

  // ── paired vs the line headline
  if (ct.includes(LINE_HEADLINE) && ct.length > 1) {
    const head = new Map(rendered(cr.filter((r) => r.tool === LINE_HEADLINE)).map((r) => [r.caseId, r]))
    out.push('')
    out.push(
      `Paired against **${LINE_HEADLINE}** (same cases, both scored): mean difference tool − ${LINE_HEADLINE}, 95% ` +
        'paired-bootstrap CI (4000 resamples, seeded), and how often the tool is strictly better (lower). ✔ = CI excludes 0.',
    )
    out.push('')
    out.push(`| tool | ${LINE_PAIRED.map(([, l]) => l).join(' | ')} |`)
    out.push(`|---|${LINE_PAIRED.map(() => '---').join('|')}|`)
    for (const t of ct) {
      if (t === LINE_HEADLINE) continue
      const tr = rendered(cr.filter((r) => r.tool === t))
      const cells = LINE_PAIRED.map(([k, , d]) => {
        const ds: number[] = []
        let wins = 0
        for (const r of tr) {
          const a = r[k]
          const b = head.get(r.caseId)?.[k]
          if (!isNum(a) || !isNum(b)) continue
          ds.push(a - b)
          if (a < b) wins++
        }
        if (ds.length < 3) return '—'
        const ci = pairedBootstrap(ds)
        const f = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(d)
        return `${f(ci.mean)} [${f(ci.lo)}, ${f(ci.hi)}]${ci.lo > 0 || ci.hi < 0 ? ' ✔' : ''} · ${wins}/${ds.length}`
      })
      out.push(`| ${name(t, tr.length)} | ${cells.join(' | ')} |`)
    }
  }

  // ── SVG-Bench (pixel), every row
  if (cr.some((r) => isNum(r.sbSsim))) {
    out.push('')
    out.push('SVG-Bench metrics (means over every row, failures as a white render):')
    out.push('')
    out.push('| tool | n | DINO ↑ | LPIPS ↓ | SSIM ↑ | MSE ↓ | tokens (file) |')
    out.push('|---|---|---|---|---|---|---|')
    for (const t of ct) {
      const rs = rendered(cr.filter((r) => r.tool === t))
      out.push(
        `| ${name(t, vals(rs, 'sbSsim').length)} | ${vals(rs, 'sbSsim').length} | ${fmt(mean(vals(rs, 'sbDino')), 3)} | ` +
          `${fmt(mean(vals(rs, 'sbLpips')), 3)} | ${fmt(mean(vals(rs, 'sbSsim')), 3)} | ${fmt(mean(vals(rs, 'sbMse')), 4)} | ` +
          `${kfmt(mean(vals(rs, 'sbTokens')))} |`,
      )
    }
  }

  // ── most-failed centreline gates, and the footnotes
  out.push('')
  out.push(
    'Most-failed centreline gates: ' +
      strokeTools
        .map((t) => {
          const h = new Map<string, number>()
          for (const r of cr.filter((r) => r.tool === t))
            for (const g of r.failedGates ?? []) h.set(g, (h.get(g) ?? 0) + 1)
          return `${t} ${
            [...h]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 4)
              .map(([g, n]) => `${g}×${n}`)
              .join(' ') || '—'
          }`
        })
        .join('; ') +
      '.',
  )
  const failed = cr.filter((r) => r.status !== 'ok')
  if (failed.length)
    out.push(
      `- failures (pixel metrics from a white render): ${failed.map((r) => `${r.tool} ${r.caseId.split('/')[1]}: ${(r.error ?? r.status).slice(0, 80)}`).join('; ')}`,
    )
  const na = cr.filter((r) => r.status === 'ok' && r.geomRefusal && r.geomRefusal !== 'no strokes')
  if (na.length)
    out.push(`- centreline n/a for another reason: ${na.map((r) => `${r.tool} ${r.geomRefusal}`).join('; ')}`)
  out.push('')
  return out
}

/** StarVector arXiv 2312.11556v4 Table 1, SVG-Emoji (mixed Twemoji/OpenMoji/Noto, cairosvg,
 *  VTracer / Potrace fed 128px). Printed under its own caveat line, never in the tool table. */
const PAPER_SVG_EMOJI: [string, number, number, number, number, string][] = [
  ['VTracer (paper)', 0.981, 0.074, 0.894, 0.008, '15.7k'],
  ['Potrace (paper)', 0.882, 0.267, 0.78, 0.067, '9.7k'],
  ['StarVector-1B (paper)', 0.929, 0.217, 0.82, 0.063, '4.8k'],
  ['StarVector-8B (paper)', 0.943, 0.193, 0.829, 0.052, '6.7k'],
]
