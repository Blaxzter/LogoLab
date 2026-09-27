// Small helpers for triggering browser downloads.

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
