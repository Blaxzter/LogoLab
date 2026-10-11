// The agent SKILL and the `logolab call` CLI it drives.
//
//   node --test test/mcp-skill.test.ts
//
// The skill is prose an agent follows literally, so what it guards is that the
// prose stays TRUE: every command it shows names a real tool and real inputs, the
// copy the Claude Code plugin ships is the string the package installs, and the
// argument forms it promises (key=value, comma lists, quoted objects, a JSON file)
// parse the way it says. A rename in the server that the skill does not follow
// fails here instead of in someone's agent.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../src/mcp/server.ts'
import { callTool, describeTools, parseCallArgs, readValue } from '../src/mcp/call.ts'
import { install, parseInstallArgs, skillPath } from '../src/mcp/install.ts'
import { SKILL_CLI, SKILL_MD } from '../src/mcp/skill.ts'

const PLUGIN_SKILL = 'plugins/logolab/skills/logolab/SKILL.md'

test('the plugin ships the same SKILL.md the package installs', () => {
  const shipped = readFileSync(PLUGIN_SKILL, 'utf8').replace(/\r\n/g, '\n')
  assert.equal(
    shipped,
    SKILL_MD,
    `${PLUGIN_SKILL} is stale — node --experimental-strip-types src/mcp/server.ts skill > ${PLUGIN_SKILL}`,
  )
})

test('frontmatter follows the Agent Skills format', () => {
  const m = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(SKILL_MD)
  assert.ok(m, 'name + description frontmatter')
  const [, name, description] = m
  assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/)
  assert.ok(name.length <= 64)
  assert.equal(name, 'logolab', 'the name matches its folder')
  assert.ok(description.length <= 1024, `description is ${description.length} chars`)
})

test('the marketplace lists the plugin, and the plugin is where it says', () => {
  const market = JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf8'))
  const entry = market.plugins.find((p: { name: string }) => p.name === 'logolab')
  assert.ok(entry, 'logolab is in the marketplace')
  const manifest = JSON.parse(readFileSync(join(entry.source, '.claude-plugin/plugin.json'), 'utf8'))
  assert.equal(manifest.name, entry.name)
  assert.ok(existsSync(join(entry.source, 'skills/logolab/SKILL.md')))
})

test('every command the skill shows names a real tool and real inputs', async () => {
  const lines = SKILL_MD.split('\n').filter((l) => l.startsWith(`${SKILL_CLI} call `) && !l.includes('<tool>'))
  assert.ok(lines.length >= 4, 'the skill shows its common calls')
  for (const line of lines) {
    const rest = line.slice(`${SKILL_CLI} call `.length)
    const tool = rest.split(' ')[0]
    const help = await describeTools(createServer, tool) // throws on an unknown tool
    // key=value pairs, a single-quoted pair counting as one.
    const keys = [...rest.matchAll(/(?:^|\s)'?([A-Za-z]+)=/g)].map((k) => k[1])
    assert.ok(keys.length > 0, line)
    for (const key of keys) assert.match(help, new RegExp(`^  ${key} \\(`, 'm'), `${tool} has an input "${key}"`)
  }
  // And the tools the table recommends exist.
  for (const tool of SKILL_MD.matchAll(/^\| .+ \| `(\w+)` \|$/gm)) await describeTools(createServer, tool[1])
})

test('key=value: JSON when it parses, a string otherwise, a comma list as an array', () => {
  assert.deepEqual(
    parseCallArgs([
      'image=icon.png',
      'strokes=true',
      'normalize=24',
      'presets=pwa,favicon',
      'appName=My App',
      'grid={"rows":3,"cols":4}',
      'ink=#000000',
      'out=a=b.svg',
    ]),
    {
      image: 'icon.png',
      strokes: true,
      normalize: 24,
      presets: ['pwa', 'favicon'],
      appName: 'My App',
      grid: { rows: 3, cols: 4 },
      ink: '#000000',
      out: 'a=b.svg',
    },
  )
  assert.throws(() => parseCallArgs(['icon.png']), /key=value/)
})

test('an object or array whose quotes a shell ate still reads as one', () => {
  // Windows PowerShell 5.1 strips `"` inside a native argument.
  assert.deepEqual(readValue('{rows:3,cols:4}'), { rows: 3, cols: 4 })
  assert.deepEqual(readValue('[home,search]'), ['home', 'search'])
  assert.deepEqual(readValue('{background:#ffffff,padding:0.1}'), { background: '#ffffff', padding: 0.1 })
  assert.equal(readValue('{not json'), '{not json')
})

test('a JSON object, a JSON file, or JSON on stdin', () => {
  assert.deepEqual(parseCallArgs(['{"image":"a.png","strokes":true}']), { image: 'a.png', strokes: true })
  const dir = mkdtempSync(join(tmpdir(), 'logolab-call-'))
  const file = join(dir, 'args.json')
  writeFileSync(file, '{"image":"b.png"}')
  assert.deepEqual(parseCallArgs([`@${file}`]), { image: 'b.png' })
  assert.deepEqual(
    parseCallArgs(['-'], () => '{"image":"c.png"}'),
    { image: 'c.png' },
  )
  assert.throws(() => parseCallArgs(['-'], () => '[1]'), /JSON object/)
})

test('call runs the real tool, and refuses an input the tool does not have', async () => {
  const ok = await callTool(createServer, 'inspect_icon', { image: 'public/examples/petals.png' })
  assert.equal(ok.isError, false, ok.text)
  assert.match(ok.text, /The tracer would go/)

  // The schema would strip it silently; from a shell nobody would notice.
  const typo = await callTool(createServer, 'inspect_icon', { image: 'public/examples/petals.png', outdir: 'x' })
  assert.equal(typo.isError, true)
  assert.match(typo.text, /no input "outdir"/)

  const missing = await callTool(createServer, 'no_such_tool', {})
  assert.equal(missing.isError, true)
  assert.match(missing.text, /unknown tool/)

  const bad = await callTool(createServer, 'trace_icon', { image: 'does-not-exist.png' })
  assert.equal(bad.isError, true)
})

test('install --skill writes SKILL.md, into .claude/skills or any skills folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logolab-skill-'))
  const project = install(parseInstallArgs(['--skill', '--dir', dir]))
  assert.equal(project.file, join(dir, '.claude', 'skills', 'logolab', 'SKILL.md'))
  assert.equal(readFileSync(project.file!, 'utf8'), SKILL_MD)
  assert.equal(project.replaced, false)
  assert.equal(install(parseInstallArgs(['--skill', '--dir', dir])).replaced, true)
  // No MCP config was touched.
  assert.ok(!existsSync(join(dir, '.mcp.json')))

  const other = join(dir, 'agent-skills')
  const custom = install(parseInstallArgs(['--skills-dir', other]))
  assert.equal(custom.file, join(other, 'logolab', 'SKILL.md'))
  assert.equal(skillPath('user', dir).endsWith(join('.claude', 'skills', 'logolab', 'SKILL.md')), true)
})
