// The classical tracers, run as separate binaries from the gitignored .bench-tools/.
//
// VTracer gets THREE configurations, as LogoLab does (adapters/logolab.ts), so neither side
// is a best-of-N against a single preset:
//
//   vtracer-default  VTracer 0.6.4 with no flags (Config::default: colour, stacked, spline,
//                    filter_speckle 4, color_precision 6, layer_difference 16, corner 60,
//                    length 4, splice 45, path_precision 2).
//   vtracer-poster   `--preset poster`, VTracer's own flat-colour preset (config.rs
//                    Preset::Poster: the default with color_precision 8).
//   vtracer-swept    the best of a small FROZEN grid, picked on the IN-SAMPLE corpora only
//                    (truth0 + fluent2 — the ones LogoLab was developed on) by
//                    bench/compare/sweepVtracer.ts, then run unchanged on the held-out set:
//                    the same dev / held-out discipline LogoLab had. VTRACER_SWEPT records
//                    the pick and the grid it came from.
//
// (The earlier `vtracer-tuned` — the web app's vectorstock sample, f8 p7 g64 — is retired: it
// was worse than the default on every corpus, a handicap rather than tuning.)
//
//   potrace          Potrace 1.16 defaults (-t 2 -a 1 -O 0.2), MONO lane only (one dark ink
//                    on white: few cases). The cut is ours and explicit: Rec.601 luma of the
//                    pixel over white < 128 is ink, written as a P4 PBM. Output is painted in
//                    the case's ink with `-C` (corpus.ts inkOf), as LogoLab's mono output is
//                    repainted in its probed ink — otherwise ΔE / SSIM / MSE score #000000
//                    against #31373d, colour Potrace cannot output, not shape.
//   potrace-bin      SVG-Bench's protocol: EVERY case binarised the same way and traced, the
//                    output scored as-is (black). A colour-blind baseline, comparable to the
//                    paper's Potrace row — not to the colour tools on ΔE.
//
// Install: see run.ts's header. A missing binary makes the adapter unavailable, not a crash.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { TOOLS } from '../paths.ts'
import type { TracerAdapter, TraceInput } from '../types.ts'

const run = promisify(execFile)
const exe = (p: string): string => (process.platform === 'win32' ? `${p}.exe` : p)

export const VTRACER = exe(join(TOOLS, 'vtracer', 'bin', 'vtracer'))
export const POTRACE = exe(join(TOOLS, 'potrace', 'potrace-1.16.win64', 'potrace'))

const missing = (bin: string) => async (): Promise<string | null> => (existsSync(bin) ? null : `not installed (${bin})`)

async function firstLine(bin: string): Promise<string> {
  const { stdout } = await run(bin, ['--version'])
  return stdout.split('\n')[0].trim()
}

export function vtracer(name: string, args: string[]): TracerAdapter {
  return {
    name,
    lanes: ['colour', 'mono'],
    available: missing(VTRACER),
    version: async () => `${await firstLine(VTRACER)} ${args.join(' ')}`.trim(),
    async trace(i: TraceInput) {
      const out = scratch(i, name, 'svg')
      const t = performance.now()
      await run(VTRACER, ['-i', i.pngPath, '-o', out, ...args])
      return { svg: readFileSync(out, 'utf8'), ms: performance.now() - t }
    },
  }
}

export const vtracerDefault = vtracer('vtracer-default', [])
export const vtracerPoster = vtracer('vtracer-poster', ['--preset', 'poster'])

/**
 * sweepVtracer.ts's pick (2026-10-17). Grid: color_precision {6,7,8} × layer_difference
 * {8,16,32} × filter_speckle {0,2,4} × hierarchical {stacked,cutout}, path_precision 2, the
 * rest default; 56 in-sample cases @512; ranked by the sum of the config's ranks on median
 * ΔE and median chamfer. Re-run the sweep to re-derive it; never pick on svgemoji.
 * Pick: ΔE p50 0.658, chamfer p50 0.348, nodes p50 248 (default: 0.612 / 0.387 / 140); the
 * runners-up (-g 8 -f 0 stacked) had lower ΔE (0.38–0.41) at ~2.4× the nodes.
 */
export const VTRACER_SWEPT: string[] = ['-p', '6', '-g', '8', '-f', '2', '--hierarchical', 'cutout']
export const vtracerSwept = vtracer('vtracer-swept', [...VTRACER_SWEPT, '--path_precision', '2'])

