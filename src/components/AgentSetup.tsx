import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bot, Check, Copy, ExternalLink, Terminal, X } from 'lucide-react'
import { Tooltip } from './ui/Tooltip'

/**
 * "Use LogoLab from your AI agent" — the install surface for the MCP server in
 * src/mcp.
 *
 * A web page cannot install anything on your machine, so this does the two
 * things it honestly can: it hands you the exact one-line command for your
 * client (already filled in with your checkout's path), and for Cursor it opens
 * the install deeplink, which IS one click. The server itself has a matching
 * `install` command that writes the config file — the commands below are that,
 * spelled out per client.
 */

/** Dev builds know where the checkout is; a hosted build cannot (see vite.config.ts). */
declare const __LOGOLAB_ROOT__: string
const BUILT_IN_ROOT = typeof __LOGOLAB_ROOT__ === 'string' ? __LOGOLAB_ROOT__ : ''
const ROOT_PLACEHOLDER = '/path/to/LogoLab'
const STORAGE_KEY = 'logolab.mcp.root'

const TOOLS: { name: string; blurb: string }[] = [
  { name: 'make_app_icons', blurb: 'image → traced SVG → a full icon set. The one call that does the job.' },
  { name: 'trace_icon', blurb: 'just the vectorization: a clean, editable SVG.' },
  { name: 'export_icons', blurb: 'an existing SVG/PNG → PWA, favicon, Tauri, Electron, Android, iOS or extension icons.' },
  { name: 'split_icon_sheet', blurb: 'a grid of icons on one canvas → one traced SVG per icon.' },
  { name: 'inspect_icon', blurb: 'what the tracer would decide, before it runs.' },
]

type Client = 'claude' | 'cursor' | 'vscode' | 'json'

const CLIENTS: { id: Client; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'vscode', label: 'VS Code' },
  { id: 'json', label: 'Other / JSON' },
]

/** Quote a path for a shell only when it needs it (Windows paths have spaces). */
const q = (p: string) => (/\s/.test(p) ? `"${p}"` : p)

function useCheckoutRoot(): [string, (v: string) => void] {
  const [root, setRoot] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || BUILT_IN_ROOT
    } catch {
      return BUILT_IN_ROOT
    }
  })
  const set = useCallback((v: string) => {
    setRoot(v)
    try {
      localStorage.setItem(STORAGE_KEY, v)
    } catch {
      /* private mode — the field still works for this session */
    }
  }, [])
  return [root, set]
}

/** Copy-to-clipboard button with a two-second confirmation. */
function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(false), 2000)
    return () => clearTimeout(t)
  }, [done])
  return (
    <button
      type="button"
      className="btn btn-secondary h-8 shrink-0 px-2.5 text-xs"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => setDone(true),
          () => setDone(false),
        )
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
      {done ? 'Copied' : label}
    </button>
  )
}

/** A shell command, wrapped so a long Windows path cannot widen the dialog. */
function Command({ children }: { children: string }) {
  return (
    <div className="flex items-start gap-2">
      <code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-surface-3 px-2.5 py-2 font-mono text-[0.7rem] leading-relaxed break-all text-ink-2">
        {children}
      </code>
      <CopyButton text={children} />
    </div>
  )
}

