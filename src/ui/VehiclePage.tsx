import { useLiveQuery } from 'dexie-react-hooks'
import { Link, useParams } from 'react-router-dom'
import { db } from '../db/db'
import {
  entriesForVehicle,
  issuesForVehicle,
  serviceItemsForVehicle,
  todosForVehicle,
} from '../db/repo'
import { compareEntriesDesc } from '../model/dates'
import EntryCard from './EntryCard'
import InfoTab from './InfoTab'
import ServiceTab from './ServiceTab'
import { serviceStatusParts } from './serviceStatus'
import TodoList from './TodoList'
import { useToday } from './useToday'

const TABS = [
  { key: 'log', label: 'Log' },
  { key: 'info', label: 'Info' },
  { key: 'service', label: 'Service' },
] as const

export default function VehiclePage({ today }: { today?: Date }) {
  const { id = '', tab } = useParams()
  const now = useToday(today)

  // One query, tagged with its vehicle id so a stale result is never shown after the id changes.
  const data = useLiveQuery(
    async () => {
      const vehicle = await db.vehicles.get(id)
      return {
        vid: id,
        vehicle: vehicle && !vehicle.deleted ? vehicle : null,
        entries: await entriesForVehicle(id),
        issues: await issuesForVehicle(id),
        items: await serviceItemsForVehicle(id),
        todos: await todosForVehicle(id),
      }
    },
    [id],
  )

  if (!data || data.vid !== id) return null
  const { vehicle, entries, issues, items, todos } = data
  if (!vehicle) {
    return (
      <p className="empty">
        <span>Vehicle not found</span>. <Link to="/">Back to the garage</Link>.
      </p>
    )
  }

  const active = TABS.find((t) => t.key === tab)?.key ?? 'log'
  const openIssues = issues.filter((i) => i.status === 'open')
  const parked = issues.filter((i) => i.status === 'parked')

  const todoCount = todos.filter((t) => !t.done && t.issueId === undefined).length

  const issueLinks = (list: typeof issues) => (
    <ul className="plain-list">
      {list.map((i) => (
        <li key={i.id}>
          <Link to={`/issue/${i.id}`} className="row-link">
            {i.title}
          </Link>
        </li>
      ))}
    </ul>
  )
  const parkedList = parked.length > 0 && (
    <details className="parked">
      <summary>Parked ({parked.length})</summary>
      {issueLinks(parked)}
    </details>
  )

  return (
    <section className="vehicle-page">
      <div className="vehicle-head">
        <h2 className="vehicle-name">{vehicle.name}</h2>
        <div className="vehicle-actions">
          <Link to={`/vehicles/${vehicle.id}/edit`} className="head-link" aria-label="Edit vehicle">
            Edit
          </Link>
          <Link
            to={`/entry/new?vehicle=${vehicle.id}`}
            className="btn btn-primary btn-compact"
            aria-label="Add entry"
          >
            + Entry
          </Link>
        </div>
      </div>

      <div className="summaries">
        {openIssues.length > 0 ? (
          <details className="sum">
            <summary>
              <span className="sum-pill sum-warn">
                <span aria-hidden="true">⚠ </span>
                {openIssues.length} open {openIssues.length === 1 ? 'issue' : 'issues'}
              </span>
            </summary>
            <div className="sum-body">
              {issueLinks(openIssues)}
              {parkedList}
            </div>
          </details>
        ) : parked.length > 0 ? (
          <details className="sum">
            <summary>
              <span className="sum-pill">Parked ({parked.length})</span>
            </summary>
            <div className="sum-body">{issueLinks(parked)}</div>
          </details>
        ) : (
          <span className="sum-plain muted">No open issues</span>
        )}

        <details className="sum">
          <summary>
            <span className={todoCount > 0 ? 'sum-pill' : 'sum-pill sum-quiet'}>
              {todoCount > 0 ? (
                <>
                  <span aria-hidden="true">☐ </span>
                  {todoCount} {todoCount === 1 ? 'to-do' : 'to-dos'}
                </>
              ) : (
                'No to-dos'
              )}
            </span>
          </summary>
          <div className="sum-body">
            <TodoList vehicleId={vehicle.id} />
          </div>
        </details>

        {items.map((item) => {
          const { pill, parts, state } = serviceStatusParts({ item, vehicle, entries, today: now })
          return (
            <details key={item.id} className="sum">
              <summary>
                <span className={`sum-pill ${pill.className}`}>
                  {item.name}: {pill.label}
                </span>
              </summary>
              <div className="sum-body">
                {parts.length > 0 ? (
                  parts.map((p) => (
                    <span key={p} className="service-detail muted">
                      {p}
                    </span>
                  ))
                ) : (
                  <span className="muted">
                    {state === 'never-done' ? 'No service logged yet' : 'No due estimate'}
                  </span>
                )}
              </div>
            </details>
          )
        })}
      </div>

      <nav className="tabs" aria-label="Vehicle sections">
        {TABS.map((t) => (
          <Link
            key={t.key}
            to={`/vehicle/${vehicle.id}/${t.key}`}
            className="tab"
            aria-current={t.key === active ? 'page' : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {active === 'log' && (
        <div className="log">
          {entries.length === 0 && <p className="empty">No entries yet.</p>}
          {[...entries].sort(compareEntriesDesc).map((e) => (
            <EntryCard key={e.id} entry={e} vehicle={vehicle} showIssue />
          ))}
        </div>
      )}
      {active === 'info' && <InfoTab key={vehicle.id} vehicle={vehicle} />}
      {active === 'service' && (
        <ServiceTab vehicle={vehicle} items={items} entries={entries} today={now} />
      )}
    </section>
  )
}
