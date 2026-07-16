#!/usr/bin/env node
// Rehydrate the private ground-truth logo corpus from its sources.
//
// The brand-mark SVGs themselves are NOT committed (trademark/copyright — see
// examples/logos/README.md). This script re-downloads them on demand from the
// source_url recorded for each entry in examples/logos/manifest.json.
//
//   npm run fetch:logos                 # fetch everything missing
//   node scripts/fetch-logos.mjs --force        # re-download even if present
//   node scripts/fetch-logos.mjs bmw visa nasa  # only entries matching a filter
//   LOGOS_DIR=/tmp/logos node scripts/fetch-logos.mjs   # write elsewhere
//
// Sources: svgl.app, vectorlogo.zone (direct .svg URLs) and Wikimedia Commons
// (the File: page is resolved to its raw file via Special:FilePath). Source URLs
// can rot over time; failures are reported per-file and reruns skip what exists.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '..')
const MANIFEST = join(REPO, 'examples', 'logos', 'manifest.json')
const OUT = process.env.LOGOS_DIR ? resolve(process.env.LOGOS_DIR) : join(REPO, 'examples', 'logos')

const UA = 'LogoLab-fetch-logos/1.0 (+https://github.com/Blaxzter/LogoLab; ground-truth corpus)'
const PRIM = /<(path|rect|circle|polygon|ellipse|line|polyline)\b/i

const argv = process.argv.slice(2)
const force = argv.includes('--force')
const concArg = argv.find((a) => a.startsWith('--concurrency='))
const CONCURRENCY = concArg ? Math.max(1, parseInt(concArg.split('=')[1], 10)) : 6
const filters = argv.filter((a) => !a.startsWith('--')).map((s) => s.toLowerCase())

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function downloadUrl(sourceUrl) {
  const m = sourceUrl.match(/commons\.wikimedia\.org\/wiki\/File:(.+)$/)
  if (m) return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(m[1])}`
  return sourceUrl
}

async function get(url, tries = 3) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' })
      if (res.ok) return await res.text()
      if (res.status === 429 || res.status >= 500) {
        await sleep(800 * (i + 1))
        lastErr = new Error(`HTTP ${res.status}`)
        continue
      }
      throw new Error(`HTTP ${res.status}`)
    } catch (e) {
      lastErr = e
      if (i < tries - 1) await sleep(500 * (i + 1))
    }
  }
  throw lastErr
}

function valid(text) {
  if (!text || text.length < 80) return false
  if (!/<svg[\s>]/i.test(text)) return false
  if (!PRIM.test(text)) return false // reject empty / raster-only <image> wrappers
  return true
}

async function run() {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
  await mkdir(OUT, { recursive: true })

  let items = manifest
  if (filters.length) {
    items = manifest.filter((e) =>
      filters.some((f) => e.file.toLowerCase().includes(f) || e.company.toLowerCase().includes(f)),
    )
  }

  const stats = { ok: 0, skipped: 0, failed: 0 }
  const failures = []
  let idx = 0

  async function worker() {
    while (idx < items.length) {
      const e = items[idx++]
      const dest = join(OUT, e.file)
      if (!force && existsSync(dest)) {
        stats.skipped++
        continue
      }
      try {
        const text = await get(downloadUrl(e.source_url))
        if (!valid(text)) throw new Error('not a valid vector SVG')
        await writeFile(dest, text, 'utf8')
        stats.ok++
        process.stdout.write(`  ✓ ${e.file}\n`)
      } catch (err) {
        stats.failed++
        failures.push([e.file, e.source_url, String(err.message || err)])
        process.stdout.write(`  ✗ ${e.file}  (${String(err.message || err)})\n`)
      }
    }
  }

  console.log(`Fetching ${items.length} logo(s) into ${OUT}${force ? ' [--force]' : ''}`)
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))

  console.log(`\nDone: ${stats.ok} downloaded, ${stats.skipped} already present, ${stats.failed} failed.`)
  if (failures.length) {
    console.log('\nFailures (source may have moved — check source_url in the manifest):')
    for (const [f, u, why] of failures) console.log(`  ${f}  <- ${u}\n      ${why}`)
    process.exitCode = 1
  }
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
