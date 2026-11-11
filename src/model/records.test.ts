import { expect, test } from 'vitest'
import { newRecord, touch } from './records'
import type { Todo } from './types'

test('newRecord stamps base fields; touch updates only edit fields', () => {
  const ctx = { user: 'Jamie', deviceId: 'dev-a', now: new Date('2026-11-11T10:00:00Z') }
  const r = newRecord<Todo>({ vehicleId: 'v1', text: 'x', done: false }, ctx)
  expect(r).toMatchObject({
    createdAt: '2026-11-11T10:00:00.000Z',
    updatedAt: '2026-11-11T10:00:00.000Z',
    updatedBy: 'Jamie',
    updatedByDevice: 'dev-a',
    deleted: false,
  })
  expect(r.id).toMatch(/^[0-9a-f-]{36}$/)
  const t = touch(r, { user: 'Partner', deviceId: 'dev-b', now: new Date('2026-11-12T00:00:00Z') })
  expect(t).toMatchObject({
    id: r.id,
    createdAt: r.createdAt,
    updatedAt: '2026-11-12T00:00:00.000Z',
    updatedBy: 'Partner',
    updatedByDevice: 'dev-b',
  })
})
