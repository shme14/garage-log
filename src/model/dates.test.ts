import { describe, expect, test } from 'vitest'
import { compareEntriesDesc, dateKey, formatEntryDate, toDate, todayEntryDate } from './dates'
import type { Entry } from './types'

describe('dates', () => {
  test('month precision keys to first of month', () => {
    expect(dateKey({ precision: 'month', value: '2026-06' })).toBe('2026-06-01')
  })

  test('todayEntryDate uses the local calendar day; toDate gives local midnight', () => {
    expect(todayEntryDate(new Date(2026, 10, 11, 23, 30))).toEqual({
      precision: 'day',
      value: '2026-11-11',
    })
    expect(toDate({ precision: 'month', value: '2026-06' })).toEqual(new Date(2026, 5, 1))
  })

  test('formats both precisions', () => {
    expect(formatEntryDate({ precision: 'day', value: '2025-11-11' })).toBe('Nov 11, 2025')
    expect(formatEntryDate({ precision: 'month', value: '2026-06' })).toBe('Jun 2026')
  })

  test('sorts newest first, month sorts as first of month, ties by createdAt desc', () => {
    const e = (value: string, precision: 'day' | 'month', createdAt: string) =>
      ({ date: { precision, value }, createdAt }) as Entry
    const a = e('2026-07-14', 'day', '2026-07-14T00:00:00Z')
    const b = e('2026-07', 'month', '2026-08-01T00:00:00Z')
    const c = e('2026-07-01', 'day', '2026-07-01T00:00:00Z')
    const d = e('2025-07-22', 'day', '2026-07-30T00:00:00Z')
    expect([d, c, b, a].sort(compareEntriesDesc)).toEqual([a, b, c, d])
  })
})
