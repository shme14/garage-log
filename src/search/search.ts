import { compareEntriesDesc } from '../model/dates'
import type { RecordSet, Tag } from '../model/types'

export interface SearchHit {
  kind: 'entry' | 'issue' | 'todo' | 'info'
  /** Record id; for `info` hits this is the vehicle's id. */
  id: string
  vehicleId: string
  snippet: string
}

export interface SearchFilters {
  vehicleId?: string
  tag?: Tag
}

const SNIPPET_LENGTH = 100

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()

/** ~100 characters of `text` centred on the match at `at`, with "…" where text was cut. */
function snippetAround(text: string, at: number, matchLength: number): string {
  if (text.length <= SNIPPET_LENGTH) return text
  let start = Math.max(0, at + Math.floor(matchLength / 2) - Math.floor(SNIPPET_LENGTH / 2))
  const end = Math.min(text.length, start + SNIPPET_LENGTH)
  start = Math.max(0, end - SNIPPET_LENGTH)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/**
 * Case-insensitive substring search over entry text and shop, issue titles, todo text and vehicle
 * info pages. Deleted records, and records of deleted vehicles, never match. A tag filter applies
 * to entries only, so it excludes every other kind. An empty query lists all entries that pass the
 * filters (and nothing at all when there are no filters). Results: entries newest first, then
 * issues, todos, info.
 */
export function search(set: RecordSet, query: string, filters: SearchFilters): SearchHit[] {
  const needle = collapse(query).toLowerCase()
  const { vehicleId, tag } = filters
  if (needle === '' && !vehicleId && !tag) return []

  const deletedVehicles = new Set(set.vehicles.filter((v) => v.deleted).map((v) => v.id))
  const visible = (r: { deleted: boolean; vehicleId: string }) =>
    !r.deleted && !deletedVehicles.has(r.vehicleId) && (!vehicleId || r.vehicleId === vehicleId)

  /** The snippet for the first of `fields` containing the query, or undefined if none does. */
  const match = (...fields: (string | undefined)[]): string | undefined => {
    for (const field of fields) {
      const text = collapse(field ?? '')
      const at = text.toLowerCase().indexOf(needle)
      if (at >= 0) return snippetAround(text, at, needle.length)
    }
    return undefined
  }

  const hits: SearchHit[] = []

  const entries = set.entries
    .filter((e) => visible(e) && (!tag || e.tags.includes(tag)))
    .sort(compareEntriesDesc)
  for (const e of entries) {
    const snippet = needle === '' ? snippetAround(collapse(e.text), 0, 0) : match(e.text, e.shop)
    if (snippet !== undefined) hits.push({ kind: 'entry', id: e.id, vehicleId: e.vehicleId, snippet })
  }

  // Without a query the result is the filtered entries; a tag filter admits entries only.
  if (needle === '' || tag) return hits

  for (const i of set.issues.filter(visible)) {
    const snippet = match(i.title)
    if (snippet !== undefined) hits.push({ kind: 'issue', id: i.id, vehicleId: i.vehicleId, snippet })
  }
  for (const t of set.todos.filter(visible)) {
    const snippet = match(t.text)
    if (snippet !== undefined) hits.push({ kind: 'todo', id: t.id, vehicleId: t.vehicleId, snippet })
  }
  for (const v of set.vehicles) {
    if (v.deleted || (vehicleId && v.id !== vehicleId)) continue
    const snippet = match(v.info)
    if (snippet !== undefined) hits.push({ kind: 'info', id: v.id, vehicleId: v.id, snippet })
  }
  return hits
}
