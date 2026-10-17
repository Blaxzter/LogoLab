import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import type { Plugin } from 'vite'

/**
 * Serves the vectorizer comparison's LOCAL results to /labs/bench, in `vite dev` only.
 *
 * bench/compare/run.ts writes into the gitignored `.bench-tools/results/<run>/` — a
 * `results.json`, a summary and one directory per case holding every tool's SVG and its
 * render. That is hundreds of MB of renders of art we do not redistribute, so it is never
 * bundled (an `import.meta.glob` would fold every PNG into the build graph) and never
 * deployed: the hosted lab says how to produce the data instead.
 *
 *   GET /__bench/runs                        every run with a results.json, newest first
 *   GET /__bench/runs/<run>/<file>           results.json, summary.md, ATTRIBUTION.md, cases/…
 *   GET /__bench/runs/<run>/gt/<case id>     the case's AUTHORED SVG (resolved via pairs.jsonl)
 *   GET /__bench/manifest                    bench/compare/manifests/svg-emoji-test.json
 *
 * Nothing outside the run directory is served by path: the answer sheets live in the
 * dataset cache or the repo, so they are looked up by case id in the run's own pairs.jsonl.
 */
export function benchResults(): Plugin {
  const root = resolve('.bench-tools', 'results')
  const manifest = resolve('bench', 'compare', 'manifests', 'svg-emoji-test.json')
  const TYPES: Record<string, string> = {
    '.json': 'application/json',
    '.md': 'text/markdown; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jsonl': 'application/x-ndjson',
  }
  // Per run: case id → authored SVG path. pairs.jsonl is rewritten by every run, so it is
  // keyed by mtime rather than read once.
  const gtCache = new Map<string, { mtime: number; map: Map<string, string> }>()

  function gtMap(run: string): Map<string, string> {
    const file = join(root, run, 'pairs.jsonl')
    if (!existsSync(file)) return new Map()
    const mtime = statSync(file).mtimeMs
    const hit = gtCache.get(run)
    if (hit && hit.mtime === mtime) return hit.map
    const map = new Map<string, string>()
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      const p = JSON.parse(line) as { key: string; gt_svg?: string }
      const caseId = p.key.slice(p.key.indexOf('|') + 1)
      if (p.gt_svg && !map.has(caseId)) map.set(caseId, p.gt_svg)
    }
    gtCache.set(run, { mtime, map })
    return map
  }

  function runs() {
    if (!existsSync(root)) return []
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'results.json')))
      .map((d) => {
        const file = join(root, d.name, 'results.json')
        // Only the head of the file is needed, but meta comes first and is small next to the
        // rows; parsing the whole thing keeps this honest about what the lab will load.
        const { meta, rows } = JSON.parse(readFileSync(file, 'utf8')) as {
          meta: { date?: string; corpora?: string[]; tools?: string[] }
          rows: unknown[]
        }
        return {
          name: d.name,
          date: meta.date ?? null,
          corpora: meta.corpora ?? [],
          tools: meta.tools ?? [],
          rows: rows.length,
          bytes: statSync(file).size,
        }
      })
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
  }

  return {
    name: 'logolab-bench-results',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__bench', (req, res, next) => {
        const send = (status: number, body: string | Buffer, type = 'application/json') => {
          res.statusCode = status
          res.setHeader('Content-Type', type)
          res.setHeader('Cache-Control', 'no-store')
          res.end(body)
        }
        try {
          const url = decodeURIComponent((req.url ?? '/').split('?')[0])
          if (url === '/runs') return send(200, JSON.stringify({ root, runs: runs() }))
          if (url === '/manifest') {
            return existsSync(manifest) ? send(200, readFileSync(manifest)) : send(404, '{"error":"no manifest"}')
          }
          const m = /^\/runs\/([^/]+)\/(.+)$/.exec(url)
          if (!m) return next()
          const [, run, rest] = m
          if (rest.startsWith('gt/')) {
            const svg = gtMap(run).get(rest.slice(3))
            return svg && existsSync(svg)
              ? send(200, readFileSync(svg), TYPES['.svg'])
              : send(404, '{"error":"no authored svg"}')
          }
          const file = resolve(root, run, rest)
          if (!file.startsWith(root + sep)) return send(403, '{"error":"outside results"}')
          if (!existsSync(file) || !statSync(file).isFile()) return send(404, '{"error":"not found"}')
          return send(200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream')
        } catch (e) {
          return send(500, JSON.stringify({ error: String(e) }))
        }
      })
    },
  }
}
