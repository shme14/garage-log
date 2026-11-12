export interface SyncFileRef {
  id: string
  name: string
}

/**
 * A shared folder of per-device change files. Each device only ever writes its
 * own file (`writeOwn`); it reads everyone else's.
 */
export interface SyncStore {
  list(): Promise<SyncFileRef[]>
  read(id: string): Promise<string>
  /** Create or replace the file with this name. */
  writeOwn(name: string, content: string): Promise<void>
}

/** The store needs the user to (re)authenticate. */
export class AuthError extends Error {
  constructor(message = 'Authentication required') {
    super(message)
    this.name = 'AuthError'
  }
}

/** No Drive folder has been chosen on this device yet (not a sign-in problem). */
export class FolderError extends Error {
  constructor(message = 'Choose a folder in Settings') {
    super(message)
    this.name = 'FolderError'
  }
}

/** In-memory store for tests: file name -> content. */
export class MemoryStore implements SyncStore {
  readonly files = new Map<string, string>()

  async list(): Promise<SyncFileRef[]> {
    return [...this.files.keys()].map((name) => ({ id: name, name }))
  }

  async read(id: string): Promise<string> {
    const content = this.files.get(id)
    if (content === undefined) throw new Error(`No such file: ${id}`)
    return content
  }

  async writeOwn(name: string, content: string): Promise<void> {
    this.files.set(name, content)
  }
}
