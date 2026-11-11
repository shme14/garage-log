import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { db } from '../db/db'
import { putRaw } from '../db/repo'
import type { Entry, Issue, ServiceItem, Todo, Vehicle } from '../model/types'
import { UndoProvider } from './UndoToast'
import VehiclePage from './VehiclePage'

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

const entry = (id: string, over: Partial<Entry> = {}): Entry => ({
  ...base,
  id,
  vehicleId: 'v1',
  date: { precision: 'day', value: '2026-10-01' },
  readings: {},
  text: `entry ${id}`,
  tags: [],
  serviceItemIds: [],
  createdBy: 'Jamie',
  ...over,
})

const issue = (id: string, status: Issue['status'], over: Partial<Issue> = {}): Issue => ({
  ...base,
  id,
  vehicleId: 'v1',
  title: `Issue ${id}`,
  status,
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

const item = (id: string, name: string, over: Partial<ServiceItem> = {}): ServiceItem => ({
  ...base,
  id,
  vehicleId: 'v1',
  name,
  ...over,
})

const NOW = new Date(2026, 10, 11)

function renderPage(url = '/vehicle/v1') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <UndoProvider>
        <Routes>
          <Route path="/vehicle/:id/:tab?" element={<VehiclePage today={NOW} />} />
          <Route path="/" element={<p>Garage home</p>} />
        </Routes>
      </UndoProvider>
    </MemoryRouter>,
  )
}

const articleTexts = () => screen.getAllByRole('article').map((a) => a.textContent ?? '')

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

