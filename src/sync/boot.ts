import { completeRedirect, isSignedIn, pendingSignIn } from './auth'
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
  // Ask the browser not to evict our IndexedDB under storage pressure (best effort; iOS may ignore it).
  try {
    void navigator.storage?.persist?.()?.catch(() => {})
  } catch {
    // unsupported or blocked: nothing to do
  }
  try {
    // After a redirect sign-in the account is stored in the background: check it only once that
    // is done, so the first session after signing in starts syncing (still once per session).
    await pendingSignIn()
  } catch {
    // never rejects; boot goes on regardless
  }
  try {
    await ensureSyncStarted()
  } catch {
    // an unreadable meta table must not stop the app from rendering
  }
}

/**
 * App entry, called once from main.tsx. If Google has just redirected back with a token in the
 * URL fragment, completeRedirect takes it out of the URL (and stores the sign-in) BEFORE render,
 * so HashRouter never sees it as a route. It does not wait on the network; bootSync waits for
 * the account to be stored (pendingSignIn) before deciding whether to start syncing.
 * Nothing here can stop the app from rendering.
 */
export async function startApp(render: () => void): Promise<void> {
  try {
    await completeRedirect()
  } catch {
    // completeRedirect does not throw, but the app must render regardless
  }
  render()
  // Once per app session, outside React so StrictMode cannot run it twice.
  void bootSync()
}
