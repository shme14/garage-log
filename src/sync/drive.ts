import { db } from '../db/db'
import { clearToken, getToken } from './auth'
import { FOLDER_ID_KEY, FOLDER_INFO_KEY, FOLDER_NAME } from './config'
import { AuthError, type SyncFileRef, type SyncStore } from './store'

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const FOLDER_FIELDS = 'id,name,owners(emailAddress),shared'

export interface DriveFolder {
  id: string
  name: string
  ownerEmail: string
  shared: boolean
}

interface RawFolder {
  id: string
  name: string
  owners?: { emailAddress?: string }[]
  shared?: boolean
}

function toFolder(f: RawFolder): DriveFolder {
  return {
    id: f.id,
    name: f.name,
    ownerEmail: f.owners?.[0]?.emailAddress ?? '',
    shared: f.shared === true,
  }
}

// Drive query strings quote with single quotes.
function q(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

// ---------------------------------------------------------------- HTTP

/** A non-auth, non-2xx Drive response. */
class DriveHttpError extends Error {
  readonly status: number
  constructor(status: number, body: string) {
    super(`Google Drive error ${status}: ${snippet(body)}`)
    this.name = 'DriveHttpError'
    this.status = status
  }
}

function snippet(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

function isAuthReason(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as {
      error?: { status?: string; errors?: { reason?: string }[] }
    }
    const reasons = (parsed.error?.errors ?? []).map((e) => e.reason)
    return reasons.some((r) => r === 'insufficientPermissions' || r === 'authError')
  } catch {
    return false
  }
}

/** Authorised fetch that maps Drive failures onto AuthError / plain Error. */
async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const accessToken = await getToken()
  let res: Response
  try {
    res = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${accessToken}` },
    })
  } catch (e) {
    if (e instanceof TypeError) throw new Error('Network error talking to Google Drive')
    throw e
  }
  if (res.ok) return res
  if (res.status === 401) {
    clearToken()
    throw new AuthError('Google rejected the sign-in')
  }
  const body = await res.text().catch(() => '')
  if (res.status === 403 && isAuthReason(body)) {
    throw new AuthError('Google Drive access was not granted')
  }
  throw new DriveHttpError(res.status, body)
}

async function driveJson<T>(url: string, init?: RequestInit): Promise<T> {
  return (await driveFetch(url, init)).json() as Promise<T>
}

// ---------------------------------------------------------------- folder

/** Every "Garage Log" folder this account can see (its own and ones shared with it). */
export async function findFolders(): Promise<DriveFolder[]> {
  const params = new URLSearchParams({
    q: `name='${q(FOLDER_NAME)}' and mimeType='${FOLDER_MIME}' and trashed=false`,
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true',
    fields: 'files(id,name,owners(emailAddress),shared)',
  })
  const out = await driveJson<{ files?: RawFolder[] }>(`${API}/files?${params}`)
  return (out.files ?? []).map(toFolder)
}

/**
 * Create the shared folder. Refuses if one is already visible so a device never makes a second
 * folder next to one that was shared with it.
 */
export async function createFolder(): Promise<DriveFolder> {
  if ((await findFolders()).length > 0) {
    throw new Error(`A "${FOLDER_NAME}" folder already exists. Choose it instead.`)
  }
  const params = new URLSearchParams({ supportsAllDrives: 'true', fields: FOLDER_FIELDS })
  const raw = await driveJson<RawFolder>(`${API}/files?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
  })
  return toFolder(raw)
}

/** Remember the chosen folder (and, for display, its details). */
export async function setFolder(id: string, info?: DriveFolder): Promise<void> {
  await db.transaction('rw', db.meta, async () => {
    await db.meta.put({ key: FOLDER_ID_KEY, value: id })
    if (info) await db.meta.put({ key: FOLDER_INFO_KEY, value: JSON.stringify(info) })
    else await db.meta.delete(FOLDER_INFO_KEY)
  })
}

export async function getFolderId(): Promise<string | undefined> {
  return (await db.meta.get(FOLDER_ID_KEY))?.value
}

