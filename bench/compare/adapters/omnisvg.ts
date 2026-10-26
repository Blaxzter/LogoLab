// OmniSVG1.1-4B im2svg (NeurIPS 2025), through bench/compare/py/omnisvg_run.py in its own
// .bench-tools venv (it pins transformers 4.51.3; StarVector's venv cannot share it).
//
// BATCH, as StarVector: every PNG in one directory, the model loaded once (~15 s, 7.3 GB of
// VRAM; peak 8 GB while sampling). It sees the same 512px PNG every tool gets; the repo's own
// preprocessing resizes it to 448. Its output lives in a 200-unit viewBox and is rendered and
// scored at 512 like everyone else's.
//
// The runner drives the repo's own inference.py: its prompt, its image-to-svg sampling
// defaults and its rule for which sample is the answer (the first that decodes and renders
// non-empty, never a comparison with the input), with a fixed seed. Its deviations (resvg in
// place of cairosvg, weights_only loading, torch 2.5.1) are listed in the runner's header.
// An image with no valid candidate is a failure row.

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { spawn } from 'node:child_process'
import { PY, TOOLS } from '../paths.ts'
import type { TracerAdapter, TraceInput, TraceResult } from '../types.ts'

const MODEL = 'OmniSVG/OmniSVG1.1_4B'
export const OMNISVG_REVISION = '117d4c4541839e02943554fe71c0a0d54fcef819'
export const QWEN_REVISION = '66285546d2b821cf421d4f5eb2576359d3770cd3'
/** github.com/OmniSVG/OmniSVG checkout whose inference.py the runner imports. */
export const OMNISVG_SRC_SHA = '308b49b3e3df29c8b5424bbaa7f1f7c6ff218e8d'
const RUNNER = join(PY, 'omnisvg_run.py')
const VENV = join(
  TOOLS,
  'omnisvg-venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python',
)
const WEIGHTS = join(TOOLS, 'hf-cache', 'models--OmniSVG--OmniSVG1.1_4B')

const safe = (id: string): string => id.replace(/[^\w.-]+/g, '__')

/** What results.json records: the batch's own report (model, revisions, generation, GPU). */
export function omnisvgProvenance(batchDir: string): Record<string, unknown> | null {
  const p = join(batchDir, 'report.json')
  if (!existsSync(p)) return { model: MODEL, revision: OMNISVG_REVISION, report: null }
  const { images: _images, ...rest } = JSON.parse(readFileSync(p, 'utf8'))
  return rest
}

export const omnisvg: TracerAdapter = {
  name: 'omnisvg-4b',
  lanes: ['colour', 'mono'],
  async available() {
    if (!existsSync(VENV)) return `no venv (${VENV})`
    if (!existsSync(WEIGHTS)) return `no weights (${WEIGHTS}) — see py/setup.sh`
    if (!existsSync(join(TOOLS, 'omnisvg-src', 'inference.py'))) return 'no omnisvg-src checkout — see py/setup.sh'
    return null
  },
  version: async () => `${MODEL}@${OMNISVG_REVISION.slice(0, 8)} src ${OMNISVG_SRC_SHA.slice(0, 8)} seed0 first-valid`,
  async traceBatch(inputs: TraceInput[], outDir: string) {
    const inDir = join(outDir, 'in')
    const svgDir = join(outDir, 'out')
    mkdirSync(inDir, { recursive: true })
    const byStem = new Map<string, TraceInput>()
    for (const i of inputs) {
      // The PNG's hash is in the name: the runner skips a name it already has (--skip-existing),
      // so a re-used run directory must not hand back an output made from a different raster.
      const stem = `${safe(i.case.id)}__${createHash('sha1').update(readFileSync(i.pngPath)).digest('hex').slice(0, 10)}`
      byStem.set(stem, i)
      copyFileSync(i.pngPath, join(inDir, `${stem}.png`))
    }
    const report = join(outDir, 'report.json')
    const code = await new Promise<number>((resolve) => {
      const p = spawn(
        VENV,
        ['-I', RUNNER, '--in-dir', inDir, '--out-dir', svgDir, '--report', report, '--skip-existing'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      p.stdout.on('data', (b: Buffer) => {
        for (const line of b.toString().split('\n')) {
          const m = /"input": "([^"]+)".*"seconds": ([\d.]+).*"status": "(\w+)"/.exec(line)
          if (m) console.log(`    omnisvg ${basename(m[1].replace(/\\\\/g, '/'))} ${m[2]}s ${m[3]}`)
          else if (line.trim()) console.log(`    omnisvg: ${line.trim()}`)
        }
      })
      p.stderr.on('data', (b: Buffer) => {
        const s = b.toString().trim()
        if (/error|Traceback|Exception/i.test(s)) console.error(`    omnisvg! ${s.slice(0, 400)}`)
      })
      p.on('close', (c) => resolve(c ?? 1))
      p.on('error', () => resolve(1))
    })
    const out = new Map<string, TraceResult | { error: string }>()
    const rows: { input: string; seconds: number; status: string; paths?: number; error?: string }[] = existsSync(
      report,
    )
      ? JSON.parse(readFileSync(report, 'utf8')).images
      : []
    const seen = new Map(rows.map((r) => [basename(r.input).replace(/\.png$/, ''), r]))
    for (const [stem, i] of byStem) {
      const r = seen.get(stem)
      const svgPath = join(svgDir, `${stem}.svg`)
      if (!r) {
        out.set(i.case.id, { error: `omnisvg produced no output (exit ${code})` })
      } else if (r.status !== 'ok' || !existsSync(svgPath)) {
        out.set(i.case.id, { error: `omnisvg: ${r.error ?? r.status}` })
      } else {
        out.set(i.case.id, { svg: readFileSync(svgPath, 'utf8'), ms: r.seconds * 1000, notes: `${r.paths} paths` })
      }
    }
    return out
  },
}
