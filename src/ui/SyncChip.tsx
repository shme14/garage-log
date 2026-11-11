import { useEffect, useState } from 'react'
import { subscribeStatus, type SyncStatus } from '../sync/engine'

const SYNC_LABELS: Record<SyncStatus, string> = {
  synced: 'Synced',
  syncing: 'Syncing…',
  offline: 'Offline',
  pending: 'Not synced',
  'sign-in': 'Sign in',
  error: 'Sync error',
}

export default function SyncChip() {
  const [status, setStatus] = useState<SyncStatus>('pending')
  useEffect(() => subscribeStatus((s) => setStatus(s)), [])
  return (
    <span className={`chip chip-${status}`} role="status" data-status={status}>
      {SYNC_LABELS[status]}
    </span>
  )
}
