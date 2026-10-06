// The font registry: the bundled families, the user's uploaded ones, and the
// loaded faces layout reads synchronously.
//
// Loading is async (a fetch, plus the HarfBuzz WASM the first time) but layout
// is not, so the registry keeps loaded faces in a map and `lookup` answers from
// it. A text whose font is not loaded yet keeps the outlines it was last laid
// out with — the children are a cache — so nothing has to wait to DRAW.
//
// Bundled fonts are SIL OFL (public/fonts/OFL-*.txt) and live outside the
// precache: they are fetched when first picked and kept by the service
// worker's runtime cache from then on.

import type { FaceLookup } from './layout.ts'
import type { LoadedFace } from './engine.ts'
import { readLocal, writeLocal } from '../persist/local.ts'
import { idbGetMany, idbSet } from '../persist/idb.ts'

export type FontCategory = 'sans' | 'serif' | 'display' | 'script' | 'mono' | 'yours'

export interface FontEntry {
  id: string
  family: string
  category: FontCategory
  /** Where the bytes come from: a URL under /fonts, or an IndexedDB key. */
  file: string
  italicFile?: string
  uploaded?: boolean
  /** Google Fonts css2 `family=` value, for a live-text export to @import. */
  css2?: string
}

export const BUNDLED_FONTS: FontEntry[] = [
  {
    id: 'inter',
    family: 'Inter',
    category: 'sans',
    file: 'inter.ttf',
    italicFile: 'inter-italic.ttf',
    css2: 'Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900',
  },
  {
    id: 'montserrat',
    family: 'Montserrat',
    category: 'sans',
    file: 'montserrat.ttf',
    italicFile: 'montserrat-italic.ttf',
    css2: 'Montserrat:ital,wght@0,100..900;1,100..900',
  },
  {
    id: 'space-grotesk',
    family: 'Space Grotesk',
    category: 'sans',
    file: 'space-grotesk.ttf',
    css2: 'Space+Grotesk:wght@300..700',
  },
  {
    id: 'playfair',
    family: 'Playfair Display',
    category: 'serif',
    file: 'playfair.ttf',
    italicFile: 'playfair-italic.ttf',
    css2: 'Playfair+Display:ital,wght@0,400..900;1,400..900',
  },
  {
    id: 'fraunces',
    family: 'Fraunces',
    category: 'serif',
    file: 'fraunces.ttf',
    italicFile: 'fraunces-italic.ttf',
    css2: 'Fraunces:ital,opsz,wght,SOFT,WONK@0,9..144,100..900,0..100,0..1;1,9..144,100..900,0..100,0..1',
  },
  { id: 'bebas-neue', family: 'Bebas Neue', category: 'display', file: 'bebas-neue.ttf', css2: 'Bebas+Neue' },
  { id: 'pacifico', family: 'Pacifico', category: 'script', file: 'pacifico.ttf', css2: 'Pacifico' },
  {
    id: 'jetbrains-mono',
    family: 'JetBrains Mono',
    category: 'mono',
    file: 'jetbrains-mono.ttf',
    italicFile: 'jetbrains-mono-italic.ttf',
    css2: 'JetBrains+Mono:ital,wght@0,100..800;1,100..800',
  },
]

export const DEFAULT_FONT = 'inter'

/* ----------------------------------------------------------- registry */

const UPLOADS_KEY = 'editor-fonts'
const faces = new Map<string, LoadedFace>()
const pending = new Map<string, Promise<LoadedFace | null>>()
let uploads: FontEntry[] = readLocal<{ list: FontEntry[] }>(UPLOADS_KEY, { list: [] }).list
let version = 0
const listeners = new Set<() => void>()

function changed() {
  version++
  for (const l of listeners) l()
}

