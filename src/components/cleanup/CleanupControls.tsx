// Left rail of the cleanup studio: background-removal controls grouped into
// collapsible sections to keep the panel uncluttered — one-click removers,
// manual brushes/flood tools, guided keep/remove markers, edge refine, trim,
// and the matte fill — plus a pinned footer with the usage tip + Reset. Pure
// controlled UI: every bit of cleanup state lives in CleanupStudio; only the
// "which info hint is open" state is local. Mirrors TraceControls' structure.

import { useState } from 'react'
import { Bot, Loader2, MapPin, RotateCcw, Sparkles, Wand2, X } from 'lucide-react'
import { Button } from '../ui/Button'
import { ColorField, Collapsible, Field, Segmented, Slider, Toggle } from '../ui/controls'
import type { CleanupTool } from '../../hooks/useCleanupCanvas'

/**
 * The manual painting tools split into their two families: single-click flood
 * *removers* (tolerance-driven) and the drag *touch-up brushes* (size-driven).
 * They live in separate rail sections so neither control is cramped and each
 * owns a stable parameter slider.
 */
type ManualTool = 'magic' | 'color' | 'restore' | 'erase'
type RemoveTool = 'magic' | 'color'
type BrushTool = 'erase' | 'restore'
const REMOVE_TOOLS: { value: RemoveTool; label: string }[] = [
  { value: 'magic', label: 'Magic' },
  { value: 'color', label: 'By color' },
]
const BRUSH_TOOLS: { value: BrushTool; label: string }[] = [
  { value: 'erase', label: 'Erase' },
  { value: 'restore', label: 'Restore' },
]

/** Per-tool teaching copy, carried verbatim from the old CleanupPanel. */
function toolHint(tool: ManualTool): string {
  switch (tool) {
    case 'magic':
      return 'Click the background: erases the connected blob of similar color you click. Bump Tolerance if it stops too soon, lower it if it eats into the logo.'
    case 'color':
      return 'Click a color: erases that color everywhere at once — including enclosed gaps a single flood can’t reach.'
    case 'erase':
      return 'Drag to rub out pixels by hand. Best for stray specks and the holes auto-remove misses.'
    case 'restore':
      return 'Drag to paint the original image back — fix any spot you erased too much.'
  }
}

export interface CleanupControlsProps {
  /** The active studio tool — the manual + marker Segmenteds both write here. */
  tool: CleanupTool
  onToolChange: (tool: CleanupTool) => void
  tolerance: number
  onTolerance: (v: number) => void
  /** Edge softness 0–1. */
  softness: number
  onSoftness: (v: number) => void
  /** Brush diameter in image px (erase/restore). */
  brushSize: number
  onBrushSize: (v: number) => void
  /** Fringe-cleanup strength 0–1 applied on each remove; 0 = off. */
  defringeStrength: number
  onDefringeStrength: (v: number) => void

  /** Guided keep/remove marker counts (placed pins) + clear. */
  keepCount: number
  removeCount: number
  onClearMarkers: () => void

  /** Edge-refine sliders (live values + Apply handlers). */
  edgeShift: number
  onEdgeShift: (v: number) => void
  onApplyEdgeShift: () => void
  feather: number
  onFeather: (v: number) => void
  onApplyFeather: () => void
  defringeAmt: number
  onDefringeAmt: (v: number) => void
  onApplyDefringe: () => void

  /** Flat-recolor (monochrome logos): target color + Apply. */
  recolorColor: string
  onRecolorColor: (v: string) => void
  onRecolor: () => void

  /** Trim & padding. */
  trimPad: number
  onTrimPad: (v: number) => void
  onAutoTrim: () => void

  /** Background-fill matte. */
  matteOn: boolean
  onMatteOn: (v: boolean) => void
  matteColor: string
  onMatteColor: (v: string) => void

  /** One-click removers + reset. */
  onAuto: () => void
  onAi: () => void
  onReset: () => void