describe('VehiclePage log', () => {
  test('log is sorted newest first with month entries in place', async () => {
    await putRaw({
      vehicles: [vehicle()],
      entries: [
        entry('may', { date: { precision: 'day', value: '2026-05-20' }, text: 'May day' }),
        entry('jun', { date: { precision: 'month', value: '2026-06' }, text: 'June month' }),
        // Same sort key as oct1 (a month sorts as the 1st): the later createdAt wins the tie.
        entry('octm', {
          date: { precision: 'month', value: '2026-10' },
          text: 'October month',
          createdAt: '2026-10-05T00:00:00Z',
        }),
        entry('oct1', { date: { precision: 'day', value: '2026-10-01' }, text: 'October first' }),
        entry('new', { date: { precision: 'day', value: '2026-10-20' }, text: 'Newest' }),
        entry('gone', { text: 'Deleted one', deleted: true }),
        entry('other', { vehicleId: 'v2', text: 'Other vehicle' }),
      ],
    })
    renderPage()
    await screen.findByText('Newest')
    const texts = articleTexts()
    expect(texts).toHaveLength(5)
    const order = ['Newest', 'October month', 'October first', 'June month', 'May day']
    order.forEach((t, i) => expect(texts[i]).toContain(t))
    expect(texts[0]).toContain('Oct 20, 2026')
    expect(texts[1]).toContain('Oct 2026')
    expect(texts[3]).toContain('Jun 2026')
    expect(screen.queryByText('Deleted one')).not.toBeInTheDocument()
    expect(screen.queryByText('Other vehicle')).not.toBeInTheDocument()
  })

  test('entry card shows readings, tags, text, cost, shop, author, issue link and actions', async () => {
    await putRaw({
      vehicles: [
        vehicle({
          meters: [
            { id: 'odo', name: 'Odometer', unit: 'km' },
            { id: 'hrs', name: 'Engine hours', unit: 'h' },
          ],
        }),
      ],
      issues: [issue('i1', 'open', { title: 'Motor mount creak' })],
      entries: [
        entry('e1', {
          readings: { odo: 159500, hrs: 2566 },
          tags: ['repair', 'mod'],
          text: 'Line one\nLine two',
          cost: 85,
          shop: 'Canadian Tire',
          issueId: 'i1',
        }),
      ],
    })
    renderPage()
    const card = await screen.findByRole('article')
    expect(within(card).getByText('Odometer')).toBeInTheDocument()
    expect(within(card).getByText('159,500 km')).toBeInTheDocument()
    expect(within(card).getByText('Engine hours')).toBeInTheDocument()
    expect(within(card).getByText('2,566 h')).toBeInTheDocument()
    expect(within(card).getByText('repair')).toBeInTheDocument()
    expect(within(card).getByText('mod')).toBeInTheDocument()
    // Line breaks live in the text node (CSS pre-wrap shows them); getByText would normalise them.
    expect(card.querySelector('.entry-text')?.textContent).toBe('Line one\nLine two')
    expect(within(card).getByText('$85.00')).toBeInTheDocument()
    expect(within(card).getByText('Canadian Tire')).toBeInTheDocument()
    expect(within(card).getByText(/by Jamie/)).toBeInTheDocument()
    await waitFor(() =>
      expect(within(card).getByRole('link', { name: 'Motor mount creak' })).toHaveAttribute(
        'href',
        '/issue/i1',
      ),
    )
    expect(within(card).getByRole('link', { name: 'Edit' })).toHaveAttribute('href', '/entry/e1/edit')
    expect(within(card).getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  test('single-meter readings omit the meter name', async () => {
    await putRaw({ vehicles: [vehicle()], entries: [entry('e1', { readings: { odo: 1200 } })] })
    renderPage()
    const card = await screen.findByRole('article')
    expect(within(card).getByText('1,200 km')).toBeInTheDocument()
    expect(within(card).queryByText('Odometer')).not.toBeInTheDocument()
  })

  test('Add entry links to quick entry for this vehicle', async () => {
    await putRaw({ vehicles: [vehicle()] })
    renderPage()
    const link = await screen.findByRole('link', { name: 'Add entry' })
    expect(link).toHaveAttribute('href', '/entry/new?vehicle=v1')
  })
})

describe('VehiclePage undo delete', () => {
  test('delete shows Undo and restores within 5s', async () => {
    await putRaw({ vehicles: [vehicle()], entries: [entry('e1', { text: 'Rotated tires' })] })
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Rotated tires')

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByText('Rotated tires')).not.toBeInTheDocument())
    expect(await screen.findByText(/Entry deleted/)).toBeInTheDocument()
    expect((await db.entries.get('e1'))?.deleted).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(await screen.findByText('Rotated tires')).toBeInTheDocument()
    expect((await db.entries.get('e1'))?.deleted).toBe(false)
    expect(screen.queryByText(/Entry deleted/)).not.toBeInTheDocument()
  })

  test('toast is armed for 5000 ms, then disappears and the delete stays', async () => {
    await putRaw({ vehicles: [vehicle()], entries: [entry('e1', { text: 'Rotated tires' })] })
    // Fake timers would stall Testing Library's own polling, so observe the real timer instead:
    // it must be requested for exactly 5000 ms, and firing its callback must dismiss the toast.
    const spy = vi.spyOn(globalThis, 'setTimeout')
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Rotated tires')
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText(/Entry deleted/)).toBeInTheDocument()

    const armed = spy.mock.calls.filter(([, ms]) => ms === 5000)
    expect(armed).toHaveLength(1)
    await act(async () => {
      ;(armed[0][0] as () => void)()
    })
    expect(screen.queryByText(/Entry deleted/)).not.toBeInTheDocument()
    expect((await db.entries.get('e1'))?.deleted).toBe(true)
  })

  test('a second delete replaces the toast; the first delete stays deleted', async () => {
    await putRaw({
      vehicles: [vehicle()],
      entries: [
        entry('e1', { text: 'First entry', date: { precision: 'day', value: '2026-10-02' } }),
        entry('e2', { text: 'Second entry' }),
      ],
    })
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('First entry')
    await user.click(screen.getAllByRole('button', { name: 'Delete' })[0])
    await waitFor(() => expect(screen.queryByText('First entry')).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByText('Second entry')).not.toBeInTheDocument())
    expect(screen.getAllByText(/Entry deleted/)).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(await screen.findByText('Second entry')).toBeInTheDocument()
    expect(screen.queryByText('First entry')).not.toBeInTheDocument()
    expect((await db.entries.get('e1'))?.deleted).toBe(true)
  })
})

