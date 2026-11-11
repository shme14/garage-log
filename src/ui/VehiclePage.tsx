import { useLiveQuery } from 'dexie-react-hooks'
import { Link, useParams } from 'react-router-dom'
import { db } from '../db/db'
import { entriesForVehicle, issuesForVehicle, serviceItemsForVehicle } from '../db/repo'
import { compareEntriesDesc } from '../model/dates'
import EntryCard from './EntryCard'
import InfoTab from './InfoTab'
import ServiceTab, { ServiceStatus } from './ServiceTab'
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
      }
    },
    [id],
  )

  if (!data || data.vid !== id) return null
  const { vehicle, entries, issues, items } = data
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

  return (
    <section className="vehicle-page">
      <div className="vehicle-head">
        <h2 className="vehicle-name">{vehicle.name}</h2>
        <Link to={`/vehicles/${vehicle.id}/edit`}>Edit vehicle</Link>
      </div>
      <Link to={`/entry/new?vehicle=${vehicle.id}`} className="btn btn-primary btn-block">
        Add entry
      </Link>

      <div className="panel">
        <h3>Open issues</h3>
        {openIssues.length === 0 && <p className="muted">No open issues.</p>}
        <ul className="plain-list">
          {openIssues.map((i) => (
            <li key={i.id}>
              <Link to={`/issue/${i.id}`} className="row-link">
                {i.title}
              </Link>
            </li>
          ))}
        </ul>
        {parked.length > 0 && (
          <details className="parked">
            <summary>Parked ({parked.length})</summary>
            <ul className="plain-list">
              {parked.map((i) => (
                <li key={i.id}>
                  <Link to={`/issue/${i.id}`} className="row-link">
                    {i.title}
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <div className="panel">
        <h3>Todos</h3>
        <TodoList vehicleId={vehicle.id} />
      </div>

      {items.length > 0 && (
        <div className="panel">
          <h3>Service due</h3>
          <ul className="plain-list">
            {items.map((item) => (
              <li key={item.id} className="service-row">
                <span className="service-name">{item.name}</span>
                <span className="service-state">
                  <ServiceStatus item={item} vehicle={vehicle} entries={entries} today={now} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

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
