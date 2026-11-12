import { isSignedIn, preloadGsi } from './auth'
import { createDriveStore, getFolderId } from './drive'
import { isSyncRunning, startSync } from './engine'

/**
 * Start syncing if this device is signed in and has a folder, and sync is not already running.
 * Returns true only when it started the engine. The final check and startSync happen with no
 * await between them, so concurrent callers can never start it twice (a second startSync could
 * overlap a still-running pass).
 */
export async function ensureSyncStarted(): Promise<boolean> {
  if (isSyncRunning()) return false
  if (!(await isSignedIn())) return false
  if (!(await getFolderId())) return false
  if (isSyncRunning()) return false
  startSync(createDriveStore())
  return true
}

/** Called once from main.tsx. Also covers recovery after iOS evicts the local DB: the first pass pulls everything. */
export async function bootSync(): Promise<void> {
  preloadGsi()
  try {
    await ensureSyncStarted()
  } catch {
    // an unreadable meta table must not stop the app from rendering
  }
}
