import { describe, expect, test } from 'vitest'
import type { Entry, RecordSet, Vehicle } from '../model/types'
import { exportJson, exportText } from './export'

const base = {
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: 'test',
  updatedByDevice: 'dev',
  deleted: false,
}

const vehicle = (id: string, over: Partial<Vehicle> = {}): Vehicle => ({
  ...base,
  id,
  name: id,
  kind: 'truck',
  info: '',
  infoUpdatedAt: '',
  meters: [
    { id: 'odo', name: 'Odometer', unit: 'km' },
    { id: 'hrs', name: 'Engine hours', unit: 'h' },
  ],
  archived: false,
  ...over,
})

const entry = (id: string, over: Partial<Entry> = {}): Entry => ({
  ...base,
  id,
  vehicleId: 'f150',
  date: { precision: 'day', value: '2026-01-01' },
  readings: {},
  text: `entry ${id}`,
  tags: [],
  serviceItemIds: [],
  createdBy: 'Jamie',
  ...over,
})

const set: RecordSet = {
  vehicles: [
    vehicle('f150', { name: '2021 F150', info: 'VIN 123\nTires 275/65R18' }),
    vehicle('bike', { name: 'Bike', meters: [] }),
    vehicle('gone', { name: 'Zed gone', deleted: true }),
  ],
  entries: [
    entry('new', {
      date: { precision: 'day', value: '2026-10-20' },
      readings: { odo: 159500, hrs: 2566 },
      text: 'Oil change\nUsed 5W-30',
    }),
    entry('old', {
      date: { precision: 'month', value: '2026-06' },
      text: 'Brake pads',
    }),
    entry('gone', { text: 'deleted entry', deleted: true }),
    entry('b1', { vehicleId: 'bike', text: 'Chain waxed', readings: { unknown: 5 } }),
    entry('z1', { vehicleId: 'gone', text: 'on deleted vehicle' }),
  ],
  issues: [],
  todos: [],
  serviceItems: [],
}

describe('exportText', () => {
  test('includes vehicle heading and month dates', () => {
    const text = exportText(set)
    expect(text).toContain('# 2021 F150')
    expect(text).toContain('Jun 2026 — ')
  })

  test('formats readings, indents continuation lines, orders oldest to newest', () => {
    const text = exportText(set)
    expect(text).toContain('Oct 20, 2026 — 159,500 km · 2,566 h — Oil change\n  Used 5W-30')
    expect(text).toContain('Jun 2026 — Brake pads')
    expect(text.indexOf('Jun 2026')).toBeLessThan(text.indexOf('Oct 20, 2026'))
  })

  test('omits readings segment when none, hides deleted records and sorts vehicles by name', () => {
    const text = exportText(set)
    expect(text).toContain('Jan 1, 2026 — Chain waxed')
    expect(text).not.toContain('deleted entry')
    expect(text).not.toContain('Zed gone')
    expect(text).not.toContain('on deleted vehicle')
    expect(text.indexOf('# 2021 F150')).toBeLessThan(text.indexOf('# Bike'))
  })

  test('puts info after the heading, separated by blank lines', () => {
    expect(exportText(set)).toContain('# 2021 F150\n\nVIN 123\nTires 275/65R18\n\nJun 2026')
  })

  test('separates vehicles with a blank line', () => {
    expect(exportText(set)).toContain('Used 5W-30\n\n# Bike\n\nJan 1, 2026')
  })
})

describe('exportJson', () => {
  test('is versioned, pretty-printed and keeps tombstones', () => {
    const now = new Date('2026-11-11T12:00:00Z')
    const json = exportJson(set, now)
    const parsed = JSON.parse(json)
    expect(parsed.version).toBe(1)
    expect(parsed.exportedAt).toBe('2026-11-11T12:00:00.000Z')
    expect(parsed.records).toEqual(set)
    expect(parsed.records.entries.some((e: Entry) => e.deleted)).toBe(true)
    expect(json).toContain('\n  "version": 1')
  })
})