describe('VehiclePage header', () => {
  test('lists open issues as links and parks the rest under a collapsed section', async () => {
    await putRaw({
      vehicles: [vehicle()],
      issues: [
        issue('i1', 'open', { title: 'Creak' }),
        issue('i2', 'parked', { title: 'Parked thing' }),
        issue('i3', 'resolved', { title: 'Fixed thing' }),
        issue('i4', 'open', { title: 'Gone', deleted: true }),
      ],
    })
    renderPage()
    expect(await screen.findByRole('link', { name: 'Creak' })).toHaveAttribute('href', '/issue/i1')
    const parked = screen.getByText('Parked (1)').closest('details')!
    expect(parked).not.toHaveAttribute('open')
    expect(within(parked).getByRole('link', { name: 'Parked thing', hidden: true })).toHaveAttribute(
      'href',
      '/issue/i2',
    )
    expect(screen.queryByText('Fixed thing')).not.toBeInTheDocument()
    expect(screen.queryByText('Gone')).not.toBeInTheDocument()
  })

  test('has an Edit vehicle link and tab links', async () => {
    await putRaw({ vehicles: [vehicle()] })
    renderPage('/vehicle/v1/info')
    expect(await screen.findByRole('link', { name: 'Edit vehicle' })).toHaveAttribute(
      'href',
      '/vehicles/v1/edit',
    )
    expect(screen.getByRole('link', { name: 'Log' })).toHaveAttribute('href', '/vehicle/v1/log')
    expect(screen.getByRole('link', { name: 'Info' })).toHaveAttribute('href', '/vehicle/v1/info')
    expect(screen.getByRole('link', { name: 'Service' })).toHaveAttribute(
      'href',
      '/vehicle/v1/service',
    )
    expect(screen.getByRole('link', { name: 'Info' })).toHaveAttribute('aria-current', 'page')
  })

  test.each(['/vehicle/nope', '/vehicle/gone/log'])(
    'unknown or deleted vehicle shows not found (%s)',
    async (url) => {
      await putRaw({ vehicles: [vehicle({ id: 'gone', deleted: true })] })
      renderPage(url)
      expect(await screen.findByText('Vehicle not found')).toBeInTheDocument()
      expect(screen.getByRole('link', { name: /garage|home/i })).toHaveAttribute('href', '/')
    },
  )

  test('service items show a text state pill and remaining amount or due date', async () => {
    await putRaw({
      vehicles: [vehicle()],
      serviceItems: [
        item('s-ok', 'Oil change', { intervalMeterId: 'odo', intervalAmount: 5000 }),
        item('s-soon', 'Tire rotation', { intervalMeterId: 'odo', intervalAmount: 5000 }),
        item('s-over', 'Brake fluid', { intervalMeterId: 'odo', intervalAmount: 5000 }),
        item('s-never', 'Air filter', { intervalMonths: 12 }),
        item('s-time', 'Inspection', { intervalMonths: 12 }),
      ],
      entries: [
        entry('now', { readings: { odo: 153200 }, text: 'Driving' }),
        entry('d-ok', { readings: { odo: 150000 }, serviceItemIds: ['s-ok'] }),
        entry('d-soon', { readings: { odo: 148700 }, serviceItemIds: ['s-soon'] }),
        entry('d-over', { readings: { odo: 140000 }, serviceItemIds: ['s-over'] }),
        entry('d-time', {
          date: { precision: 'day', value: '2026-07-01' },
          serviceItemIds: ['s-time'],
        }),
      ],
    })
    renderPage()
    const row = async (name: string) =>
      (await screen.findByText(name, { selector: '.service-name' })).closest('li') as HTMLElement
    await waitFor(async () =>
      expect(within(await row('Oil change')).getByText('OK')).toBeInTheDocument(),
    )
    expect(within(await row('Oil change')).getByText('1,800 km left')).toBeInTheDocument()
    expect(within(await row('Tire rotation')).getByText('Due soon')).toBeInTheDocument()
    expect(within(await row('Tire rotation')).getByText('500 km left')).toBeInTheDocument()
    expect(within(await row('Brake fluid')).getByText('Overdue')).toBeInTheDocument()
    expect(within(await row('Brake fluid')).getByText('8,200 km over')).toBeInTheDocument()
    expect(within(await row('Air filter')).getByText('Never done')).toBeInTheDocument()
    expect(within(await row('Inspection')).getByText('OK')).toBeInTheDocument()
    expect(within(await row('Inspection')).getByText('due Jul 1, 2027')).toBeInTheDocument()
  })
})

