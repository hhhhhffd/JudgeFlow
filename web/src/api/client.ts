export interface ApiErrorBody {
  error: string
  message: string
  details?: unknown
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }

  get isUnauthorized() {
    return this.status === 401
  }
  get isNotFound() {
    return this.status === 404
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** JSON-serialised unless it is a Blob/ArrayBuffer (raw upload). */
  body?: unknown
  /** Judge Bearer token. */
  token?: string
  signal?: AbortSignal
  headers?: Record<string, string>
}

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as Partial<ApiErrorBody>
    if (body && typeof body.error === 'string') {
      return new ApiError(res.status, body.error, body.message ?? res.statusText, body.details)
    }
  } catch {
    // non-JSON error body (proxy error, network gateway) — fall through
  }
  return new ApiError(res.status, 'http_error', res.statusText || `HTTP ${res.status}`)
}

export function buildHeaders(opts: Pick<RequestOptions, 'token' | 'headers'>, json: boolean) {
  const headers: Record<string, string> = { ...opts.headers }
  if (json) headers['Content-Type'] = 'application/json'
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  return headers
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const raw = opts.body instanceof Blob || opts.body instanceof ArrayBuffer
  const hasJson = opts.body !== undefined && !raw
  let res: Response
  try {
    res = await fetch(path, {
      method: opts.method ?? 'GET',
      credentials: 'same-origin',
      headers: buildHeaders(opts, hasJson),
      body: opts.body === undefined ? undefined : hasJson ? JSON.stringify(opts.body) : (opts.body as BodyInit),
      signal: opts.signal,
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new ApiError(0, 'network', 'Нет связи с сервером')
  }
  if (!res.ok) throw await toApiError(res)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}
