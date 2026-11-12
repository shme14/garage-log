import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { db } from '../db/db'
import { putRaw } from '../db/repo'
import type { Entry, Issue, Todo, Vehicle } from '../model/types'
import IssuePage from './IssuePage'
import { UndoProvider } from './UndoToast'

const base = {
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: 'test',
  updatedByDevice: 'dev',
  deleted: false,
}

const vehicle = (over: Partial<Vehicle> = {}): Vehicle => ({
  ...base,
  id: 'v1',
  name: '2021 F150',
  kind: 'truck',
  info: '',
  infoUpdatedAt: '',
  meters: [{ id: 'odo', name: 'Odometer', unit: 'km' }],
  archived: false,
  ...over,
})

const issue = (over: Partial<Issue> = {}): Issue => ({
  ...base,
  id: 'i1',
  vehicleId: 'v1',
  title: 'Motor mount creak',
  status: 'open',
  ...over,
})

const entry = (id: string, over: Partial<Entry> = {}): Entry => ({
  ...base,
  id,
  vehicleId: 'v1',
  issueId: 'i1',
  date: { precision: 'day', value: '2026-10-01' },
  readings: {},
  text: `entry ${id}`,
  tags: [],
  serviceItemIds: [],
  createdBy: 'Jamie',
  ...over,
})

const todo = (id: string, over: Partial<Todo> = {}): Todo => ({
  ...base,
  id,
  vehicleId: 'v1',
  text: `Todo ${id}`,
  done: false,
  ...over,
})

function renderPage(url = '/issue/i1') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <UndoProvider>
        <Routes>
          <Route path="/issue/:id" element={<IssuePage />} />
          <Route path="/" element={<p>Garage home</p>} />
        </Routes>
      </UndoProvider>
    </MemoryRouter>,
  )
}

beforeEach(async () => {
  await Promise.all([
    db.vehicles.clear(),
    db.entries.clear(),
    db.issues.clear(),
    db.todos.clear(),
    db.serviceItems.clear(),
  ])
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('IssuePage', () => {
  test('entries listed oldest first', async () => {
    await putRaw({
      vehicles: [vehicle()],
      issues: [issue()],
      entries: [
        entry('new', { date: { precision: 'day', value: '2026-10-20' }, text: 'Newest' }),
        entry('old', { date: { precision: 'day', value: '2026-03-02' }, text: 'Oldest' }),
        entry('mid', { date: { precision: 'month', value: '2026-06' }, text: 'Middle' }),
        entry('gone', { text: 'Deleted one', deleted: true }),
        entry('elsewhere', { issueId: 'i2', text: 'Other issue' }),
        entry('unlinked', { issueId: undefined, text: 'No issue' }),
      ],
    })
    renderPage()
    await screen.findByText('Newest')
    // Each log row is a single link to the entry's edit screen.
    const rows = screen
      .getAllByRole('link')
      .filter((a) => /^\/entry\/[^/]+\/edit$/.test(a.getAttribute('href') ?? ''))
    const texts = rows.map((a) => a.textContent ?? '')
    expect(texts).toHaveLength(3)
    const order = ['Oldest', 'Middle', 'Newest']
    order.forEach((t, i) => expect(texts[i]).toContain(t))
    expect(screen.queryByText('Deleted one')).not.toBeInTheDocument()
    expect(screen.queryByText('Other issue')).not.toBeInTheDocument()
    expect(screen.getByText('3 updates')).toBeInTheDocument()
  })

  test('shows back link to the vehicle, the issue todos only, and singular count', async () => {
    await putRaw({
      vehicles: [vehicle()],
      issues: [issue()],
      entries: [entry('a')],
      todos: [
        todo('t1', { issueId: 'i1', text: 'Lock out hubs' }),
        todo('t2', { text: 'Vehicle level todo' }),
      ],
    })
    renderPage()
    expect(await screen.findByText('Lock out hubs')).toBeInTheDocument()
    expect(screen.queryByText('Vehicle level todo')).not.toBeInTheDocument()
    expect(screen.getByText('1 update')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /2021 F150/ })).toHaveAttribute('href', '/vehicle/v1')
  })

  test('status change persists', async () => {
    await putRaw({ vehicles: [vehicle()], issues: [issue()] })
    const user = userEvent.setup()
    renderPage()
    const open = await screen.findByRole('button', { name: 'Open' })
    expect(open).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Parked' })).toHaveAttribute('aria-pressed', 'false')

    await user.click(screen.getByRole('button', { name: 'Resolved' }))
    await waitFor(async () => expect((await db.issues.get('i1'))?.status).toBe('resolved'))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Resolved' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
    expect(screen.getByRole('button', { name: 'Open' })).toHaveAttribute('aria-pressed', 'false')
  })

  test('Add update link carries vehicle and issue', async () => {
    await putRaw({ vehicles: [vehicle()], issues: [issue()] })
    renderPage()
    const link = await screen.findByRole('link', { name: 'Add update' })
    expect(link).toHaveAttribute('href', '/entry/new?vehicle=v1&issue=i1')
  })

  test('title can be edited, trimmed, and cancelled', async () => {
    await putRaw({ vehicles: [vehicle()], issues: [issue()] })
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Edit title' }))
    const input = screen.getByRole('textbox', { name: 'Issue title' })
    expect(input).toHaveValue('Motor mount creak')

    // Cancel discards the draft.
    await user.clear(input)
    await user.type(input, 'Discarded')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('heading', { name: 'Motor mount creak' })).toBeInTheDocument()
    expect((await db.issues.get('i1'))?.title).toBe('Motor mount creak')

    // Empty (whitespace-only) cannot be saved.
    await user.click(screen.getByRole('button', { name: 'Edit title' }))
    const again = screen.getByRole('textbox', { name: 'Issue title' })
    await user.clear(again)
    await user.type(again, '   ')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    await user.clear(again)
    await user.type(again, '  Front mount clunk  ')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('heading', { name: 'Front mount clunk' })).toBeInTheDocument()
    expect((await db.issues.get('i1'))?.title).toBe('Front mount clunk')
  })

  test('save keeps fields merged in by a sync since the page loaded', async () => {
    await putRaw({ vehicles: [vehicle()], issues: [issue()] })
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Edit title' }))
    // A sync merge changes the stored status while the editor is open.
    await db.issues.put({ ...issue(), status: 'parked' })
    const input = screen.getByRole('textbox', { name: 'Issue title' })
    await user.clear(input)
    await user.type(input, 'Renamed')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(async () => expect((await db.issues.get('i1'))?.title).toBe('Renamed'))
    expect((await db.issues.get('i1'))?.status).toBe('parked')
  })

  test('a rejected save shows an alert instead of an unhandled rejection', async () => {
    await putRaw({ vehicles: [vehicle()], issues: [issue()] })
    vi.spyOn(db, 'table').mockReturnValue({ put: () => Promise.reject(new Error('disk full')) } as never)
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Parked' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not save/i)
  })

  test('unknown or deleted issue shows not found with a home link', async () => {
    await putRaw({ vehicles: [vehicle()], issues: [issue({ id: 'i9', deleted: true })] })
    const { unmount } = renderPage('/issue/nope')
    expect(await screen.findByText('Issue not found')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /garage/i })).toHaveAttribute('href', '/')
    unmount()
    renderPage('/issue/i9')
    expect(await screen.findByText('Issue not found')).toBeInTheDocument()
  })
})
