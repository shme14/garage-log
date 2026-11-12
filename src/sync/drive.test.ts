import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { db } from '../db/db'

const auth = vi.hoisted(() => ({
  getToken: vi.fn(async () => 'tok'),
  clearToken: vi.fn(),
}))
vi.mock('./auth', () => auth)

import {
  createDriveStore,
  createFolder,
  findFolders,
  getFolder,
  getFolderId,
  setFolder,
} from './drive'
import { FOLDER_NAME } from './config'
import { AuthError } from './store'

type Call = { url: URL; init: RequestInit }
let calls: Call[]
let responder: (c: Call) => Response | Promise<Response>

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(async () => {
  await db.meta.clear()
  auth.getToken.mockClear()
  auth.clearToken.mockClear()
  calls = []
  responder = () => json({})
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const c = { url: new URL(url), init }
      calls.push(c)
      return responder(c)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const headers = (c: Call) => c.init.headers as Record<string, string>

describe('folders', () => {
  test('findFolders queries by name and mime type across drives and maps owner and shared', async () => {
    responder = () =>
      json({
        files: [
          { id: 'f1', name: 'Garage Log', owners: [{ emailAddress: 'owner@x.com' }], shared: true },
          { id: 'f2', name: 'Garage Log' },
        ],
      })
    const out = await findFolders()
    expect(out).toEqual([
      { id: 'f1', name: 'Garage Log', ownerEmail: 'owner@x.com', shared: true },
      { id: 'f2', name: 'Garage Log', ownerEmail: '', shared: false },
    ])
    const { url, init } = calls[0]
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/drive/v3/files')
    expect(url.searchParams.get('q')).toBe(
      "name='Garage Log' and mimeType='application/vnd.google-apps.folder' and trashed=false",
    )
    expect(url.searchParams.get('includeItemsFromAllDrives')).toBe('true')
    expect(url.searchParams.get('supportsAllDrives')).toBe('true')
    expect(url.searchParams.get('fields')).toBe('files(id,name,owners(emailAddress),shared)')
    expect(headers({ url, init })['Authorization']).toBe('Bearer tok')
  })

  test('createFolder creates when none exists and returns it', async () => {
    responder = (c) =>
      c.init.method === 'POST'
        ? json({ id: 'new1', name: 'Garage Log', owners: [{ emailAddress: 'me@x.com' }], shared: false })
        : json({ files: [] })
    const f = await createFolder()
    expect(f).toEqual({ id: 'new1', name: 'Garage Log', ownerEmail: 'me@x.com', shared: false })
    const post = calls.find((c) => c.init.method === 'POST')!
    expect(post.url.pathname).toBe('/drive/v3/files')
    expect(post.url.searchParams.get('supportsAllDrives')).toBe('true')
    expect(JSON.parse(post.init.body as string)).toEqual({
      name: 'Garage Log',
      mimeType: 'application/vnd.google-apps.folder',
    })
  })

  test('createFolder refuses when a Garage Log folder already exists (no second folder)', async () => {
    responder = () => json({ files: [{ id: 'f1', name: 'Garage Log', shared: true }] })
    await expect(createFolder()).rejects.toThrow(/already exists/i)
    expect(calls.some((c) => c.init.method === 'POST')).toBe(false)
  })

  test('setFolder stores the id and details; getFolder / getFolderId read them back', async () => {
    expect(await getFolderId()).toBeUndefined()
    await setFolder('f1', { id: 'f1', name: 'Garage Log', ownerEmail: 'o@x.com', shared: true })
    expect((await db.meta.get('google.folderId'))?.value).toBe('f1')
    expect(await getFolderId()).toBe('f1')
    expect(await getFolder()).toEqual({ id: 'f1', name: 'Garage Log', ownerEmail: 'o@x.com', shared: true })
  })

  test('setFolder without details drops stale details', async () => {
    await setFolder('f1', { id: 'f1', name: 'Garage Log', ownerEmail: 'o@x.com', shared: true })
    await setFolder('f2')
    expect(await getFolderId()).toBe('f2')
    expect(await getFolder()).toEqual({ id: 'f2', name: FOLDER_NAME, ownerEmail: '', shared: false })
  })
})

describe('drive store', () => {
  beforeEach(async () => {
    await setFolder('folder-1')
  })

  test('list queries the folder, follows nextPageToken and returns id/name', async () => {
    responder = (c) =>
      c.url.searchParams.get('pageToken') === 'p2'
        ? json({ files: [{ id: 'b', name: 'changes-b.json' }] })
        : json({ files: [{ id: 'a', name: 'changes-a.json' }], nextPageToken: 'p2' })
    const out = await createDriveStore().list()
    expect(out).toEqual([
      { id: 'a', name: 'changes-a.json' },
      { id: 'b', name: 'changes-b.json' },
    ])
    expect(calls).toHaveLength(2)
    const u = calls[0].url
    expect(u.searchParams.get('q')).toBe(
      "'folder-1' in parents and trashed=false and name contains 'changes-'",
    )
    expect(u.searchParams.get('supportsAllDrives')).toBe('true')
    expect(u.searchParams.get('includeItemsFromAllDrives')).toBe('true')
    expect(u.searchParams.get('fields')).toBe('nextPageToken,files(id,name)')
    expect(calls[1].url.searchParams.get('pageToken')).toBe('p2')
  })

  test('read fetches the media as text', async () => {
    responder = () => new Response('{"hello":1}', { status: 200 })
    expect(await createDriveStore().read('abc')).toBe('{"hello":1}')
    const u = calls[0].url
    expect(u.pathname).toBe('/drive/v3/files/abc')
    expect(u.searchParams.get('alt')).toBe('media')
    expect(u.searchParams.get('supportsAllDrives')).toBe('true')
  })

  test('writeOwn creates (multipart, parents set) when missing, then PATCHes the cached id', async () => {
    responder = (c) => {
      if (c.init.method === 'POST') return json({ id: 'created-1' })
      if (c.init.method === 'PATCH') return json({ id: 'created-1' })
      return json({ files: [] }) // lookup by name
    }
    const store = createDriveStore()
    await store.writeOwn('changes-me.json', '{"v":1}')

    const lookup = calls[0]
    expect(lookup.url.searchParams.get('q')).toBe(
      "'folder-1' in parents and name='changes-me.json' and trashed=false",
    )
    const post = calls[1]
    expect(post.init.method).toBe('POST')
    expect(post.url.pathname).toBe('/upload/drive/v3/files')
    expect(post.url.searchParams.get('uploadType')).toBe('multipart')
    expect(post.url.searchParams.get('supportsAllDrives')).toBe('true')
    expect(headers(post)['Content-Type']).toMatch(/^multipart\/related; boundary=/)
    const body = post.init.body as string
    expect(body).toContain('"name":"changes-me.json"')
    expect(body).toContain('"parents":["folder-1"]')
    expect(body).toContain('"mimeType":"application/json"')
    expect(body).toContain('{"v":1}')

    await store.writeOwn('changes-me.json', '{"v":2}')
    expect(calls).toHaveLength(3) // no second lookup
    const patch = calls[2]
    expect(patch.init.method).toBe('PATCH')
    expect(patch.url.pathname).toBe('/upload/drive/v3/files/created-1')
    expect(patch.url.searchParams.get('uploadType')).toBe('media')
    expect(patch.url.searchParams.get('supportsAllDrives')).toBe('true')
    expect(patch.init.body).toBe('{"v":2}')
    expect(headers(patch)['Content-Type']).toBe('application/json')
  })

  test('writeOwn PATCHes an existing file found by name', async () => {
    responder = (c) =>
      c.init.method === 'PATCH' ? json({ id: 'existing' }) : json({ files: [{ id: 'existing' }] })
    await createDriveStore().writeOwn('changes-me.json', 'X')
    expect(calls.map((c) => c.init.method ?? 'GET')).toEqual(['GET', 'PATCH'])
    expect(calls[1].url.pathname).toBe('/upload/drive/v3/files/existing')
  })

  test('writeOwn recovers when the cached file was deleted (404) by creating a new one', async () => {
    let patches = 0
    responder = (c) => {
      if (c.init.method === 'PATCH') {
        patches++
        return json({ error: { code: 404 } }, 404)
      }
      if (c.init.method === 'POST') return json({ id: 'fresh' })
      return json({ files: [{ id: 'old' }] })
    }
    const store = createDriveStore()
    await store.writeOwn('changes-me.json', 'A') // lookup finds old, PATCH 404, re-lookup, create
    expect(patches).toBe(1)
    expect(calls.some((c) => c.init.method === 'POST')).toBe(true)
  })

  test('401 clears the token and throws AuthError', async () => {
    responder = () => json({ error: { code: 401 } }, 401)
    await expect(createDriveStore().list()).rejects.toBeInstanceOf(AuthError)
    expect(auth.clearToken).toHaveBeenCalledTimes(1)
  })

  test('403 insufficientPermissions / authError is an AuthError; other 403s are plain errors', async () => {
    responder = () => json({ error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } }, 403)
    await expect(createDriveStore().list()).rejects.toBeInstanceOf(AuthError)
    responder = () => json({ error: { code: 403, errors: [{ reason: 'authError' }] } }, 403)
    await expect(createDriveStore().list()).rejects.toBeInstanceOf(AuthError)

    responder = () => json({ error: { code: 403, errors: [{ reason: 'rateLimitExceeded' }] } }, 403)
    const err = await createDriveStore().list().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(AuthError)
    expect((err as Error).message).toContain('403')
    expect((err as Error).message).toContain('rateLimitExceeded')
  })

  test('other non-2xx statuses throw an Error with status and a body snippet', async () => {
    responder = () => new Response('x'.repeat(500), { status: 500 })
    const err = (await createDriveStore().read('a').catch((e: unknown) => e)) as Error
    expect(err).not.toBeInstanceOf(AuthError)
    expect(err.message).toContain('500')
    expect(err.message.length).toBeLessThan(400)
  })

  test('a network failure is a plain Error, not an AuthError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const err = await createDriveStore().list().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(AuthError)
    expect(err).not.toBeInstanceOf(TypeError)
  })

  test('a token failure propagates as AuthError', async () => {
    auth.getToken.mockRejectedValueOnce(new AuthError('Sign in'))
    await expect(createDriveStore().list()).rejects.toBeInstanceOf(AuthError)
    expect(calls).toHaveLength(0)
  })
})