/** Binary P4 PBM of the raster: composited-over-white Rec.601 luma < threshold is ink. */
export function toPbm(img: { width: number; height: number; data: Uint8ClampedArray }, threshold = 128): Buffer {
  const { width: w, height: h, data } = img
  const rowBytes = Math.ceil(w / 8)
  const body = Buffer.alloc(rowBytes * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const a = data[o + 3] / 255
      const l =
        0.299 * (data[o] * a + 255 * (1 - a)) +
        0.587 * (data[o + 1] * a + 255 * (1 - a)) +
        0.114 * (data[o + 2] * a + 255 * (1 - a))
      if (l < threshold) body[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  return Buffer.concat([Buffer.from(`P4\n${w} ${h}\n`), body])
}

function potraceAdapter(name: string, lanes: ('colour' | 'mono')[], inked: boolean): TracerAdapter {
  return {
    name,
    lanes,
    available: missing(POTRACE),
    // The version string is the cache key: it must say whether the output is repainted.
    version: async () => `${await firstLine(POTRACE)} -s${inked ? ' -C <case ink>' : ''}`,
    async trace(i) {
      const pbm = scratch(i, name, 'pbm')
      const out = scratch(i, name, 'svg')
      const t = performance.now()
      writeFileSync(pbm, toPbm(i.image))
      await run(POTRACE, ['-s', ...(inked ? ['-C', i.ink] : []), '-o', out, pbm])
      return { svg: readFileSync(out, 'utf8'), ms: performance.now() - t, notes: inked ? `ink ${i.ink}` : undefined }
    },
  }
}

export const potrace = potraceAdapter('potrace', ['mono'], true)
export const potraceBin = potraceAdapter('potrace-bin', ['colour', 'mono'], false)

// AutoTrace 0.40.0 (2020-02-19, the last Windows build that runs: the 0.31.10 installer of
// 2024 ships libtool's build-tree wrapper instead of the program). StarVector's paper reports
// it on SVG-Emoji. This build reads no PNG, so it gets a binary PPM of the same raster,
// composited over white. Two rows, as VTracer has:
//
//   autotrace-default  no flags: every exact colour is traced, so each anti-aliased edge
//                      tone becomes its own sliver (2770 paths on the smiling face).
//   autotrace-swept    the best of a frozen grid picked on the IN-SAMPLE corpora only
//                      (bench/compare/sweepAutotrace.ts), as vtracer-swept is.
//
// Its SVG has no xmlns and no viewBox; render.ts normalizeRoot adds both for every tool.

export const AUTOTRACE = exe(join(TOOLS, 'autotrace', 'autotrace-0.40.0', 'autotrace'))

/** Binary P6 PPM of the raster composited over white. */
export function toPpm(img: { width: number; height: number; data: Uint8ClampedArray }): Buffer {
  const { width: w, height: h, data } = img
  const body = Buffer.alloc(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3] / 255
    for (let c = 0; c < 3; c++) body[i * 3 + c] = Math.round(data[i * 4 + c] * a + 255 * (1 - a))
  }
  return Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), body])
}

export function autotrace(name: string, args: string[]): TracerAdapter {
  return {
    name,
    lanes: ['colour', 'mono'],
    available: missing(AUTOTRACE),
    version: async () => `${await firstLine(AUTOTRACE)} ${args.join(' ')}`.trim(),
    async trace(i: TraceInput) {
      const ppm = scratch(i, name, 'ppm')
      const out = scratch(i, name, 'svg')
      const t = performance.now()
      writeFileSync(ppm, toPpm(i.image))
      await run(AUTOTRACE, ['-output-format', 'svg', '-output-file', out, ...args, ppm])
      return { svg: readFileSync(out, 'utf8'), ms: performance.now() - t }
    },
  }
}

/**
 * sweepAutotrace.ts's pick (2026-10-25), 56 in-sample cases @512: ΔE p50 0.193, chamfer p50
 * 0.251, nodes p50 359 (default: 0.390 / 0.315 / 3900). Colour reduction lost on every
 * setting. The pick sits on the grid's lowest error-threshold (1); the grid was not widened
 * after seeing that, so a lower threshold might do better still.
 */
export const AUTOTRACE_SWEPT: string[] = ['-despeckle-level', '8', '-error-threshold', '1']
export const autotraceDefault = autotrace('autotrace-default', [])
export const autotraceSwept = autotrace('autotrace-swept', AUTOTRACE_SWEPT)

/** A per-case scratch file next to the case's PNG. */
function scratch(i: TraceInput, tool: string, ext: string): string {
  const dir = join(i.pngPath, '..', 'raw')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${tool}.${ext}`)
}
