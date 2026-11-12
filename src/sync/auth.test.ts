import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { db, getUser } from '../db/db'

const engine = vi.hoisted(() => ({ stopSync: vi.fn() }))
vi.mock('./engine', () => engine)

import { AuthError } from './store'
import { clearToken, getAccount, getToken, isSignedIn, signIn, signOut } from './auth'

interface TokenResp {
  access_token?: string
  expires_in?: number
  error?: string
}
interface Cfg {
  client_id: string
  scope: string
  callback: (r: TokenResp) => void
  error_callback: (e: { type: string }) => void
}

// A fake google.accounts.oauth2 whose requestAccessToken answers from a queue.
function installGoogle() {
  const requests: Record<string, unknown>[] = []
  const answers: (TokenResp | { fail: string })[] = []
  let cfg: Cfg | undefined
  const revoke = vi.fn((_t: string, done?: () => void) => done?.())
  const oauth2 = {
    initTokenClient: vi.fn((c: Cfg) => {
      cfg = c
      return {
        requestAccessToken(o: Record<string, unknown>) {
          requests.push(o)
          const a = answers.shift()
          if (!a) return // never answers
          if ('fail' in a) cfg!.error_callback({ type: a.fail })
          else cfg!.callback(a)
        },
      }
    }),
    revoke,
  }
  ;(window as unknown as { google: unknown }).google = { accounts: { oauth2 } }
  return { requests, answers, oauth2, revoke, config: () => cfg }
}

function mockUserinfo(body: unknown = { name: 'Jamie D', email: 'jamie@example.com' }, status = 200) {
  const f = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', f)
  return f
}

beforeEach(async () => {
  await db.meta.clear()
  clearToken()
  engine.stopSync.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  delete (window as unknown as { google?: unknown }).google
})

describe('signIn', () => {
  test('requests the fixed scope with no prompt, stores the account (not the token), sets the user', async () => {
    const g = installGoogle()
    g.answers.push({ access_token: 'tok-1', expires_in: 3599 })
    const f = mockUserinfo()

    const acct = await signIn()

    expect(acct).toEqual({ name: 'Jamie D', email: 'jamie@example.com' })
    const cfg = g.config()!
    expect(cfg.scope).toBe('https://www.googleapis.com/auth/drive openid email profile')
    expect(cfg.client_id).toMatch(/\.apps\.googleusercontent\.com$/)
    expect(g.requests).toEqual([{ prompt: '' }])
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://www.googleapis.com/oauth2/v3/userinfo')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1')
    expect(await getUser()).toBe('Jamie D')
    expect(JSON.parse((await db.meta.get('google.account'))!.value)).toEqual(acct)
    expect(await isSignedIn()).toBe(true)
    expect(await getAccount()).toEqual(acct)
    // the token never lands in storage
    const rows = JSON.stringify(await db.meta.toArray())
    expect(rows).not.toContain('tok-1')
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain('tok-1')
    expect(await getToken()).toBe('tok-1')
  })

  test('rejects when the user closes the popup, and stores nothing', async () => {
    const g = installGoogle()
    g.answers.push({ fail: 'popup_closed' })
    mockUserinfo()
    await expect(signIn()).rejects.toThrow(/popup_closed/)
    expect(await isSignedIn()).toBe(false)
  })

  test('rejects on an error response', async () => {
    const g = installGoogle()
    g.answers.push({ error: 'access_denied' })
    mockUserinfo()
    await expect(signIn()).rejects.toThrow(/access_denied/)
    expect(await isSignedIn()).toBe(false)
  })

  test('requests the token synchronously inside the click handler when GIS is already loaded', async () => {
    const g = installGoogle()
    g.answers.push({ access_token: 't', expires_in: 3599 })
    mockUserinfo()
    const p = signIn() // no await before checking
    expect(g.requests).toHaveLength(1)
    await p
  })

  test('signing in as a different account forgets the previous folder', async () => {
    await db.meta.put({ key: 'google.account', value: JSON.stringify({ email: 'old@x.com', name: 'Old' }) })
    await db.meta.put({ key: 'google.folderId', value: 'folder-old' })
    const g = installGoogle()
    g.answers.push({ access_token: 't', expires_in: 3599 })
    mockUserinfo()
    await signIn()
    expect(await db.meta.get('google.folderId')).toBeUndefined()
  })

  test('keeps the folder when the same account signs in again', async () => {
    await db.meta.put({
      key: 'google.account',
      value: JSON.stringify({ email: 'jamie@example.com', name: 'Jamie D' }),
    })
    await db.meta.put({ key: 'google.folderId', value: 'folder-1' })
    const g = installGoogle()
    g.answers.push({ access_token: 't', expires_in: 3599 })
    mockUserinfo()
    await signIn()
    expect((await db.meta.get('google.folderId'))?.value).toBe('folder-1')
  })
})

