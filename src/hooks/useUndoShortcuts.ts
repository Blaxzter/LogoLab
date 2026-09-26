// Ctrl/Cmd+Z to undo, Ctrl/Cmd+Shift+Z or Ctrl+Y to redo, for the Cleanup canvas.

import { useEffect } from 'react'
import { isFormField } from '../lib/cleanup/cleanupOps'

/** Window-level undo/redo keys, live only while `ready` and never mid-AI. */
export function useUndoShortcuts(ready: boolean, aiBusy: boolean, handleUndo: () => void, handleRedo: () => void) {
  // Ctrl/Cmd+Z to undo, Ctrl/Cmd+Shift+Z or Ctrl+Y to redo (panel only).
  useEffect(() => {
    if (!ready) return
    const onKey = (e: KeyboardEvent) => {
      if (aiBusy || !(e.ctrlKey || e.metaKey)) return
      // Don't hijack the browser's native undo while the user is typing in a
      // text field (the always-mounted Sidebar has hex / brand-name inputs).
      if (isFormField(e.target)) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault()
        handleUndo()
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault()
        handleRedo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ready, aiBusy, handleUndo, handleRedo])
}
