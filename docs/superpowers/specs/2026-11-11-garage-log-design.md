# Garage Log — Design Spec

Date: 2026-11-11
Status: Draft for review

## 1. Purpose

Replace the Google Keep notes currently used to log vehicle and bike maintenance with an app that makes date/meter-stamped notes fast to add and easy to find later.

The current Keep notes (one note per vehicle, free-text chronological log, plus undated reference sections) have these problems, all in scope:

- **Slow entry** — retyping date and km, scrolling to the bottom of long notes.
- **Hard to find things** — "what torque/Loctite on the motor bushings?", "what rebound did I like at Sun Peaks?", "when did I last change transfer case fluid?"
- **No reminders** — nothing says what is due next.
- **Buried problems** — multi-month problems (motor creak, bed shake, front-end growl) and "try this next" notes get lost in the log.

### Users

- **Owner** (Android phone + computer) — primary user, creates and edits everything.
- **Partner** (iPhone) — adds entries and reads. Same permissions in the app; the distinction is usage, not access control.
- Each entry records who added it.

### Success criteria

- Adding an entry with today's date and an updated meter reading takes ~10 seconds on a phone.
- The app works fully offline (read, search, add, edit) at a trailhead with no signal, and syncs when back online.
- Entries added on both phones while offline merge with no lost data.
- The four existing Keep notes are imported and reviewed before go-live.
- Data can always be exported in full.

## 2. Platform & architecture

- **Offline-first Progressive Web App (PWA)**, installed to the home screen on Android and iPhone; also usable in a desktop browser.
- **Stack:** TypeScript, React, Vite, `vite-plugin-pwa` (service worker caches the app shell), Dexie over IndexedDB for local storage.
- **Hosting:** static build on GitHub Pages. No application server.
- **Sync backend:** Google Drive, via Google Identity Services (browser token flow) and the Drive v3 REST API.

Rationale: a single PWA covers Android, iPhone and desktop without Apple developer-account costs or two native codebases; Google Drive avoids running and exposing a server.

### Module boundaries

| Module | Responsibility | Depends on |
|---|---|---|
| `model/` | Record types, ID/timestamp helpers, date-precision handling, sorting | — |
| `db/` | Dexie schema; local CRUD; all writes stamp `updatedAt`/`updatedBy` | `model` |
| `sync/merge` | Pure function: merge sets of records by ID, newest `updatedAt` wins | `model` |
| `sync/drive` | Google auth, folder access, read/write per-device change files | Drive API |
| `sync/engine` | Orchestrates pull → merge → write local → push; status reporting; retry | `db`, `sync/merge`, `sync/drive` |
| `service/` | Pure functions computing due status of service items | `model` |
| `search/` | Text + filter search over local records | `db` |
| `import/` | One-time loader for the converted Keep data file | `db` |
| `ui/` | Screens and components | all of the above |

`sync/drive` is the only module that knows about Google. If Drive proves unworkable, it is replaced by a self-hosted backend behind the same interface without touching other modules.

## 3. Data model

All records share:

```ts
interface BaseRecord {
  id: string;          // UUID v4
  createdAt: string;   // ISO timestamp
  updatedAt: string;   // ISO timestamp, set on every change
  updatedBy: string;   // Google account display name/email of last editor
  updatedByDevice: string; // deviceId of last editor (merge tie-break)
  deleted: boolean;    // tombstone; deleted records are hidden but kept for sync
}
```

### Vehicle

```ts
interface Vehicle extends BaseRecord {
  name: string;                 // "2021 F150", "Relay", "Sparky"
  kind: 'truck' | 'car' | 'bike' | 'ebike' | 'other';
  info: string;                 // free-text reference page (purchase details, config codes, weights, links)
  infoUpdatedAt: string;        // shown as "edited on"
  meters: Meter[];              // ordered; may be empty
  archived: boolean;
}

interface Meter {
  id: string;
  name: string;                 // "Odometer", "Engine hours", "Bike km", "Motor km"
  unit: 'km' | 'h';
}
```