describe('drive store without a folder', () => {
  test('every operation throws AuthError telling the user to choose a folder', async () => {
    const store = createDriveStore()
    for (const op of [
      () => store.list(),
      () => store.read('x'),
      () => store.writeOwn('changes-a.json', '{}'),
    ]) {
      const err = await op().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(AuthError)
      expect((err as Error).message).toMatch(/choose a folder/i)
    }
    expect(calls).toHaveLength(0)
  })

  test('picking up a folder chosen later needs no new store', async () => {
    const store = createDriveStore()
    await expect(store.list()).rejects.toBeInstanceOf(AuthError)
    await setFolder('late')
    responder = () => json({ files: [] })
    await expect(store.list()).resolves.toEqual([])
    expect(calls[0].url.searchParams.get('q')).toContain("'late' in parents")
  })

  test('changing folder drops the cached own-file id', async () => {
    responder = (c) =>
      c.init.method === 'POST' ? json({ id: 'in-1' }) : c.init.method === 'PATCH' ? json({}) : json({ files: [] })
    const store = createDriveStore()
    await setFolder('one')
    await store.writeOwn('changes-me.json', 'a')
    await setFolder('two')
    calls.length = 0
    await store.writeOwn('changes-me.json', 'b')
    expect(calls[0].url.searchParams.get('q')).toContain("'two' in parents") // looked up again, not PATCHed
  })
})
