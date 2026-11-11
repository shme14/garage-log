import { useLiveQuery } from 'dexie-react-hooks'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { db, getEditContext } from '../db/db'
import { create, update } from '../db/repo'
import type { BaseRecord, Meter, Vehicle } from '../model/types'

const KINDS: { value: Vehicle['kind']; label: string }[] = [
  { value: 'truck', label: 'Truck' },
  { value: 'car', label: 'Car' },
  { value: 'bike', label: 'Bike' },
  { value: 'ebike', label: 'E-bike' },
  { value: 'other', label: 'Other' },
]

export default function VehicleEditor() {
  const { id } = useParams()
  const vehicle = useLiveQuery(
    async () => (id ? ((await db.vehicles.get(id)) ?? null) : null),
    [id],
  )

  if (!id) return <EditorBody key="new" />
  if (vehicle === undefined) return null
  if (vehicle === null || vehicle.deleted) {
    return (
      <p className="empty">
        <span>Vehicle not found</span>. <Link to="/">Back to the garage</Link>.
      </p>
    )
  }
  return <EditorBody key={vehicle.id} vehicle={vehicle} />
}

/** A meter in the form; `saved` meters already exist on the vehicle and keep their unit. */
interface DraftMeter extends Meter {
  saved: boolean
}

function EditorBody({ vehicle }: { vehicle?: Vehicle }) {
  const navigate = useNavigate()
  const [name, setName] = useState(vehicle?.name ?? '')
  const [kind, setKind] = useState<Vehicle['kind']>(vehicle?.kind ?? 'car')
  const [archived, setArchived] = useState(vehicle?.archived ?? false)
  const [meters, setMeters] = useState<DraftMeter[]>(
    () => vehicle?.meters.map((m) => ({ ...m, saved: true })) ?? [],
  )
  const [saving, setSaving] = useState(false)

  // Meters are never removed (entries refer to them by id), so a blank *new* row is simply ignored.
  const savedBlank = meters.some((m) => m.saved && m.name.trim() === '')
  const canSave = name.trim() !== '' && !savedBlank && !saving

  function patch(meterId: string, change: Partial<DraftMeter>) {
    setMeters((list) => list.map((m) => (m.id === meterId ? { ...m, ...change } : m)))
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault()
    if (!canSave) return
    setSaving(true)
    try {
      const ctx = await getEditContext()
      const added: Meter[] = meters
        .filter((m) => !m.saved && m.name.trim() !== '')
        .map((m) => ({ id: m.id, name: m.name.trim(), unit: m.unit }))

      if (vehicle) {
        // Start from the stored record so fields merged in by a sync meanwhile are kept.
        const fresh = (await db.vehicles.get(vehicle.id)) ?? vehicle
        const renamed = new Map(meters.filter((m) => m.saved).map((m) => [m.id, m.name.trim()]))
        const next: Vehicle = {
          ...fresh,
          name: name.trim(),
          kind,
          archived,
          meters: [...fresh.meters.map((m) => ({ ...m, name: renamed.get(m.id) ?? m.name })), ...added],
        }
        await update<Vehicle>('vehicles', next, ctx)
        navigate(`/vehicle/${vehicle.id}`)
      } else {
        const fields: Omit<Vehicle, keyof BaseRecord> = {
          name: name.trim(),
          kind,
          info: '',
          infoUpdatedAt: '',
          meters: added,
          archived: false,
        }
        const created = await create<Vehicle>('vehicles', fields, ctx)
        navigate(`/vehicle/${created.id}`)
      }
    } catch (err) {
      setSaving(false)
      throw err
    }
  }

  return (
    <form className="stack-form" onSubmit={(ev) => void onSubmit(ev)}>
      <h2 className="entry-title">{vehicle ? 'Edit vehicle' : 'New vehicle'}</h2>
      <label className="field">
        <span className="field-label">Name</span>
        <input type="text" value={name} onChange={(ev) => setName(ev.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Kind</span>
        <select value={kind} onChange={(ev) => setKind(ev.target.value as Vehicle['kind'])}>
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="field">
        <legend className="field-label">Meters</legend>
        {meters.length === 0 && <p className="muted">No meters yet. Add one to log readings.</p>}
        {meters.map((m, i) => (
          <div key={m.id} className="field-row meter-row">
            <label className="field field-grow">
              <span className="field-label">Meter {i + 1} name</span>
              <input
                type="text"
                value={m.name}
                placeholder="Odometer"
                onChange={(ev) => patch(m.id, { name: ev.target.value })}
              />
            </label>
            {m.saved ? (
              <span className="meter-unit muted">{m.unit}</span>
            ) : (
              <label className="field">
                <span className="field-label">Meter {i + 1} unit</span>
                <select
                  value={m.unit}
                  onChange={(ev) => patch(m.id, { unit: ev.target.value as Meter['unit'] })}
                >
                  <option value="km">km</option>
                  <option value="h">h</option>
                </select>
              </label>
            )}
          </div>
        ))}
        <button
          type="button"
          className="btn"
          onClick={() =>
            setMeters((list) => [
              ...list,
              { id: crypto.randomUUID(), name: '', unit: 'km', saved: false },
            ])
          }
        >
          Add meter
        </button>
      </fieldset>

      {vehicle && (
        <label className="check">
          <input
            type="checkbox"
            checked={archived}
            onChange={(ev) => setArchived(ev.target.checked)}
          />
          <span>Archived</span>
        </label>
      )}

      <div className="form-actions">
        <Link to={vehicle ? `/vehicle/${vehicle.id}` : '/'} className="btn">
          Cancel
        </Link>
        <button type="submit" className="btn btn-primary" disabled={!canSave}>
          Save
        </button>
      </div>
    </form>
  )
}
