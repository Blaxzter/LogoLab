// Raw SVG markup → markup that is safe to hand to `innerHTML` in the app's own DOM.
//
// A RawItem is the part of an uploaded SVG the model doesn't understand (an
// <image>, <defs>, a filter, a <style>…), kept verbatim by `parseSvg`. Everywhere
// else an uploaded SVG is shown through an <img>, where nothing in it can run;
// the editor canvas is the one place its markup becomes LIVE DOM in this origin,
// so `<image href="x" onerror="…">` in a downloaded logo.svg would run with the
// persisted session in reach — and run again on every reload, because the editor
// slot stores it.
//
// So the markup is rebuilt from an ALLOWLIST rather than scrubbed of a denylist:
// only SVG elements we know, only element and text nodes (a comment or a
// processing instruction re-parsed by the HTML parser is a classic mutation-XSS
// vector), no `on*` attribute, no `href` that leaves the document except an
// embedded raster, no animation that could write an `href` or a handler, and no
// CSS that fetches anything. The output is serialized HERE, not by
// XMLSerializer, so what reaches `innerHTML` is exactly what was checked.
//
// The walk is over a structural node shape so it runs under `node --test`; the
// browser entry (`sanitizeSvgMarkup`) parses with DOMParser and hands it the DOM.

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Lower-cased local names. Not here, so dropped with their subtree: script,
 *  foreignObject, iframe/embed/object, the legacy SVG `font` family (an HTML
 *  breakout tag in foreign content), anything in another namespace. */
// biome-ignore format: grouped by kind, one line per family
const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'image', 'switch', 'a', 'view',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textpath', 'title', 'desc',
  'lineargradient', 'radialgradient', 'stop', 'pattern', 'clippath', 'mask', 'marker',
  'style',
  'filter', 'feblend', 'fecolormatrix', 'fecomponenttransfer', 'fecomposite',
  'feconvolvematrix', 'fediffuselighting', 'fedisplacementmap', 'fedistantlight',
  'fedropshadow', 'feflood', 'fefunca', 'fefuncb', 'fefuncg', 'fefuncr',
  'fegaussianblur', 'feimage', 'femerge', 'femergenode', 'femorphology', 'feoffset',
  'fepointlight', 'fespecularlighting', 'fespotlight', 'fetile', 'feturbulence',
  'animate', 'animatetransform', 'animatemotion', 'set', 'mpath',
])

const ANIMATIONS = new Set(['animate', 'animatetransform', 'animatemotion', 'set'])

/** Element / attribute / text, as much of the DOM as the walk reads. */
export interface MarkupNode {
  nodeType: number
  localName?: string | null
  namespaceURI?: string | null
  attributes?: ArrayLike<{ name: string; localName?: string | null; value: string }>
  childNodes?: ArrayLike<MarkupNode>
  nodeValue?: string | null
}

const ATTR_NAME = /^[A-Za-z_][\w.:-]*$/

/** `#id` (a reference into the document) or an embedded raster image. */
function safeHref(v: string): boolean {
  const s = v.trim()
  return s.startsWith('#') || /^data:image\/(png|jpe?g|gif|webp|avif|bmp);/i.test(s)
}

/** Any `url(…)` that points outside the document: a fetch, so an exfiltration channel. */
const LOCAL_URL = String.raw`(?!['"]?\s*(#|data:image\/(png|jpe?g|gif|webp|avif|bmp);))`
const EXTERNAL_URL = new RegExp(String.raw`url\(\s*${LOCAL_URL}`, 'i')
const EXTERNAL_URL_ALL = new RegExp(String.raw`url\(\s*${LOCAL_URL}[^)]*\)`, 'gi')

function safeCss(css: string): string {
  // A CSS escape can spell `url(` (`\75 rl(`) and `image-set("…")` fetches without
  // one; neither belongs in a logo, so CSS carrying either is dropped whole.
  if (/\\|image-set\s*\(/i.test(css)) return ''
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(EXTERNAL_URL_ALL, 'none')
    .replace(/expression\s*\(/gi, '')
}

function escapeText(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(v: string): string {
  return escapeText(v).replace(/"/g, '&quot;')
}

/** Concatenated text + CDATA children: a <style> is checked as ONE string, or
 *  `u<![CDATA[rl(https://…)]]>` passes as two harmless halves and joins after. */
function textOf(node: MarkupNode): string {
  let out = ''
  for (const c of Array.from(node.childNodes ?? [])) if (c.nodeType === 3 || c.nodeType === 4) out += c.nodeValue ?? ''
  return out
}

function sanitizeNode(node: MarkupNode): string {
  // Text and CDATA become escaped text; comments, PIs and doctypes vanish.
  if (node.nodeType === 3 || node.nodeType === 4) return escapeText(node.nodeValue ?? '')
  if (node.nodeType !== 1 || !node.localName) return ''
  if (node.namespaceURI != null && node.namespaceURI !== SVG_NS) return ''
  const tag = node.localName
  const lower = tag.toLowerCase()
  if (!ELEMENTS.has(lower)) return ''

  const attrs = Array.from(node.attributes ?? [])
  if (ANIMATIONS.has(lower)) {
    // An animation can WRITE an attribute: `<set attributeName="href" to="javascript:…">`.
    const target =
      attrs
        .find((a) => a.name.toLowerCase() === 'attributename')
        ?.value.trim()
        .toLowerCase() ?? ''
    if (/^on/.test(target) || /(^|:)href$/.test(target)) return ''
  }

  let out = `<${tag}`
  for (const a of attrs) {
    const name = a.name
    const local = (a.localName ?? name.slice(name.indexOf(':') + 1)).toLowerCase()
    if (!ATTR_NAME.test(name)) continue
    if (local.startsWith('on')) continue
    if (name.toLowerCase() === 'xmlns' || name.toLowerCase().startsWith('xmlns:')) continue
    if (local === 'href' && !safeHref(a.value)) continue
    let value = a.value
    if (local === 'style') value = safeCss(value)
    else if (EXTERNAL_URL.test(value) || value.includes('\\')) continue
    out += ` ${name}="${escapeAttr(value)}"`
  }
  out += '>'
  if (lower === 'style') out += escapeText(safeCss(textOf(node)))
  // <title>/<desc> are HTML integration points: an element inside them is parsed
  // as HTML by `innerHTML`, so they keep their text and nothing else.
  else if (lower === 'title' || lower === 'desc') out += escapeText(textOf(node))
  else for (const child of Array.from(node.childNodes ?? [])) out += sanitizeNode(child)
  return `${out}</${tag}>`
}

/** The children of `root`, sanitized and serialized (the root itself is a parse wrapper). */
export function sanitizeChildren(root: MarkupNode): string {
  let out = ''
  for (const child of Array.from(root.childNodes ?? [])) out += sanitizeNode(child)
  return out
}

/**
 * Browser entry: parse `markup` as SVG fragment content and return it rebuilt
 * from the allowlist. Markup that doesn't parse renders as nothing — a RawItem
 * we can't check is not one we draw.
 */
export function sanitizeSvgMarkup(markup: string): string {
  if (typeof DOMParser === 'undefined') return ''
  const wrapped = `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink">${markup}</svg>`
  const dom = new DOMParser().parseFromString(wrapped, 'image/svg+xml')
  if (dom.getElementsByTagName('parsererror').length > 0) return ''
  return sanitizeChildren(dom.documentElement as unknown as MarkupNode)
}
