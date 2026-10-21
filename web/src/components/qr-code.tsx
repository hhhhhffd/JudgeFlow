import { useEffect, useState } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { ru } from '@/i18n/ru'

/** The `qrcode` library is loaded on demand so it never lands in the judge/live bundles. */
export function QrCode({ value, size = 220 }: { value: string; size?: number }) {
  const [result, setResult] = useState<{ value: string; src?: string; failed?: boolean } | null>(null)

  useEffect(() => {
    let cancelled = false
    import('qrcode')
      .then((m) => m.toDataURL(value, { margin: 2, width: size * 2, errorCorrectionLevel: 'M' }))
      .then((src) => !cancelled && setResult({ value, src }))
      .catch(() => !cancelled && setResult({ value, failed: true }))
    return () => {
      cancelled = true
    }
  }, [value, size])

  const current = result?.value === value ? result : null
  if (current?.failed) return <p className="text-sm text-destructive">{ru.enroll.qrFailed}</p>
  if (!current?.src) return <Skeleton style={{ width: size, height: size }} />
  // Always dark-on-white (scanners need contrast), regardless of theme.
  return <img src={current.src} alt={ru.enroll.qrAlt} width={size} height={size} className="rounded-lg border bg-white" />
}
