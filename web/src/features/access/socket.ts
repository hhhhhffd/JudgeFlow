export function openAccessSocket(onChange: () => void): () => void {
  let socket: WebSocket | null = null
  let stopped = false
  let retry: number | undefined
  let attempt = 0

  const connect = () => {
    if (stopped) return
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    socket = new WebSocket(`${scheme}//${window.location.host}/api/access/ws`)
    socket.addEventListener('open', () => {
      if (attempt > 0) onChange()
      attempt = 0
    })
    socket.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as { kind?: unknown }
        if (typeof payload.kind === 'string') onChange()
      } catch {
        // Unknown messages do not affect the workspace.
      }
    })
    socket.addEventListener('close', () => {
      if (stopped) return
      attempt += 1
      retry = window.setTimeout(connect, Math.min(30_000, 1000 * 2 ** (attempt - 1)))
    })
  }

  connect()
  return () => {
    stopped = true
    if (retry !== undefined) window.clearTimeout(retry)
    socket?.close()
  }
}
