// A run's progress on disk, so a run that dies (a hang, a reboot, a PC that went to sleep)
// resumes where it stopped instead of tracing and scoring hours of finished cases again. v8
// lost its scoring twice that way: every row lived in memory until the very end.
//
// An entry is reused only when its KEY matches the one this run would compute — the code
// state (git HEAD plus the sha1 of the dirty diff under src/ and bench/, the rev LogoLab's
// version string carries), the run's options, and the exact inputs. Change the tracer or the
// scorer and the entries stop matching by themselves; nothing has to be invalidated by hand.
// `--fresh` ignores them all. One file per entry, written to a temp name and renamed, so a
// run killed mid-write leaves either the old entry or the new one, never half of one.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface Progress {
  /** The value saved under (kind, name), or null when there is none or its key differs. */
  get<T>(kind: string, name: string, key: string): T | null
  put(kind: string, name: string, key: string, value: unknown): void
}

export function progress(runDir: string, fresh: boolean): Progress {
  const file = (kind: string, name: string): string =>
    join(runDir, 'progress', kind, `${name.replace(/[^\w.-]+/g, '_')}.json`)
  return {
    get<T>(kind: string, name: string, key: string): T | null {
      if (fresh) return null
      const f = file(kind, name)
      if (!existsSync(f)) return null
      try {
        const j = JSON.parse(readFileSync(f, 'utf8')) as { key: string; value: T }
        return j.key === key ? j.value : null
      } catch {
        return null // unreadable: do that one again
      }
    },
    put(kind: string, name: string, key: string, value: unknown): void {
      const f = file(kind, name)
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(`${f}.tmp`, JSON.stringify({ key, value }))
      renameSync(`${f}.tmp`, f)
    },
  }
}

/**
 * The rows of a (possibly cut-off) svgbench_metrics.py output: its meta line and every row
 * that carries a digest. A run killed mid-pass leaves a last line half written; it is dropped.
 */
export function readSvgbenchRows(path: string): { meta: unknown; rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>()
  let meta: unknown = null
  if (!existsSync(path)) return { meta, rows }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let j: Record<string, unknown>
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    if ('meta' in j) meta = j.meta
    else if (typeof j.key === 'string' && typeof j.digest === 'string') rows.set(j.key, j)
  }
  return { meta, rows }
}
