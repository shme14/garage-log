import { compareEntriesDesc, formatEntryDate } from '../model/dates'
import type { Entry, RecordSet, Vehicle } from '../model/types'

/** The whole data set, tombstones included, so nothing is ever trapped in the app. */
export function exportJson(set: RecordSet, now: Date = new Date()): string {
  return JSON.stringify({ version: 1, exportedAt: now.toISOString(), records: set }, null, 2)
}

const number = new Intl.NumberFormat('en-CA')

/** "159,500 km · 2,566 h" in the vehicle's meter order; readings for unknown meters are dropped. */
function formatReadings(vehicle: Vehicle, entry: Entry): string {
  return vehicle.meters
    .filter((m) => typeof entry.readings[m.id] === 'number')
    .map((m) => `${number.format(entry.readings[m.id])} ${m.unit}`)
    .join(' · ')
}

function entryLine(vehicle: Vehicle, entry: Entry): string {
  const parts = [formatEntryDate(entry.date)]
  const readings = formatReadings(vehicle, entry)
  if (readings) parts.push(readings)
  parts.push(entry.text.replace(/\r\n?/g, '\n').replace(/\n/g, '\n  '))
  return parts.join(' — ')
}

/** A readable log grouped by vehicle (sorted by name), entries oldest to newest. */
export function exportText(set: RecordSet): string {
  const blocks = set.vehicles
    .filter((v) => !v.deleted)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((v) => {
      const lines = [`# ${v.name}`, '']
      const info = v.info.trim()
      if (info) lines.push(info, '')
      const entries = set.entries
        .filter((e) => e.vehicleId === v.id && !e.deleted)
        .sort((a, b) => compareEntriesDesc(b, a))
      for (const e of entries) lines.push(entryLine(v, e))
      return lines.join('\n').trimEnd()
    })
  return blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`
}

/** Local calendar date as YYYY-MM-DD, for download file names. */
export function localDateStamp(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${m}-${d}`
}

/** Saves `content` as a file via a temporary object URL and `<a download>`, then releases the URL. */
export function downloadFile(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoked a moment later: some browsers (iOS Safari) start the download asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
