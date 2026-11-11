import { beforeEach, expect, test, vi } from 'vitest'
import { db, getDeviceId, getEditContext, getUser, setUser } from './db'
import {
  create,
  entriesForIssue,
  entriesForVehicle,
  issuesForVehicle,
  putRaw,
  readAll,
  restore,
  serviceItemsForVehicle,
  setLocalChangeListener,
  softDelete,
  todosForVehicle,
  update,
  vehiclesLive,
} from './repo'
import type { Entry, Issue, Todo, Vehicle, ServiceItem } from '../model/types'

const ctx = { user: 'Jamie', deviceId: 'dev-a' }

const entryFields = {
  vehicleId: 'v1',
  date: { precision: 'day', value: '2026-11-11' },
  readings: {},
  text: 'oil',
  tags: [],
  serviceItemIds: [],
  createdBy: 'Jamie',
} as const

beforeEach(async () => {
  setLocalChangeListener(() => {})
  await db.delete()
  await db.open()
})

test('create stamps and excludes tombstones from queries', async () => {
  const e = await create<Entry>('entries', { ...entryFields, tags: [], serviceItemIds: [] }, ctx)
  expect(e.updatedBy).toBe('Jamie')
  expect(e.deleted).toBe(false)
  expect(await entriesForVehicle('v1')).toHaveLength(1)
  await softDelete('entries', e.id, ctx)
  expect(await entriesForVehicle('v1')).toHaveLength(0)
  expect((await readAll()).entries[0].deleted).toBe(true)
  await restore('entries', e.id, ctx)
  expect(await entriesForVehicle('v1')).toHaveLength(1)
})

test('deviceId is stable', async () => {
  expect(await getDeviceId()).toBe(await getDeviceId())
})

test('putRaw does not restamp', async () => {
  const rec = { id: 'x', updatedAt: '2020-01-01T00:00:00.000Z' } as Issue
  await putRaw({ issues: [rec] })
  expect((await readAll()).issues[0].updatedAt).toBe('2020-01-01T00:00:00.000Z')
})

test('update restamps and persists changes', async () => {
  const t0 = new Date('2026-01-01T00:00:00.000Z')
  const t1 = new Date('2026-02-01T00:00:00.000Z')
  const i = await create<Issue>(
    'issues',
    { vehicleId: 'v1', title: 'Creak', status: 'open' },
    { ...ctx, now: t0 },
  )
  const saved = await update<Issue>(
    'issues',
    { ...i, status: 'resolved' },
    { user: 'Sam', deviceId: 'dev-b', now: t1 },
  )
  expect(saved.updatedAt).toBe(t1.toISOString())
  const [stored] = (await readAll()).issues
  expect(stored.status).toBe('resolved')
  expect(stored.updatedBy).toBe('Sam')
  expect(stored.updatedByDevice).toBe('dev-b')
  expect(stored.createdAt).toBe(t0.toISOString())
})

test('softDelete and restore stamp the record', async () => {
  const t1 = new Date('2026-02-01T00:00:00.000Z')
  const i = await create<Issue>('issues', { vehicleId: 'v1', title: 'x', status: 'open' }, ctx)
  await softDelete('issues', i.id, { user: 'Sam', deviceId: 'dev-b', now: t1 })
  const [stored] = (await readAll()).issues
  expect(stored.deleted).toBe(true)
  expect(stored.updatedAt).toBe(t1.toISOString())
  expect(stored.updatedBy).toBe('Sam')
})

test('softDelete and restore throw on a missing id', async () => {
  await expect(softDelete('todos', 'nope', ctx)).rejects.toThrow(/todos.*nope/)
  await expect(restore('todos', 'nope', ctx)).rejects.toThrow(/todos.*nope/)
})

test('live helpers filter by parent and exclude tombstones', async () => {
  const v = await create<Vehicle>(
    'vehicles',
    { name: 'Relay', kind: 'ebike', info: '', infoUpdatedAt: '', meters: [], archived: false },
    ctx,
  )
  const gone = await create<Vehicle>(
    'vehicles',
    { name: 'Old', kind: 'car', info: '', infoUpdatedAt: '', meters: [], archived: false },
    ctx,
  )
  await softDelete('vehicles', gone.id, ctx)
  expect((await vehiclesLive()).map((x) => x.id)).toEqual([v.id])

  const issue = await create<Issue>('issues', { vehicleId: v.id, title: 'a', status: 'open' }, ctx)
  await create<Issue>('issues', { vehicleId: 'other', title: 'b', status: 'open' }, ctx)
  const deadIssue = await create<Issue>('issues', { vehicleId: v.id, title: 'c', status: 'open' }, ctx)
  await softDelete('issues', deadIssue.id, ctx)
  expect((await issuesForVehicle(v.id)).map((x) => x.id)).toEqual([issue.id])

  const todo = await create<Todo>('todos', { vehicleId: v.id, text: 't', done: false }, ctx)
  await create<Todo>('todos', { vehicleId: 'other', text: 'u', done: false }, ctx)
  expect((await todosForVehicle(v.id)).map((x) => x.id)).toEqual([todo.id])

  const item = await create<ServiceItem>('serviceItems', { vehicleId: v.id, name: 'Oil' }, ctx)
  expect((await serviceItemsForVehicle(v.id)).map((x) => x.id)).toEqual([item.id])

  const linked = await create<Entry>('entries', { ...entryFields, vehicleId: v.id, issueId: issue.id, tags: [], serviceItemIds: [] }, ctx)
  await create<Entry>('entries', { ...entryFields, vehicleId: v.id, tags: [], serviceItemIds: [] }, ctx)
  expect((await entriesForIssue(issue.id)).map((x) => x.id)).toEqual([linked.id])
})

test('stamping mutations notify the listener; putRaw does not', async () => {
  const listener = vi.fn()
  setLocalChangeListener(listener)
  const i = await create<Issue>('issues', { vehicleId: 'v1', title: 'x', status: 'open' }, ctx)
  await update<Issue>('issues', { ...i, title: 'y' }, ctx)
  await softDelete('issues', i.id, ctx)
  await restore('issues', i.id, ctx)
  expect(listener).toHaveBeenCalledTimes(4)
  await putRaw({ issues: [i] })
  expect(listener).toHaveBeenCalledTimes(4)
})

test('getEditContext uses the stored user, falling back to Me', async () => {
  expect(await getUser()).toBeUndefined()
  const before = await getEditContext()
  expect(before.user).toBe('Me')
  expect(before.deviceId).toBe(await getDeviceId())
  await setUser('Jamie')
  expect(await getUser()).toBe('Jamie')
  expect((await getEditContext()).user).toBe('Jamie')
})
