import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, test } from 'vitest'
import { db } from '../db/db'
import { putRaw } from '../db/repo'
import type { Vehicle } from '../model/types'
import VehicleEditor from './VehicleEditor'

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
  name: 'Relay',
  kind: 'ebike',
  info: 'keep my info',
  infoUpdatedAt: '2026-01-15T12:00:00Z',
  meters: [{ id: 'bike', name: 'Bike', unit: 'km' }],
  archived: false,
  ...over,
})

function renderEditor(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/vehicles/new" element={<VehicleEditor />} />
        <Route path="/vehicles/:id/edit" element={<VehicleEditor />} />
        <Route path="/vehicle/:id" element={<p>Vehicle page</p>} />
        <Route path="/" element={<p>Garage home</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(async () => {
  await Promise.all([db.vehicles.clear(), db.entries.clear()])
})

describe('VehicleEditor', () => {
  test('creates a vehicle with meters and goes to its page', async () => {
    const user = userEvent.setup()
    renderEditor('/vehicles/new')
    const save = await screen.findByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    expect(screen.queryByLabelText('Archived')).not.toBeInTheDocument()

    await user.type(screen.getByLabelText('Name'), 'Sparky')
    await user.selectOptions(screen.getByLabelText('Kind'), 'bike')
    await user.click(screen.getByRole('button', { name: 'Add meter' }))
    await user.type(screen.getByLabelText('Meter 1 name'), 'Odometer')
    await user.click(screen.getByRole('button', { name: 'Add meter' }))
    await user.type(screen.getByLabelText('Meter 2 name'), 'Motor')
    await user.selectOptions(screen.getByLabelText('Meter 2 unit'), 'h')
    // A blank extra row is ignored rather than saved.
    await user.click(screen.getByRole('button', { name: 'Add meter' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByText('Vehicle page')
    const all = await db.vehicles.toArray()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({
      name: 'Sparky',
      kind: 'bike',
      info: '',
      infoUpdatedAt: '',
      archived: false,
    })
    expect(all[0].meters).toHaveLength(2)
    expect(all[0].meters[0]).toMatchObject({ name: 'Odometer', unit: 'km' })
    expect(all[0].meters[1]).toMatchObject({ name: 'Motor', unit: 'h' })
    expect(all[0].meters[0].id).not.toBe(all[0].meters[1].id)
    expect(all[0].meters[0].id).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('edits: renames a meter, adds one, archives; cannot remove or change unit of saved meters', async () => {
    await putRaw({ vehicles: [vehicle()] })
    const user = userEvent.setup()
    renderEditor('/vehicles/v1/edit')
    const name = await screen.findByLabelText('Name')
    expect(name).toHaveValue('Relay')
    expect(screen.getByLabelText('Kind')).toHaveValue('ebike')
    expect(screen.queryByRole('button', { name: /remove|delete/i })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Meter 1 unit')).not.toBeInTheDocument()

    const meter = screen.getByLabelText('Meter 1 name')
    await user.clear(meter)
    await user.type(meter, 'Bike km')
    await user.click(screen.getByRole('button', { name: 'Add meter' }))
    await user.type(screen.getByLabelText('Meter 2 name'), 'Motor km')
    await user.click(screen.getByLabelText('Archived'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByText('Vehicle page')
    const saved = await db.vehicles.get('v1')
    expect(saved?.meters).toHaveLength(2)
    expect(saved?.meters[0]).toEqual({ id: 'bike', name: 'Bike km', unit: 'km' })
    expect(saved?.meters[1]).toMatchObject({ name: 'Motor km', unit: 'km' })
    expect(saved?.archived).toBe(true)
    expect(saved?.info).toBe('keep my info')
    expect(await db.vehicles.count()).toBe(1)
  })

  test('requires a name and does not allow blanking a saved meter name', async () => {
    await putRaw({ vehicles: [vehicle()] })
    const user = userEvent.setup()
    renderEditor('/vehicles/v1/edit')
    await user.clear(await screen.findByLabelText('Meter 1 name'))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.type(screen.getByLabelText('Meter 1 name'), 'Bike')
    await user.clear(screen.getByLabelText('Name'))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await waitFor(async () => expect((await db.vehicles.get('v1'))?.name).toBe('Relay'))
  })

  test('unknown or deleted vehicle shows not found', async () => {
    await putRaw({ vehicles: [vehicle({ id: 'gone', deleted: true })] })
    renderEditor('/vehicles/gone/edit')
    expect(await screen.findByText('Vehicle not found')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /garage|home/i })).toHaveAttribute('href', '/')
  })
})
