import { Circle, RotateCcw, Square, Squircle } from 'lucide-react'
import { isDefaultAppearance, useAppearance, useEnv, useStore } from '../store'
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
 * Scrollable controls plus a pinned Reset footer, shared by the desktop
 * {@link Sidebar} and the mobile {@link MobileSidebarDrawer}. Fills its parent.
 */
function SidebarBody() {
  const tab = useActiveTab()
  const app = useAppearance()
  const env = useEnv()
  const setAppearance = useStore((s) => s.setAppearance)
  const setEnv = useStore((s) => s.setEnv)
  const resetAppearance = useStore((s) => s.resetAppearance)

  // Only Preview and Export use the appearance/branding controls; the Logo
  // section is shown everywhere.
  const isPreview = tab === 'preview'
  const showStyling = isPreview || tab === 'export'

  const shapeOptions: { value: IconShape; label: React.ReactNode; title: string }[] = [
    { value: 'rounded', label: <Squircle size={15} />, title: 'Rounded' },
    { value: 'circle', label: <Circle size={15} />, title: 'Circle' },
    { value: 'square', label: <Square size={15} />, title: 'Square' },
  ]

  // One-line summaries shown on collapsed sections.
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
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
        <section className="flex flex-col gap-3">
          <SectionTitle>Logo</SectionTitle>
          <UploadDropzone />
          <TryExampleButton />
        </section>

        {showStyling && (
          <>
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

            {/* Theme and page background only drive the Preview scenes; the brand
                name also names the PWA manifest. */}
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

      {/* Pinned Reset footer, shown only when the appearance differs from the defaults. */}
      {showStyling && !isDefaultAppearance(app) && (
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
  // These tabs have their own rails and don't use the sidebar.
  const collapsed = tab === 'cleanup' || tab === 'vectorize' || tab === 'sheet'

  return (
    <aside
      aria-hidden={collapsed}
      inert={collapsed}
      style={{ width: collapsed ? 0 : '320px' }}
      className={`h-full min-w-0 shrink-0 overflow-hidden border-line bg-surface transition-[width] duration-300 ease-in-out ${
        collapsed ? 'border-r-0' : 'border-r'
      } ${className}`}
    >
      {/* Fixed-width inner so content doesn't reflow during the collapse transition. */}
      <div className="flex h-full w-[320px] flex-col">
        <SidebarBody />
      </div>
    </aside>
  )
}

/**
 * Mobile slide-over with the same controls. Rendered only for Preview and Export
 * (and opened only once a logo exists — see {@link App}).
 */
export function MobileSidebarDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Customize" side="right">
      <SidebarBody />
    </Sheet>
  )
}
