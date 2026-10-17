// StarVector-1B im2svg, through bench/compare/py/starvector_run.py in the .bench-tools venv.
//
// BATCH: every case's PNG goes in one directory and the model loads once (~6 s, 2.8 GB
// VRAM; ~100 tokens/s on a 4070 Ti SUPER). The model sees the same 512px PNG every tool
// gets; its own processor resizes that to its native 224px input (384 for the 8B) — that
// is StarVector's resolution, not a handicap we chose. Its output is then rendered and
// scored at the same 512px as everyone else.
//
// Generation is the SVG-Bench eval config for the 1B HF model (nucleus sampling, T 0.2,
// top-p 0.95, max_length 7800) with seed 0, so a run is reproducible. An SVG the model
// could not finish is repaired or replaced by StarVector's own placeholder exactly as its
// reference code does — scored as what it is, never skipped. The 8B does not fit in bf16 on
// a 16 GB card and is not run.

import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { PY, TOOLS, VENV_PY } from '../paths.ts'
import type { TracerAdapter, TraceInput, TraceResult } from '../types.ts'

const MODEL = 'starvector/starvector-1b-im2svg'
/** Weights + remote code commit (also the runner's --revision default). */
export const MODEL_REVISION = '380ab95d25a8e9ab1dc825debe238b4953ae13b9'
/** github.com/joanrod/star-vector checkout the venv installs `starvector` from. */
export const STARVECTOR_SRC_SHA = '0e083c1911760aa31bc576ca7f337a7f8ee605ec'
const RUNNER = join(PY, 'starvector_run.py')
const WEIGHTS = join(TOOLS, 'hf-cache', 'models--starvector--starvector-1b-im2svg')

const safe = (id: string): string => id.replace(/[^\w.-]+/g, '__')

/**
 * What results.json records about the StarVector run. Outputs are cached by (version, PNG)
 * in compare-cache/, so a run may generate nothing itself: then the batch report of the run
 * that DID generate them (newest results/<run>/batch/starvector-1b/report.json) is used,
 * and `reportFrom` says which.
 */
export function starvectorProvenance(batchDir: string): Record<string, unknown> {
  let reportPath: string | null = join(batchDir, 'report.json')
  if (!existsSync(reportPath)) {
    const results = join(TOOLS, 'results')
    const found = (existsSync(results) ? readdirSync(results) : [])
      .map((r) => join(results, r, 'batch', 'starvector-1b', 'report.json'))
      .filter((p) => existsSync(p))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    reportPath = found[0] ?? null
  }
  const rep = reportPath ? JSON.parse(readFileSync(reportPath, 'utf8')) : {}
  const src = join(TOOLS, 'star-vector-src')
  let srcSha: string | null = null
  try {
    srcSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: src, encoding: 'utf8' }).trim()
  } catch {}
  return {
    model: MODEL,
    modelRevision: MODEL_REVISION,
    starvectorSrc: srcSha ?? `expected ${STARVECTOR_SRC_SHA} (checkout missing)`,
    base: rep.base ?? null, // 'shim' = starcoderbase-1b config from local shim, not the gated hub repo
    dtype: rep.dtype ?? null,
    torch: rep.torch ?? null,
    gpu: rep.gpu ?? null,
    generation: rep.generation ?? null,
    reportFrom: reportPath,
  }
}

export const starvector: TracerAdapter = {
  name: 'starvector-1b',
  lanes: ['colour', 'mono'],
  async available() {
    if (!existsSync(VENV_PY)) return `no venv (${VENV_PY})`
    if (!existsSync(WEIGHTS)) return `no weights (${WEIGHTS}) — see run.ts header`
    return null
  },
  version: async () => `${MODEL} fp16 seed0 T0.2 top_p0.95 max7800`,
  async traceBatch(inputs: TraceInput[], outDir: string) {
    const inDir = join(outDir, 'in')
    const svgDir = join(outDir, 'out')
    mkdirSync(inDir, { recursive: true })
    const byStem = new Map<string, TraceInput>()
    for (const i of inputs) {
      const stem = safe(i.case.id)
      byStem.set(stem, i)
      copyFileSync(i.pngPath, join(inDir, `${stem}.png`))
    }
    const report = join(outDir, 'report.json')
    const code = await new Promise<number>((resolve) => {
      const p = spawn(
        VENV_PY,
        [
          '-I',
          RUNNER,
          '--model',
          MODEL,
          '--revision',
          MODEL_REVISION,
          '--in-dir',
          inDir,
          '--out-dir',
          svgDir,
          '--report',
          report,
          '--skip-existing',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      p.stdout.on('data', (b: Buffer) => {
        for (const line of b.toString().split('\n')) {
          const m = /"input": "([^"]+)".*"seconds": ([\d.]+).*"status": "(\w+)"/.exec(line)
          if (m) console.log(`    starvector ${basename(m[1].replace(/\\\\/g, '/'))} ${m[2]}s ${m[3]}`)
          else if (line.trim()) console.log(`    starvector: ${line.trim()}`)
        }
      })
      p.stderr.on('data', (b: Buffer) => {
        const s = b.toString().trim()
        // HF / torch chatter is noisy; keep real errors.
        if (/error|Traceback|Exception/i.test(s)) console.error(`    starvector! ${s.slice(0, 400)}`)
      })
      p.on('close', (c) => resolve(c ?? 1))
      p.on('error', () => resolve(1))
    })
    const out = new Map<string, TraceResult | { error: string }>()
    const rows: { input: string; seconds: number; status: string; truncated: boolean; tokens: number }[] = existsSync(
      report,
    )
      ? JSON.parse(readFileSync(report, 'utf8')).images
      : []
    const seen = new Map(rows.map((r) => [basename(r.input).replace(/\.png$/, ''), r]))
    for (const [stem, i] of byStem) {
      const r = seen.get(stem)
      const svgPath = join(svgDir, `${stem}.svg`)
      if (!r || !existsSync(svgPath)) {
        out.set(i.case.id, { error: `starvector produced no output (exit ${code})` })
        continue
      }
      out.set(i.case.id, {
        svg: readFileSync(svgPath, 'utf8'),
        ms: r.seconds * 1000,
        notes: `${r.status}${r.truncated ? ' truncated' : ''} ${r.tokens} tok`,
      })
    }
    return out
  },
}
