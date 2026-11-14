// Browser/system bar colour (`<meta name="theme-color">`) kept in step with the colour scheme.
// Not every browser honours `media` on theme-color tags, so one tag is updated live instead.
// Values match --surface (the app header) in src/ui/styles.css.
export const LIGHT_BAR = '#ffffff'
export const DARK_BAR = '#1a1f25'

type MatchMedia = (query: string) => {
  matches: boolean
  addEventListener(type: 'change', fn: (e: { matches: boolean }) => void): void
  removeEventListener(type: 'change', fn: (e: { matches: boolean }) => void): void
}

/** Point the single theme-color tag at the current scheme and follow switches. Returns a cleanup. */
export function syncThemeColor(
  matchMedia: MatchMedia | undefined = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia.bind(window)
    : undefined,
): () => void {
  if (!matchMedia) return () => {}
  const mql = matchMedia('(prefers-color-scheme: dark)')

  for (const m of document.head.querySelectorAll('meta[name="theme-color"]')) m.remove()
  const meta = document.createElement('meta')
  meta.name = 'theme-color'
  document.head.appendChild(meta)

  const apply = (dark: boolean) => {
    meta.content = dark ? DARK_BAR : LIGHT_BAR
  }
  apply(mql.matches)
  const onChange = (e: { matches: boolean }) => apply(e.matches)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}
