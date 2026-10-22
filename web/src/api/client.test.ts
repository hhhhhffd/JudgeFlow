import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, request } from './client'

afterEach(() => vi.unstubAllGlobals())

describe('request errors', () => {
  it('replaces the English statusText of a non-JSON 5xx with a Russian message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' })))
    const err = await request('/api/x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).message).toBe('Сервер временно недоступен')
    expect((err as ApiError).status).toBe(502)
  })
  it('keeps the server message of a JSON error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'internal', message: 'Внутренняя ошибка' }, { status: 500 })))
    const err = (await request('/api/x').catch((e: unknown) => e)) as ApiError
    expect(err.message).toBe('Внутренняя ошибка')
  })
})
