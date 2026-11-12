import { isSignedIn, preloadGsi } from './auth'
import { createDriveStore, getFolderId } from './drive'
import { startSync } from './engine'

// startSync runs at most once per page session: stopSync cannot cancel an in-flight pass, so a
// second startSync could overlap it (duplicate files, older snapshot overwriting a newer one).
// Sign-out reloads the page, which resets this.
let started = false

/**
 * Start syncing if this device is signed in and has a folder, and it has not been started in this
 * page session. Returns true only when it started the engine; callers that get false should just
 * syncNow(). The flag is set with no await between the check and startSync, so concurrent callers
 * cannot start it twice.
 */
export async function ensureSyncStarted(): Promise<boolean> {
  if (started) return false
  if (!(await isSignedIn())) return false
  if (!(await getFolderId())) return false
  if (started) return false
  started = true
  startSync(createDriveStore())
  return true
}

/** Test only: forget that sync was started. */
export function resetSyncSessionForTests(): void {
  started = false
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
