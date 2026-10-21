import { createContext, useContext, useEffect, useState } from 'react'
import type { PublicRankingRow, StageResponse } from '@/api/types'
import { stageText } from '@/i18n/stage'
import { formatX100 } from '@/lib/format'
import { boardColumns } from '@/lib/ranking'
import { cn } from '@/lib/utils'
import { boardScale, groupByRank, podiumSlots, type RankGroup } from './lib'

/**
 * Ids of items already on screen. Items that mount while their id is absent play the reveal animation;
 * the set is seeded with what was visible on first load so a reload never replays the ceremony.
 */
export const SeenContext = createContext<Set<string>>(new Set())

function useFresh(id: string): boolean {
  const seen = useContext(SeenContext)
  const [fresh] = useState(() => !seen.has(id))
  useEffect(() => {
    seen.add(id)
    return () => void seen.delete(id)
  }, [seen, id])
  return fresh
}

function TieMark({ row }: { row: PublicRankingRow }) {
  if (!row.tie) return null
  return <span className="mt-2 inline-block rounded-full border border-border px-3 py-0.5 text-[0.95rem] text-muted-foreground">{stageText.tie}</span>
}

// ---------- waiting / unavailable ----------

export function Hero({ title, text, eyebrow }: { title: string; text: string; eyebrow?: string }) {
  return (
    <section className="m-auto flex max-w-[70rem] flex-col items-center gap-5 text-center">
      {eyebrow && <p className="text-[1.5rem] font-semibold tracking-[0.28em] text-signal uppercase">{eyebrow}</p>}
      <h1 className="text-[clamp(2.6rem,7.5vw,6.5rem)] leading-[1.02] font-extrabold tracking-tight text-balance">{title}</h1>
      <div aria-hidden className="stage-ticks h-2 w-48 text-signal" />
      <p className="max-w-[40rem] text-[1.5rem] leading-snug text-muted-foreground text-pretty">{text}</p>
    </section>
  )
}

// ---------- podium ----------

function SlotContent({ place, group, first }: { place: number; group: RankGroup; first: boolean }) {
  const fresh = useFresh(group.rows[0]!.team_id)
  return (
    <>
      {first && (
        <div
          aria-hidden
          className={cn('pointer-events-none absolute -inset-x-[25%] -top-[45%] -bottom-4 -z-10 opacity-55', fresh && 'stage-glow')}
          style={{ background: 'radial-gradient(closest-side, oklch(0.82 0.15 82 / 0.38), transparent)' }}
        />
      )}
      <div className={cn('flex min-w-0 flex-1 flex-col gap-3 wide:flex-none', fresh && 'stage-fresh')}>
        {group.rows.map((row) => (
          <div
            key={row.team_id}
            className={cn(
              'rounded-2xl border bg-card/90 px-6 py-5 backdrop-blur-sm wide:text-center',
              first ? 'border-signal/70 shadow-[0_0_3rem_-0.5rem_oklch(0.82_0.15_82/0.5)]' : 'border-border',
            )}
          >
            <p className={cn('leading-[1.05] font-bold text-balance break-words', first ? 'text-[clamp(2rem,3.4vw,3.6rem)]' : 'text-[clamp(1.7rem,2.8vw,3rem)]')}>{row.team_name}</p>
            <p className={cn('num mt-2 leading-none font-extrabold', first ? 'text-[clamp(2.4rem,4.2vw,4.4rem)] text-signal' : 'text-[clamp(2rem,3.4vw,3.6rem)]')}>
              {row.score_x100 === null ? stageText.noScore : formatX100(row.score_x100)}
            </p>
            <TieMark row={row} />
          </div>
        ))}
      </div>
      <div
        aria-hidden
        className={cn(
          'stage-plinth relative hidden shrink-0 items-center justify-center overflow-hidden rounded-t-2xl border border-b-0 wide:flex',
          first ? 'border-signal/70 bg-gradient-to-b from-signal/45 to-signal/10' : 'border-border bg-gradient-to-b from-card to-card/30',
          fresh && 'stage-plinth-fresh',
        )}
      >
        <div className={cn('stage-ticks absolute inset-x-0 top-0 h-2', first ? 'text-signal' : 'text-foreground/60')} />
        <span className={cn('stage-numeral num leading-none font-extrabold', first ? 'text-signal' : 'text-foreground/35')}>{place}</span>
      </div>
      <span aria-hidden className={cn('num order-first w-[3.2rem] shrink-0 self-center text-center text-[3.4rem] leading-none font-extrabold wide:hidden', first ? 'text-signal' : 'text-foreground/40')}>
        {place}
      </span>
    </>
  )
}

function GhostSlot({ place }: { place: number }) {
  return (
    <>
      <div
        aria-hidden
        className="stage-plinth hidden shrink-0 items-center justify-center rounded-t-2xl border border-b-0 border-dashed border-border/70 wide:flex"
      >
        <span className="stage-numeral num leading-none font-extrabold text-foreground/10">{place}</span>
      </div>
      <div aria-hidden className="flex items-center gap-4 rounded-2xl border border-dashed border-border/70 px-4 py-3 wide:hidden">
        <span className="num w-[3.2rem] text-center text-[3.4rem] leading-none font-extrabold text-foreground/15">{place}</span>
      </div>
    </>
  )
}

