import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { entriesForVehicle, issuesForVehicle, serviceItemsForVehicle } from '../db/repo'
import type { Vehicle } from '../model/types'
import { currentReading, dueStatus } from '../service/due'

export default function VehicleCard({ vehicle, today }: { vehicle: Vehicle; today: Date }) {
  const id = vehicle.id
  const entries = useLiveQuery(() => entriesForVehicle(id), [id])
  const issues = useLiveQuery(() => issuesForVehicle(id), [id])
  const items = useLiveQuery(() => serviceItemsForVehicle(id), [id])

  const openCount = issues?.filter((i) => i.status === 'open').length ?? 0
  const dueCount =
    entries && items
      ? items.filter((item) => {
          const s = dueStatus(item, vehicle, entries, today).state
          return s === 'due-soon' || s === 'overdue'
        }).length
      : 0

  return (
    <Link to={`/vehicle/${id}`} className="card">
      <span className="card-name">{vehicle.name}</span>
      {vehicle.meters.length > 0 && (
        <span className="card-readings">
          {vehicle.meters.map((m) => {
            const value = entries ? currentReading(entries, m.id) : undefined
            return (
              <span key={m.id} className="reading">
                {value === undefined ? '—' : `${value.toLocaleString('en-CA')} ${m.unit}`}
              </span>
            )
          })}
        </span>
      )}
      {(openCount > 0 || dueCount > 0) && (
        <span className="card-badges">
          {openCount > 0 && <span className="badge badge-open">{openCount} open</span>}
          {dueCount > 0 && <span className="badge badge-due">{dueCount} due</span>}
        </span>
      )}
    </Link>
  )
}
