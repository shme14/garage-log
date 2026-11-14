import { db, getUser, setUser } from '../db/db'
import { ACCOUNT_KEY, FOLDER_ID_KEY, FOLDER_INFO_KEY, GOOGLE_CLIENT_ID, TOKEN_KEY } from './config'
import { stopSync } from './engine'
import { AuthError } from './store'

// Google sign-in with a full-page OAuth 2.0 implicit redirect (no popup, no Google script):
// signIn navigates to Google, Google navigates back to the app with the token in the URL fragment,
// and completeRedirect (run from main.tsx before anything renders) takes it out of the URL at once.
//
// The access token is kept in memory and in IndexedDB (meta 'google.token') only until it expires
// (~1 h), so reopening the app within the hour needs no new sign-in. It is never written to
// localStorage or logs, and never stays in the URL after load. The account (name + email) is stored.

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'
const SCOPE = 'https://www.googleapis.com/auth/drive openid email profile'

/** sessionStorage key for the pending redirect: { state, returnHash }. */
const OAUTH_KEY = 'garage.oauth'

const REFRESH_MARGIN_MS = 60_000

export interface GoogleAccount {
  name: string
  email: string
}

interface PendingRedirect {
  state: string
  returnHash: string
}

interface StoredToken {
  token: string
  expiresAt: number
}

// ---------------------------------------------------------------- token state

let token: string | undefined
let expiresAt = 0
// A token Google rejected (401): never load it again from the database, even if the delete of the
// persisted copy has not landed yet.
let rejected: string | undefined

function forgetMemoryToken(): void {
  token = undefined
  expiresAt = 0
}

async function deleteStoredToken(): Promise<void> {
  try {
    await db.meta.delete(TOKEN_KEY)
  } catch {
    // an unreadable meta table: nothing more to do
  }
}

/** Forget the access token, in memory and in the database (it was rejected, or the user signed out). */
export async function clearToken(): Promise<void> {
  if (token) rejected = token
  forgetMemoryToken()
  await deleteStoredToken()
}

async function readStoredToken(): Promise<StoredToken | 'invalid' | undefined> {
  const row = await db.meta.get(TOKEN_KEY)
  if (!row) return undefined
  try {
    const v = JSON.parse(row.value) as Partial<StoredToken>
    if (typeof v.token === 'string' && typeof v.expiresAt === 'number') {
      return { token: v.token, expiresAt: v.expiresAt }
    }
  } catch {
    // fall through
  }
  return 'invalid'
}

function fresh(at: number): boolean {
  return at - Date.now() > REFRESH_MARGIN_MS
}

/**
 * A valid access token: the in-memory one, else the persisted one, if it has more than 60 s left.
 * Otherwise throws AuthError so the sync chip asks for a tap on "Sign in".
 *
 * This never starts a sign-in itself (no navigation, no popup): it runs from background sync
 * passes, and only a tap on "Sign in" may take the user to Google.
 */
export async function getToken(): Promise<string> {
  if (token && fresh(expiresAt)) return token
  forgetMemoryToken()
  let stored: Awaited<ReturnType<typeof readStoredToken>>
  try {
    stored = await readStoredToken()
  } catch {
    stored = undefined
  }
  if (stored && stored !== 'invalid' && stored.token !== rejected && fresh(stored.expiresAt)) {
    token = stored.token
    expiresAt = stored.expiresAt
    return token
  }
  if (stored) await deleteStoredToken()
  throw new AuthError(knownEmail ? 'Sign in to Google again' : 'Sign in to Google')
}

// ---------------------------------------------------------------- account

// The stored account's email, mirrored in memory. Refreshed by every getAccount (boot reads it
// long before any tap), completeRedirect and signOut.
let knownEmail: string | undefined

// Set when this page load finished a sign-in; read once by the settings page (to offer folders).
let redirectSignIn = false

async function readAccount(): Promise<GoogleAccount | undefined> {
  const row = await db.meta.get(ACCOUNT_KEY)
  if (!row) return undefined
  try {
    const v = JSON.parse(row.value) as Partial<GoogleAccount>
    if (typeof v.email === 'string' && typeof v.name === 'string') {
      return { name: v.name, email: v.email }
    }
  } catch {
    // fall through
  }
  return undefined
}

export async function getAccount(): Promise<GoogleAccount | undefined> {
  const account = await readAccount()
  knownEmail = account?.email
  return account
}

/** True when an account was signed in on this device (the token itself may have expired). */
export async function isSignedIn(): Promise<boolean> {
  return (await getAccount()) !== undefined
}

/** True once after a page load that completed a Google sign-in; false afterwards. */
export function consumeRedirectSignIn(): boolean {
  const v = redirectSignIn
  redirectSignIn = false
  return v
}

async function fetchUserinfo(accessToken: string): Promise<GoogleAccount> {
  const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new Error(`Could not read your Google profile (${res.status})`)
  const info = (await res.json()) as { name?: string; email?: string }
  if (!info.email) throw new Error('Google did not return an email address')
  return { name: info.name || info.email, email: info.email }
}