/** For `useSyncExternalStore`: bumps whenever a face loads or a font is added. */
export function subscribeFonts(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export function fontsVersion(): number {
  return version
}

export function allFonts(): FontEntry[] {
  return [...BUNDLED_FONTS, ...uploads]
}

export function fontEntry(id: string): FontEntry | null {
  return allFonts().find((f) => f.id === id) ?? null
}

const faceKey = (id: string, italic: boolean) => `${id}${italic ? ':i' : ''}`

/** The loaded face for a font, or null if it isn't loaded (yet). */
export function loadedFace(id: string, italic = false): LoadedFace | null {
  return faces.get(faceKey(id, italic)) ?? null
}

/** Synchronous lookup for layout: the italic face, else the upright one slanted. */
export const lookupFace: FaceLookup = (id, italic) => {
  const entry = fontEntry(id)
  if (italic && entry?.italicFile) {
    const it = faces.get(faceKey(id, true))
    if (it) return { face: it, synthItalic: false }
    // Not loaded yet: slant the upright until it is, rather than draw nothing.
  }
  const up = faces.get(faceKey(id, false))
  return up ? { face: up, synthItalic: italic } : null
}

/** Put a parsed face in the registry (tests, and the loaders below). */
export function registerFace(id: string, italic: boolean, face: LoadedFace): void {
  faces.set(faceKey(id, italic), face)
  changed()
}

async function engine() {
  return import('./engine.ts')
}

async function fetchBytes(entry: FontEntry, italic: boolean): Promise<ArrayBuffer | null> {
  const file = italic ? entry.italicFile : entry.file
  if (!file) return null
  if (entry.uploaded) {
    const got = (await idbGetMany([file])).get(file)
    return got instanceof ArrayBuffer ? got : null
  }
  const res = await fetch(`${import.meta.env?.BASE_URL ?? '/'}fonts/${file}`)
  return res.ok ? res.arrayBuffer() : null
}

/**
 * Load a font's face (and its italic, when asked for and it has one). Resolves
 * null if it can't be loaded; never rejects.
 */
export function loadFont(id: string, italic = false): Promise<LoadedFace | null> {
  const entry = fontEntry(id)
  const wantItalic = italic && !!entry?.italicFile
  const key = faceKey(id, wantItalic)
  const have = faces.get(key)
  if (have) return Promise.resolve(have)
  const inflight = pending.get(key)
  if (inflight) return inflight
  const p = (async () => {
    if (!entry) return null
    try {
      const bytes = await fetchBytes(entry, wantItalic)
      if (!bytes) return null
      const face = (await engine()).faceFromBytes(bytes)
      registerFace(id, wantItalic, face)
      return face
    } catch {
      return null
    } finally {
      pending.delete(key)
    }
  })()
  pending.set(key, p)
  return p
}

/** Load every face a text needs (fonts × italic) before laying it out. */
export async function loadFontsFor(styles: Iterable<{ font: string; italic: boolean }>): Promise<void> {
  const seen = new Set<string>()
  const jobs: Promise<unknown>[] = []
  for (const s of styles) {
    const k = faceKey(s.font, s.italic)
    if (seen.has(k)) continue
    seen.add(k)
    jobs.push(loadFont(s.font, s.italic))
  }
  await Promise.all(jobs)
}

/* ------------------------------------------------------------ uploads */

/** Accepted upload types. WOFF2 is Brotli-compressed and isn't decoded here. */
export const FONT_ACCEPT = '.ttf,.otf,.woff,font/ttf,font/otf,font/woff'

/**
 * Add a font file the user picked. Parsed first (so a bad file fails here,
 * with a message, not later as a blank text), then stored in IndexedDB so it
 * survives a reload. Returns the new font's id.
 */
export async function addUploadedFont(file: File): Promise<{ id: string } | { error: string }> {
  if (/\.woff2$/i.test(file.name)) {
    return { error: "WOFF2 fonts aren't supported yet. Use the .ttf or .otf version of the font." }
  }
  let bytes = await file.arrayBuffer()
  try {
    if (/\.woff$/i.test(file.name) || isWoff(bytes)) bytes = await woffToSfnt(bytes)
    const face = (await engine()).faceFromBytes(bytes)
    const id = `upload:${face.family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${(await digest(bytes)).slice(0, 8)}`
    const existing = uploads.find((u) => u.id === id)
    if (!existing) {
      const key = `font:${id}`
      await idbSet(key, bytes)
      const name =
        face.subfamily && !/^regular$/i.test(face.subfamily) ? `${face.family} ${face.subfamily}` : face.family
      uploads = [...uploads, { id, family: name, category: 'yours', file: key, uploaded: true }]
      writeLocal(UPLOADS_KEY, { list: uploads })
    }
    registerFace(id, false, face)
    return { id }
  } catch {
    return { error: `“${file.name}” isn't a font this editor can read.` }
  }
}

async function digest(bytes: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest('SHA-1', bytes)
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function isWoff(bytes: ArrayBuffer): boolean {
  return bytes.byteLength > 4 && new DataView(bytes).getUint32(0) === 0x774f4646 // 'wOFF'
}

/** WOFF 1.0 → plain sfnt: each table is zlib-deflated or stored as is. */
async function woffToSfnt(woff: ArrayBuffer): Promise<ArrayBuffer> {
  const v = new DataView(woff)
  const flavor = v.getUint32(4)
  const numTables = v.getUint16(12)
  const tables: { tag: number; checksum: number; data: Uint8Array }[] = []
  for (let i = 0; i < numTables; i++) {
    const o = 44 + i * 20
    const tag = v.getUint32(o)
    const offset = v.getUint32(o + 4)
    const compLength = v.getUint32(o + 8)
    const origLength = v.getUint32(o + 12)
    const checksum = v.getUint32(o + 16)
    const raw = new Uint8Array(woff, offset, compLength)
    const data =
      compLength < origLength
        ? new Uint8Array(
            await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer(),
          )
        : raw
    tables.push({ tag, checksum, data })
  }
  const headerLen = 12 + numTables * 16
  let size = headerLen
  for (const t of tables) size += (t.data.length + 3) & ~3
  const out = new Uint8Array(size)
  const w = new DataView(out.buffer)
  let p2 = 1
  let pow = 0
  while (p2 * 2 <= numTables) {
    p2 *= 2
    pow++
  }
  w.setUint32(0, flavor)
  w.setUint16(4, numTables)
  w.setUint16(6, p2 * 16)
  w.setUint16(8, pow)
  w.setUint16(10, numTables * 16 - p2 * 16)
  let at = headerLen
  tables.forEach((t, i) => {
    const o = 12 + i * 16
    w.setUint32(o, t.tag)
    w.setUint32(o + 4, t.checksum)
    w.setUint32(o + 8, at)
    w.setUint32(o + 12, t.data.length)
    out.set(t.data, at)
    at += (t.data.length + 3) & ~3
  })
  return out.buffer
}
