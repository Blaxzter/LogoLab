// `logolab install` — register this server with the agent you use.
//
// Every client stores the same three facts (a name, a command, its arguments) in
// a different file, so this writes the right shape into the right place and
// leaves everything else in that file untouched.
//
//   logolab install                     → .mcp.json here (Claude Code, project scope)
//   logolab install --client cursor     → .cursor/mcp.json
//   logolab install --client vscode     → .vscode/mcp.json
//   logolab install --scope user        → the client's user-level config
//   logolab install --client print      → print the JSON, change nothing
//
// The same file runs two ways, and the config it WRITES has to match the one it
// was RUN from, or the client would launch a copy the user never chose:
// from a checkout (`node src/mcp/server.ts`) it writes that path, and from the
// published package it writes `npx -y logolab`. See `launchSpec`.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureParent, projectRoot, resolvePath, runningFromSource } from './runtime.ts'

export type InstallClient = 'claude' | 'cursor' | 'vscode' | 'print'
export type InstallScope = 'project' | 'user'

export interface InstallOptions {
  client: InstallClient
  scope: InstallScope
  /** The project to install into (project scope). Defaults to the CWD. */
  dir: string
  /** Server name as the client will show it. */
  name: string
}

/** The package name on npm. `npx -y <this>` is the install everyone else uses. */
export const PACKAGE_NAME = 'logolab'

/** Absolute path to this server's entry point in a checkout (`''` when published). */
export function serverEntry(): string {
  return runningFromSource() ? join(projectRoot(), 'src', 'mcp', 'server.ts') : ''
}

/**
 * The stdio launch command every client config is a wrapper around.
 *
 * Published, that is `npx -y logolab`: no clone, no path, and the `-y` skips the
 * prompt npx would otherwise block on with no TTY to answer it.
 *
 * From a checkout it is the path to the entry point, so a contributor's client
 * runs their working tree instead of silently downloading the release. Plain
 * `node`, not `process.execPath`: a version manager moves the absolute path out
 * from under the config, and every client resolves `node` on PATH the way a
 * shell does.
 */
export function launchSpec(): { command: string; args: string[] } {
  return runningFromSource()
    ? { command: 'node', args: [serverEntry()] }
    : { command: 'npx', args: ['-y', PACKAGE_NAME] }
}

/** Claude Code / Cursor shape. */
function mcpServersEntry(name: string): Record<string, unknown> {
  const { command, args } = launchSpec()
  return { [name]: { command, args } }
}

/** VS Code shape (`servers`, and it wants the transport named). */
function vscodeEntry(name: string): Record<string, unknown> {
  const { command, args } = launchSpec()
  return { [name]: { type: 'stdio', command, args } }
}

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch (err) {
    throw new Error(`${file} is not valid JSON, so it was left alone: ${(err as Error).message}`)
  }
}

/** Merge one server into `key` of a JSON config, preserving everything else. */
function mergeInto(file: string, key: string, entry: Record<string, unknown>): { file: string; replaced: boolean } {
  const config = readJson(file)
  const bucket = (config[key] && typeof config[key] === 'object' ? config[key] : {}) as Record<string, unknown>
  const name = Object.keys(entry)[0]
  const replaced = name in bucket
  config[key] = { ...bucket, ...entry }
  writeFileSync(ensureParent(file), JSON.stringify(config, null, 2) + '\n')
  return { file, replaced }
}

/** Where each client keeps its config. */
export function configPath(client: InstallClient, scope: InstallScope, dir: string): string {
  const home = homedir()
  if (client === 'claude') return scope === 'user' ? join(home, '.claude.json') : join(dir, '.mcp.json')
  if (client === 'cursor') return scope === 'user' ? join(home, '.cursor', 'mcp.json') : join(dir, '.cursor', 'mcp.json')
  return scope === 'user' ? join(home, '.vscode', 'mcp.json') : join(dir, '.vscode', 'mcp.json')
}

