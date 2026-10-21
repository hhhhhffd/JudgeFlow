import { describe, expect, it } from 'vitest'
import type { PublicRankingRow } from '@/api/types'
import { boardScale, groupByRank, podiumSlots } from './lib'

const row = (team_id: string, rank: number | null): PublicRankingRow => ({
  rank,
  tie: false,
  team_id,
  team_name: team_id,
  score_x100: rank === null ? null : 1000 - rank,
  sheets: 1,
  meets_quorum: true,
  criteria: [],
  judges: [],
})

describe('groupByRank', () => {
  it('groups ties and skips unranked rows', () => {
    const groups = groupByRank([row('a', 1), row('b', 1), row('c', 3), row('d', null)])
    expect(groups.map((g) => [g.rank, g.rows.map((r) => r.team_id)])).toEqual([
      [1, ['a', 'b']],
      [3, ['c']],
    ])
  })
  it('orders by rank regardless of input order', () => {
    expect(groupByRank([row('c', 3), row('a', 1)]).map((g) => g.rank)).toEqual([1, 3])
  })
})

describe('podiumSlots', () => {
  it('caps at three places', () => {
    expect(podiumSlots(1)).toEqual([1])
    expect(podiumSlots(2)).toEqual([1, 2])
    expect(podiumSlots(10)).toEqual([1, 2, 3])
  })
})

describe('boardScale', () => {
  it('shrinks as rows grow', () => {
    expect(boardScale(3)).toBeGreaterThan(boardScale(8))
    expect(boardScale(8)).toBeGreaterThan(boardScale(20))
  })
})
