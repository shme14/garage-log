import Dexie, { type EntityTable } from 'dexie'
import type { EditContext } from '../model/records'
import type { Entry, Issue, ServiceItem, Todo, Vehicle } from '../model/types'

export interface MetaRow {
  key: string
  value: string
}

export class GarageDB extends Dexie {
  vehicles!: EntityTable<Vehicle, 'id'>
  entries!: EntityTable<Entry, 'id'>
  issues!: EntityTable<Issue, 'id'>
  todos!: EntityTable<Todo, 'id'>
  serviceItems!: EntityTable<ServiceItem, 'id'>
  meta!: EntityTable<MetaRow, 'key'>

  constructor() {
    super('garage-log')
    this.version(1).stores({
      vehicles: 'id',
      entries: 'id, vehicleId, issueId',
      issues: 'id, vehicleId',
      todos: 'id, vehicleId, issueId',
      serviceItems: 'id, vehicleId',
      meta: 'key',
    })
  }
}

export const db = new GarageDB()

export async function getDeviceId(): Promise<string> {
  return db.transaction('rw', db.meta, async () => {
    const row = await db.meta.get('deviceId')
    if (row) return row.value
    const value = crypto.randomUUID()
    await db.meta.put({ key: 'deviceId', value })
    return value
  })
}

export async function getUser(): Promise<string | undefined> {
  return (await db.meta.get('user'))?.value
}

export async function setUser(name: string): Promise<void> {
  await db.meta.put({ key: 'user', value: name })
}

export async function getEditContext(): Promise<EditContext> {
  const [deviceId, user] = await Promise.all([getDeviceId(), getUser()])
  return { user: user ?? 'Me', deviceId }
}