export interface InstallResult {
  client: InstallClient
  file: string | null
  replaced: boolean
  /** What to tell the user afterwards. */
  message: string
}

/**
 * User-scope Claude Code lives in `~/.claude.json` — the CLI's own state file,
 * megabytes of it, possibly being written by a session RIGHT NOW. Rewriting that
 * from here would race with it, so ask the CLI to do its own bookkeeping and only
 * fall back to the file when there is no CLI to ask.
 */
function claudeCliAdd(name: string, command: string, args: string[]): boolean {
  const run = (bin: string) =>
    spawnSync(bin, ['mcp', 'add', '--scope', 'user', name, '--', command, ...args], {
      stdio: 'ignore',
      // `claude` is a .cmd shim on Windows, which needs the shell to resolve.
      shell: process.platform === 'win32',
    })
  for (const bin of ['claude']) {
    const result = run(bin)
    if (!result.error && result.status === 0) return true
  }
  return false
}

export function install(opts: InstallOptions): InstallResult {
  const { client, scope, name } = opts
  const dir = resolvePath(opts.dir)
  const { command, args } = launchSpec()

  if (client === 'print') {
    const snippet = JSON.stringify({ mcpServers: mcpServersEntry(name) }, null, 2)
    return {
      client,
      file: null,
      replaced: false,
      message: [
        'Nothing was written. Add this to your client config:',
        '',
        snippet,
        '',
        'Claude Code:  ' + `claude mcp add ${name} -- ${command} ${args.join(' ')}`,
        'VS Code:      ' + `code --add-mcp "${JSON.stringify({ name, command, args }).replace(/"/g, '\\"')}"`,
      ].join('\n'),
    }
  }

  if (client === 'claude' && scope === 'user' && claudeCliAdd(name, command, args)) {
    return {
      client,
      file: null,
      replaced: false,
      message: `Added "${name}" for every project via \`claude mcp add --scope user\`. Restart Claude Code.`,
    }
  }

  const file = configPath(client, scope, dir)
  const key = client === 'vscode' ? 'servers' : 'mcpServers'
  const entry = client === 'vscode' ? vscodeEntry(name) : mcpServersEntry(name)
  const result = mergeInto(file, key, entry)

  const restart =
    client === 'claude'
      ? scope === 'project'
        ? 'Restart Claude Code in this directory; it will ask you to approve the project server once.'
        : 'Restart Claude Code — the server is now on for every project.'
      : client === 'cursor'
        ? 'Reload Cursor (or toggle the server in Settings → MCP).'
        : 'Reload VS Code; the server appears under MCP servers.'

  return {
    client,
    file: result.file,
    replaced: result.replaced,
    message: `${result.replaced ? 'Updated' : 'Added'} "${name}" in ${result.file}. ${restart}`,
  }
}

/** Parse `install` CLI flags. */
export function parseInstallArgs(argv: string[]): InstallOptions {
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const client = (flag('client') ?? 'claude') as InstallClient
  if (!['claude', 'cursor', 'vscode', 'print'].includes(client)) {
    throw new Error(`--client must be claude, cursor, vscode or print (got "${client}")`)
  }
  const scope = (flag('scope') ?? 'project') as InstallScope
  if (!['project', 'user'].includes(scope)) throw new Error(`--scope must be project or user (got "${scope}")`)
  return { client, scope, dir: flag('dir') ?? process.cwd(), name: flag('name') ?? 'logolab' }
}

/**
 * True when this module was run directly, not imported.
 *
 * Both sides are resolved through `realpath` because an npm `bin` is a SYMLINK
 * (`node_modules/.bin/logolab` → `../logolab/dist/mcp/server.js`): argv[1] is the
 * link, `import.meta.url` is the target ESM already resolved, and comparing them
 * raw makes an npx-launched server decide it was imported and exit without ever
 * serving.
 */
export function isMain(url: string): boolean {
  const invoked = process.argv[1]
  if (invoked == null) return false
  const real = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  return real(fileURLToPath(url)) === real(resolvePath(invoked))
}
