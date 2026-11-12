import { db } from '../db/db'
import { putRaw, vehiclesLive } from '../db/repo'
import type { EditContext } from '../model/records'
import {
  TAGS,
  type BaseRecord,
  type Entry,
  type Issue,
  type RecordSet,
  type ServiceItem,
  type TableName,
  type Todo,
  type Vehicle,
} from '../model/types'

/** A seed record: no base fields except a stable id; stamped by loadSeed. */
type Seed<T, Extra extends string = never> = Omit<T, keyof BaseRecord | Extra> & { id: string }

export interface SeedSet {
  vehicles: Seed<Vehicle, 'infoUpdatedAt'>[]
  entries: Seed<Entry, 'createdBy'>[]
  issues: Seed<Issue>[]
  todos: Seed<Todo>[]
  serviceItems: Seed<ServiceItem>[]
}

/** File order, which is also the stamping order. */
const TABLES: TableName[] = ['vehicles', 'issues', 'serviceItems', 'todos', 'entries']
const KINDS = ['truck', 'car', 'bike', 'ebike', 'other']
const STATUSES = ['open', 'parked', 'resolved']

type Rec = Record<string, unknown>

function isObject(x: unknown): x is Rec {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

const isNonEmptyString = (x: unknown): x is string => typeof x === 'string' && x.trim() !== ''

/** A real calendar date: YYYY-MM-DD for 'day', YYYY-MM for 'month'. */
function isValidDate(precision: unknown, value: unknown): boolean {
  if (typeof value !== 'string') return false
  const m =
    precision === 'day'
      ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
      : precision === 'month'
        ? /^(\d{4})-(\d{2})$/.exec(value)
        : null
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), m[3] === undefined ? 1 : Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1) return false
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate()
}

/**
 * Checks a seed file's shape and every cross-reference, returning it typed.
 * Throws an Error naming the first bad record ("entries/e-truck-03: …").
 */
