import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { vehiclesLive } from '../db/repo'
import VehicleCard from './VehicleCard'

export default function Garage({ today }: { today?: Date }) {
  const vehicles = useLiveQuery(vehiclesLive)
  // A phone PWA can sit open for days: refresh "today" whenever the app comes back to the foreground.
  const [now, setNow] = useState(() => today ?? new Date())
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') setNow(today ?? new Date())
    }
    document.addEventListener('visibilitychange', refresh)
    return () => document.removeEventListener('visibilitychange', refresh)
  }, [today])
  const shown = vehicles?.filter((v) => !v.archived)

  return (
    <section className="garage">
      {shown && shown.length === 0 && (
        <p className="empty">
          No vehicles yet. <Link to="/settings">Add one in Settings</Link>.
        </p>
      )}
      {shown && shown.length > 0 && (
        <ul className="card-list">
          {shown.map((v) => (
            <li key={v.id}>
              <VehicleCard vehicle={v} today={now} />
            </li>
          ))}
        </ul>
      )}
      <Link to="/entry/new" className="fab" aria-label="Add entry">
        +
      </Link>
    </section>
  )
}
