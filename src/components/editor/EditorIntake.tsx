// The editor's front door.
//
// No wizard and no modal — an editor you open "for a quick fix" must not make
// you answer questions first. So the routes are ranked instead of tiled: the
// drop zone the rest of the app uses is the whole top of the page, the two
// routes that need something you already have sit right under it, and the two
// that need nothing — a blank artboard, an example drawing — follow as their
// own sections.
//
// Nothing here explains the canvas. Shortcuts for tools you cannot reach yet
// are noise at the moment you are still choosing what to open; the toolbar
// carries them where they mean something.

import { useRef, useState } from 'react'
import { ClipboardPaste, ImageDown, Loader2, PenTool, X } from 'lucide-react'
import type { EditableDoc } from '../../lib/path/types'
import { parseSvg } from '../../lib/path/model'
import { useLogo } from '../../store'
import { ActionButton } from '../ui/ActionButton'
import { BlankArtboard } from './BlankArtboard'
import { EditorExampleGrid } from './EditorExamples'
import { adoptIds, blankDoc } from './editorDoc'

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
  const [dragging, setDragging] = useState(false)

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
    if (!/svg/i.test(file.type) && !/\.svg$/i.test(file.name)) {
      setError('The editor works on SVG. Use Vectorize to turn a bitmap into one first.')
      return
    }
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

  const logoIsSvg = Boolean(logo.svgText && logo.isSvg)

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const file = e.dataTransfer.files?.[0]
        if (file) void openFile(file)
      }}
      className="canvas-ui mx-auto flex w-full max-w-4xl flex-col items-center gap-4 p-6 animate-in-fade"
    >
      <header className="text-center">
        <h1 className="text-lg font-bold tracking-tight text-ink">SVG editor</h1>
        <p className="mt-1 text-sm text-muted">
          Draw, fix and rearrange vector artwork — nodes, shapes, layers and colour. Everything
          stays in your browser.
        </p>
      </header>

      {/* The primary route, and the target for a drop anywhere on this page. */}
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        className={`flex w-full flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed px-6 py-16 text-center transition-colors ${
          dragging
            ? 'border-accent bg-accent-soft'
            : 'border-line-strong bg-surface-2 hover:border-faint hover:bg-surface-3'
        }`}
      >
        <div
          className={`flex h-14 w-14 items-center justify-center rounded-full transition-colors ${
            dragging ? 'bg-accent-soft text-accent' : 'bg-surface-3 text-muted'
          }`}
        >
          {busy ? <Loader2 size={26} className="animate-spin text-accent" /> : <PenTool size={26} />}
        </div>
        <div>
          <p className="text-base font-medium text-ink">
            {dragging ? 'Drop to open it' : 'Drop an SVG to edit'}
          </p>
          <p className="mt-1 max-w-md text-sm text-muted">
            Its layer groups, gradients and strokes come across as editable objects — anything this
            editor can't model round-trips untouched.
          </p>
          <p className="mt-2 text-xs text-faint">
            Drop a file or <span className="font-medium text-muted">click to browse</span> · SVG only
          </p>
        </div>
      </button>

      {error && <p className="text-sm text-bad">{error}</p>}

      {/* The two routes that start from something you already have. */}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <ActionButton
          label="Open the current logo"
          note="Brings the logo this app is working on into the editor."
          reason={
            logoIsSvg
              ? null
              : logo.src
                ? 'The loaded logo is a bitmap. Trace it on the Vectorize tab first — that produces the SVG this editor works on.'
                : 'No logo is loaded. Drop one on the Preview tab, or open an SVG file here.'
          }
          onClick={() =>
            logo.svgText && open(logo.svgText, logo.fileName?.replace(/\.[^.]+$/, '') ?? 'logo')
          }
          className="btn btn-secondary h-9 max-w-full text-xs"
        >
          <ImageDown size={15} className="shrink-0" />
          {/* A file name can be arbitrarily long; the button is not. */}
          <span className="truncate">
            {logoIsSvg && logo.fileName ? `Open ${logo.fileName}` : 'Open the current logo'}
          </span>
        </ActionButton>
        <ActionButton
          label={pasting ? 'Close the paste box' : 'Paste markup'}
          note={
            pasting
              ? 'Hides the box again.'
              : "Opens a box for raw <svg> text — from a design tool, a codebase, anywhere."
          }
          pressed={pasting}
          onClick={() => setPasting((v) => !v)}
          className={`btn btn-secondary h-9 text-xs ${pasting ? 'is-active' : ''}`}
        >
          {pasting ? <X size={15} /> : <ClipboardPaste size={15} />}
          Paste markup
        </ActionButton>
      </div>

      {pasting && (
        <div className="w-full rounded-xl border border-line bg-surface p-3">
          <textarea
            value={markup}
            onChange={(e) => setMarkup(e.target.value)}
            placeholder="<svg viewBox=…"
            rows={5}
            spellCheck={false}
            autoFocus
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
        </div>
      )}

      {/* Nothing to open: start from an empty artboard… */}
      <Divider>Or start from a blank artboard</Divider>
      <div className="w-full">
        <BlankArtboard onCreate={(w, h) => onOpen(blankDoc(w, h), 'drawing')} />
      </div>

      {/* …or from a drawing that already has something to pull on. */}
      <Divider>Or open an example</Divider>
      <div className="w-full">
        <EditorExampleGrid onOpen={onOpen} className="sm:grid-cols-2 lg:grid-cols-3" />
      </div>

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
    </div>
  )
}

/** A titled rule between two ways in — the same one the other intakes use. */
function Divider({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 flex w-full items-center gap-3">
      <span className="h-px flex-1 bg-line" />
      <span className="text-xs font-medium uppercase tracking-wider text-faint">{children}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  )
}
