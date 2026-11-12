import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { db } from '../db/db'
import { create, putRaw, readAll, update } from '../db/repo'
import type { Entry, Vehicle } from '../model/types'
import { emptySet, type RecordSet } from '../model/types'
import {
  fileName,
  isSyncRunning,
  startSync,
  stopSync,
  subscribeStatus,
  syncNow,
  syncOnce,
  type SyncFile,
  type SyncStatus,
} from './engine'
import { AuthError, FolderError, MemoryStore, type SyncFileRef, type SyncStore } from './store'

const ME = 'a'
const ctxA = { user: 'Jamie', deviceId: ME }

function entry(id: string, updatedAt: string, device: string, extra: Partial<Entry> = {}): Entry {
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    updatedBy: 'someone',
    updatedByDevice: device,
    deleted: false,
    vehicleId: 'v1',
    date: { precision: 'day', value: '2026-11-11' },
    readings: {},
    text: `text-${id}-${updatedAt}`,
    tags: [],
    serviceItemIds: [],
    createdBy: 'someone',
    ...extra,
  }
}

function vehicle(id: string, updatedAt: string, device: string): Vehicle {
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    updatedBy: 'someone',
    updatedByDevice: device,
    deleted: false,
    name: 'Truck',
    kind: 'truck',
    info: '',
    infoUpdatedAt: updatedAt,
    meters: [],
    archived: false,
  }
}

function fileOf(deviceId: string, records: Partial<RecordSet>): string {
  const f: SyncFile = { version: 1, deviceId, records: { ...emptySet(), ...records } }
  return JSON.stringify(f)
}

function ownFile(store: MemoryStore): SyncFile {
  return JSON.parse(store.files.get(fileName(ME)) ?? 'null') as SyncFile
}

function waitForStatus(s: SyncStatus): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const unsub = subscribeStatus((cur) => {
      if (cur === s && !done) {
        done = true
        resolve()
        queueMicrotask(() => unsub())
      }
    })
  })
}

function currentStatus(): SyncStatus {
  let cur: SyncStatus = 'pending'
  subscribeStatus((s) => (cur = s))()
  return cur
}

beforeEach(async () => {
  stopSync()
  await db.delete()
  await db.open()
  await db.meta.put({ key: 'deviceId', value: ME })
})

