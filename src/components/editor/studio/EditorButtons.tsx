// The studio's small button primitives: tool pills, icon bar buttons and text mini-buttons.

import { ActionButton, isOff } from '../../ui/ActionButton'
import { toolDef, type EditorTool } from '../tools'
import { TOOL_ICON } from '../toolIcons'

/** One segmented group of tool buttons. */
export function ToolPill({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-0.5 rounded-lg bg-surface-3 p-0.5">{children}</div>
}

export function ToolBtn({ id, tool, onPick }: { id: EditorTool; tool: EditorTool; onPick: (t: EditorTool) => void }) {
  const def = toolDef(id)
  return (
    <ActionButton
      label={`${def.label} (${def.key.toUpperCase()})`}
      note={def.hint}
      ariaLabel={def.label}
      pressed={tool === id}
      onClick={() => onPick(id)}
      className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
        tool === id ? 'bg-surface text-accent shadow-xs' : 'text-ink-2 hover:text-ink'
      }`}
    >
      {TOOL_ICON[id]}
    </ActionButton>
  )
}

export function Divider() {
  return <span className="mx-1 h-6 w-px shrink-0 bg-line" />
}

export function BarBtn({
  label,
  note,
  onClick,
  reason,
  active,
  children,
}: {
  label: string
  note?: string
  onClick: () => void
  reason?: string | null
  active?: boolean
  children: React.ReactNode
}) {
  // No hover styling when disabled: a greyed control that lights up still reads
  // as pressable. It stays hoverable only for its tooltip.
  const off = isOff(reason)
  return (
    <ActionButton
      label={label}
      note={note}
      reason={reason}
      onClick={onClick}
      pressed={active}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors ${
        off
          ? 'cursor-not-allowed text-ink-2 opacity-35'
          : active
            ? 'bg-accent-soft text-accent'
            : 'text-ink-2 hover:bg-surface-3 hover:text-ink'
      }`}
    >
      {children}
    </ActionButton>
  )
}

export function MiniBtn({
  label,
  note,
  onClick,
  reason,
}: {
  label: string
  note?: string
  onClick: () => void
  reason?: string | null
}) {
  // `.btn` handles its own disabled styling via `aria-disabled` (index.css).
  return (
    <ActionButton
      label={label}
      note={note}
      reason={reason}
      onClick={onClick}
      className="btn btn-secondary h-7 px-1.5 text-[0.68rem]"
    >
      {label}
    </ActionButton>
  )
}
