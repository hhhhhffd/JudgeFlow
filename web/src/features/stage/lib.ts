import type { PublicRankingRow } from '@/api/types'

export interface RankGroup {
  rank: number
  rows: PublicRankingRow[]
}

/** Ranked rows grouped by shared rank (ties), best place first. Unranked rows are dropped. */
export function groupByRank(rows: PublicRankingRow[]): RankGroup[] {
  const groups = new Map<number, PublicRankingRow[]>()
  for (const row of rows) {
    if (row.rank === null) continue
    const list = groups.get(row.rank)
    if (list) list.push(row)
    else groups.set(row.rank, [row])
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([rank, list]) => ({ rank, rows: list }))
}

/** Podium slots are the places 1..min(3, topN); a tied group sits in the slot of its rank (1,1,3 leaves slot 2 empty). */
export function podiumSlots(topN: number): number[] {
  return Array.from({ length: Math.min(3, topN) }, (_, i) => i + 1)
}

/** Font scale (rem) for a leaderboard of `count` rows, so long tables still fit a projector screen. */
export function boardScale(count: number): number {
  if (count <= 6) return 1
  if (count <= 9) return 0.82
  if (count <= 13) return 0.66
  return 0.52
}