afterEach(() => {
  stopSync()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test('fileName', () => {
  expect(fileName('abc')).toBe('changes-abc.json')
})

test('two devices converge', async () => {
  const store = new MemoryStore()
  const e1 = await create<Entry>('entries', entry('x', '', ME), ctxA)
  store.files.set(
    'changes-b.json',
    fileOf('b', { entries: [entry('e2', '2026-11-01T00:00:00.000Z', 'b')] }),
  )

  const res = await syncOnce(store)

  expect(res).toEqual({ applied: 1, skipped: [] })
  const local = await readAll()
  expect(local.entries.map((e) => e.id).sort()).toEqual([e1.id, 'e2'].sort())
  const own = ownFile(store)
  expect(own.version).toBe(1)
  expect(own.deviceId).toBe(ME)
  expect(own.records.entries.map((e) => e.id)).toEqual([e1.id])
})

test('local edit newer than remote survives sync', async () => {
  await putRaw({ entries: [entry('x', '2026-11-01T00:00:12.000Z', ME, { text: 'local' })] })
  const store = new MemoryStore()
  store.files.set(
    'changes-b.json',
    fileOf('b', { entries: [entry('x', '2026-11-01T00:00:11.000Z', 'b', { text: 'remote' })] }),
  )

  const res = await syncOnce(store)

  expect(res.applied).toBe(0)
  const [x] = (await readAll()).entries
  expect(x.text).toBe('local')
  expect(ownFile(store).records.entries[0].text).toBe('local')
})

test('newer remote record overwrites older local one, tombstones included', async () => {
  await putRaw({
    entries: [
      entry('x', '2026-11-01T00:00:10.000Z', ME),
      entry('y', '2026-11-01T00:00:10.000Z', ME),
    ],
  })
  const store = new MemoryStore()
  store.files.set(
    'changes-b.json',
    fileOf('b', {
      entries: [
        entry('x', '2026-11-01T00:00:11.000Z', 'b', { text: 'remote' }),
        entry('y', '2026-11-01T00:00:11.000Z', 'b', { deleted: true }),
      ],
    }),
  )

  const res = await syncOnce(store)

  expect(res.applied).toBe(2)
  const byId = new Map((await readAll()).entries.map((e) => [e.id, e]))
  expect(byId.get('x')?.text).toBe('remote')
  expect(byId.get('y')?.deleted).toBe(true)
  // now owned by b, so not in our file
  expect(ownFile(store).records.entries).toEqual([])
})

test('skips unparseable file and reports it', async () => {
  const store = new MemoryStore()
  store.files.set('changes-b.json', '{bad')
  store.files.set(
    'changes-c.json',
    fileOf('c', { entries: [entry('ec', '2026-11-01T00:00:00.000Z', 'c')] }),
  )

  const res = await syncOnce(store)

  expect(res.skipped).toEqual(['changes-b.json'])
  expect((await readAll()).entries.map((e) => e.id)).toEqual(['ec'])
})

test('skips structurally invalid files, our own copy, and ignores unrelated names', async () => {
  const good = entry('g', '2026-11-01T00:00:00.000Z', 'z')
  const store = new MemoryStore()
  store.files.set('changes-v2.json', JSON.stringify({ version: 2, deviceId: 'v2', records: emptySet() }))
  store.files.set('changes-nodev.json', JSON.stringify({ version: 1, records: emptySet() }))
  store.files.set(
    'changes-noarr.json',
    JSON.stringify({ version: 1, deviceId: 'n', records: { ...emptySet(), todos: 'nope' } }),
  )
  store.files.set('changes-null.json', 'null')
  store.files.set(
    'changes-junk.json',
    JSON.stringify({ version: 1, deviceId: 'j', records: { ...emptySet(), entries: [null] } }),
  )
  store.files.set(
    'changes-dup (1).json',
    fileOf(ME, { entries: [entry('mine', '2026-11-01T00:00:00.000Z', ME)] }),
  )
  store.files.set('notes.txt', 'hello')
  store.files.set('changes-z.json.bak', '{bad')
  store.files.set('changes-z.json', fileOf('z', { entries: [good] }))

  const res = await syncOnce(store)

  expect(res.skipped.sort()).toEqual(
    [
      'changes-dup (1).json',
      'changes-junk.json',
      'changes-noarr.json',
      'changes-nodev.json',
      'changes-null.json',
      'changes-v2.json',
    ].sort(),
  )
  expect((await readAll()).entries.map((e) => e.id)).toEqual(['g'])
})

test('duplicate ids inside one file resolve to the newest, not the last', async () => {
  const store = new MemoryStore()
  store.files.set(
    'changes-b.json',
    fileOf('b', {
      entries: [
        entry('x', '2026-11-01T00:00:12.000Z', 'b', { text: 'newest' }),
        entry('x', '2026-11-01T00:00:05.000Z', 'b', { text: 'older' }),
      ],
    }),
  )
  await syncOnce(store)
  expect((await readAll()).entries.map((e) => e.text)).toEqual(['newest'])
})

test('own file includes edits to records created by other device', async () => {
  const store = new MemoryStore()
  store.files.set(
    'changes-b.json',
    fileOf('b', { entries: [entry('eb', '2026-11-01T00:00:00.000Z', 'b')] }),
  )
  await syncOnce(store)
  expect(ownFile(store).records.entries).toEqual([])

  const [eb] = (await readAll()).entries
  await update<Entry>('entries', { ...eb, text: 'edited by a' }, ctxA)
  await syncOnce(store)

  const own = ownFile(store).records.entries
  expect(own.map((e) => e.id)).toEqual(['eb'])
  expect(own[0].text).toBe('edited by a')
  expect(own[0].updatedByDevice).toBe(ME)
})

test('merges each file separately (same id in two files resolves to the newest)', async () => {
  const store = new MemoryStore()
  store.files.set(
    'changes-b.json',
    fileOf('b', { vehicles: [vehicle('v', '2026-11-01T00:00:20.000Z', 'b')] }),
  )
  store.files.set(
    'changes-c.json',
    fileOf('c', { vehicles: [vehicle('v', '2026-11-01T00:00:10.000Z', 'c')] }),
  )
  await syncOnce(store)
  const [v] = (await readAll()).vehicles
  expect(v.updatedByDevice).toBe('b')
})

test('a local edit made while files are downloading is not overwritten', async () => {
  await putRaw({ entries: [entry('x', '2026-11-01T00:00:10.000Z', ME, { text: 'old local' })] })
  const inner = new MemoryStore()
  inner.files.set(
    'changes-b.json',
    fileOf('b', { entries: [entry('x', '2026-11-01T00:00:11.000Z', 'b', { text: 'remote' })] }),
  )
  const racing: SyncStore = {
    list: () => inner.list(),
    writeOwn: (n, c) => inner.writeOwn(n, c),
    async read(id) {
      const text = await inner.read(id)
      // user edits the record after the download started: newer than remote
      await putRaw({
        entries: [entry('x', '2026-11-01T00:00:30.000Z', ME, { text: 'edited during sync' })],
      })
      return text
    },
  }

  await syncOnce(racing)

  expect((await readAll()).entries[0].text).toBe('edited during sync')
  expect(ownFile(inner).records.entries[0].text).toBe('edited during sync')
})

test('store failure leaves local data untouched and nothing is applied', async () => {
  await putRaw({ entries: [entry('x', '2026-11-01T00:00:10.000Z', ME, { text: 'local' })] })
  const before = await readAll()
  const inner = new MemoryStore()
  inner.files.set(
    'changes-b.json',
    fileOf('b', { entries: [entry('e2', '2026-11-01T00:00:00.000Z', 'b')] }),
  )
  inner.files.set(
    'changes-c.json',
    fileOf('c', { entries: [entry('x', '2026-11-01T00:00:59.000Z', 'c')] }),
  )
  let reads = 0
  const flaky: SyncStore = {
    list: () => inner.list(),
    writeOwn: (n, c) => inner.writeOwn(n, c),
    async read(id) {
      if (++reads === 2) throw new Error('network down')
      return inner.read(id)
    },
  }

  await expect(syncOnce(flaky)).rejects.toThrow('network down')
  expect(await readAll()).toEqual(before)
  expect(inner.files.has(fileName(ME))).toBe(false)
})

test('AuthError sets status sign-in and leaves local data untouched', async () => {
  await putRaw({ entries: [entry('x', '2026-11-01T00:00:10.000Z', ME)] })
  const before = await readAll()
  const store: SyncStore = {
    list: () => Promise.reject(new AuthError('expired')),
    read: () => Promise.reject(new AuthError('expired')),
    writeOwn: () => Promise.reject(new AuthError('expired')),
  }
  const seen: SyncStatus[] = []
  const unsub = subscribeStatus((s) => seen.push(s))

  startSync(store)
  await waitForStatus('sign-in')
  unsub()

  expect(seen).toContain('syncing')
  expect(seen.at(-1)).toBe('sign-in')
  expect(await readAll()).toEqual(before)
})

test('a missing folder sets status no-folder, not sign-in', async () => {
  const store: SyncStore = {
    list: () => Promise.reject(new FolderError()),
    read: () => Promise.reject(new FolderError()),
    writeOwn: () => Promise.reject(new FolderError()),
  }
  startSync(store)
  await waitForStatus('no-folder')
  expect(currentStatus()).toBe('no-folder')
})

test('other failures set status error', async () => {
  const store: SyncStore = {
    list: () => Promise.reject(new Error('500')),
    read: () => Promise.reject(new Error('500')),
    writeOwn: () => Promise.reject(new Error('500')),
  }
  startSync(store)
  await waitForStatus('error')
})

test('offline: no network attempt and status offline', async () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  const store = new MemoryStore()
  const list = vi.spyOn(store, 'list')

  startSync(store)
  await syncNow()

  expect(currentStatus()).toBe('offline')
  expect(list).not.toHaveBeenCalled()
})

test('online event triggers a sync after being offline', async () => {
  const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  const store = new MemoryStore()
  startSync(store)
  await syncNow()
  expect(currentStatus()).toBe('offline')

  onLine.mockReturnValue(true)
  window.dispatchEvent(new Event('online'))
  await waitForStatus('synced')
  expect(store.files.has(fileName(ME))).toBe(true)
})

test('subscribeStatus reports current state immediately, lastSynced and skipped after sync', async () => {
  const store = new MemoryStore()
  store.files.set('changes-b.json', '{bad')
  const calls: Array<[SyncStatus, string | undefined, string[] | undefined]> = []
  const unsub = subscribeStatus((s, l, sk) => calls.push([s, l, sk]))
  expect(calls).toHaveLength(1)

  startSync(store)
  await waitForStatus('synced')
  const last = calls.at(-1)!
  expect(last[0]).toBe('synced')
  expect(Number.isNaN(Date.parse(last[1] ?? ''))).toBe(false)
  expect(last[2]).toEqual(['changes-b.json'])

  unsub()
  const n = calls.length
  await syncNow()
  expect(calls).toHaveLength(n)
})

test('single-flight: syncNow while running does not start a second concurrent sync', async () => {
  const inner = new MemoryStore()
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let lists = 0
  let active = 0
  let maxActive = 0
  const store: SyncStore = {
    async list(): Promise<SyncFileRef[]> {
      lists++
      active++
      maxActive = Math.max(maxActive, active)
      await gate
      active--
      return inner.list()
    },
    read: (id) => inner.read(id),
    writeOwn: (n, c) => inner.writeOwn(n, c),
  }

  startSync(store)
  const p1 = syncNow()
  const p2 = syncNow()
  await vi.waitFor(() => expect(lists).toBe(1))
  release()
  await Promise.all([p1, p2])

  expect(lists).toBe(1)
  expect(maxActive).toBe(1)
  expect(currentStatus()).toBe('synced')
})

test('a local change during a sync causes exactly one more pass for waiters', async () => {
  const inner = new MemoryStore()
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let lists = 0
  const store: SyncStore = {
    async list(): Promise<SyncFileRef[]> {
      if (++lists === 1) await gate
      return inner.list()
    },
    read: (id) => inner.read(id),
    writeOwn: (n, c) => inner.writeOwn(n, c),
  }

  startSync(store)
  await vi.waitFor(() => expect(lists).toBe(1))
  const created = await create<Entry>('entries', entry('x', '', ME), ctxA)
  const w1 = syncNow()
  const w2 = syncNow()
  release()
  await Promise.all([w1, w2])

  expect(lists).toBe(2)
  expect(currentStatus()).toBe('synced')
  expect(ownFile(inner).records.entries.map((e) => e.id)).toEqual([created.id])
})

test('local change marks pending and syncs after a 5000 ms debounce', async () => {
  const store = new MemoryStore()
  const list = vi.spyOn(store, 'list')
  startSync(store)
  await waitForStatus('synced')
  expect(list).toHaveBeenCalledTimes(1)

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const created = await create<Entry>('entries', entry('x', '', ME), ctxA)
  expect(currentStatus()).toBe('pending')

  await vi.advanceTimersByTimeAsync(4999)
  expect(list).toHaveBeenCalledTimes(1)
  await create<Entry>('entries', entry('y', '', ME), ctxA) // resets the debounce
  await vi.advanceTimersByTimeAsync(4999)
  expect(list).toHaveBeenCalledTimes(1)

  await vi.advanceTimersByTimeAsync(1)
  await syncNow() // join the sync the timer started
  expect(list).toHaveBeenCalledTimes(2)
  expect(currentStatus()).toBe('synced')
  expect(ownFile(store).records.entries.map((e) => e.id)).toContain(created.id)
  expect(ownFile(store).records.entries).toHaveLength(2)
})

test('a throwing subscriber or missing store does not break the listener or syncNow', async () => {
  await expect(syncNow()).resolves.toBeUndefined() // not started
  const store = new MemoryStore()
  startSync(store)
  await waitForStatus('synced')
  subscribeStatus(() => {
    throw new Error('subscriber bug')
  })
  await expect(create<Entry>('entries', entry('x', '', ME), ctxA)).resolves.toBeDefined()
})

test('stopSync removes the listener and timers', async () => {
  const store = new MemoryStore()
  const list = vi.spyOn(store, 'list')
  startSync(store)
  await waitForStatus('synced')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await create<Entry>('entries', entry('x', '', ME), ctxA)
  stopSync()
  await vi.advanceTimersByTimeAsync(10000)
  window.dispatchEvent(new Event('online'))
  await vi.advanceTimersByTimeAsync(10000)
  expect(list).toHaveBeenCalledTimes(1)
})

test('isSyncRunning is true only between startSync and stopSync', async () => {
  expect(isSyncRunning()).toBe(false)
  startSync(new MemoryStore())
  expect(isSyncRunning()).toBe(true)
  await waitForStatus('synced')
  stopSync()
  expect(isSyncRunning()).toBe(false)
})

// ---------------------------------------------------------------- resume (visibilitychange)

// 'synced' is published just before the pass's promise settles; let it finish.
const settle = () => new Promise((r) => setTimeout(r, 0))

function setVisibility(state: 'visible' | 'hidden'): void {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state)
  document.dispatchEvent(new Event('visibilitychange'))
}

