import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { readAll } from '../db/repo'
import { formatEntryDate } from '../model/dates'
import { TAGS, type Tag } from '../model/types'
import { search, type SearchHit } from '../search/search'

const KIND_LABELS: Record<SearchHit['kind'], string> = {
  entry: 'Entry',
  issue: 'Issue',
  todo: 'To-do',
  info: 'Info',
}

function hitPath(hit: SearchHit, issueIdOfTodo: Map<string, string | undefined>): string {
  switch (hit.kind) {
    case 'entry':
      return `/vehicle/${hit.vehicleId}/log`
    case 'issue':
      return `/issue/${hit.id}`
    case 'todo': {
      const issueId = issueIdOfTodo.get(hit.id)
      return issueId ? `/issue/${issueId}` : `/vehicle/${hit.vehicleId}`
    }
    case 'info':
      return `/vehicle/${hit.vehicleId}/info`
  }
}

/** The snippet with every occurrence of `query` wrapped in <mark> (built as elements, never HTML). */
function highlight(snippet: string, query: string): ReactNode[] {
  const needle = query.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!needle) return [snippet]
  const lower = snippet.toLowerCase()
  const parts: ReactNode[] = []
  let from = 0
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push(snippet.slice(from, at))
    from = at + needle.length
    parts.push(<mark key={at}>{snippet.slice(at, from)}</mark>)
  }
  if (from < snippet.length) parts.push(snippet.slice(from))
  return parts
}

export default function SearchPage() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const vehicleId = params.get('v') ?? ''
  const tagParam = params.get('t')
  const tag = TAGS.find((t) => t === tagParam)

  const set = useLiveQuery(readAll)

  const hits = useMemo(
    () => (set ? search(set, q, { vehicleId: vehicleId || undefined, tag }) : []),
    [set, q, vehicleId, tag],
  )

  const lookups = useMemo(() => {
    const vehicles = new Map((set?.vehicles ?? []).map((v) => [v.id, v]))
    const entries = new Map((set?.entries ?? []).map((e) => [e.id, e]))
    const todoIssue = new Map((set?.todos ?? []).map((t) => [t.id, t.issueId]))
    return { vehicles, entries, todoIssue }
  }, [set])

  const liveVehicles = (set?.vehicles ?? [])
    .filter((v) => !v.deleted)
    .sort((a, b) => a.name.localeCompare(b.name))

  // Replace rather than push, so one Back leaves the search instead of undoing each keystroke.
  function update(change: { q?: string; v?: string; t?: Tag | '' }) {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(change)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    setParams(next, { replace: true })
  }

  const hasCriteria = q.trim() !== '' || vehicleId !== '' || tag !== undefined

  return (
    <section className="search-page">
      <h2 className="entry-title">Search</h2>
      <label className="field">
        <span className="field-label">Search</span>
        <input
          type="search"
          className="search-input"
          autoFocus
          value={q}
          placeholder="Torque, rebound, shop, issue…"
          onChange={(ev) => update({ q: ev.target.value })}
        />
      </label>
      <label className="field">
        <span className="field-label">Vehicle</span>
        <select value={vehicleId} onChange={(ev) => update({ v: ev.target.value })}>
          <option value="">All vehicles</option>
          {liveVehicles.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </label>
      <div className="tag-row">
        {TAGS.map((t) => (
          <button
            key={t}
            type="button"
            className="tag-chip"
            aria-pressed={tag === t}
            onClick={() => update({ t: tag === t ? '' : t })}
          >
            {t}
          </button>
        ))}
      </div>

      {!hasCriteria && (
        <p className="empty muted">Type to search all your logs, or pick a vehicle or tag.</p>
      )}
      {hasCriteria && set && hits.length === 0 && <p className="empty">No matches.</p>}
      {hits.length > 0 && (
        <ul className="card-list">
          {hits.map((hit) => {
            const entry = hit.kind === 'entry' ? lookups.entries.get(hit.id) : undefined
            return (
              <li key={`${hit.kind}-${hit.id}`}>
                <Link className="card result" to={hitPath(hit, lookups.todoIssue)}>
                  <span className="result-meta">
                    <span className="badge">{KIND_LABELS[hit.kind]}</span>
                    <span>{lookups.vehicles.get(hit.vehicleId)?.name}</span>
                    {entry && <span className="muted">{formatEntryDate(entry.date)}</span>}
                  </span>
                  <span className="result-snippet">{highlight(hit.snippet, q)}</span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