/** Store the account that just signed in; a different account loses the previous folder choice. */
async function applyAccount(account: GoogleAccount): Promise<void> {
  const previous = await getAccount()
  const changed = previous !== undefined && previous.email !== account.email
  // Keep a name the user already has unless a different Google account just signed in.
  if (!(await getUser()) || changed) await setUser(account.name)
  await db.meta.put({ key: ACCOUNT_KEY, value: JSON.stringify(account) })
  knownEmail = account.email
  if (changed) await db.meta.bulkDelete([FOLDER_ID_KEY, FOLDER_INFO_KEY])
}

// ---------------------------------------------------------------- redirect sign-in

/**
 * Interactive sign-in: navigates this page to Google's consent screen. Google sends the browser
 * back to the app (same URL, token in the fragment) and completeRedirect finishes there.
 * The returned promise never resolves, because the page is leaving; it rejects only if the
 * navigation itself could not start.
 */
export async function signIn(
  navigate: (url: string) => void = (url) => window.location.assign(url),
): Promise<never> {
  let email = knownEmail
  if (!email) {
    try {
      email = (await getAccount())?.email
    } catch {
      // no hint then
    }
  }
  const state = crypto.randomUUID()
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: window.location.origin + import.meta.env.BASE_URL,
    response_type: 'token',
    scope: SCOPE,
    include_granted_scopes: 'true',
    state,
  })
  if (email) params.set('login_hint', email)
  const pending: PendingRedirect = { state, returnHash: window.location.hash }
  try {
    sessionStorage.setItem(OAUTH_KEY, JSON.stringify(pending))
  } catch {
    // storage blocked: the state check will reject the answer, so nothing unsafe is accepted
  }
  navigate(`${AUTHORIZE_URL}?${params.toString()}`)
  return new Promise<never>(() => {})
}

function takePending(): PendingRedirect | undefined {
  try {
    const raw = sessionStorage.getItem(OAUTH_KEY)
    sessionStorage.removeItem(OAUTH_KEY)
    if (!raw) return undefined
    const v = JSON.parse(raw) as Partial<PendingRedirect>
    if (typeof v.state !== 'string' || v.state === '') return undefined
    return { state: v.state, returnHash: typeof v.returnHash === 'string' ? v.returnHash : '' }
  } catch {
    return undefined
  }
}

function safeReturnHash(h: string | undefined): string {
  return h && h.startsWith('#/') && !/access_token=|[#&?]error=/.test(h) ? h : '#/'
}

/**
 * Finish a sign-in when Google has just sent the browser back. Call before the router renders.
 * Does nothing unless the fragment holds OAuth params. The token leaves the URL synchronously,
 * before any await. Never throws: a failure must not stop the app from rendering.
 */
export async function completeRedirect(): Promise<void> {
  let params: URLSearchParams
  try {
    params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  } catch {
    return
  }
  const accessToken = params.get('access_token')
  const error = params.get('error')
  if (!accessToken && !error) return

  const pending = takePending()
  try {
    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search + safeReturnHash(pending?.returnHash),
    )
  } catch {
    // keep going: the token must still not be accepted without a state match
  }

  if (error || !accessToken) return // e.g. access_denied: the user said no
  const state = params.get('state')
  if (!pending || !state || state !== pending.state) {
    console.warn('Google sign-in answer ignored (state mismatch)')
    return
  }

  try {
    const seconds = Number(params.get('expires_in'))
    token = accessToken
    expiresAt = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000
    if (rejected === accessToken) rejected = undefined
    const account = await fetchUserinfo(accessToken)
    await applyAccount(account)
    const stored: StoredToken = { token: accessToken, expiresAt }
    await db.meta.put({ key: TOKEN_KEY, value: JSON.stringify(stored) })
    redirectSignIn = true
  } catch (e) {
    forgetMemoryToken()
    await deleteStoredToken()
    console.error('Google sign-in could not be completed:', e instanceof Error ? e.message : 'unknown error')
  }
}

// ---------------------------------------------------------------- sign-out

function revoke(accessToken: string): void {
  try {
    void fetch(`${REVOKE_URL}?token=${encodeURIComponent(accessToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      keepalive: true, // let it finish while the page reloads
    }).catch(() => {})
  } catch {
    // best effort
  }
}

/** Forget this device's Google account, folder and token, stop syncing. Local data is untouched. */
export async function signOut(
  reload: () => void = () => window.location.reload(),
): Promise<void> {
  stopSync()
  let old = token
  if (!old) {
    try {
      const stored = await readStoredToken()
      if (stored && stored !== 'invalid') old = stored.token
    } catch {
      // nothing to revoke then
    }
  }
  // Forget the account, folder and stored token before the memory token so a concurrent sync
  // pass fails fast.
  await db.meta.bulkDelete([ACCOUNT_KEY, FOLDER_ID_KEY, FOLDER_INFO_KEY, TOKEN_KEY])
  knownEmail = undefined
  forgetMemoryToken()
  if (old) revoke(old)
  // stopSync cannot cancel an in-flight pass and the engine is started at most once per page
  // session, so the next sign-in must begin in a fresh session.
  try {
    reload()
  } catch {
    // nothing more to do
  }
}

/** Test only: forget everything held in memory, as a page reload would. */
export function resetAuthForTests(): void {
  forgetMemoryToken()
  rejected = undefined
  knownEmail = undefined
  redirectSignIn = false
}
