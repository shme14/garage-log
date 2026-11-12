import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { db } from '../db/db'
import { putRaw } from '../db/repo'
import type { Entry, Issue, ServiceItem, Vehicle } from '../model/types'
import EntryForm from './EntryForm'
import { getLastVehicleId } from './lastVehicle'
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
  infoUpdatedAt: '2026-01-01T00:00:00Z',
  meters: [
    { id: 'odo', name: 'Odometer', unit: 'km' },
    { id: 'hrs', name: 'Engine hours', unit: 'h' },
  ],
  archived: false,
  ...over,
})

const entry = (id: string, readings: Record<string, number>, over: Partial<Entry> = {}): Entry => ({
  ...base,
  id,
  vehicleId: 'v1',
  date: { precision: 'day', value: '2026-10-01' },
  readings,
  text: `entry ${id}`,
  tags: [],
  serviceItemIds: [],
  createdBy: 'test',
  ...over,
})

const issue = (id: string, status: Issue['status']): Issue => ({
  ...base,
  id,
  vehicleId: 'v1',
  title: `Issue ${id}`,
  status,
})

const oil: ServiceItem = { ...base, id: 'oil', vehicleId: 'v1', name: 'Oil change' }

const NOW = new Date(2026, 10, 11)

function renderForm(url = '/entry/new') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <UndoProvider>
        <Routes>
          <Route path="/entry/new" element={<EntryForm now={NOW} />} />
          <Route path="/entry/:id/edit" element={<EntryForm now={NOW} />} />
          <Route path="/vehicle/:id" element={<p>Vehicle page</p>} />
          <Route path="/settings" element={<p>Settings page</p>} />
        </Routes>
      </UndoProvider>
    </MemoryRouter>,
  )
}

const seedGarage = () =>
  putRaw({
    vehicles: [vehicle()],
    entries: [entry('e1', { odo: 159500, hrs: 2566 })],
  })

const save = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText('Vehicle page')
}

