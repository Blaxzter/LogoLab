import { Circle, RotateCcw, Square, Squircle } from 'lucide-react'
import { useAppearance, useEnv, useStore } from '../store'
import { useActiveTab } from '../hooks/useActiveTab'
import { UploadDropzone } from './UploadDropzone'
import { TryExampleButton } from './ExamplesDialog'
import { Collapsible, ColorField, Field, Segmented, Slider, TextField, Toggle } from './ui/controls'
import { Button } from './ui/Button'
import { Sheet } from './ui/Sheet'
import type { IconShape } from '../types'

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[0.7rem] font-bold uppercase tracking-wider text-faint">{children}</h3>
  )
}

const SHAPE_LABEL: Record<IconShape, string> = {
  rounded: 'Rounded',
  circle: 'Circle',
  square: 'Square',
}

/**
 * The sidebar's scrollable controls + pinned Reset footer. Shared verbatim by the
 * desktop {@link Sidebar} column and the mobile {@link MobileSidebarDrawer} so the
 * two never drift. Fills its parent (the parent sets the width); on desktop that's
 * a fixed 320px shell, in the drawer it's the full slide-over.
 */
function SidebarBody() {
  const tab = useActiveTab()
  const app = useAppearance()
  const env = useEnv()
  const setAppearance = useStore((s) => s.setAppearance)
  const setEnv = useStore((s) => s.setEnv)
  const resetAppearance = useStore((s) => s.resetAppearance)

  // Only Preview and Export consume the appearance/branding controls. Cleanup
  // and Vectorize work on the raw pixels and read nothing but the logo, so their
  // styling controls would be inert — hide them there. The Logo section stays in
  // every view (you load / swap / pick an example from it everywhere).
  const isPreview = tab === 'preview'
  const showStyling = isPreview || tab === 'export'

  const shapeOptions: { value: IconShape; label: React.ReactNode; title: string }[] = [
    { value: 'rounded', label: <Squircle size={15} />, title: 'Rounded' },
    { value: 'circle', label: <Circle size={15} />, title: 'Circle' },
    { value: 'square', label: <Square size={15} />, title: 'Square' },
  ]

  // One-line glances for each collapsed section — same convention the cleanup &
  // vectorize rails use so the panel stays readable while folded.
  const sizeSummary = `${Math.round(app.scale * 100)}% scale · ${app.padding}% pad`
  const cardSummary =
    app.cardColor === 'transparent'
      ? 'Transparent'
      : `${SHAPE_LABEL[app.cardShape]} · ${app.cardColor}`
  const recolorSummary = app.tintEnabled
    ? `Tint ${app.tintColor}`
    : app.invert
      ? 'Inverted'
      : 'Off'
  const envSummary = isPreview
    ? `${env.theme === 'dark' ? 'Dark' : 'Light'}${env.brandName ? ` · ${env.brandName}` : ''}`
    : env.brandName || 'Unnamed'

  return (
    <>
      {/* Scrollable settings — the Reset footer below stays pinned, mirroring the
          cleanup & vectorize rails. */}
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
        {/* Logo — needed in every view, so it stays open at the top (not folded). */}
        <section className="flex flex-col gap-3">
          <SectionTitle>Logo</SectionTitle>
          <UploadDropzone />
          <TryExampleButton />
        </section>

        {showStyling && (
          <>
            {/* Size & spacing */}
            <Collapsible title="Size & spacing" summary={sizeSummary} defaultOpen>
              <Field label="Logo scale">
                <Slider
                  value={Math.round(app.scale * 100)}
                  min={30}
                  max={120}
                  unit="%"
                  onChange={(v) => setAppearance({ scale: v / 100 })}
                />
              </Field>
              <Field label="Safe-zone padding">
                <Slider
                  value={app.padding}
                  min={0}
                  max={35}
                  unit="%"
                  onChange={(v) => setAppearance({ padding: v })}
                />
              </Field>
            </Collapsible>

            {/* Background card */}
            <Collapsible title="Background card" summary={cardSummary} defaultOpen>
              {/* "Draw card in flat contexts" only affects the Preview scenes. */}
              {isPreview && (
                <Field
                  label="Draw card in flat contexts"
                  right={
                    <Toggle
                      checked={app.cardInFlat}
                      onChange={(v) => setAppearance({ cardInFlat: v })}
                    />
                  }
                >
                  <p className="text-xs leading-snug text-muted">
                    Adds a colored backplate behind the logo (great for white line-art). Always on
                    for app-icon scenes; toggle controls flat scenes like nav bars &amp; favicons.
                  </p>
                </Field>
              )}
              <Field label="Card color">
                <ColorField
                  value={app.cardColor}
                  onChange={(v) => setAppearance({ cardColor: v })}
                  allowTransparent
                />
              </Field>
              <Field label="Shape">
                <Segmented
                  value={app.cardShape}
                  options={shapeOptions}
                  onChange={(v) => setAppearance({ cardShape: v })}
                />
              </Field>
              {app.cardShape === 'rounded' && (
                <Field label="Corner radius">
                  <Slider
                    value={app.cardRadius}
                    min={0}
                    max={50}
                    unit="%"
                    onChange={(v) => setAppearance({ cardRadius: v })}
                  />
                </Field>
              )}
              {/* Drop shadow is a Preview-scene flourish; export icons don't use it. */}
              {isPreview && (
                <Toggle
                  checked={app.cardShadow}
                  onChange={(v) => setAppearance({ cardShadow: v })}
                  label="Drop shadow"
                />
              )}
            </Collapsible>

            {/* Recolor */}
            <Collapsible title="Recolor" summary={recolorSummary}>
              <Field
                label="Recolor logo"
                right={
                  <Toggle
                    checked={app.tintEnabled}
                    onChange={(v) => setAppearance({ tintEnabled: v })}
                  />
                }
              >
                <p className="text-xs leading-snug text-muted">
                  Paint a monochrome logo a single color via its alpha — preview a white mark in
                  any brand color.
                </p>
              </Field>
              {app.tintEnabled && (
                <Field label="Tint color">
                  <ColorField value={app.tintColor} onChange={(v) => setAppearance({ tintColor: v })} />
                </Field>
              )}
              <Toggle
                checked={app.invert}
                onChange={(v) => setAppearance({ invert: v })}
                label="Invert colors"
              />
            </Collapsible>

            {/* Environment (Preview) / Branding (Export). Theme & page background only
                drive the Preview scenes; the brand name also names the PWA manifest. */}
            <Collapsible title={isPreview ? 'Environment' : 'Branding'} summary={envSummary}>
              {isPreview && (
                <Field label="Preview theme">
                  <Segmented
                    value={env.theme}
                    options={[
                      { value: 'light', label: 'Light' },
                      { value: 'dark', label: 'Dark' },
                    ]}
                    onChange={(v) => setEnv({ theme: v })}
                  />
                </Field>
              )}
              {isPreview && (
                <Field label="Page background">
                  <ColorField value={env.pageBg} onChange={(v) => setEnv({ pageBg: v })} />
                </Field>
              )}
              <Field
                label="Brand name"
                hint={
                  isPreview
                    ? 'Shown as the app/site name inside mockups.'
                    : 'Names the PWA manifest & exported files.'
                }
              >
                <TextField
                  value={env.brandName}
                  onChange={(v) => setEnv({ brandName: v })}
                  placeholder="Acme"
                  maxLength={24}
                />
              </Field>
            </Collapsible>
          </>
        )}
      </div>

      {/* Pinned footer — Reset stays reachable no matter how far the settings scroll,
          matching the cleanup & vectorize rails. */}
      {showStyling && (
        <div className="flex shrink-0 flex-col gap-3 border-t border-line bg-surface p-4">
          <Button
            variant="ghost"
            block
            icon={<RotateCcw size={16} />}
            onClick={resetAppearance}
            className="h-10"
          >
            Reset appearance
          </Button>
        </div>
      )}
    </>
  )
}