export function Podium({ data, teamsLabel }: { data: StageResponse; teamsLabel: string }) {
  const { stage, rows } = data
  const groups = groupByRank(rows.filter((r) => r.rank !== null && r.rank <= stage.top_n))
  const slots = podiumSlots(stage.top_n)
  // Places below the third (top N > 3) are listed under the podium.
  const lower = groups.filter((g) => g.rank > 3)
  return (
    <div className="-mb-[max(4vmin,1rem)] flex flex-1 flex-col justify-end gap-[3vmin]">
      <ol aria-label={teamsLabel} className="stage-podium">
        {slots.map((place) => {
          const group = groups.find((g) => Math.min(g.rank, 3) === place)
          return (
            <li key={place} className={cn('relative isolate flex items-stretch gap-4 wide:flex-col wide:items-stretch wide:gap-0', `stage-slot-${place}`)}>
              {group ? <SlotContent place={place} group={group} first={place === 1} /> : <GhostSlot place={place} />}
            </li>
          )
        })}
      </ol>
      {lower.length > 0 && (
        <ol className="grid gap-2">
          {lower.flatMap((g) => g.rows).map((row) => (
            <LowerRow key={row.team_id} row={row} />
          ))}
        </ol>
      )}
    </div>
  )
}

function LowerRow({ row }: { row: PublicRankingRow }) {
  const fresh = useFresh(row.team_id)
  return (
    <li className={cn('flex items-baseline gap-5 rounded-xl border bg-card/80 px-5 py-3 backdrop-blur-sm', fresh && 'stage-fresh-row')}>
      <span className="num w-[3.5rem] text-[2rem] font-bold text-muted-foreground">{row.rank}</span>
      <span className="min-w-0 flex-1 text-[1.8rem] font-semibold break-words">{row.team_name}</span>
      <span className="num text-[2rem] font-bold">{formatX100(row.score_x100)}</span>
    </li>
  )
}

// ---------- leaderboard ----------

export function Leaderboard({ data, teamsLabel }: { data: StageResponse; teamsLabel: string }) {
  const { stage, rows, event } = data
  const columns = boardColumns(rows, event.criteria)
  const scale = boardScale(rows.length)
  return (
    <section
      aria-label={teamsLabel}
      className={cn('stage-board mx-auto w-full max-w-[100rem]', columns.length > 0 && 'stage-board-crit')}
      style={{ fontSize: `${scale}rem`, ['--n' as string]: columns.length }}
    >
      <div className="stage-board-row px-[1.2em] pb-[0.6em] text-[0.85em] font-medium tracking-wide text-muted-foreground uppercase">
        <span>{stageText.rank}</span>
        <span>{teamsLabel}</span>
        {columns.map((c) => (
          <span key={c.key} className="stage-crit truncate text-right normal-case">
            {c.label}
          </span>
        ))}
        <span className="text-right">{stageText.score}</span>
      </div>
      <ol className="grid gap-[0.45em]">
        {rows.map((row) => (
          <BoardRow key={row.team_id} row={row} columns={columns} highlighted={row.rank !== null && row.rank <= stage.top_n} />
        ))}
      </ol>
    </section>
  )
}

function BoardRow({
  row,
  columns,
  highlighted,
}: {
  row: PublicRankingRow
  columns: ReturnType<typeof boardColumns>
  highlighted: boolean
}) {
  const fresh = useFresh(row.team_id)
  const winner = row.rank === 1
  return (
    <li
      className={cn(
        'stage-board-row rounded-[0.7em] border px-[1.2em] py-[0.7em] backdrop-blur-sm',
        highlighted ? 'bg-card/95' : 'bg-card/60',
        winner ? 'border-signal/70' : 'border-border',
        fresh && 'stage-fresh-row',
      )}
    >
      <span className={cn('num text-[2.2em] leading-none font-extrabold', winner ? 'text-signal' : row.rank === null ? 'text-muted-foreground' : '')}>
        {row.rank ?? '—'}
        {row.tie && <span className="sr-only">{stageText.tie}</span>}
      </span>
      <span className="min-w-0">
        <span className="block text-[1.9em] leading-tight font-semibold break-words">{row.team_name}</span>
        {(row.tie || row.score_x100 === null) && (
          <span className="block text-[0.9em] text-muted-foreground">{row.score_x100 === null ? stageText.noScore : stageText.tie}</span>
        )}
      </span>
      {columns.map((c) => (
        <span key={c.key} className="stage-crit num text-right text-[1.4em] font-medium text-muted-foreground">
          {c.value(row)}
        </span>
      ))}
      <span className={cn('num text-right text-[2.3em] leading-none font-extrabold', winner && 'text-signal')}>{formatX100(row.score_x100)}</span>
    </li>
  )
}
