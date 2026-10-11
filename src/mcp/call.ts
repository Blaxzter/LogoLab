// `logolab call <tool> …` — the MCP tools from a plain shell.
//
// An agent that reads a skill instead of talking MCP (or a person at a terminal)
// still gets the exact same tools: this connects a client to `createServer()` over
// the SDK's in-memory transport and makes a real `tools/call`. The schemas, the
// validation, the defaults and the reply text are the server's own — there is no
// second CLI surface to drift from it.
//
// Arguments, in whichever form survives the caller's shell:
//
//   logolab call trace_icon image=logo.png strokes=true     key=value pairs (value read as JSON if it parses)
//   logolab call trace_icon '{"image":"logo.png"}'          one JSON object
//   logolab call trace_icon @args.json                      a JSON file
//   logolab call trace_icon - < args.json                   JSON on stdin
//
// key=value is the one an agent should reach for: PowerShell and cmd mangle the
// quotes inside a JSON argument, and `a=b` has none.

import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { resolvePath } from './runtime.ts'

export interface CallResult {
  text: string
  isError: boolean
}

async function connect(createServer: () => McpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'logolab-cli', version: '0' })
  await createServer().server.connect(serverSide)
  await client.connect(clientSide)
  return client
}

/** Parse the argument forms above into the tool's input object. */
export function parseCallArgs(
  argv: string[],
  stdin: () => string = () => readFileSync(0, 'utf8'),
): Record<string, unknown> {
  if (argv.length === 0) return {}
  const [first] = argv
  const asObject = (text: string, from: string): Record<string, unknown> => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      throw new Error(`${from} is not valid JSON: ${(err as Error).message}`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${from} must be a JSON object`)
    return parsed as Record<string, unknown>
  }
  if (argv.length === 1 && first === '-') return asObject(stdin(), 'stdin')
  if (argv.length === 1 && first.startsWith('@')) {
    const file = resolvePath(first.slice(1))
    return asObject(readFileSync(file, 'utf8'), file)
  }
  if (argv.length === 1 && first.trimStart().startsWith('{')) return asObject(first, 'the argument')

  const out: Record<string, unknown> = {}
  for (const arg of argv) {
    const eq = arg.indexOf('=')
    if (eq <= 0) throw new Error(`expected key=value, got "${arg}"`)
    const key = arg.slice(0, eq)
    const raw = arg.slice(eq + 1)
    out[key] = readValue(raw)
  }
  return out
}

/**
 * A key=value value: JSON when it is JSON (`true`, `24`, `["pwa","favicon"]`,
 * `{"rows":3,"cols":4}`), otherwise the string as typed — so `image=logo.png`
 * needs no quotes. A comma list of words is an array, the one shape a shell
 * cannot write as JSON without quoting (`presets=pwa,favicon`).
 */
export function readValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    if (/^[\w-]+(,[\w-]+)+$/.test(raw)) return raw.split(',')
    const relaxed = relaxedJson(raw)
    return relaxed === undefined ? raw : relaxed
  }
}

/**
 * `{rows:3,cols:4}` / `[home,search]`: an object or array whose quotes a shell ate
 * (Windows PowerShell 5.1 strips `"` inside a native argument, bash does too
 * without single quotes). With no quote left in it, every bare token that is not a
 * number, true, false or null was a string.
 */
function relaxedJson(raw: string): unknown {
  const s = raw.trim()
  if (!/^[[{]/.test(s) || s.includes('"')) return undefined
  const quoted = s.replace(/[^{}[\],:\s]+/g, (tok) =>
    /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)$/.test(tok) ? tok : JSON.stringify(tok),
  )
  try {
    return JSON.parse(quoted)
  } catch {
    return undefined
  }
}

/** Run one tool and return its reply text. */
export async function callTool(
  createServer: () => McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  const client = await connect(createServer)
  try {
    const { tools } = await client.listTools()
    if (!tools.some((t) => t.name === name)) {
      return { text: `unknown tool "${name}". Tools: ${tools.map((t) => t.name).join(', ')}`, isError: true }
    }
    // The server's schemas strip keys they do not know, so a typo (`outdir=`) or an
    // option of another tool would be dropped without a word. Over MCP the client
    // reads the schema; from a shell this is the only place to say so.
    const known = Object.keys(tools.find((t) => t.name === name)?.inputSchema.properties ?? {})
    const unknown = Object.keys(args).filter((k) => !known.includes(k))
    if (unknown.length) {
      return {
        text: `${name} has no input ${unknown.map((k) => `"${k}"`).join(', ')}. Inputs: ${known.join(', ')} (logolab tools ${name})`,
        isError: true,
      }
    }
    const result = (await client.callTool({ name, arguments: args })) as {
      content?: { type: string; text?: string }[]
      isError?: boolean
    }
    const text = (result.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n')
    return { text, isError: result.isError === true }
  } finally {
    await client.close()
  }
}

/**
 * `logolab tools [name]`: every tool with its description, or one tool's inputs —
 * name, type, default and the server's own description of each — so the skill
 * never has to restate a schema that the server already owns.
 */
export async function describeTools(createServer: () => McpServer, name?: string): Promise<string> {
  const client = await connect(createServer)
  try {
    const { tools } = await client.listTools()
    if (!name) {
      return tools
        .map((t) => `${t.name}\n  ${t.description ?? ''}`)
        .concat('', 'Inputs of one tool: logolab tools <name>')
        .join('\n\n')
    }
    const tool = tools.find((t) => t.name === name)
    if (!tool) throw new Error(`unknown tool "${name}". Tools: ${tools.map((t) => t.name).join(', ')}`)
    const props = (tool.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>
    const required = new Set(tool.inputSchema.required ?? [])
    const lines = [`${tool.name} — ${tool.description ?? ''}`, '']
    for (const [key, schema] of Object.entries(props)) {
      const flags = [
        typeOf(schema),
        required.has(key) ? 'required' : null,
        'default' in schema ? `default ${JSON.stringify(schema.default)}` : null,
      ]
        .filter(Boolean)
        .join(', ')
      lines.push(`  ${key} (${flags})`)
      if (typeof schema.description === 'string') lines.push(`      ${schema.description}`)
    }
    return lines.join('\n')
  } finally {
    await client.close()
  }
}

/** A one-word reading of a JSON schema node, enough to write a key=value. */
function typeOf(schema: Record<string, unknown>): string {
  if (Array.isArray(schema.enum)) return schema.enum.map((v) => JSON.stringify(v)).join(' | ')
  if (Array.isArray(schema.anyOf)) return (schema.anyOf as Record<string, unknown>[]).map(typeOf).join(' | ')
  if (schema.type === 'array') {
    const items = schema.items as Record<string, unknown> | undefined
    return `${items ? typeOf(items) : 'any'}[]`
  }
  if (typeof schema.type === 'string') return schema.type
  if ('const' in schema) return JSON.stringify(schema.const)
  return 'any'
}