### Entry

```ts
type EntryDate =
  | { precision: 'day'; value: string }     // "2025-11-11"
  | { precision: 'month'; value: string };  // "2026-06"

type Tag = 'maintenance' | 'repair' | 'mod' | 'diagnosis' | 'setup' | 'warranty';

interface Entry extends BaseRecord {
  vehicleId: string;
  date: EntryDate;
  readings: Record<string, number>;   // meterId -> value; any subset, may be empty
  text: string;
  tags: Tag[];
  cost?: number;                      // CAD
  shop?: string;                      // free text, autocompleted from previous values
  issueId?: string;
  serviceItemIds: string[];           // service items this entry completes
  createdBy: string;                  // author shown on the entry
}
```

Sorting: by date descending; a month-precision date sorts as the first day of its month; ties broken by `createdAt`.

### Issue

```ts
interface Issue extends BaseRecord {
  vehicleId: string;
  title: string;                      // "Motor mount creak"
  status: 'open' | 'parked' | 'resolved';
}
```

An issue's history is the entries whose `issueId` points to it.

### Todo

```ts
interface Todo extends BaseRecord {
  vehicleId: string;
  issueId?: string;
  text: string;                       // "Try locking out hubs engaged"
  done: boolean;
}
```

### ServiceItem

```ts
interface ServiceItem extends BaseRecord {
  vehicleId: string;
  name: string;                       // "Oil change"
  intervalMeterId?: string;           // which meter the distance/hour interval uses
  intervalAmount?: number;            // e.g. 8000 (km) or 50 (h)
  intervalMonths?: number;            // e.g. 12
}
```

At least one of (`intervalMeterId` + `intervalAmount`) or `intervalMonths` must be set.

**Due status** (computed, not stored):
- *Last done* = the latest non-deleted entry whose `serviceItemIds` includes the item.
- *Current meter value* = the highest reading for that meter across all entries for the vehicle.
- Remaining = whichever of the meter interval and time interval runs out first.
- Status: `ok`; `due-soon` when ≤10% of the meter interval or ≤1 month remains; `overdue` when past either limit; `never-done` when no entry exists.

## 4. Screens

### Garage (home)
- A card per non-archived vehicle: name, latest reading per meter, badges for open-issue count and due-soon/overdue service count.
- Floating **+** opens Quick Entry for the last-used vehicle.

### Quick Entry
- Vehicle selector (defaults to last used).
- Date defaults to today; toggle for month-only.
- One numeric field per meter, pre-filled with that meter's current value.
- Multi-line text box, auto-focused.
- Tag chips row.
- Collapsed optional fields: Issue (pick existing or create new), Service (multi-select items completed), Cost, Shop.
- Save writes locally, returns to the previous screen, and triggers a sync attempt.
- A reading lower than the meter's current value shows a non-blocking "lower than last reading — typo?" warning.

### Vehicle
- Header section: open issues, open todos, service items with status colour (green / amber due-soon / red overdue / grey never-done).
- Log: entries in sort order, each showing date, readings, tags, text, cost/shop, author, and issue link.
- Tabs: **Log** | **Info** (editable reference page) | **Service** (manage service items).
- Edit/delete on each entry; delete shows a 5-second Undo.

### Issue
- Title, status control (Open / Parked / Resolved), linked entries oldest-first, todos.
- "Add update" opens Quick Entry pre-linked to the issue.

### Search
- Single text box, case-insensitive substring match over entry text, shop, issue titles, todo text, and vehicle info pages.
- Filter chips: vehicle, tag.
- Results link to the entry, issue or info page.

### Settings
- Google sign-in/out; display name used as author.
- Sync: status, last-synced time, "Sync now", Drive folder selection/setup.
- Export: full JSON dump and a readable plain-text log grouped by vehicle.

## 5. Sync design

