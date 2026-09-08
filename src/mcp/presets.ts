// The icon COLLECTIONS an agent can ask for.
//
// A preset is pure data: which files, at which sizes, in which folder layout,
// plus the text assets that make the set usable (manifest, Contents.json, the
// adaptive-icon XML, a <head> snippet). Nothing here renders — `export.ts` walks
// this and calls the renderer — so adding a platform is a table, not code.
//
// The web presets are NOT re-listed here: they are `DEFAULT_TARGETS` from
// src/lib/iconSpec.ts, the same catalogue the browser export offers, so the two
// cannot drift.

import { DEFAULT_TARGETS, buildHtmlSnippet, buildManifest } from '../lib/iconSpec.ts'
import { ICNS_SIZES } from './icns.ts'
import type { ExportTarget, IconShape } from '../types'

/** One PNG in a collection. */
export interface IconFileSpec {
  /** Path relative to the export root. */
  path: string
  size: number
  /** Full-bleed with the platform safe zone (Android adaptive / PWA maskable). */
  maskable?: boolean
  /** Override the card shape for this file (Android's round launcher icon). */
  shape?: IconShape
  /**
   * What to paint behind the logo when the caller asked for TRANSPARENT and the
   * platform will not take it (iOS rejects alpha outright; the Play listing icon
   * has to be a flat square). A chosen card colour still wins — this is a floor,
   * not an override.
   */
  opaqueBackground?: string
}

/** A multi-image container assembled from already-rendered PNGs. */
export interface ContainerSpec {
  path: string
  kind: 'ico' | 'icns'
  sizes: number[]
}

export interface TextFileSpec {
  path: string
  content: string
}

/** What the text assets need to know about this export. */
export interface PresetContext {
  appName: string
  /** The card colour, so the Android adaptive background matches the PNGs. */
  background: string
}

export interface Preset {
  id: string
  label: string
  /** One line, shown in the tool's own description so an agent can choose. */
  summary: string
  icons: IconFileSpec[]
  containers?: ContainerSpec[]
  text?: (ctx: PresetContext) => TextFileSpec[]
  /** Where a copy of the traced SVG belongs in this layout, if anywhere. */
  svgPath?: string
}

/* ------------------------------------------------------------------ the web */

const webIcon = (t: ExportTarget): IconFileSpec => ({
  path: `public/icons/${t.fileName}`,
  size: t.size,
  maskable: t.maskable,
})

/** The app's own catalogue, filtered to a group set, with `enabled` rewritten. */
function webTargets(groups: ExportTarget['group'][], onlyDefaults: boolean): ExportTarget[] {
  return DEFAULT_TARGETS.filter((t) => groups.includes(t.group) && (!onlyDefaults || t.enabled)).map((t) => ({
    ...t,
    enabled: true,
  }))
}

function webPreset(id: string, label: string, summary: string, targets: ExportTarget[]): Preset {
  const faviconSizes = targets.filter((t) => t.group === 'favicon').map((t) => t.size)
  return {
    id,
    label,
    summary,
    icons: targets.map(webIcon),
    containers: faviconSizes.length ? [{ path: 'public/favicon.ico', kind: 'ico', sizes: faviconSizes.sort((a, b) => a - b) }] : [],
    text: (ctx) => [
      { path: 'public/manifest.webmanifest', content: buildManifest(ctx.appName, targets) },
      { path: 'head-snippet.html', content: buildHtmlSnippet(targets) },
    ],
    svgPath: 'public/icons/icon.svg',
  }
}

/* --------------------------------------------------------------- native app */

const TAURI_STORE_LOGOS = [30, 44, 71, 89, 107, 142, 150, 284, 310]

const tauri: Preset = {
  id: 'tauri',
  label: 'Tauri',
  summary: 'src-tauri/icons — the exact set `tauri icon` generates: PNGs, icon.ico, icon.icns and the Windows Store logos.',
  icons: [
    { path: 'src-tauri/icons/32x32.png', size: 32 },
    { path: 'src-tauri/icons/128x128.png', size: 128 },
    { path: 'src-tauri/icons/128x128@2x.png', size: 256 },
    { path: 'src-tauri/icons/icon.png', size: 512 },
    ...TAURI_STORE_LOGOS.map((s) => ({ path: `src-tauri/icons/Square${s}x${s}Logo.png`, size: s })),
    { path: 'src-tauri/icons/StoreLogo.png', size: 50 },
  ],
  containers: [
    { path: 'src-tauri/icons/icon.ico', kind: 'ico', sizes: [16, 24, 32, 48, 64, 256] },
    { path: 'src-tauri/icons/icon.icns', kind: 'icns', sizes: ICNS_SIZES },
  ],
  svgPath: 'src-tauri/icons/icon.svg',
}

