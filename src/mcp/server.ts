#!/usr/bin/env node
// LogoLab as an MCP server: the vectorizer and the icon exporter, exposed to
// whatever agent is holding the image.
//
// The flow it exists for: a model generates an icon (a 1024px PNG with soft
// edges and a JPEG-ish halo), and something has to turn that into an app icon
// set — a clean SVG, then favicons, PWA icons, a maskable pair, a .ico, a Tauri
// or Android or iOS collection. Doing that by hand means a raster upscale and a
// blurry 16px favicon; doing it here runs the same tracer the app runs.
//
//   logolab                             serve over stdio (what a client runs)
//   logolab install                     register this server with your client
//   logolab try <image> [outDir]        one-shot local check, no client
//
// From a checkout that is `node src/mcp/server.ts <same args>`; published, the
// npm bin is `logolab`, which is what `npx -y logolab` runs.
//
// stdout belongs to the protocol — everything human goes to stderr (see `log`).

import { writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { exportCollection, type Appearance, type ExportRequest } from './export.ts'
import { loadSource } from './image.ts'
import { install, isMain, parseInstallArgs } from './install.ts'
import { presetCatalogue, PRESETS } from './presets.ts'
import { prepareSource, prepareTraced, type PreparedLogo } from './render.ts'
import { ensureImageData, ensureParent, humanBytes, log, packageVersion, runningFromSource } from './runtime.ts'
import { splitSheet } from './sheet.ts'
import { describeSource, planTrace, traceIcon, type TraceRequest } from './trace.ts'

ensureImageData()

// Read from the manifest that ships, so it cannot drift from what npm serves.
const VERSION = packageVersion()

/* ------------------------------------------------------------ shared schema */

const traceShape = {
  mode: z
    .enum(['auto', 'color', 'mono'])
    .optional()
    .describe('auto (default) counts the inks: one ink on paper traces mono, which is far cleaner for line art; anything else traces colour.'),
  gradients: z
    .enum(['auto', 'flat', 'rich'])
    .optional()
    .describe('auto (default) probes for real colour ramps. flat forces solid fills (right for most icons). rich forces gradient fitting.'),
  flattenOnto: z
    .string()
    .optional()
    .describe('Composite a TRANSPARENT source onto this colour before tracing, e.g. "#ffffff". Omit to keep the alpha. (Not the card colour — that is appearance.background.)'),
  removeBackground: z.boolean().optional().describe('Drop the detected background layer so the SVG comes back transparent.'),
  detail: z.enum(['balanced', 'high']).optional().describe('high lifts the flat-art raster cap 2048 → 4096: crisper, ~4x the work.'),
  smoothing: z.number().min(0).max(100).optional().describe('0 = crisp and node-dense, 100 = smooth and sparse. Default 50.'),
  despeckle: z.number().min(0).max(100).optional().describe('0 keeps every speck, 100 is aggressive. Default 25.'),
  fidelity: z.number().min(0).optional().describe('Shape-beautification tolerance in px; 0 disables snapping to circles/lines.'),
}

const appearanceShape = {
  background: z
    .string()
    .optional()
    .describe('Card colour behind the logo, or "transparent" (the default — the source art is used full-bleed).'),
  shape: z.enum(['rounded', 'circle', 'square']).optional().describe('Card shape. Default square (no card).'),
  radiusPct: z.number().min(0).max(50).optional().describe('Corner radius as % of size, for shape=rounded. Default 24.'),
  paddingPct: z.number().min(0).max(45).optional().describe('Safe-zone inset as % of size. Default 0. Maskable targets raise this to their own floor.'),
  scale: z.number().min(0.1).max(1.5).optional().describe('Logo scale inside the safe box. Default 1.'),
  tintColor: z.string().nullable().optional().describe('Recolour a monochrome logo through its alpha, e.g. "#5b5bd6".'),
  invert: z.boolean().optional().describe('Invert the logo colours (a dark mark for a light context).'),
}

const presetEnum = z.enum(['pwa', 'favicon', 'web', 'tauri', 'electron', 'android', 'ios', 'extension'])

/* ------------------------------------------------------------------ helpers */

function appearanceFrom(input: Record<string, unknown> | undefined): Partial<Appearance> {
  if (!input) return {}
  const out: Partial<Appearance> = {}
  if (typeof input.background === 'string') out.background = input.background
  if (typeof input.shape === 'string') out.shape = input.shape as Appearance['shape']
  if (typeof input.radiusPct === 'number') out.radiusPct = input.radiusPct
  if (typeof input.paddingPct === 'number') out.paddingPct = input.paddingPct
  if (typeof input.scale === 'number') out.scale = input.scale
  if (input.tintColor === null || typeof input.tintColor === 'string') out.tintColor = input.tintColor
  if (typeof input.invert === 'boolean') out.invert = input.invert
  return out
}

function traceRequestFrom(input: Record<string, unknown>): TraceRequest {
  return {
    mode: input.mode as TraceRequest['mode'],
    gradients: input.gradients as TraceRequest['gradients'],
    background: (input.flattenOnto as string) ?? null,
    removeBackground: input.removeBackground as boolean | undefined,
    detail: input.detail as TraceRequest['detail'],
    smoothing: input.smoothing as number | undefined,
    despeckle: input.despeckle as number | undefined,
    fidelity: input.fidelity as number | undefined,
  }
}

/** A tool result: a readable summary first, the machine-readable facts after. */
function reply(summary: string, data: unknown) {
  return {
    content: [{ type: 'text' as const, text: `${summary}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`` }],
  }
}

function fail(err: unknown) {
  return { content: [{ type: 'text' as const, text: `LogoLab: ${(err as Error).message}` }], isError: true }
}

/** Default output path for a trace: next to the source, as .svg. */
function defaultSvgPath(sourcePath: string): string {
  return join(dirname(sourcePath), `${basename(sourcePath, extname(sourcePath))}.svg`)
}

const rel = (p: string): string => relative(process.cwd(), p) || p

/* ------------------------------------------------------------------- server */

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'logolab', version: VERSION },
    {
      instructions: [
        'LogoLab turns generated or hand-drawn icon images into clean vectors and complete app-icon sets, entirely on this machine (no uploads).',
        '',
        'Use it when you have an image that has to become an icon: a model just generated a PNG, a user dropped in a logo, a project needs a favicon or a PWA/Tauri/Android/iOS icon set.',
        '',
        'The normal path is one call to make_app_icons (trace + export). Reach for the pieces when you need them: inspect_icon to see what the tracer would decide, trace_icon for just the SVG, export_icons when a clean SVG or a final PNG already exists, split_icon_sheet when the image is a GRID of many icons on one canvas.',
        '',
        'Tracing is real vectorization — region segmentation and curve fitting, not an image embed — so the SVG scales, stays small, and renders crisply at 16px.',
      ].join('\n'),
    },
  )

  /* ---------------------------------------------------------- inspect_icon */

  server.registerTool(
    'inspect_icon',
    {
      title: 'Inspect an image before tracing',
      description:
        'Report what an image is (size, format, transparency) and what the tracer WOULD do with it — colour vs mono, gradients on or off, the mono cut, the resolution it would trace at — without tracing. Fast. Use it to sanity-check a source, or to explain a choice before overriding it.',
      inputSchema: {
        image: z.string().describe('Path to a PNG, JPEG, WebP, GIF, BMP or SVG file. Relative paths resolve against the working directory.'),
        ...traceShape,
      },
    },
    async (input) => {
      try {
        const src = loadSource(input.image as string)
        const facts = await describeSource(src)
        const { plan } = await planTrace(src, traceRequestFrom(input))
        return reply(
          `${rel(facts.path)} — ${facts.width}×${facts.height} ${facts.kind === 'svg' ? 'SVG' : facts.mime.replace('image/', '').toUpperCase()}${facts.transparent ? ', transparent' : ''}.\nThe tracer would go ${plan.summary}.`,
          { source: facts, plan },
        )
      } catch (err) {
        return fail(err)
      }
    },
  )

  /* ------------------------------------------------------------ trace_icon */

  server.registerTool(
    'trace_icon',
    {
      title: 'Trace an image to clean SVG',
      description:
        'Vectorize a raster image into a clean, editable SVG: colour regions become real shapes with fitted curves, not a traced outline of pixels. Decides colour vs mono, gradient fitting and trace resolution automatically (override with the options). Writes the .svg and reports path count, node count and the decisions it made.',
      inputSchema: {
        image: z.string().describe('Path to the image to trace (PNG, JPEG, WebP, GIF, BMP, or an SVG to re-trace).'),
        out: z.string().optional().describe('Where to write the SVG. Default: next to the source, same name, .svg extension.'),
        inline: z.boolean().optional().describe('Also return the SVG markup in the response (only do this for small icons).'),
        ...traceShape,
      },
    },
    async (input) => {
      try {
        const src = loadSource(input.image as string)
        const outPath = ensureParent((input.out as string) ?? defaultSvgPath(src.path))
        const result = await traceIcon(src, traceRequestFrom(input))
        writeFileSync(outPath, result.svg)
        const data: Record<string, unknown> = {
          svg: outPath,
          bytes: Buffer.byteLength(result.svg),
          stats: result.stats,
          plan: result.plan,
          ms: result.ms,
        }
        if (input.inline) data.markup = result.svg
        return reply(
          `Traced ${rel(src.path)} → ${rel(outPath)} (${humanBytes(Buffer.byteLength(result.svg))}, ${result.stats.paths} paths / ${result.stats.nodes} nodes / ${result.stats.colors} colours, ${(result.ms / 1000).toFixed(1)}s).\nPlan: ${result.plan.summary}.`,
          data,
        )
      } catch (err) {
        return fail(err)
      }
    },
  )

  /* ---------------------------------------------------------- export_icons */

  server.registerTool(
    'export_icons',
    {
      title: 'Export an icon collection',
      description:
        `Render a logo (SVG or raster) into a complete icon collection on disk. Presets:\n${presetCatalogue()}\n\nAn SVG source is rendered analytically at every size, so a 16px favicon is drawn, not downsampled. Maskable/adaptive icons get the platform safe zone automatically (Android keeps only the centre 66% circle). Also emits the real multi-image favicon.ico / .icns containers and the text assets each platform needs (webmanifest, <head> snippet, Contents.json, adaptive-icon XML).`,
      inputSchema: {
        image: z.string().describe('Path to the logo: an SVG (best — rendered crisply at every size) or a raster image.'),
        outDir: z.string().describe('Directory to write into. Files land in the layout each preset expects (public/, src-tauri/icons/, res/, …).'),
        presets: z.array(presetEnum).optional().describe('Which collections to write. Default ["pwa"]. Several may be combined.'),
        sizes: z.array(z.number().int().min(1).max(4096)).optional().describe('Extra arbitrary sizes, written to icons/icon-<n>.png.'),
        appName: z.string().optional().describe('Name used in the webmanifest and the README. Default "App".'),
        appearance: z.object(appearanceShape).optional().describe('How the logo sits in the icon. Defaults keep the source art full-bleed and transparent.'),
      },
    },
    async (input) => {
      try {
        const src = loadSource(input.image as string)
        const logo: PreparedLogo = await prepareSource(src)
        const req: ExportRequest = {
          presets: input.presets as string[] | undefined,
          sizes: input.sizes as number[] | undefined,
          appName: input.appName as string | undefined,
          appearance: appearanceFrom(input.appearance as Record<string, unknown> | undefined),
          svg: src.kind === 'svg' ? src.svgText : null,
        }
        const report = exportCollection(logo, input.outDir as string, req)
        return reply(
          `Exported ${report.files.length} files (${humanBytes(report.totalBytes)}) to ${rel(report.outDir)} — presets: ${report.presets.join(', ')}.`,
          report,
        )
      } catch (err) {
        return fail(err)
      }
    },
  )

  /* -------------------------------------------------------- make_app_icons */

  server.registerTool(
    'make_app_icons',
    {
      title: 'Image → traced SVG → icon set',
      description:
        `The whole pipeline in one call: trace the image to a clean SVG, then render that SVG into the icon collections asked for. This is the tool to use on an AI-generated icon. Presets:\n${presetCatalogue()}`,
      inputSchema: {
        image: z.string().describe('Path to the generated or drawn icon image.'),
        outDir: z.string().describe('Directory to write the icon set into.'),
        presets: z.array(presetEnum).optional().describe('Collections to write. Default ["pwa"].'),
        sizes: z.array(z.number().int().min(1).max(4096)).optional().describe('Extra arbitrary PNG sizes.'),
        appName: z.string().optional().describe('Name used in the webmanifest and README.'),
        appearance: z.object(appearanceShape).optional().describe('How the logo sits in the icon. Default: full-bleed, transparent.'),
        keepSvg: z.string().optional().describe('Also write the traced SVG here (a copy is placed inside the collection anyway).'),
        ...traceShape,
      },
    },
    async (input) => {
      try {
        const src = loadSource(input.image as string)
        const traced = await traceIcon(src, traceRequestFrom(input))
        if (input.keepSvg) writeFileSync(ensureParent(input.keepSvg as string), traced.svg)

        const report = exportCollection(prepareTraced(traced.svg), input.outDir as string, {
          presets: input.presets as string[] | undefined,
          sizes: input.sizes as number[] | undefined,
          appName: input.appName as string | undefined,
          appearance: appearanceFrom(input.appearance as Record<string, unknown> | undefined),
          svg: traced.svg,
        })

        return reply(
          [
            `Traced ${rel(src.path)} (${traced.stats.paths} paths / ${traced.stats.nodes} nodes, ${traced.plan.summary})`,
            `and exported ${report.files.length} files (${humanBytes(report.totalBytes)}) to ${rel(report.outDir)} — presets: ${report.presets.join(', ')}.`,
          ].join(' '),
          { trace: { stats: traced.stats, plan: traced.plan, ms: traced.ms }, export: report },
        )
      } catch (err) {
        return fail(err)
      }
    },
  )

  /* ------------------------------------------------------ split_icon_sheet */

  server.registerTool(
    'split_icon_sheet',
    {
      title: 'Split a sheet of icons',
      description:
        'Cut a CONTACT SHEET — a grid of many icons on one canvas, which is what image models usually return for "a set of icons" — into individual traced SVGs. Detects the tiles (grid or free layout), crops each with the sheet\'s own paper colour, and traces each one with its own plan: a one-ink glyph goes mono, a shaded badge goes colour. Caption text under the icons is detected and reported, but not read (OCR is browser-only), so tiles are named by position.',
      inputSchema: {
        sheet: z.string().describe('Path to the sheet image.'),
        outDir: z.string().describe('Directory to write one SVG per detected icon into.'),
        prefix: z.string().optional().describe('File-name stem: <prefix>-01.svg. Default: the sheet file name.'),
        mode: z.enum(['auto', 'color', 'mono']).optional().describe('Per-tile colour decision. Default auto.'),
        gradients: z.enum(['auto', 'flat', 'rich']).optional().describe('Default auto.'),
        keepCrops: z.boolean().optional().describe('Also write each tile as a PNG next to its SVG.'),
        limit: z.number().int().min(1).optional().describe('Trace at most this many tiles (tracing is the slow part).'),
        padding: z.number().min(0).max(0.5).optional().describe('Padding around each icon as a fraction of its long side. Default 0.08.'),
        threshold: z.number().min(1).max(255).optional().describe('How far from the paper colour a pixel counts as ink. Default 24.'),
        gap: z.number().optional().describe('Force the grouping gap in source px. Omit to detect it (recommended).'),
      },
    },
    async (input) => {
      try {
        const src = loadSource(input.sheet as string)
        const report = await splitSheet(src, input.outDir as string, {
          detect: {
            padding: input.padding as number | undefined,
            threshold: input.threshold as number | undefined,
            gap: input.gap as number | undefined,
          },
          mode: input.mode as 'auto' | 'color' | 'mono' | undefined,
          gradients: input.gradients as 'auto' | 'flat' | 'rich' | undefined,
          keepCrops: input.keepCrops as boolean | undefined,
          prefix: input.prefix as string | undefined,
          limit: input.limit as number | undefined,
        })
        const grid = report.grid ? `${report.grid.rows}×${report.grid.cols} grid` : 'free layout'
        return reply(
          `Split ${rel(src.path)} (${grid}) into ${report.icons.length} traced icons in ${rel(report.outDir)}${report.labels.length ? `, ignoring ${report.labels.length} caption tiles` : ''}. Took ${(report.ms / 1000).toFixed(1)}s.`,
          report,
        )
      } catch (err) {
        return fail(err)
      }
    },
  )

  return server
}

/* --------------------------------------------------------------------- CLI */

/** How the reader invoked us, so every usage line below can be pasted as printed. */
const CLI = runningFromSource() ? 'node src/mcp/server.ts' : 'logolab'

const HELP = `LogoLab MCP server ${VERSION}

  ${CLI}                 serve over stdio (this is what an MCP client runs)
  ${CLI} install         register with Claude Code in the current project
      --client claude|cursor|vscode|print
      --scope  project|user
      --dir    <project directory>       (project scope; default: cwd)
      --name   <server name>             (default: logolab)
  ${CLI} try <image> [outDir]
                                         trace + export a PWA set locally, no client involved

Presets: ${PRESETS.map((p) => p.id).join(', ')}
`

async function tryRun(argv: string[]): Promise<void> {
  const image = argv[0]
  if (!image) throw new Error(`usage: ${CLI} try <image> [outDir]`)
  const outDir = argv[1] ?? join(process.cwd(), 'logolab-icons')
  const src = loadSource(image)
  process.stdout.write(`tracing ${src.path} …\n`)
  const traced = await traceIcon(src)
  process.stdout.write(`  ${traced.plan.summary}\n  ${traced.stats.paths} paths / ${traced.stats.nodes} nodes in ${(traced.ms / 1000).toFixed(1)}s\n`)
  const report = exportCollection(prepareTraced(traced.svg), outDir, { presets: ['pwa'], svg: traced.svg, appName: src.name })
  process.stdout.write(`  ${report.summary}\n`)
  for (const f of report.files) process.stdout.write(`    ${f.path} (${humanBytes(f.bytes)})\n`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const cmd = argv[0]

  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(HELP)
    return
  }
  if (cmd === 'install') {
    const result = install(parseInstallArgs(argv.slice(1)))
    process.stdout.write(result.message + '\n')
    return
  }
  if (cmd === 'try') {
    await tryRun(argv.slice(1))
    return
  }

  const server = createServer()
  await server.connect(new StdioServerTransport())
  log(`serving on stdio (v${VERSION}) — cwd ${process.cwd()}`)
}

// Only run the CLI when executed directly; importing this module (tests) must not
// start a server.
if (isMain(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`logolab: ${(err as Error).message}\n`)
    process.exit(1)
  })
}
