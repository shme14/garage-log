import { describe, expect, test } from 'vitest'
import type { Entry, ServiceItem, Vehicle } from '../model/types'
import { currentReading, dueStatus } from './due'

const base = {
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: 'test',
  updatedByDevice: 'dev',
  deleted: false,
}

const v = {
  ...base,
  id: 'v1',
  name: 'Truck',
  kind: 'truck',
  info: '',
  infoUpdatedAt: '2026-01-01T00:00:00Z',
  meters: [{ id: 'odo', name: 'Odometer', unit: 'km' }],
  archived: false,
} as Vehicle

const oil = {
  ...base,
  id: 'oil',
  vehicleId: 'v1',
  name: 'Oil change',
  intervalMeterId: 'odo',
  intervalAmount: 8000,
  intervalMonths: 12,
} as ServiceItem

let seq = 0
function entry(date: string, precision: 'day' | 'month', readings: Record<string, number>, ids: string[]): Entry {
  seq += 1
  return {
    ...base,
    id: `e${seq}`,
    createdAt: `2026-01-01T00:00:${String(seq % 60).padStart(2, '0')}Z`,
    vehicleId: 'v1',
    date: { precision, value: date },
    readings,
    text: '',
    tags: [],
    serviceItemIds: ids,
    createdBy: 'test',
  }
}
const done = (date: string, precision: 'day' | 'month', km: number) =>
  entry(date, precision, { odo: km }, [oil.id])
const reading = (date: string, km: number) => entry(date, 'day', { odo: km }, [])

// Local-midnight date, matching how the app calls dueStatus (new Date() = local day). `new Date('YYYY-MM-DD')`
// is UTC midnight, which is the previous local day west of UTC and would make these tests TZ-dependent.
const at = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const ymd = (d: Date | undefined) =>
  d && `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

describe('dueStatus', () => {
  test('ok when plenty remains', () => {
    const entries = [done('2026-07', 'month', 153300), reading('2026-11-01', 159500)]
    expect(dueStatus(oil, v, entries, at('2026-11-11')).state).toBe('ok')
    expect(dueStatus(oil, v, entries, at('2026-11-11')).remainingAmount).toBe(1800)
  })
  test('due-soon at <=10% of distance', () => {
    expect(dueStatus(oil, v, [done('2026-07', 'month', 153300), reading('2026-11-01', 160600)], at('2026-11-11')).state).toBe('due-soon')
  })
  test('overdue past distance', () => {
    expect(dueStatus(oil, v, [done('2026-07', 'month', 153300), reading('2026-11-01', 161400)], at('2026-11-11')).state).toBe('overdue')
  })
  test('month-precision last done uses first of month', () => {
    const info = dueStatus(oil, v, [done('2026-07', 'month', 153300)], at('2027-06-02'))
    expect(ymd(info.dueDate)).toBe('2027-07-01')
    expect(info.state).toBe('due-soon')
  })
  test('overdue past time even with distance left', () => {
    expect(dueStatus(oil, v, [done('2026-07', 'month', 153300)], at('2027-07-02')).state).toBe('overdue')
  })
  test('never-done', () => {
    expect(dueStatus(oil, v, [], at('2026-11-11')).state).toBe('never-done')
  })
  test('ignores readings for unknown meter', () => {
    const e = { ...reading('2026-11-01', 0), readings: { ghost: 999999 } }
    expect(() => dueStatus(oil, v, [done('2026-07', 'month', 153300), e], at('2026-11-11'))).not.toThrow()
    expect(currentReading([e], 'odo')).toBeUndefined()
  })
  test('deleted entries are ignored', () => {
    expect(dueStatus(oil, v, [{ ...done('2026-07', 'month', 153300), deleted: true }], at('2026-11-11')).state).toBe('never-done')
  })
})
