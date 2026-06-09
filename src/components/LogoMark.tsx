import type { CSSProperties } from 'react'
import { useAppearance, useLogo } from '../store'
import type { IconShape } from '../types'

export interface LogoMarkProps {
  /** Box size in px (square). */
  size: number
  /** Force the colored card backplate on/off. Defaults to appearance.cardInFlat. */
  showCard?: boolean
  /** Override card shape (e.g. scenes force 'circle' for avatars / Android). */
  shape?: IconShape
  /** Override corner radius percentage (rounded shape). */
  radiusPct?: number
  /** Override card fill color. */
  background?: string
  /** Override card shadow. */
  shadow?: boolean
  /** Override safe-zone padding percentage. */
  padding?: number
  /** Override logo scale fraction. */
  scale?: number
  /** Clip the logo to the card shape (for full-bleed photographic logos). */
  clip?: boolean
  className?: string
  style?: CSSProperties
  /** Render a neutral placeholder mark when no logo is loaded (default true). */
  placeholder?: boolean
}

function radiusFor(shape: IconShape, size: number, radiusPct: number): string {
  if (shape === 'circle') return '50%'
  if (shape === 'square') return '0px'
  return `${(size * radiusPct) / 100}px`
}

/**
 * The single source of truth for how a logo renders anywhere in the app.
 * Scenes compose this; the export pipeline mirrors its math on a canvas.
 */
export function LogoMark({
  size,
  showCard,
  shape,
  radiusPct,
  background,
  shadow,
  padding,
  scale,
  clip = false,
  className = '',
  style,
  placeholder = true,
}: LogoMarkProps) {
  const logo = useLogo()
  const app = useAppearance()

  const effShape = shape ?? app.cardShape
  const effRadius = radiusPct ?? app.cardRadius
  const effBg = background ?? app.cardColor
  const effShadow = shadow ?? app.cardShadow
  const effPadding = padding ?? app.padding
  const effScale = scale ?? app.scale
  const cardOn = (showCard ?? app.cardInFlat) && effBg !== 'transparent'

  const borderRadius = radiusFor(effShape, size, effRadius)
  const pad = (size * effPadding) / 100
  const contentSize = Math.max(0, (size - pad * 2) * effScale)

  const cardStyle: CSSProperties = {
    width: size,
    height: size,
    borderRadius,
    backgroundColor: cardOn ? effBg : 'transparent',
    boxShadow: cardOn && effShadow ? '0 8px 22px -8px rgba(16,18,27,0.35)' : undefined,
    overflow: clip || effShape === 'circle' ? 'hidden' : 'visible',
    ...style,
  }

  const hasLogo = Boolean(logo.src)

  return (
    <div
      className={`relative flex shrink-0 items-center justify-center ${className}`}
      style={cardStyle}
    >
      {hasLogo ? (
        app.tintEnabled ? (
          <span
            style={{
              width: contentSize,
              height: contentSize,
              backgroundColor: app.tintColor,
              WebkitMaskImage: `url("${logo.src}")`,
              maskImage: `url("${logo.src}")`,
              WebkitMaskRepeat: 'no-repeat',
              maskRepeat: 'no-repeat',
              WebkitMaskPosition: 'center',
              maskPosition: 'center',
              WebkitMaskSize: 'contain',
              maskSize: 'contain',
            }}
          />
        ) : (
          <img
            src={logo.src!}
            alt={logo.fileName ?? 'logo'}
            draggable={false}
            style={{
              width: contentSize,
              height: contentSize,
              objectFit: 'contain',
              filter: app.invert ? 'invert(1)' : undefined,
            }}
          />
        )
      ) : placeholder ? (
        <PlaceholderMark size={contentSize} />
      ) : null}
    </div>
  )
}

/** Neutral abstract mark shown before any upload, so scenes stay populated. */
function PlaceholderMark({ size }: { size: number }) {
  const stroke = Math.max(1.5, size * 0.05)
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      // Self-contained mid-gray so the placeholder reads on both light and dark
      // surfaces (it must not inherit the near-black app ink as currentColor).
      style={{ color: '#9aa3b2', opacity: 0.55 }}
      aria-hidden
    >
      <circle cx="32" cy="32" r="20" stroke="currentColor" strokeWidth={stroke} />
      <circle cx="32" cy="32" r="7.5" fill="currentColor" />
    </svg>
  )
}
