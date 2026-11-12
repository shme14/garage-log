import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, test, vi } from 'vitest'
import type { SyncStatus } from '../sync/engine'

let push: (s: SyncStatus) => void = () => {}
vi.mock('../sync/engine', () => ({
  subscribeStatus: (fn: (s: SyncStatus) => void) => {
    push = fn
    fn('pending')
    return () => {}
  },
}))

import Header from './Header'

describe('Header sync chip', () => {
  test('labels each status and links to Search and Settings', () => {
    render(
      <MemoryRouter>
        <Header />
      </MemoryRouter>,
    )
    const expected: [SyncStatus, string][] = [
      ['pending', 'Not synced'],
      ['syncing', 'Syncing…'],
      ['synced', 'Synced'],
      ['offline', 'Offline'],
      ['sign-in', 'Sign in'],
      ['no-folder', 'Choose folder'],
      ['error', 'Sync error'],
    ]
    for (const [status, label] of expected) {
      act(() => push(status))
      expect(screen.getByRole('status')).toHaveTextContent(new RegExp(`^${label}$`))
    }
    expect(screen.getByRole('link', { name: 'Search' })).toHaveAttribute('href', '/search')
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings')
  })
})
