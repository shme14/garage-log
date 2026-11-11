import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { db } from '../db/db'
import { formatEntryDate } from '../model/dates'
import type { Entry, Vehicle } from '../model/types'
import { useUndoDelete } from './UndoToast'

const cad = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })

interface Props {
  entry: Entry
  vehicle: Vehicle
  /** Show the linked issue's title as a link (omit on the issue page itself). */
  showIssue?: boolean
}

export default function EntryCard({ entry, vehicle, showIssue }: Props) {
  const undoDelete = useUndoDelete()
  const issueId = showIssue ? entry.issueId : undefined
  const issue = useLiveQuery(
    async () => (issueId ? ((await db.issues.get(issueId)) ?? null) : null),
    [issueId],
  )

  // Meter names only matter when there is more than one meter to tell apart.
  const named = vehicle.meters.length > 1
  const readings = vehicle.meters.flatMap((m) => {
    const value = entry.readings[m.id]
    return typeof value === 'number' ? [{ meter: m, value }] : []
  })

  return (
    <article className="entry-card">
      <header className="entry-head">
        <span className="entry-date">{formatEntryDate(entry.date)}</span>
        {readings.length > 0 && (
          <span className="entry-readings">
            {readings.map(({ meter, value }, i) => (
              <span key={meter.id} className="reading">
                {i > 0 && <span aria-hidden="true"> · </span>}
                {named && <span className="reading-name">{meter.name} </span>}
                <span>{`${value.toLocaleString('en-CA')} ${meter.unit}`}</span>
              </span>
            ))}
          </span>
        )}
      </header>
      {entry.tags.length > 0 && (
        <ul className="tag-list">
          {entry.tags.map((t) => (
            <li key={t} className="tag-pill">
              {t}
            </li>
          ))}
        </ul>
      )}
      <p className="entry-text">{entry.text}</p>
      {(entry.cost !== undefined || entry.shop) && (
        <p className="entry-meta">
          {entry.cost !== undefined && <span>{cad.format(entry.cost)}</span>}
          {entry.cost !== undefined && entry.shop && <span aria-hidden="true"> · </span>}
          {entry.shop && <span>{entry.shop}</span>}
        </p>
      )}
      <p className="entry-meta muted">by {entry.createdBy}</p>
      {issueId && (
        <p className="entry-meta">
          <Link to={`/issue/${issueId}`}>{issue ? issue.title : 'Issue'}</Link>
        </p>
      )}
      <div className="entry-actions">
        <Link to={`/entry/${entry.id}/edit`} className="btn">
          Edit
        </Link>
        <button type="button" className="btn" onClick={() => undoDelete('entries', entry.id, 'Entry')}>
          Delete
        </button>
      </div>
    </article>
  )
}
