import { afterEach, describe, expect, test } from 'vitest'
import { DARK_BAR, LIGHT_BAR, syncThemeColor } from './themeColor'

type Listener = (e: { matches: boolean }) => void

function fakeMatchMedia(dark: boolean) {
  const listeners: Listener[] = []
  const mql = {
    matches: dark,
    addEventListener: (_: 'change', fn: Listener) => listeners.push(fn),
    removeEventListener: (_: 'change', fn: Listener) => {
      const i = listeners.indexOf(fn)
      if (i >= 0) listeners.splice(i, 1)
    },
  }
  return {
    matchMedia: () => mql,
    flip(next: boolean) {
      mql.matches = next
      for (const fn of [...listeners]) fn({ matches: next })
    },
    listeners,
  }
}

function metas() {
  return [...document.head.querySelectorAll('meta[name="theme-color"]')] as HTMLMetaElement[]
}

afterEach(() => {
  for (const m of metas()) m.remove()
})

describe('syncThemeColor', () => {
  test('replaces media-specific theme-color tags with one tag for the current scheme', () => {
    document.head.insertAdjacentHTML(
      'beforeend',
      '<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">' +
        '<meta name="theme-color" content="#1a1f25" media="(prefers-color-scheme: dark)">',
    )
    const mm = fakeMatchMedia(true)
    syncThemeColor(mm.matchMedia)
    expect(metas()).toHaveLength(1)
    expect(metas()[0].content).toBe(DARK_BAR)
    expect(metas()[0].hasAttribute('media')).toBe(false)
  })

  test('uses the light colour in light mode and creates the tag if missing', () => {
    const mm = fakeMatchMedia(false)
    syncThemeColor(mm.matchMedia)
    expect(metas()).toHaveLength(1)
    expect(metas()[0].content).toBe(LIGHT_BAR)
  })

  test('follows a theme switch while the app is open', () => {
    const mm = fakeMatchMedia(false)
    syncThemeColor(mm.matchMedia)
    mm.flip(true)
    expect(metas()[0].content).toBe(DARK_BAR)
    mm.flip(false)
    expect(metas()[0].content).toBe(LIGHT_BAR)
  })

  test('the returned cleanup stops following theme switches', () => {
    const mm = fakeMatchMedia(false)
    const stop = syncThemeColor(mm.matchMedia)
    stop()
    expect(mm.listeners).toHaveLength(0)
  })

  test('does nothing harmful when matchMedia is unavailable', () => {
    expect(() => syncThemeColor(undefined)).not.toThrow()
    expect(metas()).toHaveLength(0)
  })
})
