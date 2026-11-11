const KEY = 'garage.lastVehicle'

export function getLastVehicleId(): string | undefined {
  try {
    return localStorage.getItem(KEY) ?? undefined
  } catch {
    return undefined
  }
}

export function setLastVehicleId(id: string): void {
  try {
    localStorage.setItem(KEY, id)
  } catch {
    // storage unavailable (private mode, quota): the app works without it
  }
}
