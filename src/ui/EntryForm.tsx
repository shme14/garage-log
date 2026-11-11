import { useLiveQuery } from 'dexie-react-hooks'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { db, getEditContext } from '../db/db'
import {
  create,
  entriesForVehicle,
  issuesForVehicle,
  serviceItemsForVehicle,
  update,
  vehiclesLive,
} from '../db/repo'
import { todayEntryDate } from '../model/dates'
import {
  TAGS,
  type BaseRecord,
  type Entry,
  type EntryDate,
  type Issue,
  type Tag,
  type Vehicle,
} from '../model/types'
import { currentReading } from '../service/due'
import { getLastVehicleId, setLastVehicleId } from './lastVehicle'

const NEW_ISSUE = '__new__'

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function parseNum(s: string): number | undefined {
  const t = s.trim()
  if (t === '') return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

function toggle<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item]
}

export default function EntryForm({ now }: { now?: Date }) {
  const { id } = useParams()
  const [params] = useSearchParams()
  const vehicleParam = params.get('vehicle') ?? undefined
  const issueParam = params.get('issue') ?? undefined

  const data = useLiveQuery(
    async () => ({
      vehicles: await vehiclesLive(),
      entry: id ? ((await db.entries.get(id)) ?? null) : null,
      paramIssue: !id && issueParam ? ((await db.issues.get(issueParam)) ?? null) : null,
    }),
    [id, issueParam],
  )

  if (!data) return null

  if (id) {
    const entry = data.entry && !data.entry.deleted ? data.entry : null
    const vehicle = entry && data.vehicles.find((v) => v.id === entry.vehicleId)
    if (!entry || !vehicle) {
      return (
        <p className="empty">
          Entry not found. <Link to="/">Back to the garage</Link>.
        </p>
      )
    }
    return (
      <EntryFormBody
        key={entry.id}
        vehicles={[vehicle]}
        entry={entry}
        initialVehicleId={vehicle.id}
        now={now}
      />
    )
  }

  const vehicles = data.vehicles.filter((v) => !v.archived)
  if (vehicles.length === 0) {
    return (
      <p className="empty">
        No vehicles yet. <Link to="/settings">Add one in Settings</Link> to start logging.
      </p>
    )
  }
  const has = (vid: string | undefined) => vid !== undefined && vehicles.some((v) => v.id === vid)
  const initialVehicleId =
    [vehicleParam, data.paramIssue?.vehicleId, getLastVehicleId()].find(has) ?? vehicles[0].id
  const initialIssueId =
    data.paramIssue && data.paramIssue.vehicleId === initialVehicleId ? data.paramIssue.id : undefined
  return (
    <EntryFormBody
      vehicles={vehicles}
      initialVehicleId={initialVehicleId}
      initialIssueId={initialIssueId}
      now={now}
    />
  )
}

interface BodyProps {
  vehicles: Vehicle[]
  entry?: Entry
  initialVehicleId: string
  initialIssueId?: string
  now?: Date
}

