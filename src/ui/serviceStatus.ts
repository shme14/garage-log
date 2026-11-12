import { formatEntryDate, todayEntryDate } from '../model/dates'
import type { Entry, ServiceItem, Vehicle } from '../model/types'
import { dueStatus, type DueState } from '../service/due'

const PILL: Record<DueState, { label: string; className: string }> = {
  ok: { label: 'OK', className: 'pill pill-ok' },
  'due-soon': { label: 'Due soon', className: 'pill pill-soon' },
  overdue: { label: 'Overdue', className: 'pill pill-over' },
  'never-done': { label: 'Never done', className: 'pill pill-never' },
}

export const num = (n: number) => n.toLocaleString('en-CA')

export interface StatusProps {
  item: ServiceItem
  vehicle: Vehicle
  /** Only this vehicle's entries: the due calculation is not vehicle-scoped. */
  entries: Entry[]
  today: Date
}

/** State pill class + label (the text always carries the state) and the remaining amount / due date. */
export function serviceStatusParts({ item, vehicle, entries, today }: StatusProps) {
  const info = dueStatus(item, vehicle, entries, today)
  const pill = PILL[info.state]
  const unit = vehicle.meters.find((m) => m.id === item.intervalMeterId)?.unit
  const parts: string[] = []
  if (info.remainingAmount !== undefined && unit) {
    const r = info.remainingAmount
    parts.push(r >= 0 ? `${num(r)} ${unit} left` : `${num(-r)} ${unit} over`)
  }
  if (info.dueDate) parts.push(`due ${formatEntryDate(todayEntryDate(info.dueDate))}`)
  return { pill, parts }
}

