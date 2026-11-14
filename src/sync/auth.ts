import { db, getUser, setUser } from '../db/db'
import { ACCOUNT_KEY, FOLDER_ID_KEY, FOLDER_INFO_KEY, GOOGLE_CLIENT_ID, TOKEN_KEY } from './config'
import { stopSync } from './engine'
import { AuthError } from './store'

// Google sign-in with a full-page OAuth 2.0 implicit redirect (no popup, no Google script):
// signIn navigates to Google, Google navigates back to the app with the token in the URL fragment,
// and completeRedirect (run from main.tsx before anything renders) takes it out of the URL at once.
// The account behind the token is then read in the background (pendingSignIn), so the first
// render never waits on the network; getToken holds the token back until that check is done.
//
// The access token is kept in memory and in IndexedDB (meta 'google.token') only until it expires
// (~1 h), so reopening the app within the hour needs no new sign-in. It is never written to
// localStorage or logs, and is not left in the live URL or this tab's session history (the
// fragment is replaced before render). The browser's global history may still record the
// redirect URL with the token: that is inherent to the implicit flow, and the token expires in
// ~1 h. The account (name + email) is stored.

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'
const SCOPE = 'https://www.googleapis.com/auth/drive openid email profile'

/**
 * localStorage key for the pending redirect: { state, returnHash, createdAt }. localStorage, not
 * sessionStorage: an installed app's redirect can come back in a regular browser tab, which shares
 * the origin's localStorage and IndexedDB, so that tab can finish the sign-in and the app then
 * picks the token up from IndexedDB. It holds only the CSRF nonce, never a token.
 */
const OAUTH_KEY = 'garage.oauth'
const PENDING_MAX_AGE_MS = 10 * 60_000

const REFRESH_MARGIN_MS = 60_000
const USERINFO_TIMEOUT_MS = 15_000

/** Shown by Settings when a redirect came back but could not be used. */
export const REDIRECT_PROBLEM = "Sign-in didn't complete — please try again."

export interface GoogleAccount {
  name: string
  email: string
}

interface PendingRedirect {
  state: string
  returnHash: string
  createdAt: number
}

interface StoredToken {
  token: string
  expiresAt: number
  /** Set only once userinfo confirmed whose token this is; a row without it is never used. */
  email?: string
}

// ---------------------------------------------------------------- token state

let token: string | undefined
let expiresAt = 0
// The account the in-memory token was confirmed for (userinfo); undefined until confirmed.
let tokenEmail: string | undefined
// A token Google rejected (401): never load it again from the database, even if the delete of the
// persisted copy has not landed yet.
let rejected: string | undefined

function forgetMemoryToken(): void {
  token = undefined
  expiresAt = 0
  tokenEmail = undefined
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
      return {
        token: v.token,
        expiresAt: v.expiresAt,
        ...(typeof v.email === 'string' && v.email !== '' ? { email: v.email } : {}),
      }
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
 * Either is used only when it was confirmed (userinfo) for the stored account: an in-memory token
 * whose account no longer matches is forgotten, and a persisted one left unconfirmed (page closed
 * first) or confirmed for another account is deleted.
 * Otherwise throws AuthError so the sync chip asks for a tap on "Sign in".
 *
 * This never starts a sign-in itself (no navigation, no popup): it runs from background sync
 * passes, and only a tap on "Sign in" may take the user to Google.
 */
export async function getToken(): Promise<string> {
  await verifying // a token just back from Google is not used before its account is known
  if (token && fresh(expiresAt)) {
    const mine = token
    let account: GoogleAccount | undefined
    try {
      account = await getAccount()
    } catch {
      account = undefined
    }
    if (token === mine && tokenEmail !== undefined && tokenEmail === account?.email) return mine
    if (token === mine) rejected = mine // another account now (or none): never reuse this one
  }
  forgetMemoryToken()
  let stored: Awaited<ReturnType<typeof readStoredToken>>
  let account: GoogleAccount | undefined
  try {
    stored = await readStoredToken()
    account = stored && stored !== 'invalid' ? await getAccount() : undefined
  } catch {
    stored = undefined
  }
  if (
    stored &&
    stored !== 'invalid' &&
    stored.token !== rejected &&
    fresh(stored.expiresAt) &&
    stored.email !== undefined &&
    stored.email === account?.email
  ) {
    token = stored.token
    expiresAt = stored.expiresAt
    tokenEmail = stored.email
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

// Set when this page load got a redirect it could not use; read once by the settings page.
let redirectProblem: string | undefined

// The background step of completeRedirect (userinfo + account). Never rejects.
let verifying: Promise<void> = Promise.resolve()
let confirming = false
// Bumped by signOut so a background step that finishes afterwards stores nothing.
let generation = 0

/**
 * Resolves when a sign-in completed by this page load has its account stored (or failed).
 * Resolves at once when there is none. Never rejects.
 */
export function pendingSignIn(): Promise<void> {
  return verifying
}

/** True while this page load is still confirming a sign-in in the background. */
export function isConfirmingSignIn(): boolean {
  return confirming
}

/** Once after a page load whose Google redirect could not be used: the message to show. */
export function consumeRedirectProblem(): string | undefined {
  const v = redirectProblem
  redirectProblem = undefined
  return v
}

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
  let signal: AbortSignal | undefined
  try {
    signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(USERINFO_TIMEOUT_MS) : undefined
  } catch {
    signal = undefined
  }
  // A timeout rejects like any other failure: the token stays unconfirmed and is dropped.
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    ...(signal ? { signal } : {}),
  })
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
  const pending: PendingRedirect = { state, returnHash: window.location.hash, createdAt: Date.now() }
  try {
    localStorage.setItem(OAUTH_KEY, JSON.stringify(pending))
  } catch {
    // storage blocked: the state check will reject the answer, so nothing unsafe is accepted
  }
  navigate(`${AUTHORIZE_URL}?${params.toString()}`)
  return new Promise<never>(() => {})
}

