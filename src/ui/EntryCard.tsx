import { useLiveQuery } from 'dexie-react-hooks'
import { Fragment, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { db } from '../db/db'
import { formatEntryDate } from '../model/dates'
import type { Entry, Vehicle } from '../model/types'

const cad = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })

interface Props {
  entry: Entry
  vehicle: Vehicle
  /** Show the linked issue's title (as plain text: the row is itself a link). Omit on the issue page. */
  showIssue?: boolean
}

/** One dense log row; the whole row is the link to the entry's edit screen. */
export default function EntryCard({ entry, vehicle, showIssue }: Props) {
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

  const parts: ReactNode[] = [
    <span key="date" className="entry-date">
      {formatEntryDate(entry.date)}
    </span>,
  ]
  readings.forEach(({ meter, value }) =>
    parts.push(
      <span key={meter.id} className="reading">
        {named && <span className="reading-name">{meter.name} </span>}
        <span>{`${value.toLocaleString('en-CA')} ${meter.unit}`}</span>
      </span>,
    ),
  )
  if (entry.tags.length > 0) {
    parts.push(
      <span key="tags" className="entry-tags">
        {entry.tags.map((t, i) => (
          <Fragment key={t}>
            {i > 0 && ' '}
            <span className="entry-tag">{t}</span>
          </Fragment>
        ))}
      </span>,
    )
  }
  if (entry.cost !== undefined || entry.shop) {
    parts.push(
      <span key="cost">
        {entry.cost !== undefined && <span>{cad.format(entry.cost)}</span>}
        {entry.cost !== undefined && entry.shop && ' '}
        {entry.shop && <span>{entry.shop}</span>}
      </span>,
    )
  }
  if (issueId) {
    parts.push(
      <span key="issue" className="entry-issue">
        {issue ? issue.title : 'Issue'}
      </span>,
    )
  }
  parts.push(<span key="by">by {entry.createdBy}</span>)

  return (
    <Link to={`/entry/${entry.id}/edit`} className="entry-row">
      <span className="entry-meta">
        {parts.map((part, i) => (
          <Fragment key={i}>
            {/* NBSP before the dot keeps it on the previous line when the row wraps; the real
                spaces stay outside the hidden dot so the link's accessible name is spaced. */}
            {i > 0 && (
              <>
                {'\u00a0'}
                <span aria-hidden="true">{'\u00b7'}</span>{' '}
              </>
            )}
            {part}
          </Fragment>
        ))}
      </span>{' '}
      <span className="entry-text">{entry.text}</span>
    </Link>
  )
}
