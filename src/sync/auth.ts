import { db, getUser, setUser } from '../db/db'
import { ACCOUNT_KEY, FOLDER_ID_KEY, FOLDER_INFO_KEY, GOOGLE_CLIENT_ID } from './config'
import { stopSync } from './engine'
import { AuthError } from './store'

// Google Identity Services token flow. The access token lives in memory only: it is never
// written to IndexedDB, localStorage or anywhere else. Only the account (name + email) is stored.

const GSI_URL = 'https://accounts.google.com/gsi/client'
const SCOPE = 'https://www.googleapis.com/auth/drive openid email profile'
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'

const REFRESH_MARGIN_MS = 60_000
const SILENT_TIMEOUT_MS = 20_000

export interface GoogleAccount {
  name: string
  email: string
}

interface TokenResponse {
  access_token?: string
  expires_in?: number | string
  error?: string
  error_description?: string
}

interface TokenClientConfig {
  client_id: string
  scope: string
  callback: (r: TokenResponse) => void
  error_callback: (e: { type?: string; message?: string }) => void
}

interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string; login_hint?: string }): void
}

interface GoogleOAuth2 {
  initTokenClient(config: TokenClientConfig): TokenClient
  revoke(token: string, done?: () => void): void
}

function oauth2(): GoogleOAuth2 | undefined {
  return (window as unknown as { google?: { accounts?: { oauth2?: GoogleOAuth2 } } }).google
    ?.accounts?.oauth2
}

// ---------------------------------------------------------------- script loading

let gsiLoading: Promise<void> | null = null

/** Load the Google Identity Services script once. A failed load can be retried. */
export function loadGsi(): Promise<void> {
  if (oauth2()) return Promise.resolve()
  if (gsiLoading) return gsiLoading
  const p = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = GSI_URL
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => {
      script.remove()
      reject(new Error('Could not load Google sign-in'))
    }
    document.head.appendChild(script)
  })
  gsiLoading = p
  p.catch(() => {
    if (gsiLoading === p) gsiLoading = null
  })
  return p
}

/**
 * Fire-and-forget load so the script is ready before a tap: requestAccessToken must run inside
 * the user gesture (iOS Safari blocks the popup otherwise), and awaiting a script load first would
 * lose the gesture.
 */
export function preloadGsi(): void {
  loadGsi().catch(() => {})
}

// ---------------------------------------------------------------- token state (memory only)

let token: string | undefined
let expiresAt = 0
let refreshing: Promise<string> | null = null

/** Forget the in-memory access token (it was rejected, or the user signed out). */
export function clearToken(): void {
  token = undefined
  expiresAt = 0
}

function applyToken(resp: TokenResponse): string {
  if (!resp.access_token) throw new Error('Google returned no access token')
  const seconds = Number(resp.expires_in)
  token = resp.access_token
  expiresAt = Date.now() + (Number.isFinite(seconds) ? seconds : 3600) * 1000
  return resp.access_token
}

// ---------------------------------------------------------------- token client

let client: { owner: GoogleOAuth2; tc: TokenClient } | undefined
let pending: { resolve: (r: TokenResponse) => void; reject: (e: Error) => void } | null = null

function tokenClient(g: GoogleOAuth2): TokenClient {
  if (client && client.owner === g) return client.tc
  const tc = g.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPE,
    callback: (resp) => {
      const p = pending
      pending = null
      if (!p) return
      if (resp.error) p.reject(new Error(resp.error_description || resp.error))
      else p.resolve(resp)
    },
    error_callback: (err) => {
      const p = pending
      pending = null
      p?.reject(new Error(err.type || err.message || 'Sign-in failed'))
    },
  })
  client = { owner: g, tc }
  return tc
}

