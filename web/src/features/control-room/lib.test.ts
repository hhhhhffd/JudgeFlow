import { describe, expect, it } from 'vitest'
import type { Criterion, JudgeSummary, Matrix, Team } from '@/api/types'
import { assignmentPairs, cellState, computeKpis, formatAgo, judgeTotal, moveItem, parseNames, parseTeamsPaste, topTeamIds } from './lib'

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
      teams: [{ id: 't1', name: 'T1', track_id: null }, { id: 't2', name: 'T2', track_id: null }],
      cells: [
        { judge_id: 'a', team_id: 't1', scored: 2, total: 2, assigned: true, conflict: false },
        { judge_id: 'a', team_id: 't2', scored: 0, total: 2, assigned: true, conflict: false },
        { judge_id: 'b', team_id: 't2', scored: 2, total: 2, assigned: true, conflict: false },
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

describe('parseTeamsPaste with tracks', () => {
  const tracks = [{ id: 'w', name: 'Веб' }]
  it('matches the third column to a track case-insensitively and flags unknown ones', () => {
    expect(parseTeamsPaste('A\tdesc\tвЕБ\nB\t\tВеб\nC\t\tМобайл', tracks)).toEqual([
      { name: 'A', description: 'desc', track_id: 'w' },
      { name: 'B', track_id: 'w' },
      { name: 'C', unknown_track: 'Мобайл' },
    ])
  })
})

describe('assignments', () => {
  const team = (id: string, track_id: string | null): Team => ({ id, name: id, description: null, track_id, sort_order: 0 })
  const crit = (id: string, track_id: string | null): Criterion => ({ id, name: id, description: null, max_x100: 1000, step_x100: 100, weight: 1, track_id, sort_order: 0 })
  const teams = [team('t1', 'a'), team('t2', 'b')]
  const criteria = [crit('c1', null), crit('c2', 'a')]

  it('counts only criteria that apply and teams in the judge set', () => {
    expect(judgeTotal('j', teams, criteria, new Set(), new Set())).toBe(3)
    expect(judgeTotal('j', teams, criteria, new Set(['j:t2']), new Set())).toBe(1)
    expect(judgeTotal('j', teams, criteria, new Set(['j:t2']), new Set(['j:t2']))).toBe(0)
  })
  it('stores "everyone judges everything" as an empty list', () => {
    const judges = [{ id: 'j' }]
    expect(assignmentPairs(judges, teams, new Set(['j:t1', 'j:t2']))).toEqual([])
    expect(assignmentPairs(judges, teams, new Set(['j:t2']))).toEqual([{ judge_id: 'j', team_id: 't2' }])
  })
})

describe('topTeamIds', () => {
  const row = (team_id: string, rank: number | null) => ({ team_id, rank }) as Parameters<typeof topTeamIds>[0][number]
  it('takes the top n of every track group, ties included, unranked never', () => {
    const rows = [row('a1', 1), row('a2', 2), row('a3', 2), row('a4', 4), row('b1', 1), row('b2', 2), row('u', null)]
    expect(topTeamIds(rows, 2)).toEqual(['a1', 'a2', 'a3', 'b1', 'b2'])
    expect(topTeamIds(rows, 1)).toEqual(['a1', 'b1'])
  })
})

describe('pairwise monitoring', () => {
  it('treats a submitted pairwise sheet as complete without a total', () => {
    expect(cellState(judge({ submitted_at: 1 }), 4, 0, true)).toBe('submitted')
    expect(cellState(judge({ submitted_at: 1 }), 4, 0)).toBe('partial')
  })
})
