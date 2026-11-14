import { beforeEach, describe, expect, test, vi } from 'vitest'

const m = vi.hoisted(() => ({
  running: false,
  signedIn: true,
  folderId: 'folder-1' as string | undefined,
  startSync: vi.fn(),
  isSyncRunning: vi.fn(),
  isSignedIn: vi.fn(),
  getFolderId: vi.fn(),
  completeRedirect: vi.fn(),
  order: [] as string[],
  store: { tag: 'drive-store' },
}))

vi.mock('./engine', () => ({
  startSync: (s: unknown) => {
    m.running = true
    m.startSync(s)
  },
  isSyncRunning: () => m.running,
}))
vi.mock('./auth', () => ({
  isSignedIn: async () => {
    m.order.push('isSignedIn')
    return m.signedIn
  },
  completeRedirect: () => m.completeRedirect(),
}))
vi.mock('./drive', () => ({
  getFolderId: async () => m.folderId,
  createDriveStore: () => m.store,
}))

import { bootSync, ensureSyncStarted, resetSyncSessionForTests, startApp } from './boot'

beforeEach(() => {
  resetSyncSessionForTests()
  m.running = false
  m.signedIn = true
  m.folderId = 'folder-1'
  m.startSync.mockClear()
  m.order = []
  m.completeRedirect.mockReset().mockImplementation(async () => {
    m.order.push('completeRedirect')
  })
})

describe('ensureSyncStarted', () => {
  test('starts the engine with the drive store when signed in with a folder', async () => {
    expect(await ensureSyncStarted()).toBe(true)
    expect(m.startSync).toHaveBeenCalledWith(m.store)
  })

  test('does nothing when not signed in', async () => {
    m.signedIn = false
    expect(await ensureSyncStarted()).toBe(false)
    expect(m.startSync).not.toHaveBeenCalled()
  })

  test('does nothing when no folder is chosen', async () => {
    m.folderId = undefined
    expect(await ensureSyncStarted()).toBe(false)
    expect(m.startSync).not.toHaveBeenCalled()
  })

  test('starts only once per session, even after the engine was stopped', async () => {
    expect(await ensureSyncStarted()).toBe(true)
    m.running = false // as if stopSync() had run (e.g. sign-out before the page reloads)
    expect(await ensureSyncStarted()).toBe(false)
    expect(await ensureSyncStarted()).toBe(false)
    expect(m.startSync).toHaveBeenCalledTimes(1)
  })

  test('never starts a second time while running, even for concurrent calls', async () => {
    const results = await Promise.all([ensureSyncStarted(), ensureSyncStarted(), ensureSyncStarted()])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(m.startSync).toHaveBeenCalledTimes(1)
    expect(await ensureSyncStarted()).toBe(false)
    expect(m.startSync).toHaveBeenCalledTimes(1)
  })
})

describe('bootSync', () => {
  test('starts sync once', async () => {
    await bootSync()
    expect(m.startSync).toHaveBeenCalledTimes(1)
  })

  test('asks the browser for persistent storage once, fire-and-forget', async () => {
    const persist = vi.fn(async () => true)
    vi.stubGlobal('navigator', { ...navigator, storage: { persist } })
    await bootSync()
    expect(persist).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  test('survives a browser without storage.persist or one that throws', async () => {
    vi.stubGlobal('navigator', { ...navigator, storage: undefined })
    await expect(bootSync()).resolves.toBeUndefined()
    vi.stubGlobal('navigator', {
      ...navigator,
      storage: {
        persist: () => {
          throw new Error('nope')
        },
      },
    })
    await expect(bootSync()).resolves.toBeUndefined()
    vi.stubGlobal('navigator', { ...navigator, storage: { persist: () => Promise.reject(new Error('x')) } })
    await expect(bootSync()).resolves.toBeUndefined()
    vi.unstubAllGlobals()
  })

  test('never rejects', async () => {
    m.folderId = undefined
    m.signedIn = false
    await expect(bootSync()).resolves.toBeUndefined()
  })
})

describe('startApp', () => {
  test('finishes the Google redirect before rendering, then boots sync', async () => {
    let finish!: () => void
    m.completeRedirect.mockImplementation(
      () =>
        new Promise<void>((r) => {
          finish = () => {
            m.order.push('completeRedirect')
            r()
          }
        }),
    )
    const render = vi.fn(() => m.order.push('render'))
    const done = startApp(render)
    await Promise.resolve()
    expect(render).not.toHaveBeenCalled() // the router must not see the token fragment
    finish()
    await done
    await vi.waitFor(() => expect(m.startSync).toHaveBeenCalledTimes(1))
    expect(m.order.slice(0, 3)).toEqual(['completeRedirect', 'render', 'isSignedIn'])
  })

  test('renders even when completing the redirect fails', async () => {
    m.completeRedirect.mockRejectedValue(new Error('boom'))
    const render = vi.fn()
    await startApp(render)
    expect(render).toHaveBeenCalledTimes(1)
  })
})
