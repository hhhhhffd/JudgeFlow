import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { ru } from '@/i18n/ru'

export function NotFoundView({ title = ru.notFound.title, text = ru.notFound.text, to = '/', action = ru.notFound.home }: { title?: string; text?: string; to?: string; action?: string }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="num font-mono text-6xl font-medium text-muted-foreground" aria-hidden>
        404
      </p>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="max-w-sm text-sm text-muted-foreground">{text}</p>
      <Button asChild>
        <Link to={to}>{action}</Link>
      </Button>
    </main>
  )
}

export default function NotFoundPage() {
  return <NotFoundView />
}