describe('getToken', () => {
  async function signedIn(g: ReturnType<typeof installGoogle>, expiresIn = 3599) {
    g.answers.push({ access_token: 'tok-1', expires_in: expiresIn })
    mockUserinfo()
    await signIn()
    g.requests.length = 0
  }

  test('returns the cached token while more than 60 s remain', async () => {
    const g = installGoogle()
    await signedIn(g)
    expect(await getToken()).toBe('tok-1')
    expect(g.requests).toHaveLength(0)
  })

  test('within 60 s of expiry it silently re-requests with prompt none and login_hint', async () => {
    const g = installGoogle()
    await signedIn(g, 30)
    g.answers.push({ access_token: 'tok-2', expires_in: 3599 })
    expect(await getToken()).toBe('tok-2')
    expect(g.requests).toEqual([{ prompt: 'none', login_hint: 'jamie@example.com' }])
  })

  test('concurrent callers share one silent request', async () => {
    const g = installGoogle()
    await signedIn(g, 30)
    g.answers.push({ access_token: 'tok-2', expires_in: 3599 })
    const [a, b] = await Promise.all([getToken(), getToken()])
    expect([a, b]).toEqual(['tok-2', 'tok-2'])
    expect(g.requests).toHaveLength(1)
  })

  test('a failed silent request is an AuthError', async () => {
    const g = installGoogle()
    await signedIn(g, 30)
    g.answers.push({ fail: 'popup_failed_to_open' })
    await expect(getToken()).rejects.toBeInstanceOf(AuthError)
  })

  test('a silent request that returns an error response is an AuthError', async () => {
    const g = installGoogle()
    await signedIn(g, 30)
    g.answers.push({ error: 'interaction_required' })
    await expect(getToken()).rejects.toBeInstanceOf(AuthError)
  })

  test('a silent request that never answers times out as an AuthError', async () => {
    const g = installGoogle()
    await signedIn(g, 30)
    vi.useFakeTimers()
    const p = getToken()
    const assertion = expect(p).rejects.toBeInstanceOf(AuthError)
    await vi.advanceTimersByTimeAsync(60_000)
    await assertion
  })

  test('with no prior sign-in it throws AuthError without opening anything', async () => {
    const g = installGoogle()
    await expect(getToken()).rejects.toBeInstanceOf(AuthError)
    expect(g.requests).toHaveLength(0)
  })

  test('clearToken forces the next getToken to re-request', async () => {
    const g = installGoogle()
    await signedIn(g)
    clearToken()
    g.answers.push({ access_token: 'tok-3', expires_in: 3599 })
    expect(await getToken()).toBe('tok-3')
  })
})

describe('signOut', () => {
  test('clears account, folder and token, revokes best-effort and stops sync', async () => {
    const g = installGoogle()
    g.answers.push({ access_token: 'tok-1', expires_in: 3599 })
    mockUserinfo()
    await signIn()
    await db.meta.put({ key: 'google.folderId', value: 'folder-1' })
    await db.meta.put({ key: 'google.folderInfo', value: '{}' })

    const reload = vi.fn()
    await signOut(reload)

    expect(reload).toHaveBeenCalledTimes(1)
    expect(g.revoke).toHaveBeenCalledWith('tok-1', expect.anything())
    expect(await db.meta.get('google.account')).toBeUndefined()
    expect(await db.meta.get('google.folderId')).toBeUndefined()
    expect(await db.meta.get('google.folderInfo')).toBeUndefined()
    expect(engine.stopSync).toHaveBeenCalledTimes(1)
    expect(await isSignedIn()).toBe(false)
    await expect(getToken()).rejects.toBeInstanceOf(AuthError)
  })

  test('deletes the account before reloading the page so the next session starts signed out', async () => {
    const g = installGoogle()
    g.answers.push({ access_token: 'tok-1', expires_in: 3599 })
    mockUserinfo()
    await signIn()
    let accountAtReload: unknown = 'unset'
    await signOut(() => {
      // reload is called synchronously after the awaited meta delete
      void db.meta.get('google.account').then((r) => (accountAtReload = r))
    })
    await vi.waitFor(() => expect(accountAtReload).toBeUndefined())
  })

  test('a reload that throws does not fail signOut', async () => {
    installGoogle()
    await signOut(() => {
      throw new Error('no reload')
    })
    expect(engine.stopSync).toHaveBeenCalledTimes(1)
  })

  test('still signs out when revoke throws or GIS is absent', async () => {
    const g = installGoogle()
    g.answers.push({ access_token: 'tok-1', expires_in: 3599 })
    mockUserinfo()
    await signIn()
    g.revoke.mockImplementation(() => {
      throw new Error('boom')
    })
    await signOut(vi.fn())
    expect(await isSignedIn()).toBe(false)

    delete (window as unknown as { google?: unknown }).google
    await signOut(vi.fn())
    expect(engine.stopSync).toHaveBeenCalledTimes(2)
  })
})