function EntryFormBody({ vehicles, entry, initialVehicleId, initialIssueId, now }: BodyProps) {
  const navigate = useNavigate()
  const editing = entry !== undefined

  const [vehicleId, setVehicleId] = useState(initialVehicleId)
  const [date, setDate] = useState<EntryDate>(() => entry?.date ?? todayEntryDate(now))
  // Only fields the user has edited; untouched meter fields show the prefill.
  const [typed, setTyped] = useState<Record<string, string>>({})
  const [text, setText] = useState(entry?.text ?? '')
  const [tags, setTags] = useState<Tag[]>(entry?.tags ?? [])
  const [issueChoice, setIssueChoice] = useState(entry?.issueId ?? initialIssueId ?? '')
  const [newIssueTitle, setNewIssueTitle] = useState('')
  const [serviceIds, setServiceIds] = useState<string[]>(entry?.serviceItemIds ?? [])
  const [cost, setCost] = useState(entry?.cost !== undefined ? String(entry.cost) : '')
  const [shop, setShop] = useState(entry?.shop ?? '')
  const [saving, setSaving] = useState(false)
  // Initial state of the <details> only; the user's own toggling is never overridden.
  const [moreOpen] = useState(
    () =>
      initialIssueId !== undefined ||
      (entry !== undefined &&
        (entry.issueId !== undefined ||
          entry.serviceItemIds.length > 0 ||
          entry.cost !== undefined ||
          entry.shop !== undefined)),
  )

  const vehicle = vehicles.find((v) => v.id === vehicleId) ?? vehicles[0]

  // Tagged with its vehicle so a stale result is never used right after switching vehicles.
  const bundle = useLiveQuery(
    async () => ({
      vid: vehicleId,
      entries: await entriesForVehicle(vehicleId),
      issues: await issuesForVehicle(vehicleId),
      serviceItems: await serviceItemsForVehicle(vehicleId),
    }),
    [vehicleId],
  )
  const vd = bundle?.vid === vehicleId ? bundle : undefined

  const shops = useLiveQuery(async () => {
    const all = await db.entries.toArray()
    return [...new Set(all.filter((e) => !e.deleted && e.shop).map((e) => e.shop as string))].sort()
  })

  const others = vd?.entries.filter((e) => e.id !== entry?.id)
  const prefill = (meterId: string): number | undefined =>
    editing ? entry.readings[meterId] : vd ? currentReading(vd.entries, meterId) : undefined
  const shown = (meterId: string): string => {
    if (typed[meterId] !== undefined) return typed[meterId]
    const p = prefill(meterId)
    return p === undefined ? '' : String(p)
  }

  const issueOptions = (vd?.issues ?? []).filter(
    (i) => i.status !== 'resolved' || i.id === issueChoice,
  )

  const canSave = text.trim() !== '' && date.value !== '' && vd !== undefined && !saving

  function changeVehicle(next: string) {
    setVehicleId(next)
    setTyped({})
    setIssueChoice('')
    setNewIssueTitle('')
    setServiceIds([])
  }

  function setMonthOnly(monthOnly: boolean) {
    setDate((d) => {
      if (monthOnly) return { precision: 'month', value: d.value.slice(0, 7) }
      const day = d.precision === 'month' ? '01' : d.value.slice(8, 10)
      return { precision: 'day', value: d.value === '' ? '' : `${d.value.slice(0, 7)}-${day}` }
    })
  }

  function leave() {
    const idx = (window.history.state as { idx?: number } | null)?.idx
    if (typeof idx === 'number' && idx > 0) navigate(-1)
    else navigate(`/vehicle/${vehicleId}`, { replace: true })
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault()
    if (!canSave) return
    setSaving(true)
    try {
      const ctx = await getEditContext()

      // R5: unchanged prefills are not readings, unless the entry completes service items
      // (then the due calculation needs the reading). Edits keep every non-empty field.
      const completing = serviceIds.length > 0
      const readings: Record<string, number> = {}
      for (const m of vehicle.meters) {
        const n = parseNum(shown(m.id))
        if (n === undefined) continue
        if (editing || completing || n !== prefill(m.id)) readings[m.id] = n
      }

      let issueId: string | undefined
      if (issueChoice === NEW_ISSUE) {
        const title = newIssueTitle.trim()
        if (title) {
          const created = await create<Issue>('issues', { vehicleId, title, status: 'open' }, ctx)
          issueId = created.id
        }
      } else if (issueChoice) {
        issueId = issueChoice
      }

      const costN = parseNum(cost)
      const shopT = shop.trim()
      const common = {
        date,
        readings,
        text: text.trim(),
        tags: TAGS.filter((t) => tags.includes(t)),
        serviceItemIds: serviceIds,
      }

      if (entry) {
        const next: Entry = { ...entry, ...common }
        if (costN === undefined) delete next.cost
        else next.cost = costN
        if (shopT === '') delete next.shop
        else next.shop = shopT
        if (issueId === undefined) delete next.issueId
        else next.issueId = issueId
        await update<Entry>('entries', next, ctx)
      } else {
        const fields: Omit<Entry, keyof BaseRecord> = {
          ...common,
          vehicleId,
          createdBy: ctx.user,
        }
        if (costN !== undefined) fields.cost = costN
        if (shopT !== '') fields.shop = shopT
        if (issueId !== undefined) fields.issueId = issueId
        await create<Entry>('entries', fields, ctx)
      }

      setLastVehicleId(vehicleId)
      leave()
    } catch (err) {
      setSaving(false)
      throw err
    }
  }

  return (
    <form className="entry-form" onSubmit={onSubmit}>
      <h2 className="entry-title">{editing ? 'Edit entry' : 'New entry'}</h2>

      <label className="field">
        <span className="field-label">Vehicle</span>
        <select value={vehicleId} disabled={editing} onChange={(e) => changeVehicle(e.target.value)}>
          {vehicles.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </label>

      <div className="field-row">
        <label className="field field-grow">
          <span className="field-label">Date</span>
          <input
            type={date.precision === 'month' ? 'month' : 'date'}
            value={date.value}
            required
            onChange={(e) => setDate({ ...date, value: e.target.value })}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={date.precision === 'month'}
            onChange={(e) => setMonthOnly(e.target.checked)}
          />
          <span>Month only</span>
        </label>
      </div>

      {vehicle.meters.length > 0 && (
        <div className="field-row field-wrap">
          {vehicle.meters.map((m) => {
            const typedN = typed[m.id] !== undefined ? parseNum(typed[m.id]) : undefined
            const last = others ? currentReading(others, m.id) : undefined
            const lower = typedN !== undefined && last !== undefined && typedN < last
            return (
              <div className="field field-grow" key={m.id}>
                <label className="field-label" htmlFor={`meter-${m.id}`}>
                  {m.name} ({m.unit})
                </label>
                <input
                  id={`meter-${m.id}`}
                  type="number"
                  inputMode="numeric"
                  step="any"
                  value={shown(m.id)}
                  onChange={(e) => setTyped({ ...typed, [m.id]: e.target.value })}
                />
                {lower && (
                  <p className="field-warn" role="status">
                    Lower than last reading ({last.toLocaleString('en-CA')} {m.unit}) — typo?
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}

      <textarea
        className="entry-text"
        aria-label="Entry text"
        placeholder="What did you do or notice?"
        rows={4}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      <div className="tag-row">
        {TAGS.map((t) => (
          <button
            type="button"
            key={t}
            className="tag-chip"
            aria-pressed={tags.includes(t)}
            onClick={() => setTags(toggle(tags, t))}
          >
            {capitalize(t)}
          </button>
        ))}
      </div>

      <details className="more" open={moreOpen}>
        <summary>More</summary>

        <label className="field">
          <span className="field-label">Issue</span>
          <select value={issueChoice} onChange={(e) => setIssueChoice(e.target.value)}>
            <option value="">None</option>
            {issueOptions.map((i) => (
              <option key={i.id} value={i.id}>
                {i.title}
              </option>
            ))}
            <option value={NEW_ISSUE}>New issue…</option>
          </select>
        </label>
        {issueChoice === NEW_ISSUE && (
          <label className="field">
            <span className="field-label">New issue title</span>
            <input
              type="text"
              value={newIssueTitle}
              placeholder="e.g. Motor mount creak"
              onChange={(e) => setNewIssueTitle(e.target.value)}
            />
          </label>
        )}

        {vd && vd.serviceItems.length > 0 && (
          <fieldset className="field service-list">
            <legend className="field-label">Service done</legend>
            {vd.serviceItems.map((s) => (
              <label className="check" key={s.id}>
                <input
                  type="checkbox"
                  checked={serviceIds.includes(s.id)}
                  onChange={() => setServiceIds(toggle(serviceIds, s.id))}
                />
                <span>{s.name}</span>
              </label>
            ))}
          </fieldset>
        )}

        <label className="field">
          <span className="field-label">Cost (CAD)</span>
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">Shop</span>
          <input type="text" list="entry-shops" value={shop} onChange={(e) => setShop(e.target.value)} />
          <datalist id="entry-shops">
            {(shops ?? []).map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
      </details>

      <div className="form-actions">
        <button type="button" className="btn" onClick={leave}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={!canSave}>
          Save
        </button>
      </div>
    </form>
  )
}
