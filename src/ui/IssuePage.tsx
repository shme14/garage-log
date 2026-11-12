import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { db, getEditContext } from '../db/db'
import { entriesForIssue, update } from '../db/repo'
import { compareEntriesDesc } from '../model/dates'
import type { Issue } from '../model/types'
import EntryCard from './EntryCard'
import TodoList from './TodoList'

const STATUSES: { value: Issue['status']; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'parked', label: 'Parked' },
  { value: 'resolved', label: 'Resolved' },
]

export default function IssuePage() {
  const { id = '' } = useParams()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // One query, tagged with its issue id so a stale result is never shown after the id changes.
  const data = useLiveQuery(async () => {
    const issue = await db.issues.get(id)
    const live = issue && !issue.deleted ? issue : null
    const vehicle = live ? await db.vehicles.get(live.vehicleId) : undefined
    return {
      iid: id,
      issue: live,
      vehicle: vehicle && !vehicle.deleted ? vehicle : null,
      entries: live ? await entriesForIssue(id) : [],
    }
  }, [id])

  if (!data || data.iid !== id) return null
  const { issue, vehicle, entries } = data
  if (!issue) {
    return (
      <p className="empty">
        <span>Issue not found</span>. <Link to="/">Back to the garage</Link>.
      </p>
    )
  }

  /** Apply a change to the stored record (re-read, so a concurrent sync merge isn't clobbered). */
  async function save(change: Partial<Pick<Issue, 'title' | 'status'>>): Promise<boolean> {
    setSaving(true)
    setError(null)
    try {
      const fresh = (await db.issues.get(id)) ?? issue!
      await update<Issue>('issues', { ...fresh, ...change }, await getEditContext())
      return true
    } catch {
      setError('Could not save the change. Please try again.')
      return false
    } finally {
      setSaving(false)
    }
  }

  function startEdit() {
    setDraft(issue!.title)
    setError(null)
    setEditing(true)
  }

  async function onSaveTitle() {
    const title = draft.trim()
    if (title === '') return
    if (await save({ title })) setEditing(false)
  }

  const sorted = [...entries].sort((a, b) => compareEntriesDesc(b, a))

  return (
    <section className="issue-page">
      <Link to={`/vehicle/${issue.vehicleId}`} className="back-link">
        <span aria-hidden="true">&larr; </span>
        {vehicle?.name ?? 'Back to vehicle'}
      </Link>

      {editing ? (
        <form
          className="issue-title-edit"
          onSubmit={(ev) => {
            ev.preventDefault()
            void onSaveTitle()
          }}
        >
          <input
            type="text"
            className="issue-title-input"
            aria-label="Issue title"
            value={draft}
            onChange={(ev) => setDraft(ev.target.value)}
          />
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={saving || draft.trim() === ''}
            >
              Save
            </button>
          </div>
        </form>
      ) : (
        <div className="issue-head">
          <h2 className="issue-title">{issue.title}</h2>
          <button type="button" className="icon-btn" aria-label="Edit title" onClick={startEdit}>
            <span aria-hidden="true">&#9998;</span>
          </button>
        </div>
      )}

      {error && (
        <p className="field-warn" role="alert">
          {error}
        </p>
      )}

      <div className="segmented" role="group" aria-label="Status">
        {STATUSES.map((s) => (
          <button
            key={s.value}
            type="button"
            className="segment"
            aria-pressed={issue.status === s.value}
            disabled={saving}
            onClick={() => {
              if (issue.status !== s.value) void save({ status: s.value })
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      <Link
        to={`/entry/new?vehicle=${issue.vehicleId}&issue=${issue.id}`}
        className="btn btn-primary btn-block"
      >
        Add update
      </Link>

      <div className="panel">
        <h3>Todos</h3>
        <TodoList vehicleId={issue.vehicleId} issueId={issue.id} />
      </div>

      <p className="muted issue-count">
        {entries.length} {entries.length === 1 ? 'update' : 'updates'}
      </p>
      <div className="log">
        {entries.length === 0 && <p className="empty">No updates yet.</p>}
        {vehicle &&
          sorted.map((e) => <EntryCard key={e.id} entry={e} vehicle={vehicle} />)}
      </div>
    </section>
  )
}
