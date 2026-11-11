import { describe, expect, it } from 'vitest'
import { formatCount, parseCount } from '../../src/lib/motion'

const roundTrip = (text: string) => {
  const format = parseCount(text)
  if (!format) throw new Error(`No se pudo leer ${text}`)
  return formatCount(format.value, format)
}

describe('dashboard count-up format', () => {
  it('keeps Spanish money, grouping, prefixes and suffixes', () => {
    expect(parseCount('12.345,67\u00a0€')).toMatchObject({ value: 12345.67, decimals: 2, grouped: true, suffix: '\u00a0€' })
    expect(roundTrip('12.345,67\u00a0€')).toBe('12.345,67\u00a0€')
    expect(roundTrip('1234,50\u00a0€')).toBe('1234,50\u00a0€')
    expect(roundTrip('€ 9,99')).toBe('€ 9,99')
    expect(roundTrip('-5,00\u00a0€')).toBe('-5,00\u00a0€')
    expect(roundTrip('42')).toBe('42')
  })

  it('treats a dot not followed by exactly three digits as a decimal mark', () => {
    expect(parseCount('1.234')).toMatchObject({ value: 1234, grouped: true, decimals: 0 })
    expect(parseCount('12.5%')).toMatchObject({ value: 12.5, decimals: 1, decimalMark: '.', suffix: '%' })
    expect(roundTrip('12.5%')).toBe('12.5%')
  })

  it('formats intermediate frames in the original style', () => {
    const format = parseCount('12.345,67\u00a0€')
    if (!format) throw new Error('format')
    expect(formatCount(1500.5, format)).toBe('1.500,50\u00a0€')
    expect(formatCount(0, format)).toBe('0,00\u00a0€')
    expect(formatCount(-0.001, format)).toBe('0,00\u00a0€')
  })

  it('rejects text that is not a single figure', () => {
    expect(parseCount('Sin datos')).toBeNull()
    expect(parseCount('1.2.3')).toBeNull()
    expect(parseCount('12.34,5')).toBeNull()
  })
})
