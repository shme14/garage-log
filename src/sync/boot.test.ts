import { beforeEach, describe, expect, test, vi } from 'vitest'

const m = vi.hoisted(() => ({
  running: false,
  signedIn: true,
  folderId: 'folder-1' as string | undefined,
  startSync: vi.fn(),
  isSyncRunning: vi.fn(),
  isSignedIn: vi.fn(),
  getFolderId: vi.fn(),
  preloadGsi: vi.fn(),
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
  isSignedIn: async () => m.signedIn,
  preloadGsi: m.preloadGsi,
}))
vi.mock('./drive', () => ({
  getFolderId: async () => m.folderId,
  createDriveStore: () => m.store,
}))

import { bootSync, ensureSyncStarted } from './boot'

beforeEach(() => {
  m.running = false
  m.signedIn = true
  m.folderId = 'folder-1'
  m.startSync.mockClear()
  m.preloadGsi.mockClear()
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

  test('never starts a second time while running, even for concurrent calls', async () => {
    const results = await Promise.all([ensureSyncStarted(), ensureSyncStarted(), ensureSyncStarted()])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(m.startSync).toHaveBeenCalledTimes(1)
    expect(await ensureSyncStarted()).toBe(false)
    expect(m.startSync).toHaveBeenCalledTimes(1)
  })
})

describe('bootSync', () => {
  test('preloads Google sign-in and starts sync once', async () => {
    await bootSync()
    expect(m.preloadGsi).toHaveBeenCalled()
    expect(m.startSync).toHaveBeenCalledTimes(1)
  })

  test('never rejects', async () => {
    m.folderId = undefined
    m.signedIn = false
    await expect(bootSync()).resolves.toBeUndefined()
  })
})
