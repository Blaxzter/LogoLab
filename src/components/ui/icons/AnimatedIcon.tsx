import { createElement, forwardRef, useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { domAnimation, LazyMotion, m, useReducedMotion, type Variants } from 'motion/react'
import type { LucideIcon, LucideProps } from 'lucide-react'
import type { MotionIconData, MotionIconElement } from './motionTypes'

/**
 * What hovering animates an icon: the control it sits in, not the glyph itself
 * — a 14px target nobody aims for. An icon outside any of these (a status
 * line, a heading) never animates.
 */
const TRIGGER =
  'button, a[href], summary, label, [role="button"], [role="menuitem"], [role="tab"], [role="option"], [role="radio"], [role="switch"], [role="checkbox"]'

/** Motion props that ride along in `attrs` and must not reach a plain DOM node. */
const MOTION_ONLY = new Set(['custom', 'transition'])

const MOTION_TAGS = {
  path: m.path,
  line: m.line,
  rect: m.rect,
  circle: m.circle,
  ellipse: m.ellipse,
  polyline: m.polyline,
  polygon: m.polygon,
  g: m.g,
}

type Current = 'initial' | 'animate'

/**
 * Wraps a lucide-react icon so it plays its lucide-motion-vue animation (ported
 * by `scripts/port-motion-icons.mjs`) while its control is hovered or
 * keyboard-focused. Same props, same `lucide lucide-<name>` classes, same
 * ref. Under `prefers-reduced-motion` it IS the static lucide icon — nothing
 * of Motion mounts.
 */
export function animated(Static: LucideIcon, data: MotionIconData): LucideIcon {
  const Animated = forwardRef<SVGSVGElement, LucideProps>(function Animated(props, ref) {
    const reduce = useReducedMotion()
    if (reduce) return <Static ref={ref} {...props} />
    return <MotionIcon data={data} svgRef={ref} {...props} />
  })
  Animated.displayName = Static.displayName
  return Animated as LucideIcon
}

function MotionIcon({
  data,
  svgRef,
  size = 24,
  strokeWidth = 2,
  absoluteStrokeWidth,
  color = 'currentColor',
  className,
  children,
  ...rest
}: LucideProps & { data: MotionIconData; svgRef: Ref<SVGSVGElement> }) {
  const own = useRef<SVGSVGElement | null>(null)
  const [current, setCurrent] = useState<Current>('initial')

  useEffect(() => {
    const target = own.current?.parentElement?.closest<HTMLElement>(TRIGGER)
    if (!target) return
    let frame = 0
    // Back to `initial`, then `animate` a frame later: a re-hover replays from
    // the start, and a `pathLength` tween gets a laid-out path to measure.
    const start = () => {
      if (target.matches(':disabled, [aria-disabled="true"]')) return
      cancelAnimationFrame(frame)
      setCurrent('initial')
      frame = requestAnimationFrame(() => setCurrent('animate'))
    }
    const stop = () => {
      cancelAnimationFrame(frame)
      setCurrent('initial')
    }
    const onFocus = () => {
      if (target.matches(':focus-visible')) start()
    }
    target.addEventListener('pointerenter', start)
    target.addEventListener('pointerleave', stop)
    target.addEventListener('focusin', onFocus)
    target.addEventListener('focusout', stop)
    return () => {
      cancelAnimationFrame(frame)
      target.removeEventListener('pointerenter', start)
      target.removeEventListener('pointerleave', stop)
      target.removeEventListener('focusin', onFocus)
      target.removeEventListener('focusout', stop)
    }
  }, [])

  const setRef = (node: SVGSVGElement | null) => {
    own.current = node
    if (typeof svgRef === 'function') svgRef(node)
    else if (svgRef) svgRef.current = node
  }
  const labelled = Object.keys(rest).some((k) => k.startsWith('aria-') || k === 'role' || k === 'title')

  return (
    <LazyMotion features={domAnimation}>
      <svg
        ref={setRef}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={absoluteStrokeWidth ? (Number(strokeWidth) * 24) / Number(size) : strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        // Several animations travel past the 24-unit box (an arrow's nudge,
        // link-2's burst); lucide's own svg would clip them.
        overflow="visible"
        className={['lucide', `lucide-${data.name}`, className].filter(Boolean).join(' ')}
        aria-hidden={labelled ? undefined : 'true'}
        {...rest}
      >
        {data.elements.map((el, i) => (
          <IconNode key={i} el={el} variants={data.variants} current={current} />
        ))}
        {children}
      </svg>
    </LazyMotion>
  )
}

function IconNode({
  el,
  variants,
  current,
}: {
  el: MotionIconElement
  variants: Record<string, Variants>
  current: Current
}): ReactNode {
  const kids = el.children?.map((child, i) => (
    <IconNode key={i} el={child} variants={variants} current={current} />
  ))
  const v = el.key ? variants[el.key] : undefined
  if (v && Object.keys(v).length) {
    const Tag = MOTION_TAGS[el.tag] as typeof m.path
    return (
      <Tag {...el.attrs} style={el.style} variants={v} initial="initial" animate={current}>
        {kids}
      </Tag>
    )
  }
  const attrs = Object.fromEntries(Object.entries(el.attrs).filter(([k]) => !MOTION_ONLY.has(k)))
  return createElement(el.tag, { ...attrs, style: el.style }, kids)
}
