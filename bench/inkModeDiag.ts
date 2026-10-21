// Census of the ink probe's AUTOMATIC decision — Colour or Mono — over every image the labs
// know, so a change to `probeInk` / `decideInkMode` shows which images flip.
//
//   node --experimental-strip-types bench/inkModeDiag.ts [--out file.json] [--compare file.json]
//
// The A/B lanes cannot show this: each one FORCES its mode (flat/grad colour, mono mono) and
// asks the probe only where to cut. Production asks it which mode to trace in first. Inputs:
// the A/B corpus (fixtures on transparency, gallery marks on white — exactly as the writer
// rasterizes them, at the flat cap), the line-art cases, and the comparison benchmark's
// rendered cases (`.bench-tools/results/<run>/cases/*/*/truth.png`, on white at 512) when
// they are there.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from '../src/lib/png/decode.ts'
import { decideInkMode, type ImageDataLike } from '../src/lib/traceInput/ink.ts'
import { RASTER_MAX_DIM_FLAT } from '../src/lib/traceInput/traceCaps.ts'
import { AB_COLOUR_LINE_CASES, AB_CORPUS, AB_LINE_ART_CASES, AB_LOGO_CASES } from './abCorpus.ts'

const argv = process.argv.slice(2)
const arg = (k: string): string | undefined => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined)
const RUN = arg('--run') ?? 'v4'

interface Verdict {
  mode: 'color' | 'mono'
  inks: number
  dominant: string | null
}

function decide(img: ImageDataLike): Verdict {
  const plan = decideInkMode(img, 128, { colorMode: 'auto' })
  return { mode: plan.mode, inks: plan.inks, dominant: plan.probe.dominant }
}

const out: Record<string, Verdict> = {}
for (const c of [...AB_CORPUS, ...AB_LOGO_CASES, ...AB_LINE_ART_CASES, ...AB_COLOUR_LINE_CASES]) {
  if (!existsSync(c.path)) continue
  const src = readFileSync(c.path)
  const bytes =
    c.kind === 'svg'
      ? new Resvg(src.toString('utf8'), {
          fitTo: { mode: 'width', value: RASTER_MAX_DIM_FLAT },
          ...(c.background ? { background: c.background } : {}),
        })
          .render()
          .asPng()
      : src
  out[`ab/${c.id}`] = decide(decodePng(bytes))
}
// The whole private logo corpus (`npm run fetch:logos`), on white as /labs/gallery shows it.
const LOGOS = join('examples', 'logos')
if (existsSync(LOGOS))
  for (const f of readdirSync(LOGOS).filter((n) => n.endsWith('.svg'))) {
    try {
      const png = new Resvg(readFileSync(join(LOGOS, f), 'utf8'), {
        fitTo: { mode: 'width', value: 512 },
        background: 'white',
      })
        .render()
        .asPng()
      out[`logos/${f}`] = decide(decodePng(png))
    } catch {
      // an SVG resvg cannot render is the gallery's problem, not the probe's
    }
  }
const cases = join('.bench-tools', 'results', RUN, 'cases')
if (existsSync(cases))
  for (const corpus of readdirSync(cases))
    for (const id of readdirSync(join(cases, corpus))) {
      const p = join(cases, corpus, id, 'truth.png')
      if (existsSync(p)) out[`bench/${corpus}/${id}`] = decide(decodePng(readFileSync(p)))
    }

const ids = Object.keys(out)
const mono = ids.filter((k) => out[k].mode === 'mono').length
console.log(`${ids.length} images: ${mono} mono, ${ids.length - mono} colour`)
const save = arg('--out')
if (save) writeFileSync(save, JSON.stringify(out, null, 1))
const cmp = arg('--compare')
if (cmp) {
  const was = JSON.parse(readFileSync(cmp, 'utf8')) as Record<string, Verdict>
  let n = 0
  for (const k of ids) {
    const a = was[k]
    const b = out[k]
    if (!a || (a.mode === b.mode && a.inks === b.inks)) continue
    n++
    console.log(`${k.padEnd(60)} ${a.mode}/${a.inks} → ${b.mode}/${b.inks}  (ink ${b.dominant})`)
  }
  console.log(`${n} changed`)
}
