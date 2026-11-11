import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, test } from 'vitest'
import { db } from '../db/db'
import { putRaw } from '../db/repo'
import type { Entry, Issue, ServiceItem, Vehicle } from '../model/types'
import Garage from './Garage'

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
  meters: [{ id: 'odo', name: 'Odometer', unit: 'km' }],
  archived: false,
  ...over,
})

const entry = (id: string, vehicleId: string, readings: Record<string, number>, over: Partial<Entry> = {}): Entry => ({
  ...base,
  id,
  vehicleId,
  date: { precision: 'day', value: '2026-10-01' },
  readings,
  text: '',
  tags: [],
  serviceItemIds: [],
  createdBy: 'test',
  ...over,
})

const issue = (id: string, vehicleId: string, status: Issue['status']): Issue => ({
  ...base,
  id,
  vehicleId,
  title: `Issue ${id}`,
  status,
})

const renderGarage = (today = new Date(2026, 10, 11)) =>
  render(
    <MemoryRouter>
      <Garage today={today} />
    </MemoryRouter>,
  )

beforeEach(async () => {
  await Promise.all([
    db.vehicles.clear(),
    db.entries.clear(),
    db.issues.clear(),
    db.todos.clear(),
    db.serviceItems.clear(),
  ])
})

describe('Garage', () => {
  test('shows latest reading, open issue count and due count on the card', async () => {
    const oil: ServiceItem = {
      ...base,
      id: 'oil',
      vehicleId: 'v1',
      name: 'Oil change',
      intervalMeterId: 'odo',
      intervalAmount: 5000,
    }
    await putRaw({
      vehicles: [vehicle()],
      entries: [
        entry('e1', 'v1', { odo: 153300 }, { serviceItemIds: ['oil'] }),
        entry('e2', 'v1', { odo: 159500 }),
      ],
      issues: [issue('i1', 'v1', 'open'), issue('i2', 'v1', 'parked'), issue('i3', 'v1', 'resolved')],
      serviceItems: [oil],
    })
    renderGarage()
    expect(await screen.findByText('2021 F150')).toBeInTheDocument()
    expect(await screen.findByText('159,500 km')).toBeInTheDocument()
    expect(await screen.findByText('1 open')).toBeInTheDocument()
    expect(await screen.findByText('1 due')).toBeInTheDocument()
  })

  test('hides badges when counts are zero and does not count never-done items as due', async () => {
    await putRaw({
      vehicles: [vehicle({ meters: [{ id: 'h', name: 'Engine hours', unit: 'h' }] })],
      entries: [entry('e1', 'v1', { h: 2566 })],
      serviceItems: [{ ...base, id: 's', vehicleId: 'v1', name: 'Never done', intervalMonths: 12 }],
    })
    renderGarage()
    expect(await screen.findByText('2,566 h')).toBeInTheDocument()
    expect(screen.queryByText(/open$/)).not.toBeInTheDocument()
    expect(screen.queryByText(/due$/)).not.toBeInTheDocument()
  })

  test("does not mix in another vehicle's entries, issues or hidden records", async () => {
    // Both vehicles deliberately share the meter id 'odo' and the same interval, so a card handed
    // the wrong vehicle's entries would show the wrong reading and the wrong due state.
    const service = (id: string, vehicleId: string): ServiceItem => ({
      ...base,
      id,
      vehicleId,
      name: 'Oil change',
      intervalMeterId: 'odo',
      intervalAmount: 5000,
    })
    await putRaw({
      vehicles: [
        vehicle(),
        vehicle({ id: 'v2', name: 'Relay' }),
        vehicle({ id: 'v3', name: 'Old Beater', archived: true }),
        vehicle({ id: 'v4', name: 'Deleted Bike', deleted: true }),
      ],
      entries: [
        // v1: oil last done at 150,000, now 159,500 -> overdue
        entry('e1', 'v1', { odo: 150000 }, { serviceItemIds: ['s1'] }),
        entry('e2', 'v1', { odo: 159500 }),
        // v2: oil last done at 40, now 42 -> ok, but overdue if v1's entries leaked in
        entry('e3', 'v2', { odo: 40 }, { serviceItemIds: ['s2'] }),
        entry('e4', 'v2', { odo: 42 }),
        entry('e5', 'v1', { odo: 999999 }, { deleted: true }),
      ],
      issues: [issue('i1', 'v2', 'open'), issue('i2', 'v1', 'open'), { ...issue('i3', 'v1', 'open'), deleted: true }],
      serviceItems: [service('s1', 'v1'), service('s2', 'v2')],
    })
    renderGarage()
    const v1 = await screen.findByRole('link', { name: /2021 F150/ })
    const v2 = await screen.findByRole('link', { name: /Relay/ })
    await waitFor(() => expect(within(v1).getByText('159,500 km')).toBeInTheDocument())
    await waitFor(() => expect(within(v2).getByText('42 km')).toBeInTheDocument())
    expect(within(v1).getByText('1 open')).toBeInTheDocument()
    expect(within(v2).getByText('1 open')).toBeInTheDocument()
    expect(within(v1).getByText('1 due')).toBeInTheDocument()
    expect(within(v2).queryByText(/due$/)).not.toBeInTheDocument()
    expect(screen.queryByText('Old Beater')).not.toBeInTheDocument()
    expect(screen.queryByText('Deleted Bike')).not.toBeInTheDocument()
    expect(screen.queryByText(/999,999/)).not.toBeInTheDocument()
  })

  test('card links to the vehicle and the + button links to new entry', async () => {
    await putRaw({ vehicles: [vehicle()] })
    renderGarage()
    const card = await screen.findByRole('link', { name: /2021 F150/ })
    expect(card).toHaveAttribute('href', '/vehicle/v1')
    expect(screen.getByRole('link', { name: 'Add entry' })).toHaveAttribute('href', '/entry/new')
  })

  test('empty state links to Settings', async () => {
    renderGarage()
    const link = await screen.findByRole('link', { name: /settings/i })
    expect(link).toHaveAttribute('href', '/settings')
    await waitFor(() => expect(screen.getByText(/no vehicles/i)).toBeInTheDocument())
  })
})