/**
 * Desktop sidebar — the inline 320px column. Collapses to zero width on the
 * Cleanup & Vectorize tabs (which carry their own rails). Hidden below `md`,
 * where {@link MobileSidebarDrawer} takes over.
 */
export function Sidebar({ className = '' }: { className?: string }) {
  const tab = useActiveTab()
  // Cleanup & Vectorize don't use any sidebar controls (and load logos from their
  // own empty state), so the whole panel slides away there for a roomier canvas.
  const collapsed = tab === 'cleanup' || tab === 'vectorize'

  return (
    <aside
      aria-hidden={collapsed}
      inert={collapsed}
      style={{ width: collapsed ? 0 : '320px' }}
      className={`h-full min-w-0 shrink-0 overflow-hidden border-line bg-surface transition-[width] duration-300 ease-in-out ${
        collapsed ? 'border-r-0' : 'border-r'
      } ${className}`}
    >
      {/* Fixed-width inner so content doesn't reflow while the panel clips it
          during the collapse transition. Width matches the cleanup & vectorize
          rails (320px). */}
      <div className="flex h-full w-[320px] flex-col">
        <SidebarBody />
      </div>
    </aside>
  )
}

/**
 * Mobile slide-over holding the same appearance controls. Rendered only for the
 * Preview & Export tabs (and only opened once a logo exists — see {@link App}),
 * so phones get the full-width preview and reach the controls on demand. Shares
 * the app-wide {@link Sheet} chrome (backdrop, z-stack, inert, scroll-lock).
 */
export function MobileSidebarDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Customize" side="right">
      <SidebarBody />
    </Sheet>
  )
}
