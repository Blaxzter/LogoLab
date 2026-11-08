// Inkvec (LogoLabs and Stefan-Lucian Deleanu, Apache-2.0), a Rust tracer for flat art.
// github.com/logolabs/inkvec. No relation to this repo's LogoLab, despite the name of its
// publisher. The command line is built from the pinned tag by py/setup.sh into the gitignored
// .bench-tools/inkvec/ and given the case's PNG, as VTracer is.
//
//   inkvec-default  no flags: `--mode quality`, its full engine.
//   inkvec-fills    `--no-detect-strokes`: the same engine, every face written as a filled outline.
//                   Its default writes faces it reads as drawn strokes as stroked paths, which the
//                   outline scorer refuses (26 of 300 logos, 59 of 100 emoji in v9), so the row
//                   that can be scored on every case is this one, as imagetracer-fills is for
//                   ImageTracer.
//   inkvec-fast     `--mode fast`, its Potrace-class fit on the same planar map.
//   inkvec-strokes  LINE corpora only: `--strokes`, line art as one path and one width each.
//
// This build has no ONNX restorer: that ships as a separate artefact and is for damaged input,
// which no case here is.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { TOOLS } from '../paths.ts'
import type { TracerAdapter, TraceInput } from '../types.ts'

const run = promisify(execFile)
export const INKVEC_SHA = '063398552190e9e8a1077338d6cbc4e902c387ed'
export const INKVEC = join(TOOLS, 'inkvec', 'target', 'release', process.platform === 'win32' ? 'inkvec.exe' : 'inkvec')

function inkvec(name: string, args: string[]): TracerAdapter {
  return {
    name,
    lanes: ['colour', 'mono'],
    available: async () => (existsSync(INKVEC) ? null : `not installed (${INKVEC})`),
    version: async () => {
      const { stdout } = await run(INKVEC, ['--version'])
      return `${stdout.split('\n')[0].trim()} (${INKVEC_SHA.slice(0, 7)}) ${args.join(' ')}`.trim()
    },
    async trace(i: TraceInput) {
      const dir = join(i.pngPath, '..', 'raw')
      mkdirSync(dir, { recursive: true })
      const out = join(dir, `${name}.svg`)
      const t = performance.now()
      await run(INKVEC, [i.pngPath, '-o', out, ...args])
      return { svg: readFileSync(out, 'utf8'), ms: performance.now() - t }
    },
  }
}

export const inkvecDefault = inkvec('inkvec-default', [])
export const inkvecFills = inkvec('inkvec-fills', ['--no-detect-strokes'])
export const inkvecFast = inkvec('inkvec-fast', ['--mode', 'fast'])
export const inkvecStrokes: TracerAdapter = { ...inkvec('inkvec-strokes', ['--strokes']), kinds: ['line'] }
