// A slider that also takes the mouse wheel (see useWheelStep): a native
// <input type="range"> plus wheel stepping, so every slider in a panel behaves
// like the number fields beside it.

import type { InputHTMLAttributes, Ref } from 'react'
import { useWheelStep } from './useWheelStep'

export function RangeInput({
  value,
  min,
  max,
  step = 1,
  wheelStep,
  onValue,
  ref: outerRef,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'min' | 'max' | 'step' | 'onChange'> & {
  value: number
  min: number
  max: number
  step?: number
  /** One wheel notch (defaults to `step`; a fine slider wants coarser notches). */
  wheelStep?: number
  /** Dragging, arrow keys and the wheel all report here. */
  onValue: (v: number) => void
  /** Merged with the wheel's own ref — a Tooltip around the slider anchors through it. */
  ref?: Ref<HTMLInputElement>
}) {
  const wheelRef = useWheelStep<HTMLInputElement>({ value, step: wheelStep ?? step, min, max, onChange: onValue })
  const setRef = (el: HTMLInputElement | null) => {
    wheelRef.current = el
    if (typeof outerRef === 'function') outerRef(el)
    else if (outerRef) (outerRef as { current: HTMLInputElement | null }).current = el
  }
  return (
    <input
      {...rest}
      ref={setRef}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onValue(Number(e.target.value))}
    />
  )
}
