import { describe, expect, it } from 'vitest'
import { formatX100, parseX100 } from './format'

describe('formatX100', () => {
  it('drops trailing zeros and uses a decimal comma', () => {
    expect(formatX100(750)).toBe('7,5')
    expect(formatX100(725)).toBe('7,25')
    expect(formatX100(705)).toBe('7,05')
    expect(formatX100(1000)).toBe('10')
    expect(formatX100(0)).toBe('0')
    expect(formatX100(5)).toBe('0,05')
  })
  it('handles missing values', () => {
    expect(formatX100(null)).toBe('—')
    expect(formatX100(undefined)).toBe('—')
  })
})

describe('parseX100', () => {
  it('parses comma and dot decimals', () => {
    expect(parseX100('7,5')).toBe(750)
    expect(parseX100('7.25')).toBe(725)
    expect(parseX100('10')).toBe(1000)
  })
  it('rejects junk', () => {
    expect(parseX100('abc')).toBeNull()
    expect(parseX100('1.234')).toBeNull()
    expect(parseX100('')).toBeNull()
  })
})
