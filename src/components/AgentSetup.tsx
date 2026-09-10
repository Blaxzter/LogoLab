import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bot, Check, Copy, ExternalLink, Terminal, X } from 'lucide-react'
import { Tooltip } from './ui/Tooltip'

/**
 * "Use LogoLab from your AI agent" — the install surface for the MCP server,
 * published to npm as `logolab` (source in src/mcp, packaged by packages/mcp).
 *
 * A web page cannot install anything on your machine, so this does the two
 * things it honestly can: it hands you the exact one-line command for your
 * client, and for Cursor it opens the install deeplink, which IS one click.
 *
 * Every command here is the SAME for every visitor — `npx -y logolab` needs no
 * clone and no path, which is why this dialog has no "where did you put it?"
 * field any more. The one exception is at the bottom: a dev server knows it is
 * a checkout, and offers to point the client at that working tree instead of
 * the release.
 */

const PACKAGE = 'logolab'
/** The stdio launch every client config wraps. Mirrors `launchSpec` in src/mcp/install.ts. */
const LAUNCH = { command: 'npx', args: ['-y', PACKAGE] }

/** Dev builds know where the checkout is; a hosted build cannot (see vite.config.ts). */
declare const __LOGOLAB_ROOT__: string
const BUILT_IN_ROOT = typeof __LOGOLAB_ROOT__ === 'string' ? __LOGOLAB_ROOT__ : ''

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
  const [client, setClient] = useState<Client>('claude')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const cursorLink = useMemo(() => {
    // cursor://anysphere.cursor-deeplink/mcp/install?name=…&config=<base64 JSON>
    const b64 = btoa(JSON.stringify(LAUNCH))
    return `cursor://anysphere.cursor-deeplink/mcp/install?name=${PACKAGE}&config=${encodeURIComponent(b64)}`
  }, [])

  /** A checkout can run its OWN tree instead of the published release. */
  const checkoutCmd = BUILT_IN_ROOT
    ? `claude mcp add ${PACKAGE} -- node ${q(`${BUILT_IN_ROOT.replace(/[\\/]+$/, '')}/src/mcp/server.ts`)}`
    : ''

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
                  <Command>{`claude mcp add ${PACKAGE} -- npx -y ${PACKAGE}`}</Command>
                  <p className="text-xs text-muted">
                    Or let the server register itself — writes <code className="font-mono">.mcp.json</code>{' '}
                    in the current project (add <code className="font-mono">--scope user</code> for every
                    project):
                  </p>
                  <Command>{`npx -y ${PACKAGE} install`}</Command>
                </>
              )}

              {client === 'cursor' && (
                <>
                  <p className="text-xs text-muted">
                    One click — Cursor opens its install prompt with this server filled in:
                  </p>
                  <a href={cursorLink} className="btn btn-primary h-9 w-full text-xs">
                    <ExternalLink size={14} />
                    Add to Cursor
                  </a>
                  <p className="text-xs text-muted">Or write the config file directly:</p>
                  <Command>{`npx -y ${PACKAGE} install --client cursor`}</Command>
                </>
              )}

              {client === 'vscode' && (
                <>
                  <p className="text-xs text-muted">With the VS Code CLI:</p>
                  <Command>{`code --add-mcp "${JSON.stringify({ name: PACKAGE, ...LAUNCH }).replace(/"/g, '\\"')}"`}</Command>
                  <p className="text-xs text-muted">
                    Or write <code className="font-mono">.vscode/mcp.json</code> for this project:
                  </p>
                  <Command>{`npx -y ${PACKAGE} install --client vscode`}</Command>
                </>
              )}

              {client === 'json' && (
                <>
                  <p className="text-xs text-muted">
                    Any MCP client — a stdio server, no ports and no network:
                  </p>
                  <Command>{JSON.stringify({ mcpServers: { [PACKAGE]: LAUNCH } }, null, 2)}</Command>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2 text-[0.7rem] text-muted">
            <p>
              Then ask your agent: <em>“trace icon.png and export a PWA icon set into public/”</em>.
            </p>
            <p>
              Needs Node 22+. The server runs on your machine and reads and writes your files
              directly — nothing is uploaded.
            </p>
          </div>

          {/* Only a dev server can offer this: it IS a checkout, and a contributor
              wants their client running that tree rather than the npm release. */}
          {checkoutCmd && (
            <div className="border-t border-line pt-4">
              <p className="text-xs text-muted">
                You are running LogoLab from a checkout. To point your client at{' '}
                <em>this working tree</em> instead of the published package:
              </p>
              <div className="mt-2">
                <Command>{checkoutCmd}</Command>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

const AGENT_LABEL = 'Use from your AI agent'

/**
 * The button that opens it.
 *
 * Three shapes for three homes: `icon` in the desktop header (its own affordance,
 * always reachable), `ghost` as a row in the mobile menu, `secondary` as the wide
 * button in the Export panel.
 *
 * The header is the one that matters. This used to live ONLY in the Export panel,
 * which meant a desktop user had to load a logo and open the right tab to find
 * out the MCP server exists — hidden behind the browser workflow it is the
 * alternative to. It is reachable now with no logo and on every tab.
 */
export function AgentSetupButton({
  variant = 'secondary',
  className = '',
  onOpened,
}: {
  variant?: 'secondary' | 'ghost' | 'icon'
  className?: string
  onOpened?: () => void
}) {
  const [open, setOpen] = useState(false)
  const openIt = () => {
    setOpen(true)
    onOpened?.()
  }

  if (variant === 'icon') {
    return (
      <>
        <Tooltip label={AGENT_LABEL}>
          <button
            type="button"
            onClick={openIt}
            aria-label={AGENT_LABEL}
            className={`flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink ${className}`}
          >
            <Terminal size={18} />
          </button>
        </Tooltip>
        {open && <AgentSetupDialog onClose={() => setOpen(false)} />}
      </>
    )
  }

  return (
    <>
      <button type="button" onClick={openIt} className={`btn btn-${variant} ${className}`}>
        <Terminal size={15} />
        {AGENT_LABEL}
      </button>
      {open && <AgentSetupDialog onClose={() => setOpen(false)} />}
    </>
  )
}