function requestToken(
  g: GoogleOAuth2,
  overrides: { prompt: string; login_hint?: string },
  timeoutMs?: number,
): Promise<TokenResponse> {
  return new Promise<TokenResponse>((resolve, reject) => {
    pending?.reject(new Error('Superseded by a newer sign-in request'))
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = <T,>(fn: (v: T) => void) => (v: T) => {
      if (timer !== undefined) clearTimeout(timer)
      fn(v)
    }
    const mine = { resolve: done(resolve), reject: done(reject) }
    pending = mine
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        if (pending === mine) pending = null
        reject(new Error('Sign-in request timed out'))
      }, timeoutMs)
    }
    try {
      tokenClient(g).requestAccessToken(overrides)
    } catch (e) {
      if (pending === mine) pending = null
      mine.reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

// ---------------------------------------------------------------- account

// The stored account's email, mirrored in memory so signIn can pass login_hint synchronously.
// Refreshed by every getAccount (boot reads it long before any tap), signIn and signOut.
let knownEmail: string | undefined

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

async function fetchUserinfo(accessToken: string): Promise<GoogleAccount> {
  const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new Error(`Could not read your Google profile (${res.status})`)
  const info = (await res.json()) as { name?: string; email?: string }
  if (!info.email) throw new Error('Google did not return an email address')
  return { name: info.name || info.email, email: info.email }
}

/**
 * Interactive sign-in. MUST be called directly from a user gesture (a click handler): when the
 * Google script is already loaded the token request is made synchronously, before any await.
 */
export async function signIn(): Promise<GoogleAccount> {
  let g = oauth2()
  if (!g) {
    await loadGsi()
    g = oauth2()
    if (!g) throw new Error('Google sign-in is unavailable')
  }
  // Preselect the account this device already uses (login_hint). Read from the in-memory copy
  // kept by getAccount: awaiting the database here would lose the user gesture.
  const resp = await requestToken(
    g,
    knownEmail ? { prompt: '', login_hint: knownEmail } : { prompt: '' },
  )
  const accessToken = applyToken(resp)
  const account = await fetchUserinfo(accessToken)

  const previous = await getAccount()
  // Keep a name the user already has unless a different Google account just signed in.
  if (!(await getUser()) || (previous && previous.email !== account.email)) {
    await setUser(account.name)
  }
  await db.meta.put({ key: ACCOUNT_KEY, value: JSON.stringify(account) })
  knownEmail = account.email
  if (previous && previous.email !== account.email) {
    // A different account: its folder choice does not carry over.
    await db.meta.bulkDelete([FOLDER_ID_KEY, FOLDER_INFO_KEY])
  }
  return account
}

async function silentRefresh(): Promise<string> {
  const account = await getAccount()
  if (!account) throw new AuthError('Sign in to Google')
  let g = oauth2()
  if (!g) {
    await loadGsi() // a load failure is a plain error (offline), not a sign-in problem
    g = oauth2()
    if (!g) throw new Error('Google sign-in is unavailable')
  }
  try {
    const resp = await requestToken(
      g,
      { prompt: 'none', login_hint: account.email },
      SILENT_TIMEOUT_MS,
    )
    return applyToken(resp)
  } catch {
    clearToken()
    throw new AuthError('Sign in to Google again')
  }
}

/**
 * A valid access token: the cached one if it has more than 60 s left, else a silent re-request.
 * Throws AuthError when the user has to sign in again.
 */
export function getToken(): Promise<string> {
  if (token && expiresAt - Date.now() > REFRESH_MARGIN_MS) return Promise.resolve(token)
  if (!refreshing) {
    const p = silentRefresh().finally(() => {
      if (refreshing === p) refreshing = null
    })
    refreshing = p
  }
  return refreshing
}

/** Forget this device's Google account, folder and token, stop syncing. Local data is untouched. */
export async function signOut(
  reload: () => void = () => window.location.reload(),
): Promise<void> {
  const old = token
  stopSync()
  // Forget the account first so a concurrent getToken cannot start a silent refresh.
  await db.meta.bulkDelete([ACCOUNT_KEY, FOLDER_ID_KEY, FOLDER_INFO_KEY])
  knownEmail = undefined
  clearToken()
  if (old) {
    try {
      oauth2()?.revoke(old, () => {})
    } catch {
      // best effort
    }
  }
  // stopSync cannot cancel an in-flight pass and the engine is started at most once per page
  // session, so the next sign-in must begin in a fresh session.
  try {
    reload()
  } catch {
    // nothing more to do
  }
}
