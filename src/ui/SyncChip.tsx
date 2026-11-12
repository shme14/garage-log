import { useEffect, useState } from 'react'
import { subscribeStatus, type SyncStatus } from '../sync/engine'
import { SYNC_LABELS } from './syncLabels'

export default function SyncChip() {
  const [status, setStatus] = useState<SyncStatus>('pending')
  useEffect(() => subscribeStatus((s) => setStatus(s)), [])
  return (
    <span className={`chip chip-${status}`} role="status" data-status={status}>
      {SYNC_LABELS[status]}
    </span>
  )
}