describe('VehiclePage todos', () => {
  test('todo toggles done and done todos hide behind Show done', async () => {
    await putRaw({
      vehicles: [vehicle()],
      todos: [
        todo('t1', { text: 'Check hubs' }),
        todo('t2', { text: 'Already done', done: true }),
        todo('t3', { text: 'Issue todo', issueId: 'i1' }),
      ],
    })
    const user = userEvent.setup()
    renderPage()
    const box = await screen.findByRole('checkbox', { name: 'Check hubs' })
    expect(box).not.toBeChecked()
    expect(screen.queryByText('Already done')).not.toBeInTheDocument()
    expect(screen.queryByText('Issue todo')).not.toBeInTheDocument()

    await user.click(box)
    await waitFor(async () => expect((await db.todos.get('t1'))?.done).toBe(true))
    await waitFor(() =>
      expect(screen.queryByRole('checkbox', { name: 'Check hubs' })).not.toBeInTheDocument(),
    )

    await user.click(screen.getByRole('button', { name: 'Show done (2)' }))
    const done = await screen.findByRole('checkbox', { name: 'Already done' })
    expect(done).toBeChecked()
    await user.click(done)
    await waitFor(async () => expect((await db.todos.get('t2'))?.done).toBe(false))
  })

  test('adds a todo for the vehicle and deletes with undo', async () => {
    await putRaw({ vehicles: [vehicle()] })
    const user = userEvent.setup()
    renderPage()
    await user.type(await screen.findByRole('textbox', { name: 'Add todo' }), '  Buy wipers ')
    await user.click(screen.getByRole('button', { name: 'Add todo' }))
    expect(await screen.findByRole('checkbox', { name: 'Buy wipers' })).toBeInTheDocument()
    const rows = await db.todos.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ vehicleId: 'v1', text: 'Buy wipers', done: false })
    expect(rows[0].issueId).toBeUndefined()
    expect(screen.getByRole('textbox', { name: 'Add todo' })).toHaveValue('')

    await user.click(screen.getByRole('button', { name: /Delete todo/ }))
    await waitFor(() =>
      expect(screen.queryByRole('checkbox', { name: 'Buy wipers' })).not.toBeInTheDocument(),
    )
    expect(await screen.findByText(/Todo deleted/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(await screen.findByRole('checkbox', { name: 'Buy wipers' })).toBeInTheDocument()
  })
})

