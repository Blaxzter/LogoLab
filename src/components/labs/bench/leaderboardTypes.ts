// The shape bench/compare/leaderboard.ts writes into leaderboard.generated.ts. Declared by
// hand, as showcaseTypes.ts is, so the page type-checks against a contract and not against
// whatever literal was generated last.

import type { Leaderboard } from './benchData'

export interface LeaderboardFile {
  run: string
  date: string
  /** Per held-out corpus, the headline view and then the ablation view. */
  boards: Leaderboard[]
}