const ELECTRON_LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

const electron: Preset = {
  id: 'electron',
  label: 'Electron',
  summary: 'build/ — icon.icns (mac), icon.ico (win) and build/icons/*.png (linux), the layout electron-builder picks up by default.',
  icons: [
    { path: 'build/icon.png', size: 1024 },
    ...ELECTRON_LINUX_SIZES.map((s) => ({ path: `build/icons/${s}x${s}.png`, size: s })),
  ],
  containers: [
    { path: 'build/icon.ico', kind: 'ico', sizes: [16, 24, 32, 48, 64, 128, 256] },
    { path: 'build/icon.icns', kind: 'icns', sizes: ICNS_SIZES },
  ],
}

/* ------------------------------------------------------------------ android */

/** Launcher densities: mdpi → xxxhdpi, at 48dp and the 108dp adaptive foreground. */
const ANDROID_DENSITIES: { dir: string; launcher: number; foreground: number }[] = [
  { dir: 'mipmap-mdpi', launcher: 48, foreground: 108 },
  { dir: 'mipmap-hdpi', launcher: 72, foreground: 162 },
  { dir: 'mipmap-xhdpi', launcher: 96, foreground: 216 },
  { dir: 'mipmap-xxhdpi', launcher: 144, foreground: 324 },
  { dir: 'mipmap-xxxhdpi', launcher: 192, foreground: 432 },
]

const android: Preset = {
  id: 'android',
  label: 'Android',
  summary: 'res/mipmap-* — ic_launcher, ic_launcher_round and the adaptive ic_launcher_foreground at every density, plus the v26 XML and the 512 Play listing icon.',
  icons: [
    ...ANDROID_DENSITIES.flatMap((d) => [
      { path: `res/${d.dir}/ic_launcher.png`, size: d.launcher },
      { path: `res/${d.dir}/ic_launcher_round.png`, size: d.launcher, shape: 'circle' as IconShape },
      // The adaptive foreground is masked by the platform, so it takes the same
      // full-bleed safe-zone treatment as a PWA maskable icon.
      { path: `res/${d.dir}/ic_launcher_foreground.png`, size: d.foreground, maskable: true },
    ]),
    // Play wants a flat, opaque 512 square — no alpha, no rounding of our own.
    { path: 'play-store-icon.png', size: 512, shape: 'square' as IconShape, opaqueBackground: '#ffffff' },
  ],
  text: (ctx) => [
    {
      path: 'res/mipmap-anydpi-v26/ic_launcher.xml',
      content: `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`,
    },
    {
      path: 'res/mipmap-anydpi-v26/ic_launcher_round.xml',
      content: `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`,
    },
    {
      path: 'res/values/ic_launcher_background.xml',
      content: `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${ctx.background === 'transparent' ? '#ffffff' : ctx.background}</color>
</resources>
`,
    },
  ],
}

/* ---------------------------------------------------------------------- iOS */

/**
 * The classic AppIcon set: idiom, point size and scale. iOS rejects alpha, so
 * every entry is forced opaque when the caller asked for a transparent card.
 */
const IOS_ENTRIES: { idiom: string; point: number; scale: number }[] = [
  { idiom: 'iphone', point: 20, scale: 2 },
  { idiom: 'iphone', point: 20, scale: 3 },
  { idiom: 'iphone', point: 29, scale: 2 },
  { idiom: 'iphone', point: 29, scale: 3 },
  { idiom: 'iphone', point: 40, scale: 2 },
  { idiom: 'iphone', point: 40, scale: 3 },
  { idiom: 'iphone', point: 60, scale: 2 },
  { idiom: 'iphone', point: 60, scale: 3 },
  { idiom: 'ipad', point: 20, scale: 1 },
  { idiom: 'ipad', point: 20, scale: 2 },
  { idiom: 'ipad', point: 29, scale: 1 },
  { idiom: 'ipad', point: 29, scale: 2 },
  { idiom: 'ipad', point: 40, scale: 1 },
  { idiom: 'ipad', point: 40, scale: 2 },
  { idiom: 'ipad', point: 76, scale: 2 },
  { idiom: 'ipad', point: 83.5, scale: 2 },
  { idiom: 'ios-marketing', point: 1024, scale: 1 },
]

