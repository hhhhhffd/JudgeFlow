/**
 * Formats an integer in hundredths (`750` -> "7,5", `1000` -> "10", `null` -> "—")
 * with a Russian decimal comma and without trailing zeros.
 */
export function formatX100(value: number | null | undefined): string {
  if (value == null) return '—'
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(Math.round(value))
  const whole = Math.floor(abs / 100)
  const frac = abs % 100
  if (frac === 0) return `${sign}${whole}`
  const fracStr = String(frac).padStart(2, '0').replace(/0$/, '')
  return `${sign}${whole},${fracStr}`
}

/** Parses user input ("7,5" / "7.5") into hundredths; NaN-safe -> null. */
export function parseX100(input: string): number | null {
  const normalized = input.trim().replace(',', '.')
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null
  return Math.round(Number(normalized) * 100)
}

export function formatDateTime(ms: number | null | undefined): string {
  if (ms == null) return '—'
  return new Date(ms).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
