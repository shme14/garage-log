import { beforeEach, describe, expect, test } from 'vitest'
import { db } from '../db/db'
import { putRaw, readAll } from '../db/repo'
import { compareEntriesDesc } from '../model/dates'
import type { Vehicle } from '../model/types'
import { loadSeed, validateSeed } from './seed'

type Loose = Record<string, Record<string, unknown>[]>

/** A small synthetic seed: one vehicle with a meter, one without, and one of each record kind. */
const seedJson = {
  vehicles: [
    {
      id: 'v-truck',
      name: 'Test Truck',
      kind: 'truck',
      info: 'Synthetic reference page.',
      archived: false,
      meters: [{ id: 'm-truck-odo', name: 'Odometer', unit: 'km' }],
    },
    {
      id: 'v-bike',
      name: 'Test Bike',
      kind: 'bike',
      info: '',
      archived: false,
      meters: [],
    },
  ],
  issues: [{ id: 'i-truck-1', vehicleId: 'v-truck', title: 'Test issue', status: 'open' }],
  serviceItems: [
    {
      id: 's-truck-1',
      vehicleId: 'v-truck',
      name: 'Test service',
      intervalMeterId: 'm-truck-odo',
      intervalAmount: 5000,
      intervalMonths: 6,
    },
  ],
  todos: [
    { id: 't-truck-1', vehicleId: 'v-truck', issueId: 'i-truck-1', text: 'Test todo', done: false },
  ],
  entries: [
    {
      id: 'e-truck-1',
      vehicleId: 'v-truck',
      date: { precision: 'day', value: '2024-01-10' },
      readings: { 'm-truck-odo': 1000 },
      text: 'First test entry',
      tags: ['maintenance'],
      cost: 10,
      shop: 'Test Shop',
      serviceItemIds: ['s-truck-1'],
    },
    {
      id: 'e-truck-2',
      vehicleId: 'v-truck',
      date: { precision: 'day', value: '2024-01-10' },
      readings: {},
      text: 'Second test entry, same day',
      tags: [],
      issueId: 'i-truck-1',
      serviceItemIds: [],
    },
    {
      id: 'e-truck-3',
      vehicleId: 'v-truck',
      date: { precision: 'month', value: '2024-06' },
      readings: {},
      text: 'Month-only test entry',
      tags: ['repair'],
      serviceItemIds: [],
    },
    {
      id: 'e-bike-1',
      vehicleId: 'v-bike',
      date: { precision: 'day', value: '2024-03-05' },
      readings: {},
      text: 'Bike test entry',
      tags: [],
      serviceItemIds: [],
    },
  ],
}

/** A deep copy of the seed that a test may break. */
function seedCopy(): Loose {
  return JSON.parse(JSON.stringify(seedJson)) as Loose
}

const now = new Date('2026-11-11T12:00:00.000Z')
const ctx = { user: 'Tester', deviceId: 'dev-import', now }

const liveVehicle: Vehicle = {
  id: 'v-existing',
  name: 'Existing',
  kind: 'car',
  info: '',
  infoUpdatedAt: '',
  meters: [],
  archived: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'test',
  updatedByDevice: 'dev',
  deleted: false,
}

beforeEach(async () => {
  await Promise.all([
    db.vehicles.clear(),
    db.entries.clear(),
    db.issues.clear(),
    db.todos.clear(),
    db.serviceItems.clear(),
  ])
})

