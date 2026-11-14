import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { signIn } from '../sync/auth'
import { subscribeStatus, type SyncStatus } from '../sync/engine'
import { SYNC_LABELS } from './syncLabels'

export default function SyncChip() {
  const [status, setStatus] = useState<SyncStatus>('pending')
  useEffect(() => subscribeStatus((s) => setStatus(s)), [])

  // Takes the page to Google; it comes back signed in and boot starts syncing after the reload.
  async function onSignIn() {
    try {
      await signIn()
    } catch {
      // the navigation could not start: the chip stays on "Sign in"
    }
  }

  return (
    <span className={`chip chip-${status}`} role="status" data-status={status}>
      {status === 'sign-in' ? (
        <button type="button" className="chip-button" onClick={() => void onSignIn()}>
          {SYNC_LABELS[status]}
        </button>
      ) : status === 'no-folder' ? (
        <Link className="chip-button" to="/settings">
          {SYNC_LABELS[status]}
        </Link>
      ) : (
        SYNC_LABELS[status]
      )}
    </span>
  )
}
