import { useEffect } from 'react'
import { useAppearance, useLogo } from '../store'
import { loadRenderSource } from '../lib/image'
import { renderIcon } from '../lib/pwaExport'

const DEFAULT_HREF = '/favicon.svg'

/**
 * Live-updates the browser tab favicon to the logo currently being worked on
 * (rendered with the current appearance — card, shape, tint…). Falls back to the
 * app's own mark when no logo is loaded.
 */
export function useLiveFavicon() {
  const logo = useLogo()
  const app = useAppearance()

  useEffect(() => {
    if (!logo.src) {
      setFavicon(DEFAULT_HREF, 'image/svg+xml')
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      loadRenderSource(logo.src!, 128, logo.isSvg ? logo.svgText : null)
        .then((rs) => {
          if (cancelled) return
          const canvas = renderIcon(rs.source, rs.width, rs.height, {
            size: 64,
            background: app.cardColor,
            shape: app.cardShape,
            radiusPct: app.cardRadius,
            paddingPct: app.padding,
            scale: app.scale,
            tintColor: app.tintEnabled ? app.tintColor : null,
            invert: app.invert,
          })
          setFavicon(canvas.toDataURL('image/png'), 'image/png')
        })
        .catch(() => {})
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [
    logo.src,
    logo.isSvg,
    logo.svgText,
    app.cardColor,
    app.cardShape,
    app.cardRadius,
    app.padding,
    app.scale,
    app.tintEnabled,
    app.tintColor,
    app.invert,
  ])
}

/** Replace any existing favicon link(s) with a fresh one (reliable cross-browser refresh). */
function setFavicon(href: string, type: string) {
  document.querySelectorAll('link[rel="icon"]').forEach((el) => el.remove())
  const link = document.createElement('link')
  link.rel = 'icon'
  link.type = type
  link.href = href
  document.head.appendChild(link)
}
