# Spike: shared Drive folder access from the partner's iPhone (2026-11)

Question: can a browser-only PWA (owner on Android, partner on iPhone) read and write one shared
"Garage Log" folder in the owner's Google Drive, and which OAuth scope mode is needed?

Test page: `spike/drive/index.html`, served at https://shme14.github.io/garage-log/spike/drive/
(local checks: http://localhost:5173/spike/drive/). The page is throwaway.

Modes:
- Mode A: `drive.file` scope + Google Picker (partner picks the shared folder once).
- Mode B: `drive` scope, folder found by name query, no Picker.

## Result

- Chosen `SCOPE_MODE`: TBD — filled after device test  (`'drive.file+picker'` or `'drive'`)
- Exact query used to find the folder: TBD — filled after device test
  (Mode B candidate: `name='Garage Log' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  with `includeItemsFromAllDrives=true&supportsAllDrives=true`)
- Re-auth needed when re-opening the installed iOS app: TBD — filled after device test
- Token lifetime notes: TBD — filled after device test
- If neither mode works: stop and raise to the owner (spec section 5 fallback).

## Mode A: `drive.file` + Picker

| Check | Result |
| --- | --- |
| Owner (Android): sign in, create folder, write file | TBD — filled after device test |
| Owner shares folder with partner as Editor | TBD — filled after device test |
| Partner iPhone Safari: sign in | TBD — filled after device test |
| Partner iPhone Safari: Picker shows shared folder, select works | TBD — filled after device test |
| Partner iPhone Safari: list + read owner's file | TBD — filled after device test |
| Partner iPhone Safari: write own file | TBD — filled after device test |
| Partner iPhone home-screen app: sign in / Picker / list / read / write | TBD — filled after device test |
| Owner: list + read partner's file | TBD — filled after device test |

## Mode B: `drive` scope (only if Mode A failed)

| Check | Result |
| --- | --- |
| Owner: sign in, find folder, write file | TBD — filled after device test |
| Partner iPhone Safari: sign in, find shared folder, list, read, write | TBD — filled after device test |
| Partner iPhone home-screen app: same | TBD — filled after device test |
| Owner: list + read partner's file | TBD — filled after device test |

## Notes

TBD — filled after device test
