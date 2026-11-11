import { compareEntriesDesc, toDate } from '../model/dates'
import type { Entry, ServiceItem, Vehicle } from '../model/types'

export type DueState = 'ok' | 'due-soon' | 'overdue' | 'never-done'

export interface DueInfo {
  state: DueState
  lastDone?: Entry
  remainingAmount?: number
  dueDate?: Date
}

/** Highest reading recorded for a meter across non-deleted entries, or undefined if none. */
export function currentReading(entries: Entry[], meterId: string): number | undefined {
  let max: number | undefined
  for (const e of entries) {
    if (e.deleted) continue
    const r = e.readings[meterId]
    if (typeof r === 'number' && (max === undefined || r > max)) max = r
  }
  return max
}

type Part = 'ok' | 'due-soon' | 'overdue'
const SEVERITY: Record<Part, number> = { ok: 0, 'due-soon': 1, overdue: 2 }

function worst(a: Part, b: Part): Part {
  return SEVERITY[a] >= SEVERITY[b] ? a : b
}

/** Local midnight of (year, month + months, same day-of-month). */
function addMonths(d: Date, months: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + months, d.getDate())
}

export function dueStatus(
  item: ServiceItem,
  vehicle: Vehicle,
  entries: Entry[],
  today: Date,
): DueInfo {
  const lastDone = entries
    .filter((e) => !e.deleted && e.serviceItemIds.includes(item.id))
    .sort(compareEntriesDesc)[0]
  if (!lastDone) return { state: 'never-done' }

  let state: Part = 'ok'
  const info: DueInfo = { state, lastDone }

  // Meter part: skipped unless the meter exists on the vehicle and the last-done entry recorded it.
  const { intervalMeterId, intervalAmount, intervalMonths } = item
  if (
    intervalMeterId !== undefined &&
    intervalAmount !== undefined &&
    vehicle.meters.some((m) => m.id === intervalMeterId)
  ) {
    const lastReading = lastDone.readings[intervalMeterId]
    const current = currentReading(entries, intervalMeterId)
    if (typeof lastReading === 'number' && current !== undefined) {
      const remaining = lastReading + intervalAmount - current
      info.remainingAmount = remaining
      if (remaining < 0) state = worst(state, 'overdue')
      else if (remaining <= 0.1 * intervalAmount) state = worst(state, 'due-soon')
    }
  }

  // Time part. Compare at day granularity using today's local calendar date, so a UTC-vs-local
  // offset on the given Date can't flip a boundary.
  if (intervalMonths !== undefined) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    const dueDate = addMonths(toDate(lastDone.date), intervalMonths)
    info.dueDate = dueDate
    if (day > dueDate) state = worst(state, 'overdue')
    else if (day >= addMonths(dueDate, -1)) state = worst(state, 'due-soon')
  }

  info.state = state
  return info
}
