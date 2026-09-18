// A tooltip must never land on the thing it is describing.
//
//   node --test test/tooltip-place.test.ts
//
// This is the bug that shipped: every header control sits about 8px from the
// top of the viewport, the default side is `top`, and the placement clamped
// both axes into the viewport — so the bubble's negative y was pulled back to
// the top edge and it came to rest ON the icon, covering exactly what the
// pointer was aimed at. A tooltip that hides its trigger is worse than no
// tooltip, and nothing caught it because placement lived inside a layout effect
// where only a human with a mouse could see it.
//
// So the maths is a pure function now, and the rule it has to keep is simple
// enough to state: flip along the axis the side points down, clamp only across
// it. The cross-axis clamp is fine — sliding along the trigger keeps the bubble
// on screen and still beside what it describes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { placeTooltip, type TriggerRect } from '../src/components/ui/tooltipPlace.ts'

/** The real thing: a 32px icon button in a 56px header, 8px from the top. */
const HEADER_ICON: TriggerRect = { left: 1400, right: 1432, top: 12, bottom: 44, width: 32, height: 32 }
/** Room on every side. */
const MIDDLE: TriggerRect = { left: 700, right: 740, top: 400, bottom: 432, width: 40, height: 32 }

const VW = 1568
const VH = 900
/** A two-line bubble, about what the header's report tip measures. */
const TW = 240
const TH = 48

function rect(r: TriggerRect, left: number, top: number, w: number, h: number) {
  return { overlapsX: left < r.right && left + w > r.left, overlapsY: top < r.bottom && top + h > r.top }
}

test('a header icon asked for `bottom` gets bottom, one gap below', () => {
  const p = placeTooltip('bottom', HEADER_ICON, TW, TH, VW, VH)
  assert.equal(p.side, 'bottom')
  assert.equal(p.top, HEADER_ICON.bottom + 8)
})

test('a header icon asked for `top` FLIPS instead of landing on itself', () => {
  const p = placeTooltip('top', HEADER_ICON, TW, TH, VW, VH)
  assert.equal(p.side, 'bottom', 'there is no room above a control 12px from the top')
  const o = rect(HEADER_ICON, p.left, p.top, TW, TH)
  assert.equal(o.overlapsY && o.overlapsX, false, 'the bubble is sitting on its own trigger')
  assert.ok(p.top >= HEADER_ICON.bottom, `top ${p.top} is not below the trigger`)
})

test('with room above, `top` stays top — the flip is not eager', () => {
  const p = placeTooltip('top', MIDDLE, TW, TH, VW, VH)
  assert.equal(p.side, 'top')
  assert.equal(p.top, MIDDLE.top - 8 - TH)
})

test('a control near the BOTTOM edge flips the other way', () => {
  const low: TriggerRect = { left: 700, right: 740, top: 860, bottom: 892, width: 40, height: 32 }
  assert.equal(placeTooltip('bottom', low, TW, TH, VW, VH).side, 'top')
  assert.equal(placeTooltip('top', low, TW, TH, VW, VH).side, 'top', 'already fine — do not flip')
})

test('left and right flip on the horizontal axis', () => {
  const nearLeft: TriggerRect = { left: 10, right: 42, top: 400, bottom: 432, width: 32, height: 32 }
  assert.equal(placeTooltip('left', nearLeft, TW, TH, VW, VH).side, 'right')
  const nearRight: TriggerRect = { left: VW - 42, right: VW - 10, top: 400, bottom: 432, width: 32, height: 32 }
  assert.equal(placeTooltip('right', nearRight, TW, TH, VW, VH).side, 'left')
})

test('the CROSS axis still clamps, so a corner trigger stays on screen', () => {
  const p = placeTooltip('bottom', HEADER_ICON, TW, TH, VW, VH)
  // Centred on the trigger it would run off the right edge; clamped, it does not.
  assert.ok(p.left + TW <= VW - 8, `right edge at ${p.left + TW} of ${VW}`)
  assert.ok(p.left >= 8)
  assert.equal(p.top, HEADER_ICON.bottom + 8, 'and the main axis is untouched by that clamp')
})

test('a viewport too small for either side keeps the asked-for side', () => {
  // Nothing fits above or below; ping-ponging to an equally bad placement would
  // just make the choice unpredictable.
  const squeezed: TriggerRect = { left: 100, right: 132, top: 30, bottom: 62, width: 32, height: 32 }
  assert.equal(placeTooltip('top', squeezed, TW, TH, VW, 100).side, 'top')
})

test('every side, on a roomy trigger, sits a single gap away', () => {
  assert.equal(placeTooltip('top', MIDDLE, TW, TH, VW, VH).top + TH, MIDDLE.top - 8)
  assert.equal(placeTooltip('bottom', MIDDLE, TW, TH, VW, VH).top, MIDDLE.bottom + 8)
  assert.equal(placeTooltip('left', MIDDLE, TW, TH, VW, VH).left + TW, MIDDLE.left - 8)
  assert.equal(placeTooltip('right', MIDDLE, TW, TH, VW, VH).left, MIDDLE.right + 8)
})