describe('validateSeed', () => {
  test('accepts a well-formed seed and returns its records in file order', () => {
    const seed = validateSeed(seedJson)
    expect(seed.vehicles.map((v) => v.id)).toEqual(['v-truck', 'v-bike'])
    expect(seed.entries.map((e) => e.id)).toEqual(['e-truck-1', 'e-truck-2', 'e-truck-3', 'e-bike-1'])
    expect(seed.issues).toHaveLength(1)
    expect(seed.todos).toHaveLength(1)
    expect(seed.serviceItems).toHaveLength(1)
  })

  test('accepts a month-precision date and an empty meter list', () => {
    const seed = validateSeed(seedJson)
    expect(seed.entries[2].date).toEqual({ precision: 'month', value: '2024-06' })
    expect(seed.vehicles[1].meters).toEqual([])
  })

  test('rejects entry with unknown vehicle', () => {
    const s = seedCopy()
    const id = s.entries[0].id as string
    s.entries[0].vehicleId = 'v-nope'
    expect(() => validateSeed(s)).toThrow(new RegExp(`${id}.*vehicle`))
  })

  test('rejects an impossible date', () => {
    const s = seedCopy()
    const id = s.entries[0].id as string
    s.entries[0].date = { precision: 'day', value: '2024-06-31' }
    expect(() => validateSeed(s)).toThrow(new RegExp(`${id}.*2024-06-31`))
  })

  test.each<[string, (s: Loose) => string]>([
    ['not an object', () => ''],
    [
      'a missing table',
      (s) => {
        delete s.todos
        return 'todos'
      },
    ],
    [
      'a duplicate id',
      (s) => {
        s.entries[1].id = s.entries[0].id
        return s.entries[0].id as string
      },
    ],
    [
      'an unknown tag',
      (s) => {
        s.entries[0].tags = ['oil']
        return 'oil'
      },
    ],
    [
      'a month date given as a day',
      (s) => {
        s.entries[0].date = { precision: 'month', value: '2024-06-30' }
        return '2024-06-30'
      },
    ],
    [
      'a reading for a meter the vehicle lacks',
      (s) => {
        s.entries[0].readings = { 'm-nope': 1 }
        return 'm-nope'
      },
    ],
    [
      'a reading for a meter of another vehicle',
      (s) => {
        s.entries[3].readings = { 'm-truck-odo': 1 }
        return 'm-truck-odo'
      },
    ],
    [
      'an unknown issue',
      (s) => {
        s.entries[0].issueId = 'i-nope'
        return 'i-nope'
      },
    ],
    [
      'an issue of another vehicle',
      (s) => {
        s.entries[3].issueId = 'i-truck-1'
        return 'belongs to another vehicle'
      },
    ],
    [
      'an unknown service item',
      (s) => {
        s.entries[0].serviceItemIds = ['s-nope']
        return 's-nope'
      },
    ],
    [
      'a service item of another vehicle',
      (s) => {
        s.entries[3].serviceItemIds = ['s-truck-1']
        return 'belongs to another vehicle'
      },
    ],
    [
      'a todo pointing at an unknown issue',
      (s) => {
        s.todos[0].issueId = 'i-nope'
        return 'i-nope'
      },
    ],
    [
      'a service item metering an unknown meter',
      (s) => {
        s.serviceItems[0].intervalMeterId = 'm-nope'
        return 'm-nope'
      },
    ],
    [
      'an issue with an unknown status',
      (s) => {
        s.issues[0].status = 'closed'
        return 'closed'
      },
    ],
    [
      'an entry without text',
      (s) => {
        s.entries[0].text = ''
        return s.entries[0].id as string
      },
    ],
  ])('rejects %s', (_name, breakIt) => {
    const s = seedCopy()
    const mention = breakIt(s)
    const input = mention === '' ? 'not a seed' : s
    expect(() => validateSeed(input)).toThrow(mention)
  })
})

describe('loadSeed', () => {
  test('loadSeed stamps and stores', async () => {
    const count = await loadSeed(seedJson, ctx)
    const s = seedCopy()
    const total =
      s.vehicles.length + s.entries.length + s.issues.length + s.todos.length + s.serviceItems.length
    expect(total).toBe(9)
    expect(count).toBe(total)

    const stored = await readAll()
    const all = [
      ...stored.vehicles,
      ...stored.entries,
      ...stored.issues,
      ...stored.todos,
      ...stored.serviceItems,
    ]
    expect(all).toHaveLength(total)
    for (const r of all) {
      expect(r.updatedByDevice).toBe('dev-import')
      expect(r.updatedBy).toBe('Tester')
      expect(r.deleted).toBe(false)
      expect(r.updatedAt).toBe(r.createdAt)
    }
    for (const e of stored.entries) expect(e.createdBy).toBe('Tester')
    for (const v of stored.vehicles) expect(v.infoUpdatedAt).toBe(v.createdAt)

    // Stamps are ctx.now + file position in ms, so same-date entries keep the note's order.
    const first = stored.vehicles.find((v) => v.id === s.vehicles[0].id)!
    expect(first.createdAt).toBe(now.toISOString())
    const byId = new Map(stored.entries.map((e) => [e.id, e.createdAt]))
    const stamps = s.entries.map((e) => byId.get(e.id as string)!)
    expect(stamps).toEqual([...stamps].sort())
    expect(new Set(all.map((r) => r.createdAt)).size).toBe(total)
  })

  test('same-day entries sort in reverse file order after loading', async () => {
    await loadSeed(seedJson, ctx)
    const truck = (await readAll()).entries
      .filter((e) => e.vehicleId === 'v-truck')
      .sort(compareEntriesDesc)
      .map((e) => e.id)
    expect(truck).toEqual(['e-truck-3', 'e-truck-2', 'e-truck-1'])
  })

  test('loadSeed refuses when a vehicle exists, and writes nothing', async () => {
    await putRaw({ vehicles: [liveVehicle] })
    await expect(loadSeed(seedJson, ctx)).rejects.toThrow('Garage already has vehicles')
    expect(await db.entries.count()).toBe(0)
    expect(await db.vehicles.count()).toBe(1)
  })

  test('a deleted vehicle does not block the import', async () => {
    await putRaw({ vehicles: [{ ...liveVehicle, deleted: true }] })
    await expect(loadSeed(seedJson, ctx)).resolves.toBeGreaterThan(0)
  })

  test('an invalid seed writes nothing', async () => {
    const s = seedCopy()
    s.entries[3].vehicleId = 'v-nope'
    await expect(loadSeed(s, ctx)).rejects.toThrow('v-nope')
    expect(await db.vehicles.count()).toBe(0)
  })
})
