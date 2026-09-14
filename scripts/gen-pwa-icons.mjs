// Render the PWA install icons from the brand mark.
//
// Run by hand (`node scripts/gen-pwa-icons.mjs`); the PNGs are committed, because
// they change only when the mark does and a build shouldn't depend on a native
// renderer being installable. Same renderer the app's own icon export leans on.
//
// Three shapes, because a launcher asks three different things of an icon:
//
//   • `any`      — the mark as drawn, rounded chip and all. What a browser tab,
//                  a task switcher and a desktop shortcut show.
//   • `maskable` — FULL BLEED, with the mark inside the 80% safe circle Android
//                  guarantees. Handing a launcher the rounded chip instead gets
//                  it clipped again into whatever shape the OS prefers, which is
//                  how icons end up with a corner shaved off.
//   • apple      — 180px, opaque, square, no rounding: iOS masks it itself, and
//                  a transparent one comes out black.

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const out = (name) => fileURLToPath(new URL(`../public/${name}`, import.meta.url))

/** The chip, as shipped in public/favicon.svg — the tab icon at install sizes. */
const CHIP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <rect x="2" y="2" width="60" height="60" rx="16" fill="#14161c" />
  <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#g)" fill-opacity="0.18" />
  <circle cx="32" cy="32" r="15" stroke="#fff" stroke-width="3.2" />
  <circle cx="32" cy="32" r="6" fill="#6366f1" />
  <defs>
    <linearGradient id="g" x1="2" y1="2" x2="62" y2="62" gradientUnits="userSpaceOnUse">
      <stop stop-color="#818cf8" />
      <stop offset="1" stop-color="#14161c" />
    </linearGradient>
  </defs>
</svg>`

/**
 * Full-bleed, with the ring scaled to sit inside the safe circle (radius 40% of
 * the icon). The background runs edge to edge so any mask the OS applies still
 * lands on paint rather than on transparency.
 */
const MASKABLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <rect width="64" height="64" fill="#14161c" />
  <rect width="64" height="64" fill="url(#g)" fill-opacity="0.18" />
  <circle cx="32" cy="32" r="12" stroke="#fff" stroke-width="2.6" />
  <circle cx="32" cy="32" r="4.8" fill="#6366f1" />
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
      <stop stop-color="#818cf8" />
      <stop offset="1" stop-color="#14161c" />
    </linearGradient>
  </defs>
</svg>`

/** Square and opaque: iOS rounds it itself and paints transparency black. */
const APPLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <rect width="64" height="64" fill="#14161c" />
  <rect width="64" height="64" fill="url(#g)" fill-opacity="0.18" />
  <circle cx="32" cy="32" r="14" stroke="#fff" stroke-width="3" />
  <circle cx="32" cy="32" r="5.6" fill="#6366f1" />
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
      <stop stop-color="#818cf8" />
      <stop offset="1" stop-color="#14161c" />
    </linearGradient>
  </defs>
</svg>`

const render = (svg, size, file) => {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
  writeFileSync(out(file), png)
  console.log(`${file}  ${size}×${size}  ${(png.length / 1024).toFixed(1)} kB`)
}

render(CHIP, 192, 'pwa-192.png')
render(CHIP, 512, 'pwa-512.png')
render(MASKABLE, 512, 'pwa-maskable-512.png')
render(APPLE, 180, 'apple-touch-icon.png')
