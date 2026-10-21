import type { RankingRow } from '@/api/types'
import { formatX100 } from '@/lib/format'
import { ru } from '@/i18n/ru'

/** Pairwise events rank by comparisons: wins/ties/losses replace the per-criterion columns. */
export const hasRecord = (rows: Pick<RankingRow, 'wins'>[]) => rows.some((r) => r.wins !== undefined)

export const RECORD_COLUMNS = [
  { key: 'wins', label: ru.ranking.wins },
  { key: 'ties', label: ru.ranking.ties },
  { key: 'losses', label: ru.ranking.losses },
] as const

/** Board columns for a track group: pairwise record, else the criteria averages. */
export function boardColumns(
  rows: RankingRow[],
  criteria: { id: string; name: string }[],
): { key: string; label: string; value: (row: RankingRow) => string }[] {
  if (hasRecord(rows)) return RECORD_COLUMNS.map((c) => ({ key: c.key, label: c.label, value: (row) => String(row[c.key] ?? 0) }))
  if (criteria.length === 0 || !rows.some((r) => r.criteria.length > 0)) return []
  return criteria.map((c) => ({
    key: c.id,
    label: c.name,
    value: (row) => {
      const v = row.criteria.find((x) => x.criterion_id === c.id)?.avg_x100
      return v == null ? '—' : formatX100(v)
    },
  }))
}
