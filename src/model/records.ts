import type { BaseRecord } from './types'

export interface EditContext {
  user: string
  deviceId: string
  now?: Date
}

export function newRecord<T extends BaseRecord>(
  fields: Omit<T, keyof BaseRecord>,
  ctx: EditContext,
): T {
  const ts = (ctx.now ?? new Date()).toISOString()
  return {
    ...fields,
    id: crypto.randomUUID(),
    createdAt: ts,
    updatedAt: ts,
    updatedBy: ctx.user,
    updatedByDevice: ctx.deviceId,
    deleted: false,
  } as T
}

export function touch<T extends BaseRecord>(rec: T, ctx: EditContext): T {
  return {
    ...rec,
    updatedAt: (ctx.now ?? new Date()).toISOString(),
    updatedBy: ctx.user,
    updatedByDevice: ctx.deviceId,
  }
}
