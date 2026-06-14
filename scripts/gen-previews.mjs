// Best-effort wrapper around the control-preview generator, used by `npm run
// build`. The generator imports .ts directly, which needs a Node new enough to
// strip types (>=22.18 / 23.6). On such a Node it regenerates the previews so
// they can't drift from the engine; on anything older it warns and the build
// proceeds with the committed (deterministic) copy. Plain .mjs so it runs on any
// Node, and a single child process so it never trips cross-shell `&&`/`||` quirks.

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const generator = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'devtest', 'genControlPreviews.ts')
const { status } = spawnSync(process.execPath, [generator], { stdio: 'inherit' })

if (status !== 0) {
  console.warn('[previews] generation skipped (Node too old to strip types?) — keeping the committed copy.')
}
process.exit(0) // never fail the build over previews
