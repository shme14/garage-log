import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { db, getUser, setUser } from '../db/db'
import { putRaw } from '../db/repo'
import type { SyncStatus } from '../sync/engine'
import type { Entry, Vehicle } from '../model/types'
import SettingsPage from './SettingsPage'

type Subscriber = (s: SyncStatus, lastSynced?: string, skipped?: string[]) => void
// What the mocked sync engine reports to each new subscriber.
const sync = vi.hoisted(() => ({ report: (_fn: unknown): void => {} }))

interface Folder {
  id: string
  name: string
  ownerEmail: string
  shared: boolean
}
// State and spies behind the mocked auth / drive / boot modules.
const google = vi.hoisted(() => ({
  account: undefined as { name: string; email: string } | undefined,
  folder: undefined as Folder | undefined,
  matches: [] as Folder[],
  signIn: vi.fn(),
  signOut: vi.fn(),
  findFolders: vi.fn(),
  createFolder: vi.fn(),
  setFolder: vi.fn(),
  ensureSyncStarted: vi.fn(),
  syncNow: vi.fn(),
  preloadGsi: vi.fn(),
}))

vi.mock('../sync/engine', () => ({
  subscribeStatus: (fn: Subscriber) => {
    sync.report(fn)
    return () => {}
  },
  syncNow: (...a: unknown[]) => google.syncNow(...a),
}))
vi.mock('../sync/auth', () => ({
  getAccount: async () => google.account,
  signIn: (...a: unknown[]) => google.signIn(...a),
  signOut: (...a: unknown[]) => google.signOut(...a),
  preloadGsi: () => google.preloadGsi(),
}))
vi.mock('../sync/drive', () => ({
  getFolder: async () => google.folder,
  findFolders: (...a: unknown[]) => google.findFolders(...a),
  createFolder: (...a: unknown[]) => google.createFolder(...a),
  setFolder: (...a: unknown[]) => google.setFolder(...a),
}))
vi.mock('../sync/boot', () => ({
  ensureSyncStarted: (...a: unknown[]) => google.ensureSyncStarted(...a),
}))

/** A tiny synthetic seed file: 1 vehicle, 1 issue, 1 service item, 1 todo, 2 entries (6 records). */
const seedJson = {
  vehicles: [
    { id: 'v-seed', name: 'Test Truck', kind: 'truck', info: '', archived: false, meters: [] },
  ],
  issues: [{ id: 'i-seed', vehicleId: 'v-seed', title: 'Test issue', status: 'open' }],
  serviceItems: [{ id: 's-seed', vehicleId: 'v-seed', name: 'Test service', intervalMonths: 12 }],
  todos: [{ id: 't-seed', vehicleId: 'v-seed', text: 'Test todo', done: false }],
  entries: [
    {
      id: 'e-seed-1',
      vehicleId: 'v-seed',
      date: { precision: 'day', value: '2024-01-10' },
      readings: {},
      text: 'First seeded entry',
      tags: [],
      issueId: 'i-seed',
      serviceItemIds: ['s-seed'],
    },
    {
      id: 'e-seed-2',
      vehicleId: 'v-seed',
      date: { precision: 'month', value: '2024-06' },
      readings: {},
      text: 'Second seeded entry',
      tags: [],
      serviceItemIds: [],
    },
  ],
}

const base = {
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: 'test',
  updatedByDevice: 'dev',
  deleted: false,
}

const vehicle = (id: string, name: string, over: Partial<Vehicle> = {}): Vehicle => ({
  ...base,
  id,
  name,
  kind: 'car',
  info: '',
  infoUpdatedAt: '',
  meters: [],
  archived: false,
  ...over,
})

const entry = (id: string, over: Partial<Entry> = {}): Entry => ({
  ...base,
  id,
  vehicleId: 'v1',
  date: { precision: 'day', value: '2026-05-21' },
  readings: {},
  text: `entry ${id}`,
  tags: [],
  serviceItemIds: [],
  createdBy: 'Jamie',
  ...over,
})

function renderPage() {
  return render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  )
}

