import { useEffect, useState } from 'react'
import { signIn } from '../sync/auth'
import { ensureSyncStarted } from '../sync/boot'
import { subscribeStatus, syncNow, type SyncStatus } from '../sync/engine'
import { SYNC_LABELS } from './syncLabels'

export default function SyncChip() {
  const [status, setStatus] = useState<SyncStatus>('pending')
  useEffect(() => subscribeStatus((s) => setStatus(s)), [])

  // Runs inside the click, so the Google popup is allowed (iOS needs a real gesture).
  async function onSignIn() {
    try {
      await signIn()
      await ensureSyncStarted()
    } catch {
      return // cancelled or failed: the chip stays on "Sign in"
    }
    await syncNow()
  }

  return (
    <span className={`chip chip-${status}`} role="status" data-status={status}>
      {status === 'sign-in' ? (
        <button type="button" className="chip-button" onClick={() => void onSignIn()}>
          {SYNC_LABELS[status]}
        </button>
      ) : (
        SYNC_LABELS[status]
      )}
    </span>
  )
}
