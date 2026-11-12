import { db, getDeviceId } from '../db/db'
import { putRaw, readAll, setLocalChangeListener } from '../db/repo'
import type { BaseRecord, RecordSet, TableName } from '../model/types'
import { newer, ownRecords, winnersOver } from './merge'
import { AuthError, FolderError, type SyncStore } from './store'

export interface SyncFile {
  version: 1
  deviceId: string
  records: RecordSet
}

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'pending' | 'sign-in' | 'no-folder' | 'error'

type StatusSubscriber = (s: SyncStatus, lastSynced?: string, skipped?: string[]) => void

const TABLES: readonly TableName[] = ['vehicles', 'entries', 'issues', 'todos', 'serviceItems']
const FILE_NAME_RE = /^changes-.+\.json$/
const DEBOUNCE_MS = 5000
const RESUME_THROTTLE_MS = 30_000

export function fileName(deviceId: string): string {
  return `changes-${deviceId}.json`
}

// ---------------------------------------------------------------- parsing

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Just enough shape for merge's comparisons and Dexie's primary key to be safe.
function isRecordLike(v: unknown): v is BaseRecord {
  return (
    isObject(v) &&
    typeof v.id === 'string' &&
    typeof v.updatedAt === 'string' &&
    typeof v.updatedByDevice === 'string'
  )
}

// winnersOver assumes unique ids in the remote set; keep the newest copy.
function dedupe(records: BaseRecord[]): BaseRecord[] {
  const byId = new Map<string, BaseRecord>()
  for (const r of records) {
    const prev = byId.get(r.id)
    byId.set(r.id, prev ? newer(prev, r) : r)
  }
  return [...byId.values()]
}

function parseSyncFile(text: string): SyncFile | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(raw) || raw.version !== 1 || typeof raw.deviceId !== 'string') return null
  const recs = raw.records
  if (!isObject(recs)) return null
  const out: Record<string, BaseRecord[]> = {}
  for (const table of TABLES) {
    const arr = recs[table]
    if (!Array.isArray(arr) || !arr.every(isRecordLike)) return null
    out[table] = dedupe(arr)
  }
  return { version: 1, deviceId: raw.deviceId, records: out as unknown as RecordSet }
}

// ---------------------------------------------------------------- one pass

function count(set: RecordSet): number {
  return TABLES.reduce((n, t) => n + set[t].length, 0)
}

// Compare and write in a single transaction so a local edit cannot land
// between reading local state and writing the winners.
function applyRemote(remote: RecordSet): Promise<number> {
  return db.transaction(
    'rw',
    [db.vehicles, db.entries, db.issues, db.todos, db.serviceItems],
    async () => {
      const wins = winnersOver(await readAll(), remote)
      await putRaw(wins)
      return count(wins)
    },
  )
}

/**
 * One full sync cycle. Throws on any store failure (nothing local is modified
 * unless every download succeeded).
 */
export async function syncOnce(store: SyncStore): Promise<{ applied: number; skipped: string[] }> {
  const me = await getDeviceId()
  const mine = fileName(me)
  const refs = (await store.list()).filter((r) => FILE_NAME_RE.test(r.name) && r.name !== mine)

  // All network I/O first.
  const skipped: string[] = []
  const files: SyncFile[] = []
  for (const ref of refs) {
    const parsed = parseSyncFile(await store.read(ref.id))
    if (!parsed || parsed.deviceId === me) skipped.push(ref.name)
    else files.push(parsed)
  }

  // Then apply one file at a time; each re-reads local state inside its transaction.
  let applied = 0
  for (const f of files) applied += await applyRemote(f.records)

  const own: SyncFile = { version: 1, deviceId: me, records: ownRecords(await readAll(), me) }
  await store.writeOwn(mine, JSON.stringify(own))
  return { applied, skipped }
}

// ---------------------------------------------------------------- scheduler

let status: SyncStatus = 'pending'
let lastSynced: string | undefined
let skippedNames: string[] | undefined
const subscribers = new Set<StatusSubscriber>()

