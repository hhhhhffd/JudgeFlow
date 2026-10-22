import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ru } from '@/i18n/ru'
import { copyText } from '@/lib/clipboard'
import { cn } from '@/lib/utils'

export function CopyField({ value, label, mono = true, className }: { value: string; label: string; mono?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    if (await copyText(value)) {
      setCopied(true)
      toast.success(ru.common.copied)
      setTimeout(() => setCopied(false), 1500)
    } else {
      toast.error(ru.common.copyFailed)
    }
  }

  return (
    <div className={cn('flex items-start gap-2', className)}>
      {/* A growing textarea shows the whole value (long URLs wrap) instead of clipping it next to the button. */}
      <Textarea
        readOnly
        rows={2}
        aria-label={label}
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        className={cn('min-h-9 min-w-0 resize-none break-all [field-sizing:content]', mono && 'font-mono text-xs')}
      />
      <Button type="button" variant="outline" size="icon" onClick={copy} aria-label={ru.common.copy}>
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  )
}
