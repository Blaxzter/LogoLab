// Internal CSS for parseSvg: Illustrator's default export ("Internal CSS") paints
// every shape through `<style>.cls-1{fill:#e30613}</style>` + `class="cls-1"`, and
// a walk that reads only attributes and inline `style` saw no fill at all, so
// every shape came out black.
//
// The rules are folded INTO each matched element's `style` attribute before the
// walk, behind its own inline declarations (which win, as in CSS), so everything
// downstream — presentation props, the unmodellable-attribute check, the stop
// colours, the raw markup that round-trips — sees the paint without knowing
// there was a stylesheet. Only what exporters write is matched: compound simple
// selectors (`tag`, `.a.b`, `#id`, `*`, comma lists). A rule this cannot match
// exactly (a combinator, a pseudo-class, an attribute test, anything under
// @media) TAINTS the elements it could match — decided loosely from its last
// compound, so the test only ever over-approximates — and the caller keeps those
// raw: with the class intact and the <style> beside it, they still render right.

interface Compound {
  tag: string | null
  ids: string[]
  classes: string[]
}

interface Rule {
  sel: Compound
  specificity: number
  order: number
  decls: [string, string, boolean][]
}

export interface Stylesheet {
  rules: Rule[]
  /** Last compounds of the selectors that could not be matched exactly. */
  loose: Compound[]
}

const AT_RULES_TO_SKIP = /^@(?:font-face|keyframes|-webkit-keyframes|page|counter-style|property)\b/i

/** Parse `tag.a.b#id` (or `*`); null when the text is not a plain compound. */
function parseCompound(text: string): Compound | null {
  const t = text.trim()
  if (t === '') return null
  const m = /^(\*|[a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/.exec(t)
  if (!m || (!m[1] && !m[2])) return null
  const c: Compound = { tag: m[1] && m[1] !== '*' ? m[1].toLowerCase() : null, ids: [], classes: [] }
  for (const part of m[2].match(/[.#][\w-]+/g) ?? []) (part[0] === '#' ? c.ids : c.classes).push(part.slice(1))
  return c
}

/** The loosest reading of a complex selector: its last compound, conditions dropped. */
function looseCompound(selector: string): Compound {
  const parts = selector.trim().split(/\s*[>+~]\s*|\s+/)
  const last = (parts[parts.length - 1] ?? '').replace(/::?[\w-]+(?:\([^)]*\))?/g, '').replace(/\[[^\]]*\]/g, '')
  return parseCompound(last) ?? { tag: null, ids: [], classes: [] }
}

function parseDecls(body: string): [string, string, boolean][] {
  const out: [string, string, boolean][] = []
  for (const decl of body.split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const name = decl.slice(0, i).trim().toLowerCase()
    let value = decl.slice(i + 1).trim()
    const important = /!\s*important\s*$/i.test(value)
    if (important) value = value.replace(/!\s*important\s*$/i, '').trim()
    if (name && value) out.push([name, value, important])
  }
  return out
}

/** Parse the CSS of every `<style>` in document order into one sheet. */
export function parseStylesheet(css: string): Stylesheet {
  const sheet: Stylesheet = { rules: [], loose: [] }
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!\[CDATA\[|\]\]>/g, '')
  let order = 0
  // Walk top-level blocks; `conditional` marks rules under an @media/@supports.
  const walk = (text: string, conditional: boolean) => {
    let i = 0
    while (i < text.length) {
      const open = text.indexOf('{', i)
      const semi = text.indexOf(';', i)
      // A statement at-rule (`@import …;`, `@charset …;`) has no block.
      if (semi >= 0 && (open < 0 || semi < open) && text.slice(i, semi).trim().startsWith('@')) {
        i = semi + 1
        continue
      }
      if (open < 0) break
      // Find the matching close brace (blocks nest under at-rules).
      let depth = 1
      let j = open + 1
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++
        else if (text[j] === '}') depth--
        j++
      }
      const prelude = text.slice(i, open).trim()
      const body = text.slice(open + 1, j - 1)
      i = j
      if (prelude.startsWith('@')) {
        if (!AT_RULES_TO_SKIP.test(prelude)) walk(body, true)
        continue
      }
      const decls = parseDecls(body)
      if (decls.length === 0) continue
      for (const selector of prelude.split(',')) {
        const sel = conditional ? null : parseCompound(selector)
        if (!sel) {
          sheet.loose.push(looseCompound(selector))
          continue
        }
        const specificity = sel.ids.length * 10000 + sel.classes.length * 100 + (sel.tag ? 1 : 0)
        sheet.rules.push({ sel, specificity, order: order++, decls })
      }
    }
  }
  walk(src, false)
  return sheet
}

function matches(el: Element, c: Compound): boolean {
  if (c.tag && el.tagName.toLowerCase() !== c.tag) return false
  if (c.ids.length > 0) {
    const id = el.getAttribute('id')
    if (!c.ids.every((x) => x === id)) return false
  }
  if (c.classes.length > 0) {
    const cls = (el.getAttribute('class') ?? '').split(/\s+/)
    if (!c.classes.every((x) => cls.includes(x))) return false
  }
  return true
}

/**
 * Fold the document's `<style>` rules into the `style` attribute of every element
 * they match, and return the elements a rule could not be resolved for. A no-op
 * (empty set) on markup without a stylesheet.
 */
export function inlineStylesheets(dom: Document): Set<Element> {
  const tainted = new Set<Element>()
  const styles = Array.from(dom.querySelectorAll('style'))
  if (styles.length === 0) return tainted
  const sheet = parseStylesheet(styles.map((s) => s.textContent ?? '').join('\n'))
  if (sheet.rules.length === 0 && sheet.loose.length === 0) return tainted

  for (const el of Array.from(dom.querySelectorAll('*'))) {
    if (el.tagName.toLowerCase() === 'style') continue
    // A tainted element keeps its markup as written: it stays raw beside the
    // <style>, and an inlined declaration would beat the very rule we could not
    // resolve there (`@media (prefers-color-scheme: dark){.a{fill:#fff}}` behind an
    // inlined `fill:#000` would never apply).
    if (sheet.loose.some((c) => matches(el, c))) {
      tainted.add(el)
      continue
    }
    const hits = sheet.rules.filter((r) => matches(el, r.sel))
    if (hits.length === 0) continue
    hits.sort((a, b) => a.specificity - b.specificity || a.order - b.order)
    // Cascade: later/more specific wins, and !important beats everything else.
    const normal = new Map<string, string>()
    const important = new Map<string, string>()
    for (const r of hits) {
      for (const [name, value, imp] of r.decls) (imp ? important : normal).set(name, value)
    }
    // parseSvg reads the FIRST declaration of a property in `style`, so the order is
    // the precedence: !important rules, the element's own inline style, the rest.
    // No property is written twice: the markup round-trips raw, and there the
    // browser would take the LAST copy.
    const own = (el.getAttribute('style') ?? '')
      .split(';')
      .filter((d) => d.includes(':'))
      .map((d) => [d.slice(0, d.indexOf(':')).trim().toLowerCase(), d.trim()] as const)
      .filter(([n]) => n !== '' && !important.has(n))
    const ownNames = new Set(own.map(([n]) => n))
    const head = [...important].map(([n, v]) => `${n}:${v}`)
    const tail = [...normal].filter(([n]) => !important.has(n) && !ownNames.has(n)).map(([n, v]) => `${n}:${v}`)
    const style = [...head, ...own.map(([, d]) => d), ...tail].join(';')
    if (style) el.setAttribute('style', style)
  }
  return tainted
}
