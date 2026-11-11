import type { Table } from 'dexie'
import { db } from './db'
import { newRecord, touch, type EditContext } from '../model/records'
import type {
  BaseRecord,
  Entry,
  Issue,
  RecordSet,
  ServiceItem,
  TableName,
  Todo,
  Vehicle,
} from '../model/types'

let onLocalChange: () => void = () => {}

/** Called after every stamping mutation (not putRaw); sync uses it to schedule a push. */
export function setLocalChangeListener(fn: () => void): void {
  onLocalChange = fn
}

function table<T extends BaseRecord>(name: TableName): Table<T, string> {
  return db.table(name) as Table<T, string>
}

export async function create<T extends BaseRecord>(
  name: TableName,
  fields: Omit<T, keyof BaseRecord>,
  ctx: EditContext,
): Promise<T> {
  const rec = newRecord<T>(fields, ctx)
  await table<T>(name).add(rec)
  onLocalChange()
  return rec
}

export async function update<T extends BaseRecord>(
  name: TableName,
  rec: T,
  ctx: EditContext,
): Promise<T> {
  const stamped = touch(rec, ctx)
  await table<T>(name).put(stamped)
  onLocalChange()
  return stamped
}

async function setDeleted(name: TableName, id: string, deleted: boolean, ctx: EditContext) {
  await db.transaction('rw', db.table(name), async () => {
    const t = table<BaseRecord>(name)
    const rec = await t.get(id)
    if (!rec) throw new Error(`Cannot update ${name}/${id}: record not found`)
    await t.put({ ...touch(rec, ctx), deleted })
  })
  onLocalChange()
}

export function softDelete(name: TableName, id: string, ctx: EditContext): Promise<void> {
  return setDeleted(name, id, true, ctx)
}

export function restore(name: TableName, id: string, ctx: EditContext): Promise<void> {
  return setDeleted(name, id, false, ctx)
}

/** Everything, including tombstones. */
export async function readAll(): Promise<RecordSet> {
  const [vehicles, entries, issues, todos, serviceItems] = await Promise.all([
    db.vehicles.toArray(),
    db.entries.toArray(),
    db.issues.toArray(),
    db.todos.toArray(),
    db.serviceItems.toArray(),
  ])
  return { vehicles, entries, issues, todos, serviceItems }
}

/** Writes records exactly as given (no stamping, no change notification); for sync and import. */
export async function putRaw(set: Partial<RecordSet>): Promise<void> {
  await db.transaction(
    'rw',
    [db.vehicles, db.entries, db.issues, db.todos, db.serviceItems],
    async () => {
      if (set.vehicles) await db.vehicles.bulkPut(set.vehicles)
      if (set.entries) await db.entries.bulkPut(set.entries)
      if (set.issues) await db.issues.bulkPut(set.issues)
      if (set.todos) await db.todos.bulkPut(set.todos)
      if (set.serviceItems) await db.serviceItems.bulkPut(set.serviceItems)
    },
  )
}

const isLive = (r: BaseRecord) => !r.deleted

export async function vehiclesLive(): Promise<Vehicle[]> {
  return (await db.vehicles.toArray()).filter(isLive)
}

export async function entriesForVehicle(vehicleId: string): Promise<Entry[]> {
  return (await db.entries.where('vehicleId').equals(vehicleId).toArray()).filter(isLive)
}

export async function entriesForIssue(issueId: string): Promise<Entry[]> {
  return (await db.entries.where('issueId').equals(issueId).toArray()).filter(isLive)
}

export async function issuesForVehicle(vehicleId: string): Promise<Issue[]> {
  return (await db.issues.where('vehicleId').equals(vehicleId).toArray()).filter(isLive)
}

export async function todosForVehicle(vehicleId: string): Promise<Todo[]> {
  return (await db.todos.where('vehicleId').equals(vehicleId).toArray()).filter(isLive)
}

export async function serviceItemsForVehicle(vehicleId: string): Promise<ServiceItem[]> {
  return (await db.serviceItems.where('vehicleId').equals(vehicleId).toArray()).filter(isLive)
}