describe('VehiclePage info tab', () => {
  test('renders info read-only with line breaks and clickable links', async () => {
    await putRaw({
      vehicles: [
        vehicle({
          info: 'Config 12345\nManual: https://example.com/manual.pdf.\nnot a link: ftp://x.y',
          infoUpdatedAt: '2026-01-15T12:00:00Z',
        }),
      ],
    })
    renderPage('/vehicle/v1/info')
    const link = await screen.findByRole('link', { name: 'https://example.com/manual.pdf' })
    expect(link).toHaveAttribute('href', 'https://example.com/manual.pdf')
    expect(link.parentElement?.textContent).toBe(
      'Config 12345\nManual: https://example.com/manual.pdf.\nnot a link: ftp://x.y',
    )
    expect(screen.getByText(/Edited Jan 15, 2026/)).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Vehicle info' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /ftp/ })).not.toBeInTheDocument()
  })

  test('Save writes info and infoUpdatedAt; nothing is saved before Save', async () => {
    await putRaw({ vehicles: [vehicle({ info: 'old', infoUpdatedAt: '2026-01-15T12:00:00Z' })] })
    const user = userEvent.setup()
    renderPage('/vehicle/v1/info')
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    const box = screen.getByRole('textbox', { name: 'Vehicle info' })
    await user.clear(box)
    await user.type(box, 'Tire pressure 35 psi')
    expect((await db.vehicles.get('v1'))?.info).toBe('old')

    const before = Date.now()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(async () =>
      expect((await db.vehicles.get('v1'))?.info).toBe('Tire pressure 35 psi'),
    )
    const saved = await db.vehicles.get('v1')
    expect(Date.parse(saved!.infoUpdatedAt)).toBeGreaterThanOrEqual(before - 1000)
    expect(await screen.findByText('Tire pressure 35 psi')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Vehicle info' })).not.toBeInTheDocument()
  })

  test('Cancel discards the draft', async () => {
    await putRaw({ vehicles: [vehicle({ info: 'keep me' })] })
    const user = userEvent.setup()
    renderPage('/vehicle/v1/info')
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    await user.type(screen.getByRole('textbox', { name: 'Vehicle info' }), ' extra')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('keep me')).toBeInTheDocument()
    expect((await db.vehicles.get('v1'))?.info).toBe('keep me')
  })
})

describe('VehiclePage service tab', () => {
  test('service item without any interval cannot be saved', async () => {
    await putRaw({ vehicles: [vehicle()] })
    const user = userEvent.setup()
    renderPage('/vehicle/v1/service')
    await user.click(await screen.findByRole('button', { name: 'Add service item' }))
    await user.type(screen.getByLabelText('Name'), 'Oil change')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Set a distance/hours interval or a number of months',
    )
    expect(await db.serviceItems.count()).toBe(0)
  })

  test('a meter without an amount is not enough', async () => {
    await putRaw({ vehicles: [vehicle()] })
    const user = userEvent.setup()
    renderPage('/vehicle/v1/service')
    await user.click(await screen.findByRole('button', { name: 'Add service item' }))
    await user.type(screen.getByLabelText('Name'), 'Oil change')
    await user.selectOptions(screen.getByLabelText('Meter'), 'odo')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(await db.serviceItems.count()).toBe(0)
  })

  test('adds, edits and deletes (with undo) a service item', async () => {
    await putRaw({ vehicles: [vehicle()] })
    const user = userEvent.setup()
    renderPage('/vehicle/v1/service')
    await user.click(await screen.findByRole('button', { name: 'Add service item' }))
    await user.type(screen.getByLabelText('Name'), 'Oil change')
    await user.selectOptions(screen.getByLabelText('Meter'), 'odo')
    await user.type(screen.getByLabelText('Every'), '8000')
    await user.type(screen.getByLabelText('Months'), '12')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(async () => expect(await db.serviceItems.count()).toBe(1))
    const saved = (await db.serviceItems.toArray())[0]
    expect(saved).toMatchObject({
      vehicleId: 'v1',
      name: 'Oil change',
      intervalMeterId: 'odo',
      intervalAmount: 8000,
      intervalMonths: 12,
    })
    expect((await screen.findAllByText('Never done')).length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: 'Edit Oil change' }))
    const name = screen.getByLabelText('Name')
    expect(name).toHaveValue('Oil change')
    await user.clear(name)
    await user.type(name, 'Engine oil')
    await user.clear(screen.getByLabelText('Months'))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(async () => expect((await db.serviceItems.get(saved.id))?.name).toBe('Engine oil'))
    const edited = await db.serviceItems.get(saved.id)
    expect(edited?.intervalMonths).toBeUndefined()
    expect(edited?.intervalAmount).toBe(8000)

    await user.click(await screen.findByRole('button', { name: 'Delete Engine oil' }))
    await waitFor(async () => expect((await db.serviceItems.get(saved.id))?.deleted).toBe(true))
    expect(await screen.findByText(/Service item deleted/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(async () => expect((await db.serviceItems.get(saved.id))?.deleted).toBe(false))
  })
})