  /** Live state from the canvas hook. */
  ready: boolean
  aiBusy: boolean
  aiStatus: string
  aiDevice: 'webgpu' | 'wasm' | null
}

/** Desktop rail — the 320px column. Below md it's hidden; the same body renders
 *  inside the studio's bottom "Tools" sheet instead (see CleanupStudio). */
export function CleanupControls(props: CleanupControlsProps) {
  return (
    <aside className="hidden w-[320px] shrink-0 flex-col border-r border-line bg-surface md:flex">
      <CleanupControlsBody {...props} />
    </aside>
  )
}

export function CleanupControlsBody({
  tool,
  onToolChange,
  tolerance,
  onTolerance,
  softness,
  onSoftness,
  brushSize,
  onBrushSize,
  defringeStrength,
  onDefringeStrength,
  keepCount,
  removeCount,
  onClearMarkers,
  edgeShift,
  onEdgeShift,
  onApplyEdgeShift,
  feather,
  onFeather,
  onApplyFeather,
  defringeAmt,
  onDefringeAmt,
  onApplyDefringe,
  recolorColor,
  onRecolorColor,
  onRecolor,
  trimPad,
  onTrimPad,
  onAutoTrim,
  matteOn,
  onMatteOn,
  matteColor,
  onMatteColor,
  onAuto,
  onAi,
  onReset,
  ready,
  aiBusy,
  aiStatus,
  aiDevice,
}: CleanupControlsProps) {
  // Which family the active tool belongs to. Each Segmented below is passed the
  // raw `tool`; when it's out of that group nothing highlights, so only the
  // active family shows a selection. Hints fall back to each family's first tool
  // so an opened-but-inactive section still previews sensible copy.
  const isRemove = tool === 'magic' || tool === 'color'
  const isBrush = tool === 'erase' || tool === 'restore'
  const isMarker = tool === 'keep' || tool === 'remove'
  const markerTotal = keepCount + removeCount

  const removeSummary = isRemove
    ? `${tool === 'magic' ? 'Magic' : 'By color'} · tolerance ${tolerance}`
    : `Tolerance ${tolerance}`
  const brushSummary = isBrush
    ? `${tool === 'erase' ? 'Erase' : 'Restore'} · ${brushSize}px`
    : `Brush ${brushSize}px`
  const markerSummary = markerTotal > 0 ? `${keepCount} keep · ${removeCount} remove` : undefined

  return (
    <>
      {/* Scrollable settings — the footer below stays pinned so it can't scroll away. */}
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
        <h2 className="text-sm font-semibold text-ink">Remove background</h2>

        {/* ----------------------------------------------------- one-click */}
        <Collapsible title="One-click" summary="Auto · AI" defaultOpen>
          <div className="flex flex-col gap-2">
            <Button
              variant="secondary"
              icon={<Sparkles size={15} />}
              onClick={onAuto}
              disabled={aiBusy || !ready}
              block
            >
              Auto-remove (corners)
            </Button>
            <Button
              variant="primary"
              icon={aiBusy ? <Loader2 size={15} className="animate-spin" /> : <Bot size={15} />}
              onClick={onAi}
              disabled={aiBusy || !ready}
              block
            >
              {aiBusy ? aiStatus || 'Working…' : 'AI auto-remove'}
            </Button>
            <p className="text-[0.7rem] leading-snug text-faint">
              AI handles tricky backgrounds & holes the flood misses. First run downloads a model
              (~few sec), then it’s cached & offline.
            </p>
            {aiDevice && !aiBusy && (
              <p className="text-[0.7rem] leading-snug text-muted">AI ready ({aiDevice})</p>
            )}
          </div>
        </Collapsible>

        {/* -------------------------------------------------- manual remove */}
        <Collapsible title="Manual remove" summary={removeSummary} defaultOpen>
          <Field label="Tool">
            {/* `value={tool}` highlights nothing while a brush/marker is active. */}
            <Segmented<RemoveTool>
              value={tool as RemoveTool}
              onChange={onToolChange}
              options={REMOVE_TOOLS}
            />
            <p className="mt-1.5 text-xs leading-snug text-muted">
              {toolHint(isRemove ? (tool as ManualTool) : 'magic')}
            </p>
          </Field>

          <Field label="Tolerance" hint="How close a color must be to count as background.">
            <Slider value={tolerance} min={1} max={160} onChange={onTolerance} />
          </Field>

          <Field label="Edge softness" hint="Feathers the cut edge to avoid jaggies.">
            <Slider
              value={Math.round(softness * 100)}
              min={0}
              max={100}
              unit="%"
              onChange={(v) => onSoftness(v / 100)}
            />
          </Field>

          <Field
            label="Defringe"
            hint="How hard each removal scrubs the leftover background color out of the soft edge. Higher = cleaner halo but a slightly harder edge; 0 = off."
          >
            <Slider
              value={Math.round(defringeStrength * 100)}
              min={0}
              max={100}
              unit="%"
              onChange={(v) => onDefringeStrength(v / 100)}
            />
          </Field>
        </Collapsible>

        {/* ------------------------------------------------ guided markers */}
        <Collapsible title="Guided markers" summary={markerSummary}>
          <Field
            label="Marker"
            hint="Click the image to keep (green) or remove (red) the region under the marker — each placement is one undo step. Pins mark your seeds; Clear removes them (they also clear on Reset, Apply or AI)."
          >
            <Segmented<'keep' | 'remove'>
              value={tool === 'remove' ? 'remove' : 'keep'}
              onChange={(v) => onToolChange(v)}
              options={[
                { value: 'keep', label: 'Keep' },
                { value: 'remove', label: 'Remove' },
              ]}
            />
          </Field>
          {!isMarker && (
            <p className="text-xs leading-snug text-muted">
              Pick Keep or Remove, then click the image to seed a region.
            </p>
          )}
          {markerTotal > 0 && (
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs text-ink-2">
                <MapPin size={12} className="text-emerald-500" />
                {keepCount} keep / {removeCount} remove placed
              </span>
              <button
                type="button"
                onClick={onClearMarkers}
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
              >
                <X size={12} /> Clear
              </button>
            </div>
          )}
        </Collapsible>

        {/* ------------------------------------------------- touch-up brush */}
        <Collapsible title="Touch-up brush" summary={brushSummary}>
          <Field label="Brush">
            {/* `value={tool}` highlights nothing while a remove/marker tool is active. */}
            <Segmented<BrushTool>
              value={tool as BrushTool}
              onChange={onToolChange}
              options={BRUSH_TOOLS}
            />
            <p className="mt-1.5 text-xs leading-snug text-muted">
              {toolHint(isBrush ? (tool as ManualTool) : 'erase')}
            </p>
          </Field>

          <Field label="Brush size" hint="Brush diameter, in image pixels.">
            <Slider value={brushSize} min={4} max={200} unit="px" onChange={onBrushSize} />
          </Field>

          <Field label="Edge softness" hint="Feathers the brush edge.">
            <Slider
              value={Math.round(softness * 100)}
              min={0}
              max={100}
              unit="%"
              onChange={(v) => onSoftness(v / 100)}
            />
          </Field>
        </Collapsible>

        {/* --------------------------------------------------- edge refine */}
        <Collapsible title="Edge refine" summary="Grow · feather · defringe">
          <Field
            label="Shrink ↔ Grow"
            hint="Tighten (negative) or fill out (positive) the cutout edge, then Apply."
          >
            <Slider
              value={edgeShift}
              min={-16}
              max={16}
              onChange={onEdgeShift}
              format={(v) => (v === 0 ? '0' : `${v > 0 ? '+' : ''}${v}px`)}
            />
            <Button
              variant="secondary"
              onClick={onApplyEdgeShift}
              disabled={aiBusy || !ready || edgeShift === 0}
              className="mt-2 h-8 text-xs"
              block
            >
              Apply {edgeShift > 0 ? 'grow' : edgeShift < 0 ? 'shrink' : ''}
            </Button>
          </Field>

          <Field label="Feather" hint="Soft-blur the alpha edge to hide jaggies, then Apply.">
            <Slider value={feather} min={0} max={16} unit="px" onChange={onFeather} />
            <Button
              variant="secondary"
              onClick={onApplyFeather}
              disabled={aiBusy || !ready || feather === 0}
              className="mt-2 h-8 text-xs"
              block
            >
              Apply feather
            </Button>
          </Field>

          <Field
            label="Defringe strength"
            hint="Pull leftover background color out of the soft edge, then Apply."
          >
            <Slider
              value={Math.round(defringeAmt * 100)}
              min={0}
              max={100}
              unit="%"
              onChange={(v) => onDefringeAmt(v / 100)}
            />
            <Button
              variant="secondary"
              onClick={onApplyDefringe}
              disabled={aiBusy || !ready || defringeAmt === 0}
              className="mt-2 h-8 text-xs"
              block
            >
              Apply defringe
            </Button>
          </Field>
        </Collapsible>

        {/* ----------------------------------------------------- recolor */}
        <Collapsible title="Recolor" summary={`To ${recolorColor}`}>
          <Field
            label="Flat color"
            hint="Paints every visible pixel one color (alpha kept), then Apply. Cleans a monochrome logo and wipes any leftover edge rim — for single-color art only, since it flattens real colors."
          >
            <ColorField value={recolorColor} onChange={onRecolorColor} />
            <Button
              variant="secondary"
              onClick={onRecolor}
              disabled={aiBusy || !ready}
              className="mt-2 h-8 text-xs"
              block
            >
              Recolor to {recolorColor}
            </Button>
          </Field>
        </Collapsible>

        {/* -------------------------------------------------- trim & padding */}
        <Collapsible title="Trim & padding" summary={`Pad ${trimPad}px`}>
          <Field label="Padding" hint="Transparent margin kept around the trimmed cutout.">
            <Slider value={trimPad} min={0} max={128} unit="px" onChange={onTrimPad} />
          </Field>
          <Button
            variant="secondary"
            icon={<Wand2 size={15} />}
            onClick={onAutoTrim}
            disabled={aiBusy || !ready}
            block
          >
            Auto-trim & pad
          </Button>
        </Collapsible>

        {/* ----------------------------------------------- background fill */}
        <Collapsible
          title="Background fill"
          summary={matteOn ? `Matte ${matteColor}` : 'Transparent'}
        >
          <Field
            label="Matte color"
            hint="Preview the cutout over a solid color — baked into Apply / Download when on."
            right={<Toggle checked={matteOn} onChange={onMatteOn} />}
          >
            {matteOn ? (
              <ColorField value={matteColor} onChange={onMatteColor} />
            ) : (
              <p className="text-xs leading-snug text-muted">
                Off — the cutout stays transparent (checkerboard preview).
              </p>
            )}
          </Field>
        </Collapsible>

        <div className="mt-auto border-t border-line pt-4">
          <p className="text-[0.7rem] leading-relaxed text-faint">
            Try AI or Auto first, then touch up with Erase / Restore. Space- or middle-drag to pan ·
            scroll to zoom · ⌘Z to undo.
          </p>
        </div>
      </div>

      {/* Pinned footer — Reset stays reachable no matter how far the settings scroll. */}
      <div className="flex shrink-0 flex-col gap-3 border-t border-line bg-surface p-4">
        <Button
          variant="ghost"
          block
          icon={<RotateCcw size={16} />}
          onClick={onReset}
          disabled={aiBusy}
          className="h-10"
        >
          Reset to original
        </Button>
      </div>
    </>
  )
}