export async function getFolder(): Promise<DriveFolder | undefined> {
  const id = await getFolderId()
  if (!id) return undefined
  const row = await db.meta.get(FOLDER_INFO_KEY)
  if (row) {
    try {
      const v = JSON.parse(row.value) as Partial<DriveFolder>
      if (v.id === id && typeof v.name === 'string') {
        return {
          id,
          name: v.name,
          ownerEmail: typeof v.ownerEmail === 'string' ? v.ownerEmail : '',
          shared: v.shared === true,
        }
      }
    } catch {
      // fall through
    }
  }
  return { id, name: FOLDER_NAME, ownerEmail: '', shared: false }
}

// ---------------------------------------------------------------- store

async function requireFolderId(): Promise<string> {
  const id = await getFolderId()
  if (!id) throw new AuthError('Choose a folder in Settings')
  return id
}

function multipartBody(boundary: string, meta: object, content: string): string {
  return (
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`
  )
}

/** A SyncStore over the chosen Drive folder. Reads the folder id on every call. */
export function createDriveStore(): SyncStore {
  let own: { folderId: string; name: string; id: string } | undefined

  async function lookupOwn(folderId: string, name: string): Promise<string | undefined> {
    const params = new URLSearchParams({
      q: `'${q(folderId)}' in parents and name='${q(name)}' and trashed=false`,
      includeItemsFromAllDrives: 'true',
      supportsAllDrives: 'true',
      fields: 'files(id)',
    })
    const out = await driveJson<{ files?: { id: string }[] }>(`${API}/files?${params}`)
    return out.files?.[0]?.id
  }

  async function create(folderId: string, name: string, content: string): Promise<string> {
    const boundary = `garagelog${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
    const params = new URLSearchParams({
      uploadType: 'multipart',
      supportsAllDrives: 'true',
      fields: 'id',
    })
    const meta = { name, parents: [folderId], mimeType: 'application/json' }
    const out = await driveJson<{ id: string }>(`${UPLOAD}/files?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipartBody(boundary, meta, content),
    })
    return out.id
  }

  // Returns false when the file no longer exists (deleted since we cached its id).
  async function patch(id: string, content: string): Promise<boolean> {
    const params = new URLSearchParams({ uploadType: 'media', supportsAllDrives: 'true' })
    try {
      await driveFetch(`${UPLOAD}/files/${encodeURIComponent(id)}?${params}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: content,
      })
      return true
    } catch (e) {
      if (e instanceof DriveHttpError && e.status === 404) return false
      throw e
    }
  }

  return {
    async list(): Promise<SyncFileRef[]> {
      const folderId = await requireFolderId()
      const files: SyncFileRef[] = []
      let pageToken: string | undefined
      do {
        const params = new URLSearchParams({
          q: `'${q(folderId)}' in parents and trashed=false and name contains 'changes-'`,
          includeItemsFromAllDrives: 'true',
          supportsAllDrives: 'true',
          fields: 'nextPageToken,files(id,name)',
        })
        if (pageToken) params.set('pageToken', pageToken)
        const out = await driveJson<{ files?: SyncFileRef[]; nextPageToken?: string }>(
          `${API}/files?${params}`,
        )
        for (const f of out.files ?? []) files.push({ id: f.id, name: f.name })
        pageToken = out.nextPageToken
      } while (pageToken)
      return files
    },

    async read(id: string): Promise<string> {
      await requireFolderId()
      const params = new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' })
      const res = await driveFetch(`${API}/files/${encodeURIComponent(id)}?${params}`)
      return res.text()
    },

    async writeOwn(name: string, content: string): Promise<void> {
      const folderId = await requireFolderId()
      if (own && (own.folderId !== folderId || own.name !== name)) own = undefined
      if (!own) {
        const found = await lookupOwn(folderId, name)
        if (found) own = { folderId, name, id: found }
      }
      if (own) {
        if (await patch(own.id, content)) return
        own = undefined // vanished since we last saw it: create a fresh one
      }
      own = { folderId, name, id: await create(folderId, name, content) }
    },
  }
}
