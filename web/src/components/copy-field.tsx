import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
    <div className={cn('flex gap-2', className)}>
      <Input readOnly aria-label={label} value={value} onFocus={(e) => e.currentTarget.select()} className={cn(mono && 'font-mono text-xs')} />
      <Button type="button" variant="outline" size="icon" onClick={copy} aria-label={ru.common.copy}>
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  )
}
