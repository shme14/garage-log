import { describe, expect, test } from 'vitest'
import type { Entry, Issue, RecordSet, Todo, Vehicle } from '../model/types'
import { search } from './search'

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
  kind: 'ebike',
  info: '',
  infoUpdatedAt: '',
  meters: [],
  archived: false,
  ...over,
})

const entry = (id: string, over: Partial<Entry> = {}): Entry => ({
  ...base,
  id,
  vehicleId: 'relay',
  date: { precision: 'day', value: '2026-01-01' },
  readings: {},
  text: `entry ${id}`,
  tags: [],
  serviceItemIds: [],
  createdBy: 'Jamie',
  ...over,
})

const issue = (id: string, over: Partial<Issue> = {}): Issue => ({
  ...base,
  id,
  vehicleId: 'relay',
  title: `issue ${id}`,
  status: 'open',
  ...over,
})

const todo = (id: string, over: Partial<Todo> = {}): Todo => ({
  ...base,
  id,
  vehicleId: 'relay',
  text: `todo ${id}`,
  done: false,
  ...over,
})

const set: RecordSet = {
  vehicles: [
    vehicle('relay', { info: 'Motor: Bosch CX. Frame no. 12345' }),
    vehicle('sparky', { info: 'Torque for axle nut: 40 Nm' }),
    vehicle('gone', { deleted: true, info: 'torque ghost' }),
  ],
  entries: [
    entry('e-may21', {
      date: { precision: 'day', value: '2026-05-21' },
      text: 'Motor bushings torqued to 14Nm, fork rebound 8 clicks',
      tags: ['maintenance'],
    }),
    entry('e-jun', {
      date: { precision: 'month', value: '2026-06' },
      text: 'New chain',
      shop: 'Torque Cycle Works',
      tags: ['repair'],
    }),
    entry('e-sparky', {
      vehicleId: 'sparky',
      date: { precision: 'day', value: '2026-07-01' },
      text: 'Checked 14nm on stem bolts',
      tags: ['maintenance'],
    }),
    entry('e-deleted', { text: 'torque deleted entry', deleted: true }),
    entry('e-orphan', { vehicleId: 'gone', text: 'torque on a deleted vehicle' }),
  ],
  issues: [
    issue('i-creak', { title: 'Motor mount creak' }),
    issue('i-del', { title: 'creak deleted', deleted: true }),
    issue('i-orphan', { vehicleId: 'gone', title: 'creak orphan' }),
  ],
  todos: [
    todo('t-creak', { text: 'Grease the creak' }),
    todo('t-del', { text: 'creak deleted todo', deleted: true }),
  ],
  serviceItems: [],
}

const ids = (q: string, f: Parameters<typeof search>[2] = {}) => search(set, q, f).map((h) => h.id)

describe('search', () => {
  test('finds torque spec case-insensitively', () => {
    expect(ids('14NM')).toContain('e-may21')
  })

  test('vehicle and tag filters narrow results', () => {
    expect(ids('14nm')).toEqual(['e-sparky', 'e-may21'])
    expect(ids('14nm', { vehicleId: 'relay' })).toEqual(['e-may21'])
    expect(ids('torque', { tag: 'repair' })).toEqual(['e-jun'])
    expect(ids('14nm', { vehicleId: 'sparky', tag: 'repair' })).toEqual([])
  })

  test('matches info page, issue title, todo text and shop; orders entries, issues, todos, info', () => {
    const hits = search(set, 'creak', {})
    expect(hits.map((h) => [h.kind, h.id])).toEqual([
      ['issue', 'i-creak'],
      ['todo', 't-creak'],
    ])
    expect(search(set, 'bosch', {})).toMatchObject([{ kind: 'info', id: 'relay', vehicleId: 'relay' }])
    expect(ids('cycle works')).toEqual(['e-jun'])
    const mixed = search(set, 'torque', {}).map((h) => h.kind)
    expect(mixed).toEqual(['entry', 'entry', 'info'])
  })

  test('skips deleted records and records of deleted vehicles', () => {
    const all = ids('torque')
    expect(all).not.toContain('e-deleted')
    expect(all).not.toContain('e-orphan')
    expect(all).not.toContain('gone')
    expect(ids('creak')).not.toContain('i-del')
    expect(ids('creak')).not.toContain('i-orphan')
    expect(ids('creak')).not.toContain('t-del')
  })

  test('the vehicle filter applies to every kind', () => {
    expect(ids('nm', { vehicleId: 'sparky' })).toEqual(['e-sparky', 'sparky'])
    expect(ids('creak', { vehicleId: 'sparky' })).toEqual([])
  })

  test('a tag filter returns entries only', () => {
    expect(search(set, 'nm', { tag: 'maintenance' }).map((h) => h.kind)).toEqual([
      'entry',
      'entry',
    ])
  })

  test('empty query and no filters finds nothing', () => {
    expect(search(set, '', {})).toEqual([])
    expect(search(set, '   ', {})).toEqual([])
  })

  test('empty query with filters lists the matching entries only', () => {
    expect(ids('', { tag: 'maintenance' })).toEqual(['e-sparky', 'e-may21'])
    expect(ids('', { vehicleId: 'relay' })).toEqual(['e-jun', 'e-may21'])
    expect(search(set, '', { vehicleId: 'relay' }).every((h) => h.kind === 'entry')).toBe(true)
  })

  test('empty-query snippet is the start of the entry text', () => {
    const hit = search(set, '', { tag: 'repair' })[0]
    expect(hit.snippet).toBe('New chain')
  })

  test('snippet is centred on the first match with ellipses at the cut ends', () => {
    const text = `${'a'.repeat(150)} NEEDLE ${'b'.repeat(150)}`
    const s: RecordSet = { ...set, entries: [entry('long', { text })] }
    const [hit] = search(s, 'needle', {})
    expect(hit.snippet.startsWith('…')).toBe(true)
    expect(hit.snippet.endsWith('…')).toBe(true)
    expect(hit.snippet).toContain('NEEDLE')
    expect(hit.snippet.length).toBeLessThanOrEqual(104)
    const short = search(set, '14nm', { vehicleId: 'relay' })[0]
    expect(short.snippet).toBe('Motor bushings torqued to 14Nm, fork rebound 8 clicks')
  })

  test('snippet for a shop match shows the shop', () => {
    expect(search(set, 'cycle works', {})[0].snippet).toContain('Cycle Works')
  })
})