test('becoming visible triggers a sync pass', async () => {
  const store = new MemoryStore()
  const list = vi.spyOn(store, 'list')
  startSync(store)
  await waitForStatus('synced')
  await settle()
  expect(list).toHaveBeenCalledTimes(1)

  setVisibility('visible')
  await syncNow() // joins the pass the event started
  expect(list).toHaveBeenCalledTimes(2)
})

test('going hidden does not trigger a sync pass', async () => {
  const store = new MemoryStore()
  const list = vi.spyOn(store, 'list')
  startSync(store)
  await waitForStatus('synced')

  setVisibility('hidden')
  await Promise.resolve()
  expect(list).toHaveBeenCalledTimes(1)
})

test('visibility passes are throttled to one per 30 s', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const store = new MemoryStore()
  const list = vi.spyOn(store, 'list')
  startSync(store)
  await waitForStatus('synced')
  await settle()
  expect(list).toHaveBeenCalledTimes(1)

  setVisibility('visible')
  await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  await vi.waitFor(() => expect(currentStatus()).toBe('synced'))
  await settle()

  vi.setSystemTime(Date.now() + 10_000)
  setVisibility('visible')
  await new Promise((r) => setTimeout(r, 30)) // real timers: let any (wrongly) started pass run
  expect(list).toHaveBeenCalledTimes(2)

  vi.setSystemTime(Date.now() + 31_000)
  setVisibility('visible')
  await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3))
})

test('stopSync removes the visibilitychange listener', async () => {
  const store = new MemoryStore()
  const list = vi.spyOn(store, 'list')
  startSync(store)
  await waitForStatus('synced')
  stopSync()

  setVisibility('visible')
  await Promise.resolve()
  expect(list).toHaveBeenCalledTimes(1)
})
