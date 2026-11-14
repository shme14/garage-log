import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { db, getUser, setUser } from '../db/db'

const engine = vi.hoisted(() => ({ stopSync: vi.fn() }))
vi.mock('./engine', () => engine)

import { AuthError } from './store'
import {
  clearToken,
  completeRedirect,
  consumeRedirectSignIn,
  getAccount,
  getToken,
  isSignedIn,
  pendingSignIn,
  resetAuthForTests,
  signIn,
  signOut,
} from './auth'

const SCOPE = 'https://www.googleapis.com/auth/drive openid email profile'
const OAUTH_KEY = 'garage.oauth'

function mockUserinfo(body: unknown = { name: 'Jamie D', email: 'jamie@example.com' }, status = 200) {
  const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', f)
  return f
}

/** Put the page where Google sends it back: base URL + #fragment params. */
function landWith(params: Record<string, string>) {
  const frag = new URLSearchParams(params).toString()
  history.replaceState(null, '', `${location.pathname}${location.search}#${frag}`)
}

function saveState(state: string, returnHash = '#/settings', createdAt = Date.now()) {
  localStorage.setItem(OAUTH_KEY, JSON.stringify({ state, returnHash, createdAt }))
}

/** A fetch whose answer the test releases later. */
function deferredUserinfo(body: unknown = { name: 'Jamie D', email: 'jamie@example.com' }) {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const f = vi.fn(async (_url: string, _init?: RequestInit) => {
    await gate
    return new Response(JSON.stringify(body), { status: 200 })
  })
  vi.stubGlobal('fetch', f)
  return { f, release }
}

type Stored = { token: string; expiresAt: number; email?: string }
async function storedToken(): Promise<Stored | undefined> {
  const row = await db.meta.get('google.token')
  return row ? (JSON.parse(row.value) as Stored) : undefined
}

/** A successful round trip through Google: state saved, page lands with a token. */
async function signedIn(token = 'tok-1', expiresIn = 3599) {
  saveState('s-ok')
  landWith({ access_token: token, token_type: 'Bearer', expires_in: String(expiresIn), scope: SCOPE, state: 's-ok' })
  mockUserinfo()
  await completeRedirect()
  await pendingSignIn()
}

