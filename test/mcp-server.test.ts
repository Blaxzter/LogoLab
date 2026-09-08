// The MCP surface itself: does a client see the tools, and do they run?
//
//   node --test test/mcp-server.test.ts
//
// Wired over the SDK's in-memory transport pair, so this is the real protocol
// (initialize, tools/list, tools/call) without spawning a process. What it
// guards is the contract an agent depends on: the tool names, that every tool
// declares its inputs, and that a call comes back with a readable summary AND
// the machine-readable JSON block the descriptions promise.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../src/mcp/server.ts'
import { configPath, launchSpec, parseInstallArgs } from '../src/mcp/install.ts'

const EXAMPLE = 'public/examples/petals.png'

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createServer()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await server.server.connect(serverTransport)
  await client.connect(clientTransport)
  return client
}

/** The text block of a tool result. */
function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? []
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n')
}

/** The ```json block every tool appends. */
function jsonOf(result: unknown): Record<string, unknown> {
  const match = /```json\n([\s\S]*?)\n```/.exec(textOf(result))
  assert.ok(match, 'the result carries a JSON block')
  return JSON.parse(match[1]) as Record<string, unknown>
}

test('a client sees every tool, each with an input schema', async () => {
  const client = await connect()
  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name).sort()

  assert.deepEqual(names, ['export_icons', 'inspect_icon', 'make_app_icons', 'split_icon_sheet', 'trace_icon'])
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 40, `${tool.name} explains itself`)
    assert.equal(tool.inputSchema.type, 'object')
    assert.ok(Object.keys(tool.inputSchema.properties ?? {}).length > 0, `${tool.name} declares inputs`)
  }
  // The one an agent should reach for first names the whole job.
  const oneShot = tools.find((t) => t.name === 'make_app_icons')
  assert.match(oneShot?.description ?? '', /trace/i)
  assert.match(oneShot?.description ?? '', /pwa|tauri|android/i)
})

test('inspect_icon reports the source and the plan without tracing', async () => {
  const client = await connect()
  const result = await client.callTool({ name: 'inspect_icon', arguments: { image: EXAMPLE } })
  assert.ok(!(result as { isError?: boolean }).isError, textOf(result))

  const data = jsonOf(result) as { source: Record<string, unknown>; plan: Record<string, unknown> }
  assert.equal(data.source.width, 512)
  assert.equal(data.source.height, 512)
  assert.equal(data.source.kind, 'raster')
  assert.ok(['color', 'mono'].includes(data.plan.mode as string))
  assert.equal(typeof data.plan.summary, 'string')
})

test('make_app_icons traces and writes a collection', async () => {
  const client = await connect()
  const out = mkdtempSync(join(tmpdir(), 'logolab-tool-'))
  const result = await client.callTool({
    name: 'make_app_icons',
    arguments: { image: EXAMPLE, outDir: out, presets: ['favicon'], appName: 'Petals' },
  })
  assert.ok(!(result as { isError?: boolean }).isError, textOf(result))

  const data = jsonOf(result) as {
    trace: { stats: { paths: number; nodes: number } }
    export: { files: { path: string }[] }
  }
  assert.ok(data.trace.stats.paths > 0, 'it traced something')
  assert.ok(data.trace.stats.nodes > 0)
  assert.ok(existsSync(join(out, 'public/favicon.ico')), 'the .ico landed')
  assert.ok(existsSync(join(out, 'public/icons/favicon-32.png')))
  assert.ok(data.export.files.some((f) => f.path === 'head-snippet.html'))
})

test('a missing file fails as an error the agent can read, not a crash', async () => {
  const client = await connect()
  const result = await client.callTool({ name: 'trace_icon', arguments: { image: 'nope/not-here.png' } })
  assert.equal((result as { isError?: boolean }).isError, true)
  assert.match(textOf(result), /No such image/)
})

test('install writes the config shape each client reads', () => {
  const { command, args } = launchSpec()
  assert.equal(command, 'node')
  assert.match(args[0], /src[\\/]mcp[\\/]server\.ts$/)

  const opts = parseInstallArgs(['--client', 'cursor', '--dir', '/tmp/project'])
  assert.equal(opts.client, 'cursor')
  assert.equal(opts.scope, 'project')
  assert.match(configPath('claude', 'project', '/tmp/project'), /\.mcp\.json$/)
  assert.match(configPath('cursor', 'project', '/tmp/project'), /\.cursor[\\/]mcp\.json$/)
  assert.match(configPath('vscode', 'project', '/tmp/project'), /\.vscode[\\/]mcp\.json$/)
  assert.throws(() => parseInstallArgs(['--client', 'emacs']), /must be claude, cursor, vscode or print/)
})
