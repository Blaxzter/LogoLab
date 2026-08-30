// The editor's front door: four ways to get a document, side by side.
//
// No wizard and no modal — an editor you open "for a quick fix" must not make
// you answer questions first, so every route is one click or one drop and the
// blank-canvas path is pre-filled with a sane artboard.

import { useRef, useState } from 'react'
import { ClipboardPaste, FilePlus2, FolderOpen, ImageDown, Loader2 } from 'lucide-react'
import type { EditableDoc } from '../../lib/path/types'
import { parseSvg } from '../../lib/path/model'
import { useLogo } from '../../store'
import { ActionButton } from '../ui/ActionButton'
import { adoptIds, blankDoc } from './editorDoc'

/** Artboard presets for a blank document. */
const SIZES = [256, 512, 1024]

export interface EditorIntakeProps {
  onOpen: (doc: EditableDoc, name: string) => void
}

export function EditorIntake({ onOpen }: EditorIntakeProps) {
  const logo = useLogo()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [pasting, setPasting] = useState(false)
  const [markup, setMarkup] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [size, setSize] = useState(512)

  /** Parse markup into a document, preserving the author's group structure. */
  const open = (svg: string, name: string) => {
    const doc = parseSvg(svg, { preserveGroups: true })
    if (!doc) {
      setError("That doesn't parse as SVG. Check the file, or paste the markup instead.")
      return
    }
    adoptIds(doc)
    setError(null)
    onOpen(doc, name)
  }

  const openFile = async (file: File) => {
    setBusy(true)
    try {
      const text = await file.text()
      open(text, file.name.replace(/\.svg$/i, ''))
    } catch {
      setError('That file could not be read.')
    } finally {
      setBusy(false)
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    if (!/svg/i.test(file.type) && !/\.svg$/i.test(file.name)) {
      setError('The editor works on SVG. Use Vectorize to turn a bitmap into one first.')
      return
    }
    void openFile(file)
  }

  const logoIsSvg = Boolean(logo.svgText && logo.isSvg)

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className={`canvas-ui mx-auto w-full max-w-4xl p-6 transition-colors ${dragOver ? 'bg-accent-soft/40' : ''}`}
    >
      <header className="mb-6 text-center">
        <h1 className="text-lg font-bold tracking-tight text-ink">SVG editor</h1>
        <p className="mt-1 text-sm text-muted">
          Draw, fix and rearrange vector artwork — nodes, shapes, layers and colour. Everything
          stays in your browser.
        </p>
      </header>

      {error && (
        <p className="mb-4 rounded-lg border border-line bg-surface px-3 py-2 text-center text-xs text-bad">
          {error}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {/* Open a file */}
        <Card
          icon={<FolderOpen size={20} />}
          title="Open an SVG"
          body="Drop a file anywhere on this page, or browse for one. Layer groups are kept."
        >
          <input
            ref={fileRef}
            type="file"
            accept=".svg,image/svg+xml"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void openFile(f)
              e.target.value = ''
            }}
          />
          <ActionButton
            label="Choose file"
            note="Opens a file picker. Only .svg files can be edited here."
            reason={busy ? 'Still reading the last file — one moment.' : null}
            onClick={() => fileRef.current?.click()}
            className="btn btn-primary h-9 w-full text-sm"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : 'Choose file'}
          </ActionButton>
        </Card>

        {/* Blank */}
        <Card
          icon={<FilePlus2 size={20} />}
          title="Start blank"
          body="An empty artboard to draw on."
        >
          <div className="mb-2 flex gap-1">
            {SIZES.map((s) => (
              <ActionButton
                key={s}
                label={`${s} × ${s} artboard`}
                note="The viewBox the new drawing gets. It can be any size later."
                onClick={() => setSize(s)}
                className={`btn btn-secondary h-8 flex-1 px-1 text-xs ${size === s ? 'is-active' : ''}`}
              >
                {s}
              </ActionButton>
            ))}
          </div>
          <ActionButton
            label={`New ${size} × ${size}`}
            note="Opens an empty artboard. Press R or E and drag to draw your first shape."
            onClick={() => onOpen(blankDoc(size), 'drawing')}
            className="btn btn-secondary h-9 w-full text-sm"
          >
            New {size} × {size}
          </ActionButton>
        </Card>

        {/* From the working logo */}
        <Card
          icon={<ImageDown size={20} />}
          title="Edit the current logo"
          body={
            logoIsSvg
              ? 'Bring the logo this app is working on into the editor.'
              : logo.src
                ? 'The loaded logo is a bitmap. Trace it on the Vectorize tab first, then it can be edited here.'
                : 'No logo loaded yet.'
          }
        >
          <ActionButton
            label="Open logo"
            note="Brings the logo this app is working on into the editor."
            reason={
              logoIsSvg
                ? null
                : logo.src
                  ? 'The loaded logo is a bitmap. Trace it on the Vectorize tab first — that produces the SVG this editor works on.'
                  : 'No logo is loaded. Drop one on the Preview tab, or open an SVG file here.'
            }
            onClick={() => logo.svgText && open(logo.svgText, logo.fileName?.replace(/\.[^.]+$/, '') ?? 'logo')}
            className="btn btn-secondary h-9 w-full text-sm"
          >
            Open logo
          </ActionButton>
        </Card>

        {/* Paste markup */}
        <Card
          icon={<ClipboardPaste size={20} />}
          title="Paste markup"
          body="Drop in raw <svg> text — from a design tool, a codebase, anywhere."
        >
          {pasting ? (
            <>
              <textarea
                value={markup}
                onChange={(e) => setMarkup(e.target.value)}
                placeholder="<svg viewBox=…"
                rows={4}
                spellCheck={false}
                className="input mb-2 h-auto w-full resize-y py-1.5 font-mono text-[0.7rem]"
              />
              <ActionButton
                label="Open markup"
                note="Parses the text above into an editable drawing."
                reason={markup.trim() ? null : 'The box above is empty — paste some <svg> markup into it first.'}
                onClick={() => open(markup, 'pasted')}
                className="btn btn-primary h-9 w-full text-sm"
              >
                Open markup
              </ActionButton>
            </>
          ) : (
            <ActionButton
              label="Paste SVG"
              note="Opens a box to paste raw <svg> text into."
              onClick={() => setPasting(true)}
              className="btn btn-secondary h-9 w-full text-sm"
            >
              Paste SVG
            </ActionButton>
          )}
        </Card>
      </div>

      <p className="mt-6 text-center text-xs text-faint">
        Tip: <kbd className="rounded border border-line px-1">V</kbd> move ·{' '}
        <kbd className="rounded border border-line px-1">A</kbd> nodes ·{' '}
        <kbd className="rounded border border-line px-1">P</kbd> pen ·{' '}
        <kbd className="rounded border border-line px-1">R</kbd>/
        <kbd className="rounded border border-line px-1">E</kbd> shapes · hold{' '}
        <kbd className="rounded border border-line px-1">Space</kbd> to pan
      </p>
    </div>
  )
}

function Card({
  icon, title, body, children,
}: {
  icon: React.ReactNode
  title: string
  body: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col rounded-xl border border-line bg-surface p-4">
      <span className="mb-2 flex h-9 w-9 items-center justify-center rounded-lg bg-accent-soft text-accent">
        {icon}
      </span>
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      <p className="mb-3 mt-0.5 flex-1 text-xs text-muted">{body}</p>
      {children}
    </section>
  )
}