beforeEach(async () => {
  await db.meta.clear()
  localStorage.clear()
  sessionStorage.clear()
  history.replaceState(null, '', '/garage-log/#/')
  resetAuthForTests()
  await getAccount() // what boot does: mirrors the stored account
  engine.stopSync.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('signIn', () => {
  test('navigates to Google with every authorize param and saves state + return hash', async () => {
    history.replaceState(null, '', '/garage-log/#/vehicle/v1')
    const f = mockUserinfo()
    const go = vi.fn()

    void signIn(go)
    await vi.waitFor(() => expect(go).toHaveBeenCalledTimes(1))

    const url = new URL(go.mock.calls[0][0] as string)
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    const p = url.searchParams
    expect(p.get('client_id')).toMatch(/\.apps\.googleusercontent\.com$/)
    expect(p.get('redirect_uri')).toBe(location.origin + import.meta.env.BASE_URL)
    expect(p.get('response_type')).toBe('token')
    expect(p.get('scope')).toBe(SCOPE)
    expect(p.get('include_granted_scopes')).toBe('true')
    expect(p.has('login_hint')).toBe(false)
    const state = p.get('state')!
    expect(state).toMatch(/^[0-9a-f-]{36}$/)

    const saved = JSON.parse(localStorage.getItem(OAUTH_KEY)!) as Record<string, unknown>
    expect(saved).toEqual({ state, returnHash: '#/vehicle/v1', createdAt: expect.any(Number) })
    expect(Math.abs((saved.createdAt as number) - Date.now())).toBeLessThan(5000)
    expect(sessionStorage.getItem(OAUTH_KEY)).toBeNull()
    expect(f).not.toHaveBeenCalled()
  })

  test('preselects the stored account with login_hint', async () => {
    await db.meta.put({
      key: 'google.account',
      value: JSON.stringify({ email: 'jamie@example.com', name: 'Jamie D' }),
    })
    await getAccount()
    const go = vi.fn()
    void signIn(go)
    await vi.waitFor(() => expect(go).toHaveBeenCalledTimes(1))
    expect(new URL(go.mock.calls[0][0] as string).searchParams.get('login_hint')).toBe('jamie@example.com')
  })

  test('uses a fresh state each time', async () => {
    const go = vi.fn()
    void signIn(go)
    void signIn(go)
    await vi.waitFor(() => expect(go).toHaveBeenCalledTimes(2))
    const states = go.mock.calls.map((c) => new URL(c[0] as string).searchParams.get('state'))
    expect(states[0]).not.toBe(states[1])
  })

  test('never resolves (the page is leaving)', async () => {
    const go = vi.fn()
    let settled = false
    void signIn(go).then(
      () => (settled = true),
      () => (settled = true),
    )
    await vi.waitFor(() => expect(go).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(settled).toBe(false)
  })

  test('rejects when navigation throws', async () => {
    await expect(
      signIn(() => {
        throw new Error('blocked')
      }),
    ).rejects.toThrow(/blocked/)
  })
})

describe('completeRedirect', () => {
  test('does not wait for the network: resolves with the token in memory and in the DB', async () => {
    saveState('s-1', '#/settings')
    landWith({ access_token: 'tok-1', expires_in: '3599', state: 's-1' })
    const { f, release } = deferredUserinfo()

    await completeRedirect() // the render gate: must not wait on the userinfo fetch
    expect(f).toHaveBeenCalledTimes(1) // started, still unanswered
    expect((await storedToken())?.token).toBe('tok-1')
    expect((await storedToken())?.email).toBeUndefined() // not confirmed yet
    expect(await db.meta.get('google.account')).toBeUndefined()

    let tokenSeen: string | undefined
    const t = getToken().then((v) => (tokenSeen = v))
    await new Promise((r) => setTimeout(r, 20))
    expect(tokenSeen).toBeUndefined() // nothing uses the token before its account is known

    release()
    await pendingSignIn()
    await t
    expect(tokenSeen).toBe('tok-1')
    expect(JSON.parse((await db.meta.get('google.account'))!.value)).toEqual({
      name: 'Jamie D',
      email: 'jamie@example.com',
    })
    expect(consumeRedirectSignIn()).toBe(true)
  })

  test('pendingSignIn resolves at once when no sign-in is being completed', async () => {
    await expect(pendingSignIn()).resolves.toBeUndefined()
  })

  test('a sign-out during the background step does not bring the account back', async () => {
    saveState('s-1')
    landWith({ access_token: 'tok-1', expires_in: '3599', state: 's-1' })
    const { release } = deferredUserinfo()
    await completeRedirect()
    await signOut(vi.fn())
    release()
    await pendingSignIn()
    expect(await db.meta.get('google.account')).toBeUndefined()
    expect(await storedToken()).toBeUndefined()
    await expect(getToken()).rejects.toBeInstanceOf(AuthError)
  })

  test('an entry older than 10 minutes counts as missing', async () => {
    saveState('s-1', '#/settings', Date.now() - 10 * 60_000 - 1000)
    landWith({ access_token: 'tok-old', expires_in: '3599', state: 's-1' })
    const f = mockUserinfo()
    await completeRedirect()
    await pendingSignIn()
    expect(location.hash).toBe('#/') // a stale entry's return hash is not used either
    expect(f).not.toHaveBeenCalled()
    expect(await storedToken()).toBeUndefined()
    expect(localStorage.getItem(OAUTH_KEY)).toBeNull()
  })

  test('an entry without createdAt counts as missing', async () => {
    localStorage.setItem(OAUTH_KEY, JSON.stringify({ state: 's-1', returnHash: '#/settings' }))
    landWith({ access_token: 'tok-x', expires_in: '3599', state: 's-1' })
    mockUserinfo()
    await completeRedirect()
    expect(await storedToken()).toBeUndefined()
  })

  test('completes in a different tab (fresh module state, same localStorage and DB)', async () => {
    const go = vi.fn()
    history.replaceState(null, '', '/garage-log/#/settings')
    void signIn(go)
    await vi.waitFor(() => expect(go).toHaveBeenCalled())
    const state = new URL(go.mock.calls[0][0] as string).searchParams.get('state')!

    // Google returns into another browsing context: new page, nothing in memory or sessionStorage.
    sessionStorage.clear()
    vi.resetModules()
    const other = await import('./auth')
    history.replaceState(null, '', '/garage-log/')
    landWith({ access_token: 'tok-tab', expires_in: '3599', state })
    mockUserinfo()
    await other.completeRedirect()
    await other.pendingSignIn()
    expect(location.hash).toBe('#/settings')
    expect((await storedToken())?.token).toBe('tok-tab')

    // The installed app (this module instance) picks it up from IndexedDB.
    resetAuthForTests()
    expect(await getToken()).toBe('tok-tab')
    expect(await isSignedIn()).toBe(true)
  })

  test('strips the fragment synchronously, stores the account and the token', async () => {
    saveState('s-1', '#/settings')
    landWith({ access_token: 'tok-1', token_type: 'Bearer', expires_in: '3599', scope: SCOPE, state: 's-1' })
    const f = mockUserinfo()
    const before = Date.now()

    const p = completeRedirect()
    expect(location.hash).toBe('#/settings') // before any await: the router never sees the token
    expect(location.href).not.toContain('tok-1')
    await p
    await pendingSignIn()

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://www.googleapis.com/oauth2/v3/userinfo')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1')
    expect(JSON.parse((await db.meta.get('google.account'))!.value)).toEqual({
      name: 'Jamie D',
      email: 'jamie@example.com',
    })
    expect(await isSignedIn()).toBe(true)
    expect(await getUser()).toBe('Jamie D')
    const t = (await storedToken())!
    expect(t.token).toBe('tok-1')
    expect(t.email).toBe('jamie@example.com') // confirmed by userinfo
    expect(t.expiresAt).toBeGreaterThanOrEqual(before + 3599_000)
    expect(t.expiresAt).toBeLessThanOrEqual(Date.now() + 3599_000)
    expect(await getToken()).toBe('tok-1')
    expect(localStorage.getItem(OAUTH_KEY)).toBeNull()
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain('tok-1')
  })

  test('falls back to #/ when no return hash was saved', async () => {
    localStorage.setItem(OAUTH_KEY, JSON.stringify({ state: 's-1', returnHash: '', createdAt: Date.now() }))
    landWith({ access_token: 'tok-1', expires_in: '3599', state: 's-1' })
    mockUserinfo()
    const p = completeRedirect()
    expect(location.hash).toBe('#/')
    await p
  })

  test('marks a fresh sign-in once, for the settings page to offer folders', async () => {
    await signedIn()
    expect(consumeRedirectSignIn()).toBe(true)
    expect(consumeRedirectSignIn()).toBe(false)
  })

  test('a mismatched state is ignored: no token, no account, URL cleaned', async () => {
    saveState('s-mine', '#/settings')
    landWith({ access_token: 'tok-evil', expires_in: '3599', state: 's-other' })
    const f = mockUserinfo()
    await completeRedirect()
    expect(location.hash).toBe('#/settings')
    expect(f).not.toHaveBeenCalled()
    expect(await storedToken()).toBeUndefined()
    expect(await isSignedIn()).toBe(false)
    await expect(getToken()).rejects.toBeInstanceOf(AuthError)
    expect(localStorage.getItem(OAUTH_KEY)).toBeNull()
    expect(consumeRedirectSignIn()).toBe(false)
  })

  test('nothing saved (state missing) is ignored, URL cleaned to #/', async () => {
    landWith({ access_token: 'tok-evil', expires_in: '3599', state: 's-x' })
    const f = mockUserinfo()
    await completeRedirect()
    expect(location.hash).toBe('#/')
    expect(f).not.toHaveBeenCalled()
    expect(await storedToken()).toBeUndefined()
    await expect(getToken()).rejects.toBeInstanceOf(AuthError)
  })

  test('a token without state is ignored', async () => {
    saveState('s-mine')
    landWith({ access_token: 'tok-evil', expires_in: '3599' })
    mockUserinfo()
    await completeRedirect()
    expect(await storedToken()).toBeUndefined()
  })

  test('#error=access_denied stores nothing and cleans the URL to the return hash', async () => {
    saveState('s-1', '#/settings')
    landWith({ error: 'access_denied', state: 's-1' })
    const f = mockUserinfo()
    const p = completeRedirect()
    expect(location.hash).toBe('#/settings')
    await p
    expect(f).not.toHaveBeenCalled()
    expect(await storedToken()).toBeUndefined()
    expect(await isSignedIn()).toBe(false)
    expect(localStorage.getItem(OAUTH_KEY)).toBeNull()
  })

  test('does nothing when the hash holds no OAuth params', async () => {
    history.replaceState(null, '', '/garage-log/#/search?q=error')
    saveState('s-1')
    const f = mockUserinfo()
    await completeRedirect()
    expect(location.hash).toBe('#/search?q=error')
    expect(f).not.toHaveBeenCalled()
    expect(localStorage.getItem(OAUTH_KEY)).not.toBeNull()
  })

  test('a failing userinfo request keeps no token and does not throw', async () => {
    saveState('s-1')
    landWith({ access_token: 'tok-1', expires_in: '3599', state: 's-1' })
    mockUserinfo({}, 500)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(completeRedirect()).resolves.toBeUndefined()
    expect(location.hash).toBe('#/settings')
    await expect(pendingSignIn()).resolves.toBeUndefined()
    expect(await storedToken()).toBeUndefined()
    await expect(getToken()).rejects.toBeInstanceOf(AuthError)
    expect(JSON.stringify(err.mock.calls)).not.toContain('tok-1')
    err.mockRestore()
  })

  test('signing in as a different account forgets the previous folder', async () => {
    await db.meta.put({ key: 'google.account', value: JSON.stringify({ email: 'old@x.com', name: 'Old' }) })
    await db.meta.put({ key: 'google.folderId', value: 'folder-old' })
    await db.meta.put({ key: 'google.folderInfo', value: '{}' })
    await signedIn()
    expect(await db.meta.get('google.folderId')).toBeUndefined()
    expect(await db.meta.get('google.folderInfo')).toBeUndefined()
  })

  test('keeps a stored user name when the same account signs in again', async () => {
    await setUser('Chosen Name')
    await db.meta.put({
      key: 'google.account',
      value: JSON.stringify({ email: 'jamie@example.com', name: 'Jamie D' }),
    })
    await signedIn()
    expect(await getUser()).toBe('Chosen Name')
  })

  test('sets the user name when none is stored yet', async () => {
    await signedIn()
    expect(await getUser()).toBe('Jamie D')
  })

  test('sets the user name when a different account signs in', async () => {
    await setUser('Old Name')
    await db.meta.put({ key: 'google.account', value: JSON.stringify({ email: 'old@x.com', name: 'Old' }) })
    await signedIn()
    expect(await getUser()).toBe('Jamie D')
  })

  test('keeps the folder when the same account signs in again', async () => {
    await db.meta.put({
      key: 'google.account',
      value: JSON.stringify({ email: 'jamie@example.com', name: 'Jamie D' }),
    })
    await db.meta.put({ key: 'google.folderId', value: 'folder-1' })
    await signedIn()
    expect((await db.meta.get('google.folderId'))?.value).toBe('folder-1')
  })
})

describe('getToken', () => {
  test('returns the in-memory token while more than 60 s remain', async () => {
    await signedIn()
    expect(await getToken()).toBe('tok-1')
  })

  test('after a reload it returns the persisted token while it is valid', async () => {
    await signedIn('tok-1', 3599)
    resetAuthForTests() // a fresh page: memory is empty
    const f = mockUserinfo()
    expect(await getToken()).toBe('tok-1')
    expect(f).not.toHaveBeenCalled()
  })

  async function persist(row: Record<string, unknown>, accountEmail?: string) {
    if (accountEmail) {
      await db.meta.put({
        key: 'google.account',
        value: JSON.stringify({ email: accountEmail, name: 'Someone' }),
      })
    }
    await db.meta.put({ key: 'google.token', value: JSON.stringify(row) })
    resetAuthForTests() // as after a reload
  }

  test('a persisted token confirmed for the stored account is returned', async () => {
    await persist({ token: 'tok-c', expiresAt: Date.now() + 3_000_000, email: 'jamie@example.com' }, 'jamie@example.com')
    expect(await getToken()).toBe('tok-c')
  })

  test('an unconfirmed persisted token (page closed before userinfo) is discarded', async () => {
    await persist({ token: 'tok-u', expiresAt: Date.now() + 3_000_000 }, 'jamie@example.com')
    await expect(getToken()).rejects.toBeInstanceOf(AuthError)
    expect(await db.meta.get('google.token')).toBeUndefined()
  })

  test('a persisted token confirmed for a different account is discarded', async () => {
    await persist({ token: 'tok-o', expiresAt: Date.now() + 3_000_000, email: 'old@x.com' }, 'jamie@example.com')
    await expect(getToken()).rejects.toBeInstanceOf(AuthError)
    expect(await db.meta.get('google.token')).toBeUndefined()
  })

  test('a confirmed persisted token with no stored account is discarded', async () => {
    await persist({ token: 'tok-n', expiresAt: Date.now() + 3_000_000, email: 'jamie@example.com' })
    await expect(getToken()).rejects.toBeInstanceOf(AuthError)
    expect(await db.meta.get('google.token')).toBeUndefined()
  })

  test('a sign-in interrupted before confirmation is not usable after a reload', async () => {
    saveState('s-1')
    landWith({ access_token: 'tok-i', expires_in: '3599', state: 's-1' })
    deferredUserinfo() // never released: the page "closes" first
    await completeRedirect()
    expect(await storedToken()).toEqual({ token: 'tok-i', expiresAt: expect.any(Number) })
    resetAuthForTests()
    await expect(getToken()).rejects.toBeInstanceOf(AuthError)
    expect(await db.meta.get('google.token')).toBeUndefined()
  })

  test('an expired persisted token throws AuthError and is deleted', async () => {
    await db.meta.put({
      key: 'google.token',
      value: JSON.stringify({ token: 'old', expiresAt: Date.now() - 1000 }),
    })
    await expect(getToken()).rejects.toBeInstanceOf(AuthError)
    expect(await db.meta.get('google.token')).toBeUndefined()
  })

  test('a persisted token within 60 s of expiry is treated as expired', async () => {
    await signedIn('tok-1', 30)
    resetAuthForTests()
    await expect(getToken()).rejects.toBeInstanceOf(AuthError)
    expect(await db.meta.get('google.token')).toBeUndefined()
  })

  test('within 60 s of expiry it throws AuthError and never navigates or fetches', async () => {
    await signedIn('tok-1', 30)
    const f = mockUserinfo()
    const href = location.href
    await Promise.allSettled([getToken(), getToken(), getToken()])
    await expect(getToken()).rejects.toBeInstanceOf(AuthError)
    expect(f).not.toHaveBeenCalled()
    expect(location.href).toBe(href) // no navigation
    expect(localStorage.getItem(OAUTH_KEY)).toBeNull() // no sign-in was started
  })

  test('with no prior sign-in it throws AuthError', async () => {
    await expect(getToken()).rejects.toBeInstanceOf(AuthError)
  })

  test('a corrupt persisted value throws AuthError and is deleted', async () => {
    await db.meta.put({ key: 'google.token', value: 'not json' })
    await expect(getToken()).rejects.toBeInstanceOf(AuthError)
    expect(await db.meta.get('google.token')).toBeUndefined()
  })
})

describe('clearToken', () => {
  test('forgets the token in memory and in the database', async () => {
    await signedIn()
    await clearToken()
    expect(await db.meta.get('google.token')).toBeUndefined()
    await expect(getToken()).rejects.toBeInstanceOf(AuthError)
  })

  test('a rejected token is not reloaded even before the delete lands', async () => {
    await signedIn()
    const p = clearToken() // not awaited, as from a 401 inside a sync pass
    await expect(getToken()).rejects.toBeInstanceOf(AuthError)
    await p
  })
})

describe('signOut', () => {
  test('clears account, folder and token (memory and DB), revokes and stops sync', async () => {
    await signedIn()
    await db.meta.put({ key: 'google.folderId', value: 'folder-1' })
    await db.meta.put({ key: 'google.folderInfo', value: '{}' })
    const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response('', { status: 200 }))
    vi.stubGlobal('fetch', f)

    const reload = vi.fn()
    await signOut(reload)

    expect(reload).toHaveBeenCalledTimes(1)
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://oauth2.googleapis.com/revoke?token=tok-1')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    )
    expect(await db.meta.get('google.account')).toBeUndefined()
    expect(await db.meta.get('google.folderId')).toBeUndefined()
    expect(await db.meta.get('google.folderInfo')).toBeUndefined()
    expect(await db.meta.get('google.token')).toBeUndefined()
    expect(engine.stopSync).toHaveBeenCalledTimes(1)
    expect(await isSignedIn()).toBe(false)
    await expect(getToken()).rejects.toBeInstanceOf(AuthError)
  })

  test('revokes the persisted token after a reload', async () => {
    await signedIn()
    resetAuthForTests()
    const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response('', { status: 200 }))
    vi.stubGlobal('fetch', f)
    await signOut(vi.fn())
    expect(f.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/revoke?token=tok-1')
  })

  test('deletes the account before reloading the page so the next session starts signed out', async () => {
    await signedIn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('')))
    let accountAtReload: unknown = 'unset'
    await signOut(() => {
      void db.meta.get('google.account').then((r) => (accountAtReload = r))
    })
    await vi.waitFor(() => expect(accountAtReload).toBeUndefined())
  })

  test('a reload that throws does not fail signOut', async () => {
    await signOut(() => {
      throw new Error('no reload')
    })
    expect(engine.stopSync).toHaveBeenCalledTimes(1)
  })

  test('still signs out when revoke fails or throws', async () => {
    await signedIn()
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))))
    const reload = vi.fn()
    await signOut(reload)
    expect(await isSignedIn()).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)

    await signedIn('tok-2')
    vi.stubGlobal('fetch', () => {
      throw new Error('boom')
    })
    await signOut(reload)
    expect(await isSignedIn()).toBe(false)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  test('without a token it does not call the revoke endpoint', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    await signOut(vi.fn())
    expect(f).not.toHaveBeenCalled()
  })
})
