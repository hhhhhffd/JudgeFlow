import { describe, expect, it } from 'vitest'
import { createSseParser, parseChangeKind } from './sse'

describe('createSseParser', () => {
  it('parses a change message and ignores keep-alive comments', () => {
    const push = createSseParser()
    const msgs = push(': keepalive\n\nevent: change\ndata: {"kind":"scores"}\n\n')
    expect(msgs).toEqual([{ event: 'change', data: '{"kind":"scores"}' }])
    expect(parseChangeKind(msgs[0]!)).toBe('scores')
  })

  it('handles messages split across chunks and CRLF', () => {
    const push = createSseParser()
    expect(push('event: change\r\ndata: {"ki')).toEqual([])
    const msgs = push('nd":"status"}\r\n\r\n')
    expect(msgs).toHaveLength(1)
    expect(parseChangeKind(msgs[0]!)).toBe('status')
  })

  it('returns null for unknown kinds, other events and bad JSON', () => {
    expect(parseChangeKind({ event: 'change', data: '{"kind":"nope"}' })).toBeNull()
    expect(parseChangeKind({ event: 'ping', data: '{"kind":"scores"}' })).toBeNull()
    expect(parseChangeKind({ event: 'change', data: 'oops' })).toBeNull()
  })
})
