import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { db, getEditContext, getUser, setUser } from '../db/db'
import { readAll } from '../db/repo'
import { downloadFile, exportJson, exportText, localDateStamp } from '../export/export'
import { loadSeed } from '../import/seed'
import { getAccount, preloadGsi, signIn, signOut, type GoogleAccount } from '../sync/auth'
import { ensureSyncStarted } from '../sync/boot'
import {
  createFolder,
  findFolders,
  getFolder,
  setFolder,
  type DriveFolder,
} from '../sync/drive'
import { subscribeStatus, syncNow, type SyncStatus } from '../sync/engine'
import { SYNC_LABELS } from './syncLabels'

interface SyncInfo {
  status: SyncStatus
  lastSynced?: string
  skipped: string[]
}

export default function SettingsPage() {
  return (
    <section className="settings-page">
      <h2 className="entry-title">Settings</h2>
      <NameSection />
      <SyncSection />
      <VehiclesSection />
      <ImportSection />
      <ExportSection />
    </section>
  )
}

function NameSection() {
  const [name, setName] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let live = true
    void getUser().then((stored) => {
      if (live && stored) setName((current) => current || stored)
    })
    return () => {
      live = false
    }
  }, [])

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault()
    if (name.trim() === '') return
    await setUser(name.trim())
    setSaved(true)
  }

  return (
    <form className="panel stack-form" onSubmit={(ev) => void onSubmit(ev)}>
      <h3>Your name</h3>
      <label className="field">
        <span className="field-label">Your name</span>
        <input
          type="text"
          value={name}
          autoComplete="name"
          onChange={(ev) => {
            setName(ev.target.value)
            setSaved(false)
          }}
        />
      </label>
      <p className="muted settings-note">Shown as the author of the entries you write.</p>
      <div className="settings-actions">
        <button type="submit" className="btn btn-primary" disabled={name.trim() === ''}>
          Save
        </button>
        {saved && <span role="status">Saved</span>}
      </div>
    </form>
  )
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function SyncSection() {
  const [info, setInfo] = useState<SyncInfo>({ status: 'pending', skipped: [] })
  const [account, setAccount] = useState<GoogleAccount | undefined>()
  const [folder, setFolderInfo] = useState<DriveFolder | undefined>()
  const [matches, setMatches] = useState<DriveFolder[] | undefined>() // undefined = chooser closed
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(
    () =>
      subscribeStatus((status, lastSynced, skipped) =>
        setInfo({ status, lastSynced, skipped: skipped ?? [] }),
      ),
    [],
  )

  useEffect(() => {
    preloadGsi() // so the Sign in tap can open Google's popup straight away
    let live = true
    void Promise.all([getAccount(), getFolder()]).then(([a, f]) => {
      if (!live) return
      setAccount(a)
      setFolderInfo(f)
    })
    return () => {
      live = false
    }
  }, [])

  // Lists the Garage Log folders this account can see. It never picks one by itself.
  async function loadMatches(keepError = false) {
    setBusy(true)
    if (!keepError) setError(undefined)
    try {
      setMatches(await findFolders())
    } catch (e) {
      setMatches(undefined)
      setError(`Could not look for the folder: ${errorMessage(e)}`)
    } finally {
      setBusy(false)
    }
  }

  // Called straight from the click so the Google popup is allowed.
  async function onSignIn() {
    setBusy(true)
    setError(undefined)
    try {
      const a = await signIn()
      setAccount(a)
      setFolderInfo(await getFolder())
    } catch (e) {
      setError(`Sign-in failed: ${errorMessage(e)}`)
      setBusy(false)
      return
    }
    setBusy(false)
    if (!(await getFolder())) await loadMatches()
  }

  async function onSignOut() {
    setBusy(true)
    setError(undefined)
    try {
      await signOut()
    } finally {
      setAccount(undefined)
      setFolderInfo(undefined)
      setMatches(undefined)
      setBusy(false)
    }
  }

  async function choose(f: DriveFolder) {
    setBusy(true)
    setError(undefined)
    try {
      await setFolder(f.id, f)
      setFolderInfo(f)
      setMatches(undefined)
      // Starts sync the first time; if it was already running, just sync the new folder.
      if (!(await ensureSyncStarted())) await syncNow()
    } catch (e) {
      setError(`Could not use that folder: ${errorMessage(e)}`)
    } finally {
      setBusy(false)
    }
  }

  async function create() {
    setBusy(true)
    setError(undefined)
    try {
      const f = await createFolder()
      await choose(f)
    } catch (e) {
      setError(errorMessage(e))
      // Most likely a folder turned up since we looked: show what is there instead.
      await loadMatches(true)
    }
  }

  async function onSyncNow() {
    setError(undefined)
    await ensureSyncStarted()
    await syncNow()
  }

  return (
    <div className="panel stack-form">
      <h3>Sync</h3>
      <p className="settings-line">
        <span className={`chip chip-${info.status}`}>{SYNC_LABELS[info.status]}</span>
      </p>
      {info.lastSynced && (
        <p className="muted settings-line">
          Last synced {new Date(info.lastSynced).toLocaleString()}
        </p>
      )}
      {info.skipped.length > 0 && (
        <p role="alert" className="field-warn">
          Some files from other devices could not be read and were skipped:{' '}
          {info.skipped.join(', ')}
        </p>
      )}

      <p className="settings-line">
        {account ? (
          <>
            Signed in as {account.name} ({account.email})
          </>
        ) : (
          <span className="muted">Not signed in</span>
        )}
      </p>
      {account && (
        <p className="muted settings-line">
          {folder ? (
            <>
              Folder: {folder.name}
              {folder.ownerEmail && ` (owner ${folder.ownerEmail})`}
              {folder.shared && ' · shared'}
            </>
          ) : (
            'No folder chosen yet'
          )}
        </p>
      )}

      {matches && matches.length > 0 && (
        <div className="stack-form">
          <p className="settings-note">Tap the Garage Log folder to use:</p>
          <ul className="plain-list">
            {matches.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  className="btn btn-block"
                  disabled={busy}
                  onClick={() => void choose(f)}
                >
                  {f.name} — {f.ownerEmail || 'unknown owner'}
                  {f.shared && ' · shared'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {matches && matches.length === 0 && (
        <div className="stack-form">
          <p className="settings-note">
            No Garage Log folder found in this Google account. If someone is sharing one with you,
            ask them to share it with {account?.email}, then try again.
          </p>
          <button type="button" className="btn" disabled={busy} onClick={() => void create()}>
            Create Garage Log folder
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="field-warn">
          {error}
        </p>
      )}

      <div className="settings-actions">
        {account ? (
          <>
            <button type="button" className="btn" disabled={busy} onClick={() => void loadMatches()}>
              Choose folder
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void onSyncNow()}>
              Sync now
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void onSignOut()}>
              Sign out
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void onSignIn()}
          >
            Sign in
          </button>
        )}
      </div>
    </div>
  )
}

function VehiclesSection() {
  const vehicles = useLiveQuery(async () =>
    (await db.vehicles.toArray())
      .filter((v) => !v.deleted)
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  return (
    <div className="panel stack-form">
      <h3>Vehicles</h3>
      {vehicles && vehicles.length === 0 && <p className="muted">No vehicles yet.</p>}
      {vehicles && vehicles.length > 0 && (
        <ul className="plain-list">
          {vehicles.map((v) => (
            <li key={v.id}>
              <Link className="row-link" to={`/vehicles/${v.id}/edit`}>
                {v.archived ? `${v.name} (archived)` : v.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link to="/vehicles/new" className="btn btn-primary">
        Add vehicle
      </Link>
    </div>
  )
}

type ImportResult = { ok: true; count: number } | { ok: false; message: string }

/** One-time load of the converted Keep notes file (seed.json); offered only to an empty garage. */
function ImportSection() {
  const empty = useLiveQuery(async () =>
    (await db.vehicles.toArray()).every((v) => v.deleted),
  )
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportResult>()

  async function onFile(ev: ChangeEvent<HTMLInputElement>) {
    const input = ev.currentTarget
    const file = input.files?.[0]
    if (!file) return
    setBusy(true)
    setResult(undefined)
    try {
      let json: unknown
      try {
        json = JSON.parse(await file.text())
      } catch {
        throw new Error(`${file.name} is not valid JSON`)
      }
      const count = await loadSeed(json, await getEditContext())
      setResult({ ok: true, count })
      void syncNow() // upload the import now instead of waiting for the next local edit
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      input.value = ''
      setBusy(false)
    }
  }

  // Keep the section up after a successful import so its message stays visible.
  if (!empty && !result) return null

  return (
    <div className="panel stack-form">
      <h3>Load Keep import</h3>
      {empty && (
        <>
          <p className="muted settings-note">
            Loads the converted Keep notes (seed.json) into this garage. Only offered while there are
            no vehicles.
          </p>
          <label className="field">
            <span className="field-label">Keep import file (seed.json)</span>
            <input
              type="file"
              accept=".json,application/json"
              disabled={busy}
              onChange={(ev) => void onFile(ev)}
            />
          </label>
        </>
      )}
      {result?.ok && <p role="status">Imported {result.count} records</p>}
      {result && !result.ok && (
        <p role="alert" className="field-warn">
          Import failed: {result.message}
        </p>
      )}
    </div>
  )
}

function ExportSection() {
  const [error, setError] = useState(false)

  async function run(kind: 'json' | 'txt') {
    setError(false)
    try {
      const set = await readAll()
      const now = new Date()
      if (kind === 'json') {
        downloadFile(
          `garage-log-${localDateStamp(now)}.json`,
          exportJson(set, now),
          'application/json',
        )
      } else {
        downloadFile(`garage-log-${localDateStamp(now)}.txt`, exportText(set), 'text/plain')
      }
    } catch {
      setError(true)
    }
  }

  return (
    <div className="panel stack-form">
      <h3>Export</h3>
      <p className="muted settings-note">
        Your data is never trapped. JSON is a full backup; text is a readable log by vehicle.
      </p>
      <div className="settings-actions">
        <button type="button" className="btn" onClick={() => void run('json')}>
          Export JSON
        </button>
        <button type="button" className="btn" onClick={() => void run('txt')}>
          Export text
        </button>
      </div>
      {error && (
        <p role="alert" className="field-warn">
          The export failed. Try again.
        </p>
      )}
    </div>
  )
}
