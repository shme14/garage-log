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

/** A real calendar date: YYYY-MM-DD for 'day', YYYY-MM for 'month'. */
export function isValidEntryDate(d: EntryDate): boolean {
  const m =
    d.precision === 'month'
      ? /^(\d{4})-(0[1-9]|1[0-2])$/.exec(d.value)
      : /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.value)
  if (!m) return false
  if (d.precision === 'month') return true
  const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || day < 1) return false
  return day <= new Date(Date.UTC(y, mo, 0)).getUTCDate()
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