### Storage layout in Drive
- A folder **"Garage Log"** in the owner's Drive, shared (editor) with the partner's Google account.
- Each device writes exactly one file: `changes-<deviceId>.json`, containing every record that device has created or modified (latest version of each).
- `deviceId` is a UUID generated once per install and stored locally.

No two devices ever write the same file, so concurrent writes cannot clobber each other.

### Sync cycle
1. List files in the folder; download every `changes-*.json` except our own.
2. Merge each downloaded record into local DB: for each ID, keep the version with the latest `updatedAt` (tie-break: lexically greater `updatedByDevice`, for determinism).
3. Upload our own file containing all records this device has authored or last modified.

Triggers: app open, after any local save (debounced 5 s), `online` event, and the "Sync now" button.

### Status
- `synced` / `syncing` / `offline` / `pending changes` / `sign-in needed` / `error` shown as a chip in the header.
- Failures retry with backoff on the next trigger; local data is never modified by a failed sync.
- A file that fails to parse is skipped with a warning naming the file; other files still merge.

### Risk & spike
How a browser-only app accesses a folder **shared from another account** must be proven first:
- Preferred: `drive.file` scope plus a one-time Google Picker selection of the shared folder.
- Fallback: broader `drive` scope with the OAuth app left in Google's "testing" mode with both users as test users.

The first implementation task is a throwaway spike verifying read/write of the shared folder from the partner's iPhone PWA. If neither option works acceptably, `sync/drive` is replaced with a small self-hosted backend (decision made then, separately).

## 6. Keep import

- One-time conversion performed by Claude from the four Keep notes (2021 F150, 2015 F150, Relay, Sparky), source text saved in `docs/import/keep-notes.md`.
- Output: `import/seed.json` containing vehicles (with info pages and meters), entries, issues, todos, and service items.
- Conversion rules:
  - Each dated paragraph becomes an entry; month-only dates use month precision; km/hour values in the text become meter readings.
  - Undated sections (purchase details, FORScan/BCM/APIM config, weights, base suspension settings, links) go into the vehicle's info page.
  - Recurring problems become issues with their entries linked (e.g. Relay motor mount creak — open; 2021 F150 front-end growl / 4WD noise — open; 2015 F150 bed shake — parked; 2015 F150 oil pan leak — parked).
  - Explicit "should / try / going to" notes become todos.
  - Oil change service items are created for both trucks with editable default intervals of 8,000 km / 12 months, linked to past oil-change entries.
  - Where a km value could belong to more than one meter (e.g. Relay bike km vs motor km after the Aug 2024 motor swap), the importer picks the most likely meter and lists it in the review report.
  - Ambiguities (e.g. Sparky "July 22, 2025: new front brakes" listed after a 2026 entry) are kept as written and listed in a review report.
- A readable review report (`import/review.md`) is produced for the owner to check before the seed is loaded.
- The app loads `seed.json` once via a Settings action on the owner's device; it then syncs like any other data.

## 7. Error handling

- Local writes are the source of truth on each device; sync failures never block or roll back local edits.
- Delete is a tombstone with 5-second Undo; tombstoned records remain in storage.
- Input validation is advisory only (lower-than-last reading warning); empty text is the only thing that blocks Save.
- Export is available at all times, offline included.
- iOS storage eviction: if local data is missing on startup and the user is signed in, a full pull from Drive restores it.

## 8. Testing

- **Unit (Vitest):** merge (concurrent edits, deletes vs edits, ties, clock skew), service due computation (meter, time, both, never-done), entry sorting with mixed precision, search matching, import seed validity.
- **Component (Vitest + Testing Library):** Quick Entry (prefill, warning, save), Issue flow (create from entry, status change).
- **Manual device check:** install on Android and iPhone; add entries offline on both; reconnect; confirm merged result on both and on desktop.

## 9. Out of scope (v1)

Photos/attachments, fuel tracking, charts, push notifications, structured suspension-setup fields, in-app Keep importer, multi-garage/permission levels, data compaction.