export function AgentSetupDialog({ onClose }: { onClose: () => void }) {
  const [root, setRoot] = useCheckoutRoot()
  const [client, setClient] = useState<Client>('claude')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const dir = root.trim() || ROOT_PLACEHOLDER
  const entry = `${dir.replace(/[\\/]+$/, '')}/src/mcp/server.ts`

  const config = useMemo(() => ({ command: 'node', args: [entry] }), [entry])
  const cursorLink = useMemo(() => {
    // cursor://anysphere.cursor-deeplink/mcp/install?name=…&config=<base64 JSON>
    const b64 = btoa(JSON.stringify(config))
    return `cursor://anysphere.cursor-deeplink/mcp/install?name=logolab&config=${encodeURIComponent(b64)}`
  }, [config])

  const known = root.trim().length > 0

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Use LogoLab from your AI agent"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-ink/40 backdrop-blur-sm dark:bg-black/55"
      />

      <div className="panel animate-in-fade relative z-10 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden">
        <div className="flex items-start justify-between border-b border-line p-5">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
              <Bot size={17} className="text-accent" />
              Use LogoLab from your AI agent
            </h2>
            <p className="mt-1 text-sm text-muted">
              LogoLab ships an MCP server: the same tracer and icon exporter, driven by your coding
              agent. “Trace <code className="font-mono text-xs">icon.png</code> and give me a PWA icon
              set” becomes one tool call — nothing is uploaded, it all runs here.
            </p>
          </div>
          <Tooltip label="Close">
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="btn btn-ghost -mr-1.5 -mt-1.5 h-8 w-8 shrink-0 px-0"
            >
              <X size={16} />
            </button>
          </Tooltip>
        </div>

        <div className="flex flex-col gap-5 overflow-y-auto p-5">
          {/* --------------------------------------------------------- tools */}
          <div>
            <span className="field-label">What your agent gets</span>
            <ul className="mt-2 space-y-1.5">
              {TOOLS.map((t) => (
                <li key={t.name} className="flex gap-2 text-xs text-muted">
                  <code className="shrink-0 font-mono text-[0.7rem] text-ink-2">{t.name}</code>
                  <span className="text-line">·</span>
                  <span className="min-w-0">{t.blurb}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* ------------------------------------------------------ checkout */}
          <div>
            <label className="field-label" htmlFor="mcp-root">
              Your LogoLab folder
            </label>
            <input
              id="mcp-root"
              value={root}
              onChange={(e) => setRoot(e.target.value)}
              placeholder={ROOT_PLACEHOLDER}
              spellCheck={false}
              className="mt-2 w-full rounded-md border border-line bg-surface px-3 py-2 font-mono text-xs text-ink outline-none focus:border-accent"
            />
            <p className="mt-1.5 text-[0.7rem] text-muted">
              {BUILT_IN_ROOT && root === BUILT_IN_ROOT
                ? 'Filled in from the dev server — this is the checkout you are running.'
                : 'Where you cloned LogoLab. Run pnpm install there once; the server needs Node 22+.'}
            </p>
          </div>

          {/* ------------------------------------------------------- clients */}
          <div>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {CLIENTS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setClient(c.id)}
                  className={`btn btn-secondary h-8 px-3 text-xs ${client === c.id ? 'is-active' : ''}`}
                >
                  {c.label}
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-3">
              {client === 'claude' && (
                <>
                  <p className="text-xs text-muted">Run this in the project you want the icons in:</p>
                  <Command>{`claude mcp add logolab -- node ${q(entry)}`}</Command>
                  <p className="text-xs text-muted">
                    Or let the server register itself — writes <code className="font-mono">.mcp.json</code>{' '}
                    in the current project (add <code className="font-mono">--scope user</code> for every
                    project):
                  </p>
                  <Command>{`node ${q(entry)} install`}</Command>
                </>
              )}

              {client === 'cursor' && (
                <>
                  <p className="text-xs text-muted">
                    One click — Cursor opens its install prompt with this server filled in:
                  </p>
                  <a
                    href={cursorLink}
                    className={`btn btn-primary h-9 w-full text-xs ${known ? '' : 'pointer-events-none opacity-50'}`}
                    aria-disabled={!known}
                  >
                    <ExternalLink size={14} />
                    Add to Cursor
                  </a>
                  {!known && (
                    <p className="text-[0.7rem] text-muted">Fill in your LogoLab folder above first.</p>
                  )}
                  <p className="text-xs text-muted">Or write the config file directly:</p>
                  <Command>{`node ${q(entry)} install --client cursor`}</Command>
                </>
              )}

              {client === 'vscode' && (
                <>
                  <p className="text-xs text-muted">With the VS Code CLI:</p>
                  <Command>{`code --add-mcp "${JSON.stringify({ name: 'logolab', ...config }).replace(/"/g, '\\"')}"`}</Command>
                  <p className="text-xs text-muted">
                    Or write <code className="font-mono">.vscode/mcp.json</code> for this project:
                  </p>
                  <Command>{`node ${q(entry)} install --client vscode`}</Command>
                </>
              )}

              {client === 'json' && (
                <>
                  <p className="text-xs text-muted">
                    Any MCP client — a stdio server, no ports and no network:
                  </p>
                  <Command>{JSON.stringify({ mcpServers: { logolab: config } }, null, 2)}</Command>
                </>
              )}
            </div>
          </div>

          <p className="text-[0.7rem] text-muted">
            Then ask your agent: <em>“trace icon.png and export a PWA icon set into public/”</em>.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** The button that opens it — used in the Export panel and the app menu. */
export function AgentSetupButton({
  variant = 'secondary',
  className = '',
  onOpened,
}: {
  variant?: 'secondary' | 'ghost'
  className?: string
  onOpened?: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true)
          onOpened?.()
        }}
        className={`btn btn-${variant} ${className}`}
      >
        <Terminal size={15} />
        Use from your AI agent
      </button>
      {open && <AgentSetupDialog onClose={() => setOpen(false)} />}
    </>
  )
}
