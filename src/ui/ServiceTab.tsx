import { useState, type FormEvent } from 'react'
import { db, getEditContext } from '../db/db'
import { create, update } from '../db/repo'
import type { BaseRecord, ServiceItem, Vehicle } from '../model/types'
import { num, serviceStatusParts, type StatusProps } from './serviceStatus'
import { useUndoDelete } from './UndoToast'

/** Coloured state pill (the text label always carries the state) plus remaining amount / due date. */
export function ServiceStatus(props: StatusProps) {
  const { pill, parts } = serviceStatusParts(props)
  return (
    <>
      <span className={pill.className}>{pill.label}</span>
      {parts.map((p) => (
        <span key={p} className="service-detail muted">
          {p}
        </span>
      ))}
    </>
  )
}

function describeInterval(item: ServiceItem, vehicle: Vehicle): string {
  const parts: string[] = []
  const unit = vehicle.meters.find((m) => m.id === item.intervalMeterId)?.unit
  if (item.intervalAmount !== undefined && unit) parts.push(`${num(item.intervalAmount)} ${unit}`)
  if (item.intervalMonths !== undefined) parts.push(`${item.intervalMonths} months`)
  return parts.length > 0 ? `Every ${parts.join(' or ')}` : ''
}

interface Props extends Omit<StatusProps, 'item'> {
  items: ServiceItem[]
}

export default function ServiceTab({ vehicle, items, entries, today }: Props) {
  const undoDelete = useUndoDelete()
  // 'new' for the add form, an item for the edit form, null for neither.
  const [editing, setEditing] = useState<'new' | ServiceItem | null>(null)

  return (
    <div className="service-tab">
      {items.length === 0 && editing === null && <p className="muted">No service items yet.</p>}
      <ul className="plain-list">
        {items.map((item) => (
          <li key={item.id} className="service-row">
            <span className="service-name">{item.name}</span>
            <span className="service-detail muted">{describeInterval(item, vehicle)}</span>
            <span className="service-state">
              <ServiceStatus item={item} vehicle={vehicle} entries={entries} today={today} />
            </span>
            <span className="entry-actions">
              <button
                type="button"
                className="btn"
                aria-label={`Edit ${item.name}`}
                onClick={() => setEditing(item)}
              >
                Edit
              </button>
              <button
                type="button"
                className="btn"
                aria-label={`Delete ${item.name}`}
                onClick={() => undoDelete('serviceItems', item.id, 'Service item')}
              >
                Delete
              </button>
            </span>
          </li>
        ))}
      </ul>
      {editing === null ? (
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
          Add service item
        </button>
      ) : (
        <ServiceForm
          key={editing === 'new' ? 'new' : editing.id}
          vehicle={vehicle}
          item={editing === 'new' ? undefined : editing}
          onDone={() => setEditing(null)}
        />
      )}
    </div>
  )
}

const REQUIRED_INTERVAL = 'Set a distance/hours interval or a number of months'

function ServiceForm({
  vehicle,
  item,
  onDone,
}: {
  vehicle: Vehicle
  item?: ServiceItem
  onDone: () => void
}) {
  const [name, setName] = useState(item?.name ?? '')
  const [meterId, setMeterId] = useState(item?.intervalMeterId ?? '')
  const [amount, setAmount] = useState(item?.intervalAmount !== undefined ? String(item.intervalAmount) : '')
  const [months, setMonths] = useState(item?.intervalMonths !== undefined ? String(item.intervalMonths) : '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault()
    if (saving) return
    const trimmed = name.trim()
    const amountN = amount.trim() === '' ? NaN : Number(amount)
    const monthsN = months.trim() === '' ? NaN : Number(months)
    const hasMeter = meterId !== '' && Number.isFinite(amountN) && amountN > 0
    const hasMonths = Number.isInteger(monthsN) && monthsN > 0
    if (trimmed === '') return setError('Name is required')
    if (!hasMeter && !hasMonths) return setError(REQUIRED_INTERVAL)

    setError(null)
    setSaving(true)
    try {
      const ctx = await getEditContext()
      const intervals: Pick<ServiceItem, 'intervalMeterId' | 'intervalAmount' | 'intervalMonths'> = {}
      if (hasMeter) {
        intervals.intervalMeterId = meterId
        intervals.intervalAmount = amountN
      }
      if (hasMonths) intervals.intervalMonths = monthsN

      if (item) {
        const fresh = (await db.serviceItems.get(item.id)) ?? item
        const next: ServiceItem = { ...fresh, name: trimmed }
        delete next.intervalMeterId
        delete next.intervalAmount
        delete next.intervalMonths
        await update<ServiceItem>('serviceItems', Object.assign(next, intervals), ctx)
      } else {
        const fields: Omit<ServiceItem, keyof BaseRecord> = {
          vehicleId: vehicle.id,
          name: trimmed,
          ...intervals,
        }
        await create<ServiceItem>('serviceItems', fields, ctx)
      }
      onDone()
    } catch (err) {
      setSaving(false)
      throw err
    }
  }

  return (
    <form className="stack-form" onSubmit={(ev) => void onSubmit(ev)} noValidate>
      <label className="field">
        <span className="field-label">Name</span>
        <input type="text" value={name} onChange={(ev) => setName(ev.target.value)} />
      </label>
      <div className="field-row field-wrap">
        <label className="field field-grow">
          <span className="field-label">Meter</span>
          <select value={meterId} onChange={(ev) => setMeterId(ev.target.value)}>
            <option value="">None</option>
            {vehicle.meters.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.unit})
              </option>
            ))}
          </select>
        </label>
        <label className="field field-grow">
          <span className="field-label">Every</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            value={amount}
            onChange={(ev) => setAmount(ev.target.value)}
          />
        </label>
        <label className="field field-grow">
          <span className="field-label">Months</span>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            step="1"
            value={months}
            onChange={(ev) => setMonths(ev.target.value)}
          />
        </label>
      </div>
      {error && (
        <p className="field-warn" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          Save
        </button>
      </div>
    </form>
  )
}
