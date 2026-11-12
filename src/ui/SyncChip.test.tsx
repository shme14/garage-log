import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { SyncStatus } from '../sync/engine'

const m = vi.hoisted(() => ({
  push: (_s: unknown): void => {},
  signIn: vi.fn(),
  syncNow: vi.fn(),
  ensureSyncStarted: vi.fn(),
  order: [] as string[],
}))

vi.mock('../sync/engine', () => ({
  subscribeStatus: (fn: (s: SyncStatus) => void) => {
    m.push = fn as (s: unknown) => void
    fn('pending')
    return () => {}
  },
  syncNow: () => {
    m.order.push('syncNow')
    return m.syncNow()
  },
}))
vi.mock('../sync/auth', () => ({
  signIn: () => {
    m.order.push('signIn')
    return m.signIn()
  },
}))
vi.mock('../sync/boot', () => ({
  ensureSyncStarted: () => {
    m.order.push('ensureSyncStarted')
    return m.ensureSyncStarted()
  },
}))

import SyncChip from './SyncChip'

beforeEach(() => {
  m.order = []
  m.signIn.mockReset().mockResolvedValue({ name: 'J', email: 'j@x.com' })
  m.syncNow.mockReset().mockResolvedValue(undefined)
  m.ensureSyncStarted.mockReset().mockResolvedValue(false)
})

describe('SyncChip', () => {
  test('is plain status text unless sign-in is needed', () => {
    render(<SyncChip />)
    for (const s of ['pending', 'syncing', 'synced', 'offline', 'error'] as SyncStatus[]) {
      act(() => m.push(s))
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
    }
  })

  test('in sign-in status it is a button that signs in, then syncs', async () => {
    const user = userEvent.setup()
    render(<SyncChip />)
    act(() => m.push('sign-in'))
    expect(screen.getByRole('status')).toHaveTextContent(/^Sign in$/)
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(m.syncNow).toHaveBeenCalledTimes(1))
    expect(m.signIn).toHaveBeenCalledTimes(1)
    expect(m.order).toEqual(['signIn', 'ensureSyncStarted', 'syncNow'])
  })

  test('a cancelled sign-in does not sync and does not throw', async () => {
    m.signIn.mockRejectedValue(new Error('popup_closed'))
    const user = userEvent.setup()
    render(<SyncChip />)
    act(() => m.push('sign-in'))
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(m.signIn).toHaveBeenCalled())
    expect(m.syncNow).not.toHaveBeenCalled()
  })
})
