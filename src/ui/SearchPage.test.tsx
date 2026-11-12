import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, test } from 'vitest'
import { db } from '../db/db'
import { putRaw } from '../db/repo'
import type { Entry, Issue, Todo, Vehicle } from '../model/types'
import SearchPage from './SearchPage'

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
  kind: 'ebike',
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

const issue = (id: string, over: Partial<Issue> = {}): Issue => ({
  ...base,
  id,
  vehicleId: 'v1',
  title: `issue ${id}`,
  status: 'open',
  ...over,
})

const todo = (id: string, over: Partial<Todo> = {}): Todo => ({
  ...base,
  id,
  vehicleId: 'v1',
  text: `todo ${id}`,
  done: false,
  ...over,
})

function Where() {
  const loc = useLocation()
  return <output data-testid="where">{`${loc.pathname}${loc.search}`}</output>
}

function renderPage(url = '/search') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/search" element={<SearchPage />} />
        <Route path="*" element={<p>Elsewhere</p>} />
      </Routes>
      <Where />
    </MemoryRouter>,
  )
}

const box = () => screen.getByRole('searchbox')

beforeEach(async () => {
  await Promise.all([
    db.vehicles.clear(),
    db.entries.clear(),
    db.issues.clear(),
    db.todos.clear(),
    db.serviceItems.clear(),
  ])
  await putRaw({
    vehicles: [
      vehicle('v1', 'Relay', { info: 'Motor: Bosch CX, torque spec 14 Nm' }),
      vehicle('v2', 'Sparky'),
    ],
    entries: [
      entry('e1', { text: 'Motor bushings torqued to 14Nm', tags: ['maintenance'] }),
      entry('e2', {
        vehicleId: 'v2',
        date: { precision: 'month', value: '2026-06' },
        text: 'Replaced front brake pads',
        tags: ['repair'],
      }),
      entry('e4', { text: 'Used (Loctite 243 for $85 shop bolts' }),
      entry('e3', { vehicleId: 'v2', text: 'Fork rebound set to 8 clicks', tags: ['setup'] }),
    ],
    issues: [issue('i1', { title: 'Motor mount creak' })],
    todos: [
      todo('t1', { text: 'Grease creak', issueId: 'i1' }),
      todo('t2', { text: 'Check creak on bridge', vehicleId: 'v2' }),
    ],
  })
})

describe('SearchPage', () => {
  test('autofocuses the box and shows only a hint until there is a query or filter', async () => {
    renderPage()
    expect(box()).toHaveFocus()
    expect(screen.getByText(/type to search/i)).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  test('shows matches with the match marked, vehicle name and links for each kind', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.type(box(), 'Motor')
    const items = await screen.findAllByRole('listitem')
    expect(items).toHaveLength(3) // entry, issue, info

    const entryLink = screen.getByRole('link', { name: /bushings/ })
    expect(entryLink).toHaveAttribute('href', '/vehicle/v1/log')
    expect(within(entryLink).getByText('Relay')).toBeInTheDocument()
    expect(within(entryLink).getByText('May 21, 2026')).toBeInTheDocument()
    expect(within(entryLink).getByText('Motor', { selector: 'mark' })).toBeInTheDocument()

    expect(screen.getByRole('link', { name: /mount creak/ })).toHaveAttribute('href', '/issue/i1')
    expect(screen.getByRole('link', { name: /Bosch CX/ })).toHaveAttribute('href', '/vehicle/v1/info')
  })

  test('todo results link to their issue, or to the vehicle without one', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.type(box(), 'creak')
    expect(await screen.findByRole('link', { name: /Grease/ })).toHaveAttribute('href', '/issue/i1')
    expect(screen.getByRole('link', { name: /bridge/ })).toHaveAttribute('href', '/vehicle/v2')
  })

  test('is case-insensitive and says when nothing matches', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.type(box(), '14NM')
    expect(await screen.findByRole('link', { name: /bushings/ })).toBeInTheDocument()
    await user.clear(box())
    await user.type(box(), 'zzzz')
    expect(await screen.findByText(/no matches/i)).toBeInTheDocument()
  })

  test('vehicle select and tag chips filter; an empty query then lists matching entries', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('option', { name: 'Sparky' })
    await user.selectOptions(screen.getByLabelText('Vehicle'), 'v2')
    expect(await screen.findAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('link', { name: /brake pads/ })).toBeInTheDocument()

    const repair = screen.getByRole('button', { name: 'repair' })
    await user.click(repair)
    expect(repair).toHaveAttribute('aria-pressed', 'true')
    expect(await screen.findAllByRole('listitem')).toHaveLength(1)

    // one tag at a time, and pressing it again clears it
    await user.click(screen.getByRole('button', { name: 'setup' }))
    expect(repair).toHaveAttribute('aria-pressed', 'false')
    expect(await screen.findByRole('link', { name: /rebound/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'setup' }))
    await user.selectOptions(screen.getByLabelText('Vehicle'), '')
    expect(screen.getByText(/type to search/i)).toBeInTheDocument()
  })

  test('keeps the query and filters in the URL, and restores them from it', async () => {
    const user = userEvent.setup()
    const first = renderPage()
    await user.type(box(), 'pads')
    await screen.findByRole('option', { name: 'Sparky' })
    await user.selectOptions(screen.getByLabelText('Vehicle'), 'v2')
    await user.click(screen.getByRole('button', { name: 'repair' }))
    const url = screen.getByTestId('where').textContent
    expect(url).toBe('/search?q=pads&v=v2&t=repair')
    first.unmount()

    renderPage(url!)
    await screen.findByRole('option', { name: 'Sparky' })
    expect(box()).toHaveValue('pads')
    expect(screen.getByLabelText('Vehicle')).toHaveValue('v2')
    expect(screen.getByRole('button', { name: 'repair' })).toHaveAttribute('aria-pressed', 'true')
    expect(await screen.findByRole('link', { name: /brake pads/ })).toBeInTheDocument()
  })

  test('regex-special queries match literally and the original-case text is marked', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.type(box(), '(loctite')
    const link = await screen.findByRole('link', { name: /Loctite 243/ })
    expect(within(link).getByText('(Loctite', { selector: 'mark' })).toBeInTheDocument()
    await user.clear(box())
    await user.type(box(), '$85')
    const link2 = await screen.findByRole('link', { name: /shop bolts/ })
    expect(within(link2).getByText('$85', { selector: 'mark' })).toBeInTheDocument()
  })

  test('typing keeps every character and writes the query to the URL', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.type(box(), '14nm')
    expect(box()).toHaveValue('14nm')
    expect(screen.getByTestId('where')).toHaveTextContent('/search?q=14nm')
    expect(await screen.findByRole('link', { name: /bushings/ })).toBeInTheDocument()
  })
})
