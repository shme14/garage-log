import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { SyncStatus } from '../sync/engine'

const m = vi.hoisted(() => ({
  push: (_s: unknown): void => {},
  signIn: vi.fn(),
  syncNow: vi.fn(),
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

import SyncChip from './SyncChip'

beforeEach(() => {
  m.order = []
  m.signIn.mockReset().mockImplementation(() => new Promise(() => {})) // the page navigates away
  m.syncNow.mockReset().mockResolvedValue(undefined)
})

describe('SyncChip', () => {
  test('is plain status text unless sign-in is needed', () => {
    render(<SyncChip />, { wrapper: MemoryRouter })
    for (const s of ['pending', 'syncing', 'synced', 'offline', 'error'] as SyncStatus[]) {
      act(() => m.push(s))
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
    }
  })

  test('in sign-in status it is a button that starts the Google redirect (sync resumes after reload)', async () => {
    const user = userEvent.setup()
    render(<SyncChip />, { wrapper: MemoryRouter })
    act(() => m.push('sign-in'))
    expect(screen.getByRole('status')).toHaveTextContent(/^Sign in$/)
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(m.signIn).toHaveBeenCalledTimes(1))
    expect(m.signIn).toHaveBeenCalledWith() // not the click event as a navigator
    expect(m.order).toEqual(['signIn'])
  })

  test('no-folder shows "Choose folder" as a link to settings, not a sign-in button', () => {
    render(<SyncChip />, { wrapper: MemoryRouter })
    act(() => m.push('no-folder'))
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Choose folder' })).toHaveAttribute('href', '/settings')
  })

  test('a cancelled sign-in does not sync and does not throw', async () => {
    m.signIn.mockRejectedValue(new Error('blocked'))
    const user = userEvent.setup()
    render(<SyncChip />, { wrapper: MemoryRouter })
    act(() => m.push('sign-in'))
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(m.signIn).toHaveBeenCalled())
    expect(m.syncNow).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })
})
