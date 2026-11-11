import { Fragment, useState } from 'react'
import { db, getEditContext } from '../db/db'
import { update } from '../db/repo'
import { formatEntryDate, todayEntryDate } from '../model/dates'
import type { Vehicle } from '../model/types'

const URL_RE = /(https?:\/\/[^\s<>]+)/g
const TRAILING_PUNCT = /[.,;:!?)\]'"]+$/

/** Text with line breaks preserved (by CSS) and http(s) URLs turned into links. */
function Linkified({ text }: { text: string }) {
  return (
    <>
      {text.split(URL_RE).map((part, i) => {
        // split() with a capture group puts the URLs at odd indexes.
        if (i % 2 === 0) return <Fragment key={i}>{part}</Fragment>
        const trail = TRAILING_PUNCT.exec(part)?.[0] ?? ''
        const url = part.slice(0, part.length - trail.length)
        return (
          <Fragment key={i}>
            <a href={url} target="_blank" rel="noopener noreferrer">
              {url}
            </a>
            {trail}
          </Fragment>
        )
      })}
    </>
  )
}

function formatEdited(iso: string): string | null {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : formatEntryDate(todayEntryDate(d))
}

export default function InfoTab({ vehicle }: { vehicle: Vehicle }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  const edited = vehicle.infoUpdatedAt ? formatEdited(vehicle.infoUpdatedAt) : null

  function startEdit() {
    setDraft(vehicle.info)
    setEditing(true)
  }

  async function onSave() {
    setSaving(true)
    try {
      // Start from the stored record so fields merged in by a sync meanwhile are kept.
      const fresh = (await db.vehicles.get(vehicle.id)) ?? vehicle
      await update<Vehicle>(
        'vehicles',
        { ...fresh, info: draft, infoUpdatedAt: new Date().toISOString() },
        await getEditContext(),
      )
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="info-tab">
      {edited && <p className="muted info-edited">Edited {edited}</p>}
      {editing ? (
        <>
          <textarea
            className="info-input"
            aria-label="Vehicle info"
            value={draft}
            onChange={(ev) => setDraft(ev.target.value)}
          />
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving}
              onClick={() => void onSave()}
            >
              Save
            </button>
          </div>
        </>
      ) : (
        <>
          {vehicle.info.trim() === '' ? (
            <p className="muted">
              Nothing here yet. Add purchase details, config codes, weights, links.
            </p>
          ) : (
            <p className="info-text">
              <Linkified text={vehicle.info} />
            </p>
          )}
          <button type="button" className="btn" onClick={startEdit}>
            Edit
          </button>
        </>
      )}
    </div>
  )
}
