import type { SyncStatus } from '../sync/engine'

export const SYNC_LABELS: Record<SyncStatus, string> = {
  synced: 'Synced',
  syncing: 'Syncing…',
  offline: 'Offline',
  pending: 'Not synced',
  'sign-in': 'Sign in',
  'no-folder': 'Choose folder',
  error: 'Sync error',
}
