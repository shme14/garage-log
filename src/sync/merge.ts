import type { BaseRecord, RecordSet, TableName } from '../model/types'
import { emptySet } from '../model/types'

const TABLES: readonly TableName[] = ['vehicles', 'entries', 'issues', 'todos', 'serviceItems']

// Last-writer-wins: later updatedAt wins; on a tie the lexically greater
// updatedByDevice wins. Timestamps are always Date.toISOString() output, so
// plain string comparison is time order. Symmetric except when both keys are
// equal (the same version), where `a` is returned.
export function newer<T extends BaseRecord>(a: T, b: T): T {
  if (a.updatedAt > b.updatedAt) return a
  if (a.updatedAt < b.updatedAt) return b
  if (a.updatedByDevice > b.updatedByDevice) return a
  if (a.updatedByDevice < b.updatedByDevice) return b
  return a
}

// Remote records that are new to us or strictly win over our copy: exactly
// what should be written locally.
export function winnersOver(local: RecordSet, remote: RecordSet): RecordSet {
  const out = emptySet()
  for (const table of TABLES) {
    const byId = new Map<string, BaseRecord>(local[table].map((r) => [r.id, r]))
    const wins: BaseRecord[] = []
    for (const r of remote[table]) {
      const l = byId.get(r.id)
      if (!l || (newer(l, r) === r && !sameVersion(l, r))) wins.push(r)
    }
    ;(out[table] as BaseRecord[]) = wins
  }
  return out
}

function sameVersion(a: BaseRecord, b: BaseRecord): boolean {
  return a.updatedAt === b.updatedAt && a.updatedByDevice === b.updatedByDevice
}

// Records whose last editor is this device (what goes in its change file).
export function ownRecords(set: RecordSet, deviceId: string): RecordSet {
  const out = emptySet()
  for (const table of TABLES) {
    ;(out[table] as BaseRecord[]) = set[table].filter((r) => r.updatedByDevice === deviceId)
  }
  return out
}
