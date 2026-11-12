# Spike: shared Drive folder access from the partner's iPhone (2026-11)

Question: can a browser-only PWA (owner on Android, partner on iPhone) read and write one shared
"Garage Log" folder in the owner's Google Drive, and which OAuth scope mode is needed?

Test page: `spike/drive/index.html`, served at https://shme14.github.io/garage-log/spike/drive/
(local checks: http://localhost:5173/spike/drive/). The page is throwaway.

Modes:
- Mode A: `drive.file` scope + Google Picker (partner picks the shared folder once).
- Mode B: `drive` scope, folder found by name query, no Picker.

Run 2026-11-12 by the owner (desktop Firefox) and the partner (iPhone, iOS 18.7, Safari 26.6.1).

## Result

- Chosen `SCOPE_MODE`: **`'drive'`** (Mode B). Mode A cannot work: with `drive.file`, each account only
  sees files *it* created through the app, so neither device can read the other's change file.
- Exact query used to find the folder:
  `name='Garage Log' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  with `includeItemsFromAllDrives=true&supportsAllDrives=true`. With `drive` scope this returns the
  owner's folder for both accounts (for the partner via "shared with me"); exactly one match once the
  partner's stray self-created folder was deleted. The app must still pick deterministically if
  several match (see Notes).
- Listing the folder: `'<folderId>' in parents and trashed=false`, `supportsAllDrives=true`,
  `includeItemsFromAllDrives=true` — returns files owned by either account.
- Re-auth when re-opening the installed iOS app: sign-in from the home-screen app works (owner
  report; partner's log not captured). The browser token flow gives a ~1 h access token with no
  refresh token, so the app must expect to request a new token after an hour or on reopen, and
  surface `sign-in` status when a silent request fails.
- Token lifetime: `expires_in` ≈ 3599 s on both devices.
- OAuth consent stays in **Testing** with both accounts as test users; Google shows the
  "unverified app" warning for the restricted `drive` scope, which both users accepted.

## Mode A: `drive.file` + Picker

| Check | Result |
| --- | --- |
| Owner (desktop): sign in, create folder, write file | Pass |
| Owner shares folder with partner as Editor | Pass |
| Partner iPhone Safari: sign in | Pass |
| Partner iPhone Safari: Picker shows shared folder, select works | Pass (`isShared: true`) |
| Partner iPhone Safari: list + read owner's file | **Fail** — list returned only the partner's own file |
| Partner iPhone Safari: write own file | Pass (wrote into the owner's folder) |
| Partner iPhone home-screen app | Not run (Mode A already failed) |
| Owner: list + read partner's file | **Fail** — owner's list showed only the owner's file |

## Mode B: `drive` scope

| Check | Result |
| --- | --- |
| Owner: sign in, find folder, list, read partner's file | Pass — 2 files listed, both read |
| Partner iPhone Safari: sign in, find shared folder, list, read, write | Pass — owner's folder found, 2 files listed and read, own file updated (PATCH) |
| Partner iPhone home-screen app: same | Pass (owner report; log not captured) |
| Owner: list + read partner's file | Pass |

## Notes

- Changing scope required an explicit new sign-in; the first Mode B attempts silently reused the
  `drive.file` grant because the mode dropdown hadn't been changed. The app only ever requests one
  scope set, so this won't recur, but sign-in should always request `drive openid email profile`.
- The partner accidentally created a second "Garage Log" folder in their own Drive during Mode A.
  The real app must not create a folder on a device that can find a shared one: "Choose folder"
  should list matches (owner + shared flag) and let the user pick, creating a folder only when none
  exists, and remember the chosen folder id in `meta`.
- Picker / API key are not needed with `drive` scope; the Picker API key and `GOOGLE_API_KEY`
  config can be dropped.
