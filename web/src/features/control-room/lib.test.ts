import { describe, expect, it } from 'vitest'
import type { JudgeSummary, Matrix } from '@/api/types'
import { cellState, computeKpis, formatAgo, moveItem, parseNames, parseTeamsPaste } from './lib'

const judge = (o: Partial<JudgeSummary> = {}): JudgeSummary => ({
  id: 'j1', name: 'J', is_active: true, submitted_at: null, last_seen_at: null, pending_count: 0, scored_count: 0, ...o,
})

describe('parseTeamsPaste', () => {
  it('splits lines, tabs and skips blanks', () => {
    expect(parseTeamsPaste('Альфа\tПро бота\r\n\n  Бета  \nГамма\t\n')).toEqual([
      { name: 'Альфа', description: 'Про бота' },
      { name: 'Бета' },
      { name: 'Гамма' },
    ])
  })
})

describe('parseNames', () => {
  it('dedupes and trims', () => {
    expect(parseNames(' Анна\nАнна\n\nБорис ')).toEqual(['Анна', 'Борис'])
  })
})

describe('cellState', () => {
  it('maps judge/cell to colors', () => {
    expect(cellState(judge({ is_active: false }), 3, 3)).toBe('attention')
    expect(cellState(judge({ pending_count: 2 }), 3, 3)).toBe('attention')
    expect(cellState(judge({ submitted_at: 1 }), 3, 3)).toBe('submitted')
    expect(cellState(judge(), 3, 3)).toBe('partial')
    expect(cellState(judge(), 1, 3)).toBe('partial')
    expect(cellState(judge(), 0, 3)).toBe('empty')
  })
})

describe('computeKpis', () => {
  it('ignores inactive judges in coverage', () => {
    const m: Matrix = {
      judges: [judge({ id: 'a', submitted_at: 1 }), judge({ id: 'b', is_active: false })],
      teams: [{ id: 't1', name: 'T1' }, { id: 't2', name: 'T2' }],
      cells: [
        { judge_id: 'a', team_id: 't1', scored: 2, total: 2 },
        { judge_id: 'a', team_id: 't2', scored: 0, total: 2 },
        { judge_id: 'b', team_id: 't2', scored: 2, total: 2 },
      ],
    }
    expect(computeKpis(m)).toEqual({ teamsWithScores: 1, teamsTotal: 2, judgesSubmitted: 1, judgesActive: 1, attention: 1, coveragePct: 50 })
  })
})

describe('moveItem / formatAgo', () => {
  it('moves within range only', () => {
    expect(moveItem([1, 2, 3], 0, 1)).toEqual([2, 1, 3])
    const same = [1, 2]
    expect(moveItem(same, 0, -1)).toBe(same)
  })
  it('formats relative time', () => {
    expect(formatAgo(null, 0)).toBe('—')
    expect(formatAgo(0, 10_000)).toBe('только что')
    expect(formatAgo(0, 5 * 60_000)).toBe('5 мин назад')
    expect(formatAgo(0, 3 * 3_600_000)).toBe('3 ч назад')
  })
})