beforeEach(async () => {
  localStorage.clear()
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

describe('EntryForm', () => {
  test('prefills meter with current reading and saves only changed readings', async () => {
    await seedGarage()
    const user = userEvent.setup()
    renderForm()
    const odo = await screen.findByLabelText(/Odometer/)
    await waitFor(() => expect(odo).toHaveValue(159500))
    expect(screen.getByLabelText(/Engine hours/)).toHaveValue(2566)
    expect(screen.getByLabelText('Entry text')).toHaveFocus()

    await user.clear(odo)
    await user.type(odo, '160200')
    await user.type(screen.getByLabelText('Entry text'), 'Swapped fuel filter')
    await save(user)

    const saved = (await db.entries.toArray()).find((e) => e.text === 'Swapped fuel filter')
    expect(saved).toBeDefined()
    expect(saved?.readings).toEqual({ odo: 160200 })
    expect(saved?.vehicleId).toBe('v1')
    expect(saved?.date).toEqual({ precision: 'day', value: '2026-11-11' })
    expect(saved?.createdBy).toBe('Me')
    expect(saved).not.toHaveProperty('cost')
    expect(saved).not.toHaveProperty('shop')
    expect(saved).not.toHaveProperty('issueId')
    expect(getLastVehicleId()).toBe('v1')
  })

  test('warns on lower reading but still saves', async () => {
    await seedGarage()
    const user = userEvent.setup()
    renderForm()
    const odo = await screen.findByLabelText(/Odometer/)
    await waitFor(() => expect(odo).toHaveValue(159500))
    expect(screen.queryByText(/lower than last reading/i)).not.toBeInTheDocument()

    await user.clear(odo)
    await user.type(odo, '150000')
    expect(await screen.findByText('Lower than last reading (159,500 km) — typo?')).toBeVisible()

    await user.type(screen.getByLabelText('Entry text'), 'Odometer typo test')
    await save(user)
    const saved = (await db.entries.toArray()).find((e) => e.text === 'Odometer typo test')
    expect(saved?.readings).toEqual({ odo: 150000 })
  })

  test('save disabled for blank text', async () => {
    await seedGarage()
    const user = userEvent.setup()
    renderForm()
    const saveBtn = await screen.findByRole('button', { name: 'Save' })
    expect(saveBtn).toBeDisabled()
    await user.type(screen.getByLabelText('Entry text'), '   ')
    expect(saveBtn).toBeDisabled()
    await user.type(screen.getByLabelText('Entry text'), 'x')
    await waitFor(() => expect(saveBtn).toBeEnabled())
  })

  test('month-only toggle saves month precision', async () => {
    await seedGarage()
    const user = userEvent.setup()
    renderForm()
    const date = await screen.findByLabelText('Date')
    expect(date).toHaveAttribute('type', 'date')
    expect(date).toHaveValue('2026-11-11')
    await user.click(screen.getByLabelText('Month only'))
    expect(screen.getByLabelText('Date')).toHaveAttribute('type', 'month')
    expect(screen.getByLabelText('Date')).toHaveValue('2026-11')
    await user.type(screen.getByLabelText('Entry text'), 'Did this sometime in November')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())
    await save(user)
    const saved = (await db.entries.toArray()).find((e) => e.text.startsWith('Did this'))
    expect(saved?.date).toEqual({ precision: 'month', value: '2026-11' })
  })

  test('new issue from entry links both', async () => {
    await seedGarage()
    const user = userEvent.setup()
    renderForm()
    await screen.findByLabelText('Entry text')
    await user.click(screen.getByText('More'))
    await user.selectOptions(await screen.findByLabelText('Issue'), 'New issue…')
    await user.type(screen.getByLabelText('New issue title'), 'Motor mount creak')
    await user.type(screen.getByLabelText('Entry text'), 'Creak on hard left turns')
    await user.type(screen.getByLabelText('Cost (CAD)'), '45.5')
    await user.type(screen.getByLabelText('Shop'), 'Joe Garage')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())
    await save(user)

    const issues = await db.issues.toArray()
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ vehicleId: 'v1', title: 'Motor mount creak', status: 'open' })
    const saved = (await db.entries.toArray()).find((e) => e.text.startsWith('Creak'))
    expect(saved?.issueId).toBe(issues[0].id)
    expect(saved?.cost).toBe(45.5)
    expect(saved?.shop).toBe('Joe Garage')
  })

  test('ticking a service item saves every meter reading, even unchanged ones', async () => {
    await putRaw({
      vehicles: [vehicle()],
      entries: [entry('e1', { odo: 159500, hrs: 2566 })],
      serviceItems: [oil],
    })
    const user = userEvent.setup()
    renderForm()
    await user.click(await screen.findByText('More'))
    await user.click(await screen.findByLabelText('Oil change'))
    await waitFor(() => expect(screen.getByLabelText(/Odometer/)).toHaveValue(159500))
    await user.type(screen.getByLabelText('Entry text'), 'Oil change done')
    await save(user)
    const saved = (await db.entries.toArray()).find((e) => e.text === 'Oil change done')
    expect(saved?.serviceItemIds).toEqual(['oil'])
    expect(saved?.readings).toEqual({ odo: 159500, hrs: 2566 })
  })

  test('edit mode prefills from the entry, locks the vehicle and updates in place', async () => {
    await putRaw({
      vehicles: [vehicle(), vehicle({ id: 'v2', name: 'Relay' })],
      entries: [
        entry('e1', { odo: 159500, hrs: 2566 }),
        entry('e9', { odo: 150000 }, { text: 'old text', cost: 20, shop: 'Old Shop' }),
      ],
    })
    const user = userEvent.setup()
    renderForm('/entry/e9/edit')
    const text = await screen.findByLabelText('Entry text')
    expect(text).toHaveValue('old text')
    expect(screen.getByLabelText(/Odometer/)).toHaveValue(150000)
    expect(screen.getByLabelText(/Engine hours/)).toHaveValue(null)
    expect(screen.getByLabelText('Vehicle')).toBeDisabled()
    // untouched own reading is lower than a later entry's, but that is not a typo warning
    expect(screen.queryByText(/lower than last reading/i)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Cost (CAD)')).toHaveValue(20)

    await user.clear(text)
    await user.type(text, 'new text')
    await user.clear(screen.getByLabelText('Cost (CAD)'))
    await user.clear(screen.getByLabelText('Shop'))
    await save(user)

    const all = await db.entries.toArray()
    expect(all).toHaveLength(2)
    const saved = all.find((e) => e.id === 'e9')
    expect(saved).toMatchObject({
      text: 'new text',
      readings: { odo: 150000 },
      createdBy: 'test',
      createdAt: base.createdAt,
    })
    expect(saved).not.toHaveProperty('cost')
    expect(saved).not.toHaveProperty('shop')
    expect(saved?.updatedAt).not.toBe(base.updatedAt)
    expect(saved?.updatedBy).toBe('Me')
  })

  test('editing keeps readings for meters that are no longer on the vehicle', async () => {
    await putRaw({
      vehicles: [vehicle()],
      entries: [entry('e9', { odo: 150000, gone: 77 }, { text: 'old text' })],
    })
    const user = userEvent.setup()
    renderForm('/entry/e9/edit')
    const odo = await screen.findByLabelText(/Odometer/)
    await waitFor(() => expect(odo).toHaveValue(150000))
    await user.clear(odo)
    await user.type(odo, '151000')
    await user.type(screen.getByLabelText('Entry text'), ' more')
    await save(user)

    const saved = (await db.entries.toArray()).find((e) => e.id === 'e9')
    expect(saved?.readings).toEqual({ odo: 151000, gone: 77 })
  })

  test('the form does not use browser validation; cost accepts any decimal', async () => {
    await seedGarage()
    renderForm()
    await screen.findByLabelText('Entry text')
    expect(document.querySelector('form')).toHaveAttribute('novalidate')
    expect(screen.getByLabelText('Cost (CAD)')).toHaveAttribute('step', 'any')
  })

  test('meter keyboards: decimal for hours, numeric for km', async () => {
    await seedGarage()
    renderForm()
    expect(await screen.findByLabelText(/Odometer/)).toHaveAttribute('inputmode', 'numeric')
    expect(screen.getByLabelText(/Engine hours/)).toHaveAttribute('inputmode', 'decimal')
  })

  test('a malformed month blocks Save with a hint and a placeholder', async () => {
    // jsdom sanitizes month inputs, so the bad value comes from a stored entry; Firefox and
    // desktop Safari show the same state when the user types free text.
    await putRaw({
      vehicles: [vehicle()],
      entries: [entry('e9', {}, { date: { precision: 'month', value: 'Jun 2024' } })],
    })
    renderForm('/entry/e9/edit')
    const date = await screen.findByLabelText('Date')
    expect(date).toHaveAttribute('placeholder', 'YYYY-MM')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByText('Use YYYY-MM')).toBeVisible()
  })

  test('a malformed day blocks Save with a hint', async () => {
    await putRaw({
      vehicles: [vehicle()],
      entries: [entry('e9', {}, { date: { precision: 'day', value: '2026-02-30' } })],
    })
    renderForm('/entry/e9/edit')
    await screen.findByLabelText('Date')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByText('Use YYYY-MM-DD')).toBeVisible()
  })

  test('preselects and opens the issue from the query string', async () => {
    await putRaw({ vehicles: [vehicle()], issues: [issue('i1', 'open'), issue('i2', 'resolved')] })
    renderForm('/entry/new?issue=i1')
    const select = await screen.findByLabelText('Issue')
    await waitFor(() => expect(select).toHaveValue('i1'))
    expect(select).toBeVisible()
    expect(screen.queryByRole('option', { name: 'Issue i2' })).not.toBeInTheDocument()
  })

  test('vehicle query param wins over the last used vehicle', async () => {
    await putRaw({ vehicles: [vehicle(), vehicle({ id: 'v2', name: 'Relay', meters: [] })] })
    localStorage.setItem('garage.lastVehicle', 'v1')
    renderForm('/entry/new?vehicle=v2')
    const select = await screen.findByLabelText('Vehicle')
    expect(select).toHaveValue('v2')
    expect(screen.queryByLabelText(/Odometer/)).not.toBeInTheDocument()
  })

  test('cancel goes back without saving', async () => {
    await seedGarage()
    const user = userEvent.setup()
    renderForm()
    await user.type(await screen.findByLabelText('Entry text'), 'never saved')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await screen.findByText('Vehicle page')
    expect(await db.entries.count()).toBe(1)
  })

  test('shows a message and Settings link when there are no vehicles', async () => {
    renderForm()
    const link = await screen.findByRole('link', { name: /settings/i })
    expect(link).toHaveAttribute('href', '/settings')
    expect(screen.queryByLabelText('Entry text')).not.toBeInTheDocument()
  })

  test('new entry has no Delete entry button', async () => {
    await seedGarage()
    renderForm()
    await screen.findByLabelText('Entry text')
    expect(screen.queryByRole('button', { name: 'Delete entry' })).not.toBeInTheDocument()
  })

  test('Delete entry soft-deletes, leaves the form, shows Undo and restores within 5s', async () => {
    await putRaw({ vehicles: [vehicle()], entries: [entry('e9', { odo: 150000 }, { text: 'Rotated tires' })] })
    const user = userEvent.setup()
    renderForm('/entry/e9/edit')
    await screen.findByLabelText('Entry text')
    await user.click(screen.getByRole('button', { name: 'Delete entry' }))

    // Left the form the same way Cancel does, with no confirm dialog; the toast outlives the screen.
    await screen.findByText('Vehicle page')
    expect(await screen.findByText(/Entry deleted/)).toBeInTheDocument()
    expect((await db.entries.get('e9'))?.deleted).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(async () => expect((await db.entries.get('e9'))?.deleted).toBe(false))
    expect(screen.queryByText(/Entry deleted/)).not.toBeInTheDocument()
  })

  test('the Undo toast is armed for 5000 ms, then disappears and the delete stays', async () => {
    await putRaw({ vehicles: [vehicle()], entries: [entry('e9', { odo: 150000 })] })
    const spy = vi.spyOn(globalThis, 'setTimeout')
    const user = userEvent.setup()
    renderForm('/entry/e9/edit')
    await screen.findByLabelText('Entry text')
    await user.click(screen.getByRole('button', { name: 'Delete entry' }))
    expect(await screen.findByText(/Entry deleted/)).toBeInTheDocument()

    const armed = spy.mock.calls.filter(([, ms]) => ms === 5000)
    expect(armed).toHaveLength(1)
    await act(async () => {
      ;(armed[0][0] as () => void)()
    })
    expect(screen.queryByText(/Entry deleted/)).not.toBeInTheDocument()
    expect((await db.entries.get('e9'))?.deleted).toBe(true)
  })
})
