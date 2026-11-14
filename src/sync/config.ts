// The OAuth client id is a public value (it ships in every web build), so a default is committed.
// Override it with VITE_GOOGLE_CLIENT_ID in .env.local to use your own Google Cloud project.
export const GOOGLE_CLIENT_ID: string =
  import.meta.env.VITE_GOOGLE_CLIENT_ID ||
  '301979172435-v2ken67m9sjfp3h91q3r30to7eqsb9rh.apps.googleusercontent.com'

/** Name of the shared Drive folder that holds every device's change file. */
export const FOLDER_NAME = 'Garage Log'

// Keys in the Dexie meta table (local to this device; never exported or synced).
export const ACCOUNT_KEY = 'google.account' // JSON { name, email }
export const TOKEN_KEY = 'google.token' // JSON { token, expiresAt, email? }: kept only until it expires (~1 h)
export const FOLDER_ID_KEY = 'google.folderId'
export const FOLDER_INFO_KEY = 'google.folderInfo' // JSON DriveFolder, for display only