const iosPx = (e: { point: number; scale: number }): number => Math.round(e.point * e.scale)
const iosFile = (e: { point: number; scale: number }): string => `Icon-${iosPx(e)}.png`

const ios: Preset = {
  id: 'ios',
  label: 'iOS',
  summary: 'AppIcon.appiconset — every iPhone/iPad size plus the 1024 marketing icon, with Contents.json. Forced opaque: iOS rejects alpha.',
  // Square and opaque: iOS applies its own mask, and an alpha channel is rejected
  // outright by App Store Connect.
  icons: [...new Map(IOS_ENTRIES.map((e) => [iosPx(e), e])).values()].map((e) => ({
    path: `AppIcon.appiconset/${iosFile(e)}`,
    size: iosPx(e),
    shape: 'square' as IconShape,
    opaqueBackground: '#ffffff',
  })),
  text: () => [
    {
      path: 'AppIcon.appiconset/Contents.json',
      content:
        JSON.stringify(
          {
            images: IOS_ENTRIES.map((e) => ({
              filename: iosFile(e),
              idiom: e.idiom,
              scale: `${e.scale}x`,
              size: `${e.point}x${e.point}`,
            })),
            info: { author: 'LogoLab', version: 1 },
          },
          null,
          2,
        ) + '\n',
    },
  ],
}

/* --------------------------------------------------------- browser extension */

const EXTENSION_SIZES = [16, 32, 48, 128]

const extension: Preset = {
  id: 'extension',
  label: 'Browser extension',
  summary: 'icons/icon-16..128.png for a Chrome/Firefox MV3 extension, with the manifest fragment to paste in.',
  icons: EXTENSION_SIZES.map((s) => ({ path: `icons/icon-${s}.png`, size: s })),
  text: () => [
    {
      path: 'manifest-icons.json',
      content:
        JSON.stringify(
          {
            icons: Object.fromEntries(EXTENSION_SIZES.map((s) => [String(s), `icons/icon-${s}.png`])),
            action: { default_icon: Object.fromEntries(EXTENSION_SIZES.map((s) => [String(s), `icons/icon-${s}.png`])) },
          },
          null,
          2,
        ) + '\n',
    },
  ],
}

/* ------------------------------------------------------------------ registry */

export const PRESETS: Preset[] = [
  webPreset(
    'pwa',
    'PWA + favicon',
    'public/ — favicon PNGs + favicon.ico, apple-touch-icon, 192/512 PWA icons, maskable pair, manifest.webmanifest and a <head> snippet.',
    webTargets(['favicon', 'apple', 'android', 'maskable'], true),
  ),
  webPreset(
    'favicon',
    'Favicon only',
    'public/ — the 16/32/48 PNGs, a real multi-size favicon.ico, apple-touch-icon and the <head> snippet.',
    webTargets(['favicon', 'apple'], true),
  ),
  webPreset(
    'web',
    'Everything for the web',
    'public/ — the full catalogue: every favicon, apple, Android, maskable and Windows tile size the app offers.',
    webTargets(['favicon', 'apple', 'android', 'maskable', 'windows'], false),
  ),
  tauri,
  electron,
  android,
  ios,
  extension,
]

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id)
}

/** A one-line catalogue for the tool description an agent reads. */
export function presetCatalogue(): string {
  return PRESETS.map((p) => `  ${p.id.padEnd(10)} ${p.summary}`).join('\n')
}

/** Build an ad-hoc preset for a caller-supplied size list. */
export function customPreset(sizes: number[], dir = 'icons'): Preset {
  const clean = [...new Set(sizes.map((s) => Math.round(s)).filter((s) => s > 0 && s <= 4096))].sort((a, b) => a - b)
  return {
    id: 'custom',
    label: 'Custom sizes',
    summary: `${dir}/ — ${clean.join(', ')}`,
    icons: clean.map((s) => ({ path: `${dir}/icon-${s}.png`, size: s })),
  }
}