/** Read and remove the pending redirect; a missing, malformed or stale (>10 min) entry is undefined. */
function takePending(): PendingRedirect | undefined {
  try {
    const raw = localStorage.getItem(OAUTH_KEY)
    localStorage.removeItem(OAUTH_KEY)
    if (!raw) return undefined
    const v = JSON.parse(raw) as Partial<PendingRedirect>
    if (typeof v.state !== 'string' || v.state === '') return undefined
    if (typeof v.createdAt !== 'number') return undefined
    const age = Date.now() - v.createdAt
    if (!(age >= 0 && age <= PENDING_MAX_AGE_MS)) return undefined
    return {
      state: v.state,
      returnHash: typeof v.returnHash === 'string' ? v.returnHash : '',
      createdAt: v.createdAt,
    }
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
 * before any await; it is then held in memory and persisted, and this resolves without touching
 * the network. Reading the account (userinfo, name, folder rules) continues in the background:
 * see pendingSignIn. Never throws: a failure must not stop the app from rendering.
 */
export async function completeRedirect(): Promise<void> {
  let params: URLSearchParams
  try {
    const hash = window.location.hash
    if (hash.startsWith('#/')) return // a router URL, never an OAuth answer
    params = new URLSearchParams(hash.replace(/^#/, ''))
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
    redirectProblem = REDIRECT_PROBLEM
    return
  }

  const seconds = Number(params.get('expires_in'))
  token = accessToken
  expiresAt = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000
  if (rejected === accessToken) rejected = undefined
  const stored: StoredToken = { token: accessToken, expiresAt }
  let persisted: Promise<boolean>
  try {
    persisted = db.meta.put({ key: TOKEN_KEY, value: JSON.stringify(stored) }).then(
      () => true,
      () => false, // memory only then: fine for this session
    )
  } catch {
    persisted = Promise.resolve(false)
  }
  confirming = true
  verifying = verifyAccount(accessToken, generation, persisted).finally(() => {
    confirming = false
  })
  await persisted
}

/** Background half of completeRedirect: read who signed in and apply the account rules. */
async function verifyAccount(
  accessToken: string,
  gen: number,
  persisted: Promise<boolean>,
): Promise<void> {
  try {
    const account = await fetchUserinfo(accessToken)
    const wasPersisted = await persisted
    if (gen !== generation) return // signed out meanwhile
    await applyAccount(account)
    if (gen !== generation) return
    if (token === accessToken) tokenEmail = account.email
    if (wasPersisted && token === accessToken) {
      // Confirm the persisted copy: only now may a later page load use it (see getToken).
      const confirmed: StoredToken = { token: accessToken, expiresAt, email: account.email }
      await db.meta.put({ key: TOKEN_KEY, value: JSON.stringify(confirmed) })
    }
    redirectSignIn = true
  } catch (e) {
    await persisted
    if (gen === generation) {
      if (token === accessToken) forgetMemoryToken()
      await deleteStoredToken()
      redirectProblem = REDIRECT_PROBLEM
    }
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
  generation++
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
  redirectProblem = undefined
  verifying = Promise.resolve()
  confirming = false
}
