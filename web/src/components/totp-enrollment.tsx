import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { CopyField } from '@/components/copy-field'
import { OtpInput } from '@/components/otp-input'
import { QrCode } from '@/components/qr-code'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ru } from '@/i18n/ru'

/** QR + manual secret. Reused for first start, invites and TOTP reset (display only). */
export function TotpDisplay({ otpauthUri, secret }: { otpauthUri: string; secret: string }) {
  return (
    <div className="flex flex-col items-center gap-4">
      <QrCode value={otpauthUri} />
      <div className="w-full space-y-1.5">
        <Label>{ru.enroll.secretLabel}</Label>
        <CopyField value={secret} label={ru.enroll.secretLabel} />
        <p className="text-xs text-muted-foreground">{ru.enroll.manualText}</p>
      </div>
    </div>
  )
}

/** Second step of every enrolment flow: show the secret, then confirm with a code. */
export function TotpEnrollment({
  otpauthUri,
  secret,
  onSubmit,
  error,
  pending,
}: {
  otpauthUri: string
  secret: string
  onSubmit: (code: string) => void
  error?: string | null
  pending?: boolean
}) {
  const [code, setCode] = useState('')
  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault()
        if (code.length === 6) onSubmit(code)
      }}
    >
      <div>
        <h2 className="text-lg font-semibold">{ru.enroll.scanTitle}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{ru.enroll.scanText}</p>
      </div>
      <TotpDisplay otpauthUri={otpauthUri} secret={secret} />
      <div className="space-y-2">
        <Label>{ru.enroll.codePrompt}</Label>
        <OtpInput value={code} onChange={setCode} onComplete={onSubmit} disabled={pending} invalid={!!error} />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <Button type="submit" className="w-full" disabled={code.length < 6 || pending}>
        {pending && <Loader2 className="animate-spin" />}
        {ru.enroll.finish}
      </Button>
    </form>
  )
}
