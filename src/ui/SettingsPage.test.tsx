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

vi.mock('../sync/engine', () => ({
  subscribeStatus: (fn: Subscriber) => {
    sync.report(fn)
    return () => {}
  },
}))

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
        vehicle('v1', 'Relay'),
        vehicle('v2', 'Old Truck', { archived: true }),
        vehicle('v3', 'Deleted', { deleted: true }),
      ],
    })
    renderPage()
    expect(await screen.findByRole('link', { name: 'Relay' })).toHaveAttribute(
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
      vehicles: [vehicle('v1', 'Relay')],
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
    expect(text).toContain('# Relay')
    expect(text).toContain('Torqued bushings')
    expect(text).not.toContain('gone')

    await waitFor(() => expect(revoke).toHaveBeenCalledTimes(2), { timeout: 3000 })
    expect(revoke).toHaveBeenCalledWith('blob:fake-1')
  })

  test('has no sign-in or Sync now controls yet', () => {
    renderPage()
    expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /sync now/i })).not.toBeInTheDocument()
  })
})
