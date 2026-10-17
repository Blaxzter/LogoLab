// Where the comparison keeps things. Everything heavy (binaries, venvs, weights, datasets,
// results) is under the gitignored .bench-tools/ at the repo root.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const TOOLS = join(REPO, '.bench-tools')
export const DATASETS = join(TOOLS, 'datasets')
export const RESULTS = join(TOOLS, 'results')
export const CACHE = join(TOOLS, 'compare-cache')
export const PY = join(REPO, 'bench', 'compare', 'py')
export const VENV_PY = join(
  TOOLS,
  'starvector-venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python',
)
