// Small helpers for triggering browser downloads.

import type { EditableDoc } from '../path/types'
import { docToAi, docToDxf, docToPdf, type VectorFormat } from './vectorFormats'

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  triggerDownload(url, fileName)
  // Revoke on next tick so the navigation has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadText(text: string, fileName: string, mime = 'text/plain'): void {
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), fileName)
}

export function downloadDataUrl(dataUrl: string, fileName: string): void {
  triggerDownload(dataUrl, fileName)
}

function triggerDownload(href: string, fileName: string): void {
  const a = document.createElement('a')
  a.href = href
  a.download = fileName
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** Save a vector document in one of the menu's formats. `svgText` is the SVG the studio already shows. */
export function downloadVector(format: VectorFormat, doc: EditableDoc, svgText: string, base: string): void {
  if (format === 'svg') downloadText(svgText, `${base}.svg`, 'image/svg+xml')
  else if (format === 'dxf') downloadText(docToDxf(doc), `${base}.dxf`, 'image/vnd.dxf')
  else if (format === 'pdf')
    downloadBlob(new Blob([docToPdf(doc, base) as BlobPart], { type: 'application/pdf' }), `${base}.pdf`)
  else downloadBlob(new Blob([docToAi(doc, base) as BlobPart], { type: 'application/postscript' }), `${base}.ai`)
}