beforeEach(async () => {
  sync.report = (fn) => (fn as Subscriber)('pending')
  google.account = undefined
  google.folder = undefined
  google.matches = []
  google.signIn.mockReset().mockImplementation(async () => {
    google.account = { name: 'Jamie D', email: 'jamie@example.com' }
    return google.account
  })
  google.signOut.mockReset().mockImplementation(async () => {
    google.account = undefined
    google.folder = undefined
  })
  google.findFolders.mockReset().mockImplementation(async () => google.matches)
  google.createFolder.mockReset().mockImplementation(async () => ({
    id: 'new-1',
    name: 'Garage Log',
    ownerEmail: 'jamie@example.com',
    shared: false,
  }))
  google.setFolder.mockReset().mockImplementation(async (_id: string, info?: Folder) => {
    google.folder = info
  })
  google.ensureSyncStarted.mockReset().mockResolvedValue(true)
  google.syncNow.mockReset().mockResolvedValue(undefined)
  google.preloadGsi.mockReset()
  await Promise.all([
    db.vehicles.clear(),
    db.entries.clear(),
    db.issues.clear(),
    db.todos.clear(),
    db.serviceItems.clear(),
    db.meta.clear(),
  ])
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SettingsPage', () => {
  test('saves the trimmed name, prefilled from the stored one', async () => {
    await setUser('Old Name')
    const user = userEvent.setup()
    renderPage()
    const field = screen.getByLabelText('Your name')
    await waitFor(() => expect(field).toHaveValue('Old Name'))
    await user.clear(field)
    await user.type(field, '  Jamie ')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(async () => expect(await getUser()).toBe('Jamie'))
    expect(await screen.findByText('Saved')).toBeInTheDocument()
  })

  test('lists live vehicles with edit links, marks archived ones, and links to add one', async () => {
    await putRaw({
      vehicles: [
        vehicle('v1', 'Test Truck'),
        vehicle('v2', 'Old Truck', { archived: true }),
        vehicle('v3', 'Deleted', { deleted: true }),
      ],
    })
    renderPage()
    expect(await screen.findByRole('link', { name: 'Test Truck' })).toHaveAttribute(
      'href',
      '/vehicles/v1/edit',
    )
    const archived = screen.getByRole('link', { name: /Old Truck/ })
    expect(archived).toHaveAttribute('href', '/vehicles/v2/edit')
    expect(archived).toHaveTextContent('Old Truck (archived)')
    expect(screen.queryByText('Deleted')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Add vehicle' })).toHaveAttribute(
      'href',
      '/vehicles/new',
    )
  })

  test('shows sync status, last synced time and a warning naming skipped files', async () => {
    const iso = new Date(2026, 9, 5, 14, 30).toISOString()
    sync.report = (fn) => (fn as Subscriber)('error', iso, ['changes-abc.json', 'changes-def.json'])
    renderPage()
    expect(screen.getByText('Sync error')).toBeInTheDocument()
    expect(screen.getByText(/Last synced/)).toHaveTextContent(new Date(iso).toLocaleString())
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('changes-abc.json')
    expect(alert).toHaveTextContent('changes-def.json')
  })

  test('has no warning or last-synced line when there is nothing to report', () => {
    sync.report = (fn) => (fn as Subscriber)('synced', undefined, [])
    renderPage()
    expect(screen.getByText('Synced')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText(/Last synced/)).not.toBeInTheDocument()
  })

  test('exports JSON and text as dated downloads and revokes the object URLs', async () => {
    await putRaw({
      vehicles: [vehicle('v1', 'Test Truck')],
      entries: [entry('e1', { text: 'Torqued bushings' }), entry('e2', { text: 'gone', deleted: true })],
    })
    const blobs: Blob[] = []
    const create = vi.fn((b: Blob) => {
      blobs.push(b)
      return `blob:fake-${blobs.length}`
    })
    const revoke = vi.fn()
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke })
    const names: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download)
    })

    const now = new Date()
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Export JSON' }))
    await waitFor(() => expect(names).toEqual([`garage-log-${stamp}.json`]))
    await user.click(screen.getByRole('button', { name: 'Export text' }))
    await waitFor(() => expect(names).toHaveLength(2))
    expect(names[1]).toBe(`garage-log-${stamp}.txt`)

    const json = JSON.parse(await blobs[0].text())
    expect(json.version).toBe(1)
    expect(json.records.entries).toHaveLength(2) // tombstones included
    const text = await blobs[1].text()
    expect(text).toContain('# Test Truck')
    expect(text).toContain('Torqued bushings')
    expect(text).not.toContain('gone')

    await waitFor(() => expect(revoke).toHaveBeenCalledTimes(2), { timeout: 3000 })
    expect(revoke).toHaveBeenCalledWith('blob:fake-1')
  })

  test('when not signed in it says so and offers Sign in only', async () => {
    renderPage()
    expect(await screen.findByText('Not signed in')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Choose folder' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument()
  })

  test('shows the signed-in account and the chosen folder with its owner', async () => {
    google.account = { name: 'Jamie D', email: 'jamie@example.com' }
    google.folder = { id: 'f1', name: 'Garage Log', ownerEmail: 'owner@example.com', shared: true }
    renderPage()
    expect(await screen.findByText(/Jamie D/)).toHaveTextContent('jamie@example.com')
    expect(await screen.findByText(/Folder: Garage Log/)).toHaveTextContent('owner@example.com')
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Choose folder' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument()
  })

  test('Sign in calls signIn, shows the account and lists folders to pick from (no auto-pick)', async () => {
    google.matches = [
      { id: 'f1', name: 'Garage Log', ownerEmail: 'owner@example.com', shared: true },
    ]
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText(/jamie@example.com/)).toBeInTheDocument()
    expect(google.signIn).toHaveBeenCalledTimes(1)
    expect(
      await screen.findByRole('button', { name: /Garage Log.*owner@example.com/ }),
    ).toBeInTheDocument()
    expect(google.setFolder).not.toHaveBeenCalled()
    expect(google.ensureSyncStarted).not.toHaveBeenCalled()
  })

  test('shows why a sign-in failed', async () => {
    google.signIn.mockRejectedValue(new Error('popup_closed'))
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/popup_closed/)
    expect(screen.getByText('Not signed in')).toBeInTheDocument()
  })

  describe('choosing a folder', () => {
    beforeEach(() => {
      google.account = { name: 'Jamie D', email: 'jamie@example.com' }
    })

    test('lists matches with owner and shared badge; a single match still needs a tap', async () => {
      google.matches = [
        { id: 'f1', name: 'Garage Log', ownerEmail: 'owner@example.com', shared: true },
      ]
      const user = userEvent.setup()
      renderPage()
      await user.click(await screen.findByRole('button', { name: 'Choose folder' }))
      const pick = await screen.findByRole('button', { name: /owner@example.com/ })
      expect(pick).toHaveTextContent('shared')
      expect(google.setFolder).not.toHaveBeenCalled()
      expect(
        screen.queryByRole('button', { name: 'Create Garage Log folder' }),
      ).not.toBeInTheDocument()

      await user.click(pick)
      await waitFor(() => expect(google.setFolder).toHaveBeenCalledWith('f1', google.matches[0]))
      await waitFor(() => expect(google.ensureSyncStarted).toHaveBeenCalled())
      expect(google.createFolder).not.toHaveBeenCalled()
    })

    test('lists several matches and picks the tapped one', async () => {
      google.matches = [
        { id: 'f1', name: 'Garage Log', ownerEmail: 'a@example.com', shared: false },
        { id: 'f2', name: 'Garage Log', ownerEmail: 'b@example.com', shared: true },
      ]
      const user = userEvent.setup()
      renderPage()
      await user.click(await screen.findByRole('button', { name: 'Choose folder' }))
      await user.click(await screen.findByRole('button', { name: /b@example.com/ }))
      await waitFor(() => expect(google.setFolder).toHaveBeenCalledWith('f2', google.matches[1]))
      expect(google.createFolder).not.toHaveBeenCalled()
    })

    test('offers Create only when no folder was found, and creates and selects it on tap', async () => {
      google.matches = []
      const user = userEvent.setup()
      renderPage()
      await user.click(await screen.findByRole('button', { name: 'Choose folder' }))
      const create = await screen.findByRole('button', { name: 'Create Garage Log folder' })
      expect(google.createFolder).not.toHaveBeenCalled()
      await user.click(create)
      await waitFor(() => expect(google.createFolder).toHaveBeenCalledTimes(1))
      await waitFor(() =>
        expect(google.setFolder).toHaveBeenCalledWith(
          'new-1',
          expect.objectContaining({ id: 'new-1' }),
        ),
      )
      await waitFor(() => expect(google.ensureSyncStarted).toHaveBeenCalled())
    })

    test('if creating finds an existing folder after all, it shows the matches instead', async () => {
      google.matches = []
      google.createFolder.mockImplementation(async () => {
        google.matches = [{ id: 'f9', name: 'Garage Log', ownerEmail: 'o@example.com', shared: true }]
        throw new Error('A "Garage Log" folder already exists. Choose it instead.')
      })
      const user = userEvent.setup()
      renderPage()
      await user.click(await screen.findByRole('button', { name: 'Choose folder' }))
      await user.click(await screen.findByRole('button', { name: 'Create Garage Log folder' }))
      expect(await screen.findByRole('button', { name: /o@example.com/ })).toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Create Garage Log folder' }),
      ).not.toBeInTheDocument()
      expect(google.setFolder).not.toHaveBeenCalled()
    })

    test('changing the folder of a running sync triggers a sync instead of a second start', async () => {
      google.matches = [{ id: 'f1', name: 'Garage Log', ownerEmail: 'o@example.com', shared: true }]
      google.ensureSyncStarted.mockResolvedValue(false) // already running
      const user = userEvent.setup()
      renderPage()
      await user.click(await screen.findByRole('button', { name: 'Choose folder' }))
      await user.click(await screen.findByRole('button', { name: /o@example.com/ }))
      await waitFor(() => expect(google.syncNow).toHaveBeenCalledTimes(1))
    })

    test('shows an error when listing folders fails', async () => {
      google.findFolders.mockRejectedValue(new Error('Drive 500'))
      const user = userEvent.setup()
      renderPage()
      await user.click(await screen.findByRole('button', { name: 'Choose folder' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('Drive 500')
      expect(
        screen.queryByRole('button', { name: 'Create Garage Log folder' }),
      ).not.toBeInTheDocument()
    })
  })

  test('Sync now starts sync if needed and then syncs', async () => {
    google.account = { name: 'Jamie D', email: 'jamie@example.com' }
    google.folder = { id: 'f1', name: 'Garage Log', ownerEmail: 'o@example.com', shared: true }
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(google.syncNow).toHaveBeenCalledTimes(1))
    expect(google.ensureSyncStarted).toHaveBeenCalled()
  })

  test('Sign out calls signOut and goes back to Not signed in', async () => {
    google.account = { name: 'Jamie D', email: 'jamie@example.com' }
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Sign out' }))
    expect(await screen.findByText('Not signed in')).toBeInTheDocument()
    expect(google.signOut).toHaveBeenCalledTimes(1)
  })

  test('offers the Keep import only while the garage has no live vehicles', async () => {
    await putRaw({ vehicles: [vehicle('v3', 'Deleted', { deleted: true })] })
    const { unmount } = renderPage()
    expect(await screen.findByLabelText('Keep import file (seed.json)')).toHaveAttribute(
      'accept',
      '.json,application/json',
    )
    expect(screen.getByRole('heading', { name: 'Load Keep import' })).toBeInTheDocument()
    unmount()

    await putRaw({ vehicles: [vehicle('v1', 'Test Truck')] })
    renderPage()
    await screen.findByRole('link', { name: 'Test Truck' })
    expect(screen.queryByRole('heading', { name: 'Load Keep import' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Keep import file (seed.json)')).not.toBeInTheDocument()
  })

  test('loads the chosen seed file and says how many records it imported', async () => {
    await setUser('Jamie')
    const user = userEvent.setup()
    renderPage()
    const input = await screen.findByLabelText('Keep import file (seed.json)')
    const s = seedJson as unknown as Record<string, unknown[]>
    const total = ['vehicles', 'entries', 'issues', 'todos', 'serviceItems'].reduce(
      (n, k) => n + s[k].length,
      0,
    )
    expect(total).toBe(6)
    const file = new File([JSON.stringify(seedJson)], 'seed.json', { type: 'application/json' })
    await user.upload(input, file)
    expect(await screen.findByText(`Imported ${total} records`)).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: 'Test Truck' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Keep import file (seed.json)')).not.toBeInTheDocument()
    const stored = await db.entries.toArray()
    expect(stored.length).toBeGreaterThan(0)
    expect(stored.every((e) => e.createdBy === 'Jamie')).toBe(true)
  })

  test('shows why a bad file was refused and imports nothing', async () => {
    const user = userEvent.setup()
    renderPage()
    const input = await screen.findByLabelText('Keep import file (seed.json)')
    const bad = { ...seedJson, todos: 'nope' }
    await user.upload(input, new File([JSON.stringify(bad)], 'seed.json', { type: 'application/json' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('todos')
    expect(await db.vehicles.count()).toBe(0)

    await user.upload(input, new File(['{not json'], 'seed.json', { type: 'application/json' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/not valid JSON/i))
  })
})
