export interface BaseRecord {
  id: string // UUID v4
  createdAt: string // ISO timestamp
  updatedAt: string // ISO timestamp, set on every change
  updatedBy: string // Google account display name/email of last editor
  updatedByDevice: string // deviceId of last editor (merge tie-break)
  deleted: boolean // tombstone; deleted records are hidden but kept for sync
}

export interface Vehicle extends BaseRecord {
  name: string // "2021 F150", "Relay", "Sparky"
  kind: 'truck' | 'car' | 'bike' | 'ebike' | 'other'
  info: string // free-text reference page (purchase details, config codes, weights, links)
  infoUpdatedAt: string // shown as "edited on"
  meters: Meter[] // ordered; may be empty
  archived: boolean
}

export interface Meter {
  id: string
  name: string // "Odometer", "Engine hours", "Bike km", "Motor km"
  unit: 'km' | 'h'
}

export type EntryDate =
  | { precision: 'day'; value: string } // "2025-11-11"
  | { precision: 'month'; value: string } // "2026-06"

export type Tag = 'maintenance' | 'repair' | 'mod' | 'diagnosis' | 'setup' | 'warranty'

export const TAGS: readonly Tag[] = [
  'maintenance',
  'repair',
  'mod',
  'diagnosis',
  'setup',
  'warranty',
]

export interface Entry extends BaseRecord {
  vehicleId: string
  date: EntryDate
  readings: Record<string, number> // meterId -> value; any subset, may be empty
  text: string
  tags: Tag[]
  cost?: number // CAD
  shop?: string // free text, autocompleted from previous values
  issueId?: string
  serviceItemIds: string[] // service items this entry completes
  createdBy: string // author shown on the entry
}

export interface Issue extends BaseRecord {
  vehicleId: string
  title: string // "Motor mount creak"
  status: 'open' | 'parked' | 'resolved'
}

export interface Todo extends BaseRecord {
  vehicleId: string
  issueId?: string
  text: string // "Try locking out hubs engaged"
  done: boolean
}

export interface ServiceItem extends BaseRecord {
  vehicleId: string
  name: string // "Oil change"
  intervalMeterId?: string // which meter the distance/hour interval uses
  intervalAmount?: number // e.g. 8000 (km) or 50 (h)
  intervalMonths?: number // e.g. 12
}

export type TableName = 'vehicles' | 'entries' | 'issues' | 'todos' | 'serviceItems'

export interface RecordSet {
  vehicles: Vehicle[]
  entries: Entry[]
  issues: Issue[]
  todos: Todo[]
  serviceItems: ServiceItem[]
}

export function emptySet(): RecordSet {
  return { vehicles: [], entries: [], issues: [], todos: [], serviceItems: [] }
}
