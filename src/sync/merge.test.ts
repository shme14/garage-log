import { describe, expect, test } from 'vitest'
import { emptySet } from '../model/types'
import type { Issue, RecordSet, Todo } from '../model/types'
import { newer, ownRecords, winnersOver } from './merge'

function issue(
  id: string,
  updatedAt: string,
  device = 'dev-a',
  extra: Partial<Issue> = {},
): Issue {
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    updatedBy: 'someone',
    updatedByDevice: device,
    deleted: false,
    vehicleId: 'v1',
    title: `issue ${id}`,
    status: 'open',
    ...extra,
  }
}

const at = (hhmm: string) => `2026-03-01T${hhmm}:00.000Z`

function setOf(issues: Issue[]): RecordSet {
  return { ...emptySet(), issues }
}

describe('newer', () => {
  test('newer updatedAt wins', () => {
    const a = issue('x', at('10:00'))
    const b = issue('x', at('11:00'))
    expect(newer(a, b)).toBe(b)
    expect(newer(b, a)).toBe(b)
  })

  test('tie broken by greater updatedByDevice', () => {
    const a = issue('x', at('10:00'), 'dev-a')
    const b = issue('x', at('10:00'), 'dev-b')
    expect(newer(a, b)).toBe(b)
    expect(newer(b, a)).toBe(b)
  })
})

describe('winnersOver', () => {
  test('returns only new or newer remote records', () => {
    const lx = issue('x', at('10:00'))
    const ly = issue('y', at('12:00'))
    const rx = issue('x', at('11:00'), 'dev-b')
    const ry = issue('y', at('11:00'), 'dev-b')
    const rz = issue('z', at('09:00'), 'dev-b')
    const out = winnersOver(setOf([lx, ly]), setOf([rx, ry, rz]))
    expect(out.issues).toEqual([rx, rz])
    expect(out.vehicles).toEqual([])
    expect(out.entries).toEqual([])
    expect(out.todos).toEqual([])
    expect(out.serviceItems).toEqual([])
  })

  test('identical version (same time and device) is not a winner', () => {
    const l = issue('x', at('10:00'), 'dev-a')
    const r = issue('x', at('10:00'), 'dev-a')
    expect(winnersOver(setOf([l]), setOf([r])).issues).toEqual([])
  })

  test('tie on time goes to the greater device id', () => {
    const l = issue('x', at('10:00'), 'dev-a')
    const r = issue('x', at('10:00'), 'dev-b')
    expect(winnersOver(setOf([l]), setOf([r])).issues).toEqual([r])
    expect(winnersOver(setOf([r]), setOf([l])).issues).toEqual([])
  })

  test('remote tombstone newer than local edit deletes it', () => {
    const local = issue('x', at('10:00'), 'dev-a', { title: 'edited' })
    const tomb = issue('x', at('11:00'), 'dev-b', { deleted: true })
    expect(winnersOver(setOf([local]), setOf([tomb])).issues).toEqual([tomb])
  })

  test('local edit newer than remote tombstone is kept', () => {
    const local = issue('x', at('12:00'), 'dev-a', { title: 'edited' })
    const tomb = issue('x', at('11:00'), 'dev-b', { deleted: true })
    expect(winnersOver(setOf([local]), setOf([tomb])).issues).toEqual([])
  })

  test('works on tables other than issues', () => {
    const todo: Todo = {
      id: 't1',
      createdAt: at('09:00'),
      updatedAt: at('10:00'),
      updatedBy: 'someone',
      updatedByDevice: 'dev-b',
      deleted: false,
      vehicleId: 'v1',
      text: 'check hubs',
      done: false,
    }
    const out = winnersOver(emptySet(), { ...emptySet(), todos: [todo] })
    expect(out.todos).toEqual([todo])
    expect(out.issues).toEqual([])
  })
})

describe('ownRecords', () => {
  test('includes records I last edited regardless of creator', () => {
    // created by dev-b, then touched by dev-a
    const touched = issue('x', at('11:00'), 'dev-a', { createdAt: at('09:00') })
    const other = issue('y', at('11:00'), 'dev-b')
    const set = setOf([touched, other])
    expect(ownRecords(set, 'dev-a').issues).toEqual([touched])
    expect(ownRecords(set, 'dev-b').issues).toEqual([other])
    expect(ownRecords(set, 'dev-c').issues).toEqual([])
  })
})
