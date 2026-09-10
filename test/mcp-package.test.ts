// The published `logolab` npm package is a COMPILE of the app's own source tree —
// packages/mcp has no sources of its own, it points tsc at src/mcp/server.ts and
// takes whatever that reaches (see packages/mcp/tsconfig.build.json).
//
//   node --test test/mcp-package.test.ts
//
// That is what keeps the server and the app from drifting apart, and it is also
// the failure mode: the server's dependency list is decided by IMPORTS, in files
// nobody edits with npm in mind. Add `import { X } from 'some-package'` anywhere
// in src/lib/trace and the app keeps working, the checkout keeps working, the
// build keeps passing — and `npx -y logolab` breaks for everyone, at runtime,
// with ERR_MODULE_NOT_FOUND, because that package was a devDependency of the app
// and was never declared by the package that ships.
//
// So this walks the real import graph from the real entry point and asserts the
// two things a green typecheck cannot:
//
//   1. every external package the server can reach is DECLARED by packages/mcp
//   2. the versions it declares still match the app's, so a bump in one place
//      cannot leave the published server pinned to the other
//
// It reads the graph rather than a list, so it covers dynamic imports (the mono
// path's `await import('esm-potrace-wasm')`) and the lazy `createRequire(...)`
// that loads the optional sharp decoder — the two that a static import list
// would miss precisely because they are the ones that only fail in production.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(ROOT, 'src', 'mcp', 'server.ts')

const readJson = (p: string): Record<string, any> => JSON.parse(readFileSync(p, 'utf8'))
/** packages/mcp/tsconfig.build.json is JSONC — drop whole-line comments. */
const readJsonc = (p: string): Record<string, any> =>
  JSON.parse(
    readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n'),
  )

const appPkg = readJson(join(ROOT, 'package.json'))
const mcpPkg = readJson(join(ROOT, 'packages', 'mcp', 'package.json'))

/** Comments hold prose with quotes in it; strip them before matching specifiers. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/** Every module specifier in `src`, however it is written. */
function specifiers(src: string): string[] {
  const code = stripComments(src)
  const out: string[] = []
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g, // static import/export
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import()
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // createRequire(...)(…)
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(code))) out.push(m[1])
  }
  return out
}

/** Walk the graph from `entry`, collecting local files and external packages. */
function closure(entry: string): { files: Set<string>; external: Set<string> } {
  const files = new Set<string>()
  const external = new Set<string>()
  const queue = [entry]
  while (queue.length) {
    const file = queue.pop()!
    if (files.has(file)) continue
    files.add(file)
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('node:')) continue
      if (!spec.startsWith('.')) {
        // "@scope/name/deep/path.js" → "@scope/name"; "zod/v4" → "zod"
        const parts = spec.split('/')
        external.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0])
        continue
      }
      const base = resolve(dirname(file), spec)
      const hit = [base, `${base}.ts`, join(base, 'index.ts')].find((c) => existsSync(c) && c.endsWith('.ts'))
      if (hit) queue.push(hit)
    }
  }
  return { files, external }
}

test('the server graph reaches only packages the published one declares', () => {
  const { external } = closure(ENTRY)
  const declared = new Set([
    ...Object.keys(mcpPkg.dependencies ?? {}),
    ...Object.keys(mcpPkg.peerDependencies ?? {}),
  ])
  const undeclared = [...external].filter((p) => !declared.has(p)).sort()
  assert.deepEqual(
    undeclared,
    [],
    `src/mcp/server.ts reaches ${undeclared.join(', ')}, which packages/mcp/package.json does not ship. ` +
      `Either declare it there (and in the app's package.json), or keep it out of the server's import graph.`,
  )
})

test('every declared package is actually reachable — no dead weight in the tarball', () => {
  const { external } = closure(ENTRY)
  const unused = Object.keys(mcpPkg.dependencies ?? {})
    .filter((p) => !external.has(p))
    .sort()
  assert.deepEqual(unused, [], `packages/mcp declares ${unused.join(', ')}, which the server never imports.`)
})

test('the published versions match the app’s', () => {
  const appDeps: Record<string, string> = { ...appPkg.dependencies, ...appPkg.devDependencies }
  const mine: Record<string, string> = { ...mcpPkg.dependencies, ...mcpPkg.peerDependencies }
  for (const [name, range] of Object.entries(mine)) {
    assert.equal(
      range,
      appDeps[name],
      `${name} is "${range}" in packages/mcp but "${appDeps[name]}" in the app. ` +
        `The checkout runs the app's copy and the release runs this one — they have to be the same package.`,
    )
  }
})

test('bin points at what the build actually emits', () => {
  const tsconfig = readJsonc(join(ROOT, 'packages', 'mcp', 'tsconfig.build.json'))
  const { rootDir, outDir } = tsconfig.compilerOptions
  const pkgDir = join(ROOT, 'packages', 'mcp')
  // Where tsc will put the compiled entry, derived the way tsc derives it.
  const emitted = join(resolve(pkgDir, outDir), relative(resolve(pkgDir, rootDir), ENTRY)).replace(/\.ts$/, '.js')
  assert.equal(
    resolve(pkgDir, mcpPkg.bin.logolab),
    emitted,
    'packages/mcp "bin" does not name the file tsconfig.build.json emits for src/mcp/server.ts.',
  )
})

test('the tarball ships the build, and nothing else', () => {
  assert.deepEqual(mcpPkg.files, ['dist'])
  assert.equal(mcpPkg.type, 'module', 'the compiled output is ESM')
  // The app is private and must stay that way; only packages/mcp is published.
  assert.equal(appPkg.private, true)
  assert.notEqual(appPkg.name, mcpPkg.name, 'two workspace projects cannot share a name')
})