export function validateSeed(json: unknown): SeedSet {
  if (!isObject(json)) throw new Error('Seed must be a JSON object')
  for (const t of TABLES) {
    if (!Array.isArray(json[t])) throw new Error(`Seed is missing the ${t} array`)
  }
  const tables = json as Record<TableName, unknown[]>

  const ids: Record<TableName, Map<string, Rec>> = {
    vehicles: new Map(),
    entries: new Map(),
    issues: new Map(),
    todos: new Map(),
    serviceItems: new Map(),
  }
  for (const t of TABLES) {
    tables[t].forEach((rec, i) => {
      if (!isObject(rec)) throw new Error(`${t}[${i}]: not an object`)
      if (!isNonEmptyString(rec.id)) throw new Error(`${t}[${i}]: missing string id`)
      if (ids[t].has(rec.id)) throw new Error(`${t}/${rec.id}: duplicate id`)
      ids[t].set(rec.id, rec)
    })
  }

  const failer =
    (table: TableName, rec: Rec) =>
    (why: string): never => {
      throw new Error(`${table}/${rec.id as string}: ${why}`)
    }

  const meterIds = new Map<string, Set<string>>()
  for (const v of ids.vehicles.values()) {
    const fail = failer('vehicles', v)
    if (!isNonEmptyString(v.name)) fail('missing name')
    if (!KINDS.includes(v.kind as string)) fail(`unknown kind "${String(v.kind)}"`)
    if (typeof v.info !== 'string') fail('info must be a string')
    if (typeof v.archived !== 'boolean') fail('archived must be true or false')
    if (!Array.isArray(v.meters)) fail('meters must be an array')
    const own = new Set<string>()
    for (const m of v.meters as unknown[]) {
      if (!isObject(m) || !isNonEmptyString(m.id) || !isNonEmptyString(m.name)) {
        fail('each meter needs an id and a name')
      }
      const meter = m as Rec
      if (meter.unit !== 'km' && meter.unit !== 'h') {
        fail(`meter ${String(meter.id)} has unknown unit "${String(meter.unit)}"`)
      }
      if (own.has(meter.id as string)) fail(`duplicate meter id ${String(meter.id)}`)
      own.add(meter.id as string)
    }
    meterIds.set(v.id as string, own)
  }

  /** Checks rec.vehicleId and, if given, that an issue reference belongs to the same vehicle. */
  function checkVehicle(rec: Rec, fail: (why: string) => never) {
    if (!ids.vehicles.has(rec.vehicleId as string)) {
      fail(`unknown vehicleId "${String(rec.vehicleId)}"`)
    }
    if (rec.issueId !== undefined) {
      const issue = ids.issues.get(rec.issueId as string)
      if (!issue) fail(`unknown issueId "${String(rec.issueId)}"`)
      else if (issue.vehicleId !== rec.vehicleId) {
        fail(`issueId "${String(rec.issueId)}" belongs to another vehicle`)
      }
    }
  }

  for (const i of ids.issues.values()) {
    const fail = failer('issues', i)
    checkVehicle(i, fail)
    if (!isNonEmptyString(i.title)) fail('missing title')
    if (!STATUSES.includes(i.status as string)) fail(`unknown status "${String(i.status)}"`)
  }

  for (const s of ids.serviceItems.values()) {
    const fail = failer('serviceItems', s)
    checkVehicle(s, fail)
    if (!isNonEmptyString(s.name)) fail('missing name')
    const hasMeter = s.intervalMeterId !== undefined || s.intervalAmount !== undefined
    if (hasMeter) {
      if (!meterIds.get(s.vehicleId as string)?.has(s.intervalMeterId as string)) {
        fail(`intervalMeterId "${String(s.intervalMeterId)}" is not a meter of its vehicle`)
      }
      if (typeof s.intervalAmount !== 'number' || !(s.intervalAmount > 0)) {
        fail('intervalAmount must be a positive number')
      }
    }
    const hasMonths = s.intervalMonths !== undefined
    if (hasMonths && !(Number.isInteger(s.intervalMonths) && (s.intervalMonths as number) > 0)) {
      fail('intervalMonths must be a positive whole number')
    }
    if (!hasMeter && !hasMonths) fail('needs a meter interval or intervalMonths')
  }

  for (const t of ids.todos.values()) {
    const fail = failer('todos', t)
    checkVehicle(t, fail)
    if (!isNonEmptyString(t.text)) fail('missing text')
    if (typeof t.done !== 'boolean') fail('done must be true or false')
  }

  for (const e of ids.entries.values()) {
    const fail = failer('entries', e)
    checkVehicle(e, fail)
    const date = e.date
    if (!isObject(date) || !isValidDate(date.precision, date.value)) {
      fail(`invalid date ${JSON.stringify(date)}`)
    }
    if (!isObject(e.readings)) fail('readings must be an object')
    const meters = meterIds.get(e.vehicleId as string)!
    for (const [key, value] of Object.entries(e.readings as Rec)) {
      if (!meters.has(key)) fail(`reading for "${key}", which is not a meter of its vehicle`)
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        fail(`reading for "${key}" must be a non-negative number`)
      }
    }
    if (!isNonEmptyString(e.text)) fail('missing text')
    if (!Array.isArray(e.tags)) fail('tags must be an array')
    for (const tag of e.tags as unknown[]) {
      if (!TAGS.includes(tag as never)) fail(`unknown tag "${String(tag)}"`)
    }
    if (e.cost !== undefined && (typeof e.cost !== 'number' || !Number.isFinite(e.cost))) {
      fail('cost must be a number')
    }
    if (e.shop !== undefined && typeof e.shop !== 'string') fail('shop must be a string')
    if (!Array.isArray(e.serviceItemIds)) fail('serviceItemIds must be an array')
    for (const sid of e.serviceItemIds as unknown[]) {
      const item = ids.serviceItems.get(sid as string)
      if (!item) fail(`unknown service item "${String(sid)}"`)
      else if (item.vehicleId !== e.vehicleId) {
        fail(`service item "${String(sid)}" belongs to another vehicle`)
      }
    }
  }

  return {
    vehicles: [...ids.vehicles.values()],
    entries: [...ids.entries.values()],
    issues: [...ids.issues.values()],
    todos: [...ids.todos.values()],
    serviceItems: [...ids.serviceItems.values()],
  } as unknown as SeedSet
}

/**
 * Validates the seed, then writes every record stamped with `ctx`: createdAt/updatedAt are
 * ctx.now + its position in the file in ms (so same-date entries keep the note's order).
 * Refuses if the garage already has a live vehicle. Returns the number of records written.
 */
export async function loadSeed(json: unknown, ctx: EditContext): Promise<number> {
  const seed = validateSeed(json)
  const start = (ctx.now ?? new Date()).getTime()
  let i = 0
  const stamp = () => {
    const ts = new Date(start + i++).toISOString()
    return {
      createdAt: ts,
      updatedAt: ts,
      updatedBy: ctx.user,
      updatedByDevice: ctx.deviceId,
      deleted: false,
    }
  }
  const out: RecordSet = { vehicles: [], entries: [], issues: [], todos: [], serviceItems: [] }
  for (const v of seed.vehicles) {
    const base = stamp()
    out.vehicles.push({ ...v, ...base, infoUpdatedAt: base.createdAt })
  }
  for (const r of seed.issues) out.issues.push({ ...r, ...stamp() })
  for (const r of seed.serviceItems) out.serviceItems.push({ ...r, ...stamp() })
  for (const r of seed.todos) out.todos.push({ ...r, ...stamp() })
  for (const e of seed.entries) out.entries.push({ ...e, ...stamp(), createdBy: ctx.user })

  await db.transaction(
    'rw',
    [db.vehicles, db.entries, db.issues, db.todos, db.serviceItems],
    async () => {
      if ((await vehiclesLive()).length > 0) throw new Error('Garage already has vehicles')
      await putRaw(out)
    },
  )
  return i
}
