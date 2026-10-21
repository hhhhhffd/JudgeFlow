import { buildHeaders } from './client'
import type { ChangeKind } from './types'

export interface ParsedSseMessage {
  event: string
  data: string
}

/**
 * Incremental SSE parser. Feed it decoded text chunks; it returns complete
 * messages and keeps the unfinished tail. Comment lines (": keepalive") are ignored.
 */
export function createSseParser() {
  let buffer = ''
  let event = 'message'
  let data: string[] = []

  return function push(chunk: string): ParsedSseMessage[] {
    buffer += chunk
    const out: ParsedSseMessage[] = []
    let idx: number
    while ((idx = buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = buffer.slice(0, idx)
      const sepLen = buffer.startsWith('\r\n', idx) ? 2 : 1
      // A lone trailing "\r" may be the first half of "\r\n": wait for more input.
      if (buffer[idx] === '\r' && idx + 1 === buffer.length) break
      buffer = buffer.slice(idx + sepLen)
      if (line === '') {
        if (data.length > 0) out.push({ event, data: data.join('\n') })
        event = 'message'
        data = []
      } else if (line.startsWith(':')) {
        continue
      } else {
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        let value = colon === -1 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'event') event = value
        else if (field === 'data') data.push(value)
      }
    }
    return out
  }
}

const KINDS: readonly string[] = ['scores', 'status', 'event', 'composition', 'alert', 'judges']

/** Extracts the change kind from a `change` message; null for anything else. */
export function parseChangeKind(msg: ParsedSseMessage): ChangeKind | null {
  if (msg.event !== 'change') return null
  try {
    const kind = (JSON.parse(msg.data) as { kind?: unknown }).kind
    return typeof kind === 'string' && KINDS.includes(kind) ? (kind as ChangeKind) : null
  } catch {
    return null
  }
}

export interface StreamOptions {
  /** Judge Bearer token (the judge stream cannot use EventSource). */
  token?: string
  onChange: (kind: ChangeKind) => void
  /** Called every time the connection is (re)established — refetch state here. */
  onOpen?: (info: { reconnect: boolean }) => void
  onError?: (error: unknown) => void
  /** Stop retrying on these statuses (e.g. 401/404). Default: 401, 403, 404. */
  fatalStatuses?: number[]
}

/**
 * Opens an SSE stream via fetch streaming and reconnects with exponential
 * backoff (1s → 30s, reset after a successful open). Returns a `close` function.
 */
export function openStream(url: string, opts: StreamOptions): () => void {
  const controller = new AbortController()
  const fatal = opts.fatalStatuses ?? [401, 403, 404]
  let attempt = 0
  let opened = false

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms)
      controller.signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
    })

  async function run() {
    while (!controller.signal.aborted) {
      try {
        const res = await fetch(url, {
          credentials: 'same-origin',
          headers: buildHeaders({ token: opts.token, headers: { Accept: 'text/event-stream' } }, false),
          signal: controller.signal,
        })
        if (!res.ok || !res.body) {
          if (fatal.includes(res.status)) {
            opts.onError?.(new Error(`stream rejected: ${res.status}`))
            return
          }
          throw new Error(`stream failed: ${res.status}`)
        }
        opts.onOpen?.({ reconnect: opened })
        opened = true
        attempt = 0
        const parse = createSseParser()
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          for (const msg of parse(value)) {
            const kind = parseChangeKind(msg)
            if (kind) opts.onChange(kind)
          }
        }
      } catch (e) {
        if (controller.signal.aborted) return
        opts.onError?.(e)
      }
      attempt += 1
      await sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.random() * 300)
    }
  }

  void run()
  return () => controller.abort()
}
