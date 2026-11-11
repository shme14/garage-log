import type { Entry, EntryDate } from './types'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Sortable YYYY-MM-DD key; a month-precision date keys to the first of its month. */
export function dateKey(d: EntryDate): string {
  return d.precision === 'month' ? `${d.value}-01` : d.value
}

export function toDate(d: EntryDate): Date {
  const [y, m, day] = dateKey(d).split('-').map(Number)
  return new Date(y, m - 1, day)
}

export function todayEntryDate(now: Date = new Date()): EntryDate {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return { precision: 'day', value: `${y}-${m}-${day}` }
}

export function formatEntryDate(d: EntryDate): string {
  const [y, m, day] = dateKey(d).split('-').map(Number)
  const month = MONTHS[m - 1]
  return d.precision === 'month' ? `${month} ${y}` : `${month} ${day}, ${y}`
}

/** Newest first by date, ties broken by createdAt descending. */
export function compareEntriesDesc(a: Entry, b: Entry): number {
  const byDate = dateKey(b.date).localeCompare(dateKey(a.date))
  return byDate !== 0 ? byDate : b.createdAt.localeCompare(a.createdAt)
}
