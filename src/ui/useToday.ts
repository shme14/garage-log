import { useEffect, useState } from 'react'

/**
 * "Today" for due calculations. A phone PWA can sit open for days, so it is refreshed whenever the
 * app comes back to the foreground. Pass `override` (tests) to pin it.
 */
export function useToday(override?: Date): Date {
  const [now, setNow] = useState(() => override ?? new Date())
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') setNow(override ?? new Date())
    }
    document.addEventListener('visibilitychange', refresh)
    return () => document.removeEventListener('visibilitychange', refresh)
  }, [override])
  return now
}