let activeStore: SyncStore | null = null
let epoch = 0 // bumped by stopSync so stale passes don't report
let inflight: Promise<void> | null = null
let dirty = false // a local change happened since the latest pass started
let lastPassOk = true
let debounceTimer: ReturnType<typeof setTimeout> | undefined
let onlineHandler: (() => void) | undefined
let visibilityHandler: (() => void) | undefined
let lastResumeAt = -Infinity

function emit(fn: StatusSubscriber): void {
  try {
    fn(status, lastSynced, skippedNames)
  } catch {
    // a broken subscriber must not break sync
  }
}

function setStatus(s: SyncStatus): void {
  status = s
  for (const fn of [...subscribers]) emit(fn)
}

export function subscribeStatus(fn: StatusSubscriber): () => void {
  subscribers.add(fn)
  emit(fn)
  return () => {
    subscribers.delete(fn)
  }
}

function clearDebounce(): void {
  if (debounceTimer !== undefined) clearTimeout(debounceTimer)
  debounceTimer = undefined
}

// Registered with the repo, which awaits it after committing writes: never throws.
function onLocalChange(): void {
  try {
    dirty = true
    if (!activeStore) return
    if (!inflight) setStatus('pending')
    clearDebounce()
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      void syncNow()
    }, DEBOUNCE_MS)
  } catch {
    // swallow: a failed notification must not fail the user's edit
  }
}

async function runPass(store: SyncStore, myEpoch: number): Promise<void> {
  clearDebounce()
  dirty = false
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    lastPassOk = false
    setStatus('offline')
    return
  }
  setStatus('syncing')
  try {
    const res = await syncOnce(store)
    if (myEpoch !== epoch) return
    lastPassOk = true
    lastSynced = new Date().toISOString()
    skippedNames = res.skipped
    setStatus(dirty ? 'pending' : 'synced')
  } catch (e) {
    if (myEpoch !== epoch) return
    lastPassOk = false
    setStatus(e instanceof FolderError ? 'no-folder' : e instanceof AuthError ? 'sign-in' : 'error')
  }
}

/**
 * Run a sync now. Never rejects. If one is already running, waits for it
 * instead of starting a concurrent one, and runs one more pass afterwards if a
 * local change happened meanwhile.
 */
export async function syncNow(): Promise<void> {
  const store = activeStore
  if (!store) return
  if (inflight) {
    await inflight
    if (inflight) return inflight // a sibling waiter already started the follow-up
    if (activeStore === store && dirty && lastPassOk) return syncNow()
    return
  }
  const p: Promise<void> = runPass(store, epoch).finally(() => {
    if (inflight === p) inflight = null
  })
  inflight = p
  await p
}

/** True between startSync and stopSync. */
export function isSyncRunning(): boolean {
  return activeStore !== null
}

export function startSync(store: SyncStore): void {
  stopSync()
  activeStore = store
  setLocalChangeListener(onLocalChange)
  onlineHandler = () => void syncNow()
  window.addEventListener('online', onlineHandler)
  // Resuming a backgrounded PWA fires no 'online'; pull what other devices wrote meanwhile.
  lastResumeAt = -Infinity
  visibilityHandler = () => {
    if (document.visibilityState !== 'visible') return
    const now = Date.now()
    if (now - lastResumeAt < RESUME_THROTTLE_MS) return
    lastResumeAt = now
    void syncNow()
  }
  document.addEventListener('visibilitychange', visibilityHandler)
  void syncNow()
}

/** Remove listeners and timers and reset state (tests, sign-out). */
export function stopSync(): void {
  epoch++
  activeStore = null
  inflight = null
  dirty = false
  lastPassOk = true
  lastSynced = undefined
  skippedNames = undefined
  clearDebounce()
  setLocalChangeListener(() => {})
  if (onlineHandler) window.removeEventListener('online', onlineHandler)
  onlineHandler = undefined
  if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler)
  visibilityHandler = undefined
  setStatus('pending')
}
