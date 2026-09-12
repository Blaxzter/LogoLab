// Ready-made drawings for the editor's empty state — the same cards the logo
// panels and the icon sheet show, so the three front doors read as one thing.
//
// The pick lands in the EDITOR only: it is parsed straight into an editable
// document and never touches the app's working logo, because opening something
// to look at its nodes must not replace what you were preparing on the other
// tabs.
//
// They are the bundled example logos, chosen for what each one gives you to
// edit — a flat mark, a stack of translucent shapes, strokes, a gradient — since
// the editor's jobs are nodes, paint and layer order, not tracing.

import { useCallback, useState } from 'react'
import type { EditableDoc } from '../../lib/path/types'
import { parseSvg } from '../../lib/path/model'
import { ExampleCard } from '../ExamplesDialog'
import { adoptIds } from './editorDoc'

interface EditorExample {
  /** File under public/examples/. */
  file: string
  name: string
  /** One-liner: what this one gives you to edit. */
  blurb: string
}

export const EDITOR_EXAMPLES: EditorExample[] = [
  {
    file: 'summit.svg',
    name: 'Summit',
    blurb: 'Two flat shapes — the simplest thing to pull nodes on.',
  },
  {
    file: 'bloom.svg',
    name: 'Bloom',
    blurb: 'Three translucent circles — restack them, group them, recolour.',
  },
  {
    file: 'orbit.svg',
    name: 'Orbit',
    blurb: 'A ring and a backdrop — strokes, width and caps.',
  },
  {
    file: 'outline.svg',
    name: 'Outline',
    blurb: 'Stroke-only line art — every corner is an editable node.',
  },
  {
    file: 'aurora.svg',
    name: 'Aurora',
    blurb: 'A gradient app icon — edit the stops, keep the rounded frame.',
  },
  {
    file: 'nebula.svg',
    name: 'Nebula',
    blurb: 'Exported from a design tool — its layer folder survives the import.',
  },
]

const exampleUrl = (file: string) => `${import.meta.env.BASE_URL}examples/${file}`

export interface EditorExampleGridProps {
  onOpen: (doc: EditableDoc, name: string) => void
  /** Grid column classes; defaults to two columns. */
  className?: string
}

/** The example cards; clicking one opens it in the editor. */
export function EditorExampleGrid({ onOpen, className }: EditorExampleGridProps) {
  const [loadingFile, setLoadingFile] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pick = useCallback(
    async (ex: EditorExample) => {
      if (loadingFile) return
      setError(null)
      setLoadingFile(ex.file)
      try {
        const res = await fetch(exampleUrl(ex.file))
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const doc = parseSvg(await res.text(), { preserveGroups: true })
        if (!doc) throw new Error('unparseable')
        adoptIds(doc)
        // The intake unmounts on success (the studio takes over), so the busy
        // state only needs clearing on failure.
        onOpen(doc, ex.name.toLowerCase())
      } catch {
        setError('Could not open that example. Check your connection and try again.')
        setLoadingFile(null)
      }
    },
    [loadingFile, onOpen],
  )

  return (
    <div className="flex flex-col gap-3">
      <div className={`grid gap-3 ${className ?? 'sm:grid-cols-2'}`}>
        {EDITOR_EXAMPLES.map((ex) => (
          <ExampleCard
            key={ex.file}
            url={exampleUrl(ex.file)}
            file={ex.file}
            name={ex.name}
            blurb={ex.blurb}
            busy={loadingFile === ex.file}
            disabled={!!loadingFile}
            onClick={() => void pick(ex)}
          />
        ))}
      </div>
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  )
}
