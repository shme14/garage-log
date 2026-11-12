# Garage Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An offline-first PWA for date/meter-stamped vehicle and bike maintenance notes, with issues, todos, service reminders and search, synced between two phones through a shared Google Drive folder.

**Architecture:** React UI over a local Dexie (IndexedDB) database that is always the source of truth on each device. A sync engine merges per-device JSON change files in a shared Drive folder using last-writer-wins per record. Pure modules (`model`, `sync/merge`, `service`, `search`, `export`) hold all logic worth unit testing; `sync/drive` is the only Google-aware module.

**Tech Stack:** TypeScript, React 18, Vite, React Router (HashRouter), Dexie + dexie-react-hooks, vite-plugin-pwa, Vitest + @testing-library/react + fake-indexeddb, Google Identity Services + Drive v3 REST, GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-11-11-garage-log-design.md`

## Prerequisites (owner does these once, before Task 1)

- A GitHub account and an empty public repo `garage-log` to host GitHub Pages.
- A Google Cloud project with the Drive API enabled, an OAuth consent screen in **Testing** mode with the owner's and partner's Google accounts added as test users, and an OAuth **Web client ID** whose authorized JavaScript origin is `https://<github-user>.github.io` (plus `http://localhost:5173` for dev). Also an **API key** restricted to the Picker API (needed only if the spike chooses the Picker route).

## Global Constraints

- App is a PWA installable on Android Chrome and iOS Safari; all read/search/add/edit works with no network.
- Local writes never wait on, or get rolled back by, sync.
- Every record has `id`, `createdAt`, `updatedAt`, `updatedBy`, `updatedByDevice`, `deleted`; every local write stamps `updatedAt`/`updatedBy`/`updatedByDevice`.
- Drive layout: folder **"Garage Log"**; each device writes only `changes-<deviceId>.json`.
- Merge: newest `updatedAt` wins; tie → lexically greater `updatedByDevice`.
- Due status: `due-soon` when ≤10% of the meter interval or ≤1 month remains; `overdue` past either limit; `never-done` with no completing entry.
- Month-precision dates sort/compute as the first day of the month.
- Only empty entry text blocks Save; a reading lower than the meter's current value warns but saves.
- Delete is a tombstone with a 5-second Undo.
- Tags are exactly: `maintenance`, `repair`, `mod`, `diagnosis`, `setup`, `warranty`.
- Currency is CAD; meter units are `km` or `h`.
- Out of scope: photos, fuel, charts, push notifications, structured suspension fields, in-app Keep importer, permissions, compaction.

## Review Focus

1. **Editing a record another device created** — my change file must include it, or the partner never sees my edit. (Task 5 test `ownRecords includes records I last edited regardless of creator`.)
2. **Sync pulling an older remote version over a newer local edit made mid-sync** — the local edit must survive. (Task 6 test `local edit newer than remote survives sync`.)
3. **Readings for a meter that was later removed from the vehicle** — must not crash due computation or prefill; ignored. (Task 4 test `ignores readings for unknown meter`.)
4. **Month-only last-done date in service due math** (e.g. "July 2026: Changed oil") — treated as 2026-07-01. (Task 4 test `month-precision last done uses first of month`.)
5. **Corrupt or foreign file in the Drive folder** — skipped with its name reported, others still merge. (Task 6 test `skips unparseable file and reports it`.)

---

## File Structure

```
index.html
vite.config.ts                 PWA + base path config
src/main.tsx                   React root, HashRouter
src/App.tsx                    routes + header (sync chip)
src/model/types.ts             record interfaces, RecordSet, TableName
src/model/records.ts           newRecord / touch / EditContext
src/model/dates.ts             EntryDate helpers + entry sorting
src/db/db.ts                   Dexie schema + meta (deviceId, user)
src/db/repo.ts                 save / softDelete / restore / queries / bulk
src/sync/merge.ts              pure LWW merge
src/sync/store.ts              SyncStore interface + MemoryStore (tests)
src/sync/drive.ts              Google auth + Drive SyncStore
src/sync/engine.ts             syncOnce + status + triggers
src/service/due.ts             currentReading + dueStatus
src/search/search.ts           search over RecordSet
src/export/export.ts           JSON + text export
src/import/seed.ts             validateSeed + loadSeed
src/ui/...                     screens (Tasks 8–12)
private/seed.json, private/review.md   converted Keep data (Task 13)
spike/drive/index.html         throwaway (Task 1)
```

Tests are colocated as `*.test.ts(x)`.

---

### Task 1: Spike — shared Drive folder from the partner's iPhone (throwaway)

**Files:**
- Create: `spike/drive/index.html` (single page, inline script, no build)
- Create: `docs/superpowers/spikes/2026-11-drive-access.md`

**Interfaces:**
- Produces: a recorded decision `SCOPE_MODE = 'drive.file+picker' | 'drive'` that Task 7 implements.

- [ ] **Step 1: Write the spike page.** Buttons: *Sign in* (GIS `initTokenClient`), *Create folder "Garage Log"* (owner), *Pick folder* (Google Picker, `DocsView` with `setIncludeFolders(true).setSelectFolderEnabled(true)`), *Write `changes-<random>.json`*, *List & read all files in folder*. A dropdown chooses scope `drive.file` or `drive`. Log every response to the page.
- [ ] **Step 2: Publish it** to the `garage-log` repo's GitHub Pages under `/spike/drive/`.
- [ ] **Step 3: Test `drive.file` + Picker.** Owner: sign in, create folder, write a file, share folder (editor) with partner in Drive UI. Partner on iPhone Safari (and again from home-screen install): sign in, pick folder, list, read owner's file, write own file. Owner: list/read partner's file.
Expected for success: both devices list and read both files.
- [ ] **Step 4: If Step 3 failed, repeat with `drive` scope** (no Picker; find folder by `name='Garage Log' and mimeType='application/vnd.google-apps.folder'` including `sharedWithMe`).
- [ ] **Step 5: Record result** in the spike doc: chosen `SCOPE_MODE`, the exact query used to find the folder, whether re-auth was needed when re-opening the installed iOS app, and any token lifetime notes. If neither mode works, stop and raise to the owner (spec §5 fallback).
- [ ] **Step 6: Commit** `git add spike docs/superpowers/spikes && git commit -m "spike: verify shared Drive folder access"`

---

### Task 2: Scaffold + model types, records and dates

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx` (placeholder "Garage Log")
- Create: `src/model/types.ts`, `src/model/records.ts`, `src/model/dates.ts`
- Test: `src/model/dates.test.ts`, `src/model/records.test.ts`

**Interfaces:**
- Produces:
  - `types.ts`: `BaseRecord`, `Vehicle`, `Meter`, `Entry`, `EntryDate`, `Tag`, `TAGS: readonly Tag[]`, `Issue`, `Todo`, `ServiceItem` exactly as spec §3 (plus `updatedByDevice`); `TableName = 'vehicles'|'entries'|'issues'|'todos'|'serviceItems'`; `RecordSet = { vehicles: Vehicle[]; entries: Entry[]; issues: Issue[]; todos: Todo[]; serviceItems: ServiceItem[] }`; `emptySet(): RecordSet`.
  - `records.ts`: `interface EditContext { user: string; deviceId: string; now?: Date }`; `newRecord<T extends BaseRecord>(fields: Omit<T, keyof BaseRecord>, ctx: EditContext): T`; `touch<T extends BaseRecord>(rec: T, ctx: EditContext): T`.
  - `dates.ts`: `dateKey(d: EntryDate): string` (YYYY-MM-DD); `toDate(d: EntryDate): Date`; `todayEntryDate(now?: Date): EntryDate`; `formatEntryDate(d: EntryDate): string` ("Nov 11, 2026" / "Jun 2026"); `compareEntriesDesc(a: Entry, b: Entry): number`.

- [ ] **Step 1: Scaffold.** `npm create vite@latest . -- --template react-ts`; add deps `dexie dexie-react-hooks react-router-dom` and dev deps `vitest @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom fake-indexeddb vite-plugin-pwa`. Vitest env `jsdom`, setup file imports `fake-indexeddb/auto` and `@testing-library/jest-dom`. Add script `"test": "vitest run"`.
- [ ] **Step 2: Write failing tests**

```ts
// dates.test.ts
test('month precision keys to first of month', () => {
  expect(dateKey({ precision: 'month', value: '2026-06' })).toBe('2026-06-01');
});
test('formats both precisions', () => {
  expect(formatEntryDate({ precision: 'day', value: '2025-11-11' })).toBe('Nov 11, 2025');
  expect(formatEntryDate({ precision: 'month', value: '2026-06' })).toBe('Jun 2026');
});
test('sorts newest first, month sorts as first of month, ties by createdAt desc', () => {
  const e = (value: string, precision: 'day'|'month', createdAt: string) =>
    ({ date: { precision, value }, createdAt } as Entry);
  const a = e('2026-07-14', 'day', '2026-07-14T00:00:00Z');
  const b = e('2026-07', 'month', '2026-08-01T00:00:00Z');
  const c = e('2026-07-01', 'day', '2026-07-01T00:00:00Z');
  const d = e('2025-07-22', 'day', '2026-07-30T00:00:00Z');
  expect([d, c, b, a].sort(compareEntriesDesc)).toEqual([a, b, c, d]);
});
// records.test.ts
test('newRecord stamps base fields; touch updates only edit fields', () => {
  const ctx = { user: 'Jamie', deviceId: 'dev-a', now: new Date('2026-11-11T10:00:00Z') };
  const r = newRecord<Todo>({ vehicleId: 'v1', text: 'x', done: false }, ctx);
  expect(r).toMatchObject({ createdAt: '2026-11-11T10:00:00.000Z', updatedAt: '2026-11-11T10:00:00.000Z',
    updatedBy: 'Jamie', updatedByDevice: 'dev-a', deleted: false });
  expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
  const t = touch(r, { user: 'Partner', deviceId: 'dev-b', now: new Date('2026-11-12T00:00:00Z') });
  expect(t).toMatchObject({ id: r.id, createdAt: r.createdAt, updatedAt: '2026-11-12T00:00:00.000Z',
    updatedBy: 'Partner', updatedByDevice: 'dev-b' });
});
```

- [ ] **Step 3: Run** `npx vitest run src/model` — Expected: FAIL (modules missing).
- [ ] **Step 4: Implement** the three model files. `newRecord` uses `crypto.randomUUID()`. Note: the `b` (month, created later) vs `c` (day 07-01) tie is broken by `createdAt` desc.
- [ ] **Step 5: Run** `npx vitest run src/model` — Expected: PASS.
- [ ] **Step 6: Commit** `git commit -am "feat: scaffold app and model types"` (add new files first).

---

### Task 3: Local database and repository

**Files:**
- Create: `src/db/db.ts`, `src/db/repo.ts`
- Test: `src/db/repo.test.ts`

**Interfaces:**
- Consumes: Task 2 types, `newRecord`, `touch`, `EditContext`.
- Produces:
  - `db.ts`: `class GarageDB extends Dexie` with tables `vehicles, entries, issues, todos, serviceItems` (primary key `id`; indexes `vehicleId`, `issueId` on entries/todos) and `meta` (key/value). `export const db: GarageDB`. `getDeviceId(): Promise<string>` (creates UUID once); `getUser(): Promise<string|undefined>`; `setUser(name: string): Promise<void>`; `getEditContext(): Promise<EditContext>`.
  - `repo.ts`: `create<T>(table: TableName, fields, ctx): Promise<T>`; `update<T>(table, rec: T, ctx): Promise<T>`; `softDelete(table, id, ctx): Promise<void>`; `restore(table, id, ctx): Promise<void>`; `readAll(): Promise<RecordSet>` (includes tombstones); `putRaw(set: Partial<RecordSet>): Promise<void>` (bulkPut without stamping — used by sync/import); `live` query helpers: `vehiclesLive()`, `entriesForVehicle(vehicleId)`, `entriesForIssue(issueId)`, `issuesForVehicle`, `todosForVehicle`, `serviceItemsForVehicle` — all excluding `deleted`.

- [ ] **Step 1: Write failing tests**

```ts
beforeEach(async () => { await db.delete(); await db.open(); });
test('create stamps and excludes tombstones from queries', async () => {
  const ctx = { user: 'Jamie', deviceId: 'dev-a' };
  const e = await create<Entry>('entries', { vehicleId: 'v1', date: { precision: 'day', value: '2026-11-11' },
    readings: {}, text: 'oil', tags: [], serviceItemIds: [], createdBy: 'Jamie' }, ctx);
  expect(await entriesForVehicle('v1')).toHaveLength(1);
  await softDelete('entries', e.id, ctx);
  expect(await entriesForVehicle('v1')).toHaveLength(0);
  expect((await readAll()).entries[0].deleted).toBe(true);
  await restore('entries', e.id, ctx);
  expect(await entriesForVehicle('v1')).toHaveLength(1);
});
test('deviceId is stable', async () => {
  expect(await getDeviceId()).toBe(await getDeviceId());
});
test('putRaw does not restamp', async () => {
  const rec = { id: 'x', updatedAt: '2020-01-01T00:00:00.000Z' } as Issue;
  await putRaw({ issues: [rec] });
  expect((await readAll()).issues[0].updatedAt).toBe('2020-01-01T00:00:00.000Z');
});
```

- [ ] **Step 2: Run** `npx vitest run src/db` — Expected: FAIL.
- [ ] **Step 3: Implement** `db.ts` and `repo.ts`. Query helpers return plain promises; UI wraps them with `useLiveQuery`. Every stamping mutation (`create`, `update`, `softDelete`, `restore`; not `putRaw`) calls a module-level listener, default no-op, settable via `setLocalChangeListener(fn: () => void): void` — Task 6 wires it to trigger sync.
- [ ] **Step 4: Run** `npx vitest run src/db` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/db && git commit -m "feat: local Dexie database and repo"`

---

### Task 4: Service due computation

**Files:**
- Create: `src/service/due.ts`
- Test: `src/service/due.test.ts`

**Interfaces:**
- Consumes: `Entry`, `ServiceItem`, `Vehicle`, `toDate`, `compareEntriesDesc`.
- Produces: `currentReading(entries: Entry[], meterId: string): number | undefined` (max non-deleted reading); `type DueState = 'ok'|'due-soon'|'overdue'|'never-done'`; `interface DueInfo { state: DueState; lastDone?: Entry; remainingAmount?: number; dueDate?: Date }`; `dueStatus(item: ServiceItem, vehicle: Vehicle, entries: Entry[], today: Date): DueInfo`.

Rules: meter part uses last-done entry's reading for `intervalMeterId` (if the last-done entry lacks that reading, meter part is skipped); `remainingAmount = lastReading + intervalAmount - currentReading`; due-soon if `remainingAmount <= 0.1 * intervalAmount`. Time part: `dueDate = toDate(lastDone.date) + intervalMonths`; due-soon if `today >= dueDate − 1 month`. Overdue if either `remainingAmount < 0` or `today > dueDate`. The worst state of the two parts wins. Meter part is skipped if `intervalMeterId` is not in `vehicle.meters`.

- [ ] **Step 1: Write failing tests** (vehicle `v` with meter `odo` km; item `oil` = 8000 km / 12 months)

```ts
test('ok when plenty remains', () => {
  const entries = [done('2026-07', 'month', 153300), reading('2026-11-01', 159500)];
  expect(dueStatus(oil, v, entries, new Date('2026-11-11')).state).toBe('ok');
  expect(dueStatus(oil, v, entries, new Date('2026-11-11')).remainingAmount).toBe(1800);
});
test('due-soon at <=10% of distance', () => {
  expect(dueStatus(oil, v, [done('2026-07', 'month', 153300), reading('2026-11-01', 160600)], new Date('2026-11-11')).state).toBe('due-soon');
});
test('overdue past distance', () => {
  expect(dueStatus(oil, v, [done('2026-07', 'month', 153300), reading('2026-11-01', 161400)], new Date('2026-11-11')).state).toBe('overdue');
});
test('month-precision last done uses first of month', () => {
  const info = dueStatus(oil, v, [done('2026-07', 'month', 153300)], new Date('2027-06-02'));
  expect(info.dueDate?.toISOString().slice(0, 10)).toBe('2027-07-01');
  expect(info.state).toBe('due-soon');
});
test('overdue past time even with distance left', () => {
  expect(dueStatus(oil, v, [done('2026-07', 'month', 153300)], new Date('2027-07-02')).state).toBe('overdue');
});
test('never-done', () => {
  expect(dueStatus(oil, v, [], new Date('2026-11-11')).state).toBe('never-done');
});
test('ignores readings for unknown meter', () => {
  const e = { ...reading('2026-11-01', 0), readings: { ghost: 999999 } };
  expect(() => dueStatus(oil, v, [done('2026-07', 'month', 153300), e], new Date('2026-11-11'))).not.toThrow();
  expect(currentReading([e], 'odo')).toBeUndefined();
});
test('deleted entries are ignored', () => {
  expect(dueStatus(oil, v, [{ ...done('2026-07', 'month', 153300), deleted: true }], new Date('2026-11-11')).state).toBe('never-done');
});
```

(`done(date, precision, km)` builds an entry with `serviceItemIds: [oil.id]`, `readings: { odo: km }`; `reading(date, km)` builds a plain entry.)

- [ ] **Step 2: Run** `npx vitest run src/service` — Expected: FAIL.
- [ ] **Step 3: Implement** `due.ts`.
- [ ] **Step 4: Run** `npx vitest run src/service` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/service && git commit -m "feat: service due computation"`

---

### Task 5: Merge

**Files:**
- Create: `src/sync/merge.ts`
- Test: `src/sync/merge.test.ts`

**Interfaces:**
- Consumes: `BaseRecord`, `RecordSet`, `TableName`, `emptySet`.
- Produces: `newer<T extends BaseRecord>(a: T, b: T): T`; `winnersOver(local: RecordSet, remote: RecordSet): RecordSet` (remote records that are new or strictly win over the local copy — exactly what to write locally); `ownRecords(set: RecordSet, deviceId: string): RecordSet` (records whose `updatedByDevice === deviceId`).

- [ ] **Step 1: Write failing tests**

```ts
test('newer updatedAt wins', ...)                  // a@10:00 vs b@11:00 -> b
test('tie broken by greater updatedByDevice', ...) // same time, 'dev-b' beats 'dev-a', symmetric
test('winnersOver returns only new or newer remote records', () => {
  // local: x@10, y@12 ; remote: x@11, y@11, z@09  ->  x@11, z@09
});
test('remote tombstone newer than local edit deletes it', ...)
test('local edit newer than remote tombstone is kept', ...)
test('ownRecords includes records I last edited regardless of creator', () => {
  // record created by dev-b, touched by dev-a -> in ownRecords(set,'dev-a'), not in ownRecords(set,'dev-b')
});
```

- [ ] **Step 2: Run** `npx vitest run src/sync/merge` — Expected: FAIL.
- [ ] **Step 3: Implement** `merge.ts` — compare `updatedAt` as ISO strings, then `updatedByDevice`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/sync/merge* && git commit -m "feat: last-writer-wins merge"`

---

### Task 6: Sync engine (against an in-memory store)

**Files:**
- Create: `src/sync/store.ts`, `src/sync/engine.ts`
- Test: `src/sync/engine.test.ts`

**Interfaces:**
- Consumes: `readAll`, `putRaw`, `getDeviceId`, `setLocalChangeListener` (Task 3); `winnersOver`, `ownRecords` (Task 5).
- Produces:
  - `store.ts`: `interface SyncFileRef { id: string; name: string }`; `interface SyncStore { list(): Promise<SyncFileRef[]>; read(id: string): Promise<string>; writeOwn(name: string, content: string): Promise<void> }`; `class MemoryStore implements SyncStore` (map of name → content, exposes `files`); `class AuthError extends Error`.
  - `engine.ts`: `interface SyncFile { version: 1; deviceId: string; records: RecordSet }`; `fileName(deviceId: string): string` → `changes-<deviceId>.json`; `syncOnce(store: SyncStore): Promise<{ applied: number; skipped: string[] }>`; `type SyncStatus = 'synced'|'syncing'|'offline'|'pending'|'sign-in'|'error'`; `subscribeStatus(fn: (s: SyncStatus, lastSynced?: string, skipped?: string[]) => void): () => void`; `startSync(store: SyncStore): void` (triggers: immediate, `online` event, local change debounced 5000 ms, and returns a `syncNow()` via `export function syncNow(): Promise<void>`).

Cycle (`syncOnce`): list → read every file except our own → parse each (on failure push name to `skipped`, continue) → `putRaw(winnersOver(await readAll(), remote))` per file → `writeOwn(fileName(me), JSON.stringify({version:1, deviceId: me, records: ownRecords(await readAll(), me)}))`. Re-read local right before computing winners so a local edit made during download is compared, not overwritten. Status: `offline` when `navigator.onLine` is false; `sign-in` when the store throws `AuthError`; `pending` when a local change happened after the last successful sync; `error` otherwise on failure.

- [ ] **Step 1: Write failing tests**

```ts
test('two devices converge', async () => {
  // device A (deviceId 'a') creates entry e1, syncs to shared MemoryStore;
  // simulate device B by writing changes-b.json with entry e2 into the store;
  // A syncs -> local has e1,e2; store has changes-a.json containing e1 only.
});
test('local edit newer than remote survives sync', async () => {
  // local x@12 by 'a'; store changes-b.json has x@11 -> after sync local x is @12
});
test('skips unparseable file and reports it', async () => {
  // store has changes-b.json = '{bad', changes-c.json valid -> skipped == ['changes-b.json'], c's records applied
});
test('own file includes edits to records created by other device', async () => {
  // pull b's record, touch it as 'a', sync -> changes-a.json contains it
});
test('AuthError sets status sign-in and leaves local data untouched', ...)
```

- [ ] **Step 2: Run** `npx vitest run src/sync/engine` — Expected: FAIL.
- [ ] **Step 3: Implement** `store.ts` and `engine.ts`; wire `setLocalChangeListener` in `startSync`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/sync && git commit -m "feat: sync engine with per-device change files"`

---

### Task 7: Google Drive store

**Files:**
- Create: `src/sync/drive.ts`, `src/sync/config.ts` (`GOOGLE_CLIENT_ID`, `GOOGLE_API_KEY`, `SCOPE_MODE` from `import.meta.env`, `.env.example` documenting them)

**Interfaces:**
- Consumes: `SyncStore`, `AuthError` (Task 6); `SCOPE_MODE` decision from Task 1's spike doc.
- Produces: `signIn(): Promise<{ name: string; email: string }>` (GIS token client; fetches `https://www.googleapis.com/oauth2/v3/userinfo` and calls `setUser(name)`); `signOut(): void`; `isSignedIn(): boolean`; `chooseFolder(): Promise<void>` (Picker in `drive.file+picker` mode; create-or-find "Garage Log" in `drive` mode), persisting folder id in `meta`; `createDriveStore(): SyncStore`.

Drive calls: list `GET files?q='<folder>' in parents and name contains 'changes-' and trashed=false&fields=files(id,name)`; read `GET files/<id>?alt=media`; writeOwn finds own file by name, then `PATCH upload/drive/v3/files/<id>?uploadType=media` or creates via multipart `POST upload/drive/v3/files?uploadType=multipart` with `parents: [folderId]`. HTTP 401/403 → throw `AuthError`; token expiry → `AuthError`.

- [ ] **Step 1: Implement** `drive.ts` and `config.ts` using the folder query and scope recorded in the spike doc.
- [ ] **Step 2: Type-check** `npx tsc --noEmit` — Expected: no errors.
- [ ] **Step 3: Manual check** in `npm run dev` on desktop: sign in, choose folder, call `syncNow()` from the console; `changes-<id>.json` appears in the Drive folder.
- [ ] **Step 4: Commit** `git add src/sync .env.example && git commit -m "feat: Google Drive sync store"`

---

### Task 8: App shell, Garage screen, sync chip

**Files:**
- Create: `src/ui/Header.tsx` (title, sync chip, links to Search/Settings), `src/ui/Garage.tsx`, `src/ui/VehicleCard.tsx`, `src/ui/styles.css`
- Modify: `src/App.tsx` (HashRouter routes: `/`, `/entry/new`, `/entry/:id/edit`, `/vehicle/:id/:tab?`, `/issue/:id`, `/search`, `/settings`), `src/main.tsx` (call `startSync(createDriveStore())` when signed in)
- Test: `src/ui/Garage.test.tsx`

**Interfaces:**
- Consumes: `vehiclesLive` etc. (Task 3), `currentReading`, `dueStatus` (Task 4), `subscribeStatus` (Task 6).
- Produces: `lastVehicleId` stored in `localStorage` key `garage.lastVehicle` (read with try/catch), used by Quick Entry.

Card shows name, latest reading per meter (`159,500 km`), badge `N open` for issues with status `open`, badge `N due` counting `due-soon`+`overdue`. Archived vehicles hidden. Floating **+** → `/entry/new`. Mobile-first layout, large tap targets.

- [ ] **Step 1: Write failing test** — seed a vehicle with meter `odo`, entries with readings 153300 and 159500, one open issue, one overdue service item; render `<Garage/>`; expect text `159,500 km`, `1 open`, `1 due`.
- [ ] **Step 2: Run** `npx vitest run src/ui/Garage` — Expected: FAIL.
- [ ] **Step 3: Implement** shell, header chip (label per `SyncStatus`: Synced / Syncing… / Offline / Not synced / Sign in / Sync error), Garage, VehicleCard.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git add src && git commit -m "feat: app shell and garage screen"`

---

### Task 9: Quick Entry (create and edit)

**Files:**
- Create: `src/ui/EntryForm.tsx`
- Test: `src/ui/EntryForm.test.tsx`

**Interfaces:**
- Consumes: `create`, `update` (Task 3), `currentReading`, `todayEntryDate`, `TAGS`.
- Produces: route `/entry/new?vehicle=<id>&issue=<id>` and `/entry/:id/edit`.

Fields per spec §4: vehicle select (default query param → `garage.lastVehicle` → first vehicle), date (day input; "Month only" toggle switches to month input), one number input per meter prefilled with `currentReading`, auto-focused textarea, tag chips, collapsed "More" with Issue select (existing + "New issue…" creating an `Issue` with status `open`), Service multi-select, Cost, Shop (`<datalist>` of previous shops). Only changed meter fields are saved as readings (unchanged prefill is not recorded). Save disabled when text is blank. Saving navigates back and sets `garage.lastVehicle`.

- [ ] **Step 1: Write failing tests**

```tsx
test('prefills meter with current reading and saves only changed readings', ...)
// vehicle odo current 159500; change to 160200; save -> entry.readings == { odo: 160200 }, engine hours omitted
test('warns on lower reading but still saves', ...)
// type 150000 -> text /lower than last reading/ visible; save works
test('save disabled for blank text', ...)
test('month-only toggle saves month precision', ...)
// -> entry.date == { precision: 'month', value: '2026-11' } with fake today 2026-11-11
test('new issue from entry links both', ...)
```

- [ ] **Step 2: Run** `npx vitest run src/ui/EntryForm` — Expected: FAIL.
- [ ] **Step 3: Implement** `EntryForm.tsx`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/ui && git commit -m "feat: quick entry form"`

---

### Task 10: Vehicle screen (log, info, service, todos, undo delete)

**Files:**
- Create: `src/ui/VehiclePage.tsx`, `src/ui/EntryCard.tsx`, `src/ui/TodoList.tsx`, `src/ui/ServiceTab.tsx`, `src/ui/InfoTab.tsx`, `src/ui/UndoToast.tsx`, `src/ui/VehicleEditor.tsx` (name, kind, meters add/rename, archive — reachable from Settings and the vehicle page)
- Test: `src/ui/VehiclePage.test.tsx`

**Interfaces:**
- Consumes: Task 3 queries/mutations, `dueStatus`, `compareEntriesDesc`, `formatEntryDate`.
- Produces: `TodoList` props `{ vehicleId: string; issueId?: string }` (reused by Task 11); `EntryCard` props `{ entry: Entry; vehicle: Vehicle; showIssue?: boolean }`; `useUndoDelete(): (table: TableName, id: string, label: string) => void` (soft-deletes, shows toast 5000 ms with Undo calling `restore`).

Header: open issues (link), open todos (checkbox toggles `done`, inline add), service items with state colour. Log tab: entries sorted by `compareEntriesDesc` showing date, readings with units, tags, text, cost/shop, `createdBy`, issue link, edit/delete. Info tab: textarea, saves `info` + `infoUpdatedAt`, shows "edited on". Service tab: list/add/edit/delete service items (validation: meter interval or months required).

- [ ] **Step 1: Write failing tests**

```tsx
test('log is sorted newest first with month entries in place', ...)
test('delete shows Undo and restores within 5s', ...)   // fake timers
test('todo toggles done', ...)
test('service item without any interval cannot be saved', ...)
```

- [ ] **Step 2: Run** `npx vitest run src/ui/VehiclePage` — Expected: FAIL.
- [ ] **Step 3: Implement** the components.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/ui && git commit -m "feat: vehicle page"`

---

### Task 11: Issue screen

**Files:**
- Create: `src/ui/IssuePage.tsx`
- Test: `src/ui/IssuePage.test.tsx`

**Interfaces:**
- Consumes: `entriesForIssue`, `update`, `TodoList`, `EntryCard`.

Shows title (editable), status segmented control Open/Parked/Resolved, linked entries **oldest first**, `TodoList` filtered by issue, "Add update" → `/entry/new?vehicle=<vid>&issue=<id>`.

- [ ] **Step 1: Write failing tests** — `entries listed oldest first`; `status change persists`; `Add update link carries vehicle and issue`.
- [ ] **Step 2: Run** `npx vitest run src/ui/IssuePage` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/ui && git commit -m "feat: issue page"`

---

### Task 12: Search, export, Settings

**Files:**
- Create: `src/search/search.ts`, `src/export/export.ts`, `src/ui/SearchPage.tsx`, `src/ui/SettingsPage.tsx`
- Test: `src/search/search.test.ts`, `src/export/export.test.ts`

**Interfaces:**
- Consumes: `RecordSet`, `readAll`, `formatEntryDate`, `signIn/signOut/chooseFolder`, `syncNow`, `subscribeStatus`, `loadSeed` (Task 13 — Settings button added there).
- Produces: `interface SearchHit { kind: 'entry'|'issue'|'todo'|'info'; id: string; vehicleId: string; snippet: string }`; `search(set: RecordSet, query: string, filters: { vehicleId?: string; tag?: Tag }): SearchHit[]` (case-insensitive substring over entry text + shop, issue title, todo text, vehicle info; skips deleted; tag filter applies to entries only; results ordered entries by date desc, then issues, todos, info); `exportJson(set: RecordSet): string` (pretty JSON incl. tombstones); `exportText(set: RecordSet): string` (per non-deleted vehicle: `# <name>`, info, then entries oldest→newest as `<date> — <readings> — <text>`).

Settings: signed-in name, Sign in/out, Choose folder, sync status + last synced + Sync now, a warning listing any `skipped` file names from the last sync, Export JSON / Export text (download via Blob link), vehicle list → `VehicleEditor`, "Add vehicle".

- [ ] **Step 1: Write failing tests**

```ts
test('finds torque spec case-insensitively', () => expect(search(set, '14NM', {}).map(h => h.id)).toContain('e-may21'));
test('vehicle and tag filters narrow results', ...)
test('matches info page and issue title', ...)
test('skips deleted', ...)
test('exportText includes vehicle heading and month dates', () => expect(exportText(set)).toContain('Jun 2026 — '));
```

- [ ] **Step 2: Run** `npx vitest run src/search src/export` — Expected: FAIL.
- [ ] **Step 3: Implement** `search.ts`, `export.ts`, then the two pages.
- [ ] **Step 4: Run** `npx vitest run` — Expected: all PASS.
- [ ] **Step 5: Commit** `git add src && git commit -m "feat: search, export and settings"`

---

### Task 13: Keep import (conversion + loader)

**Files:**
- Create: `private/seed.json`, `private/review.md` (produced by Claude from `private/keep-notes.md`)
- Create: `src/import/seed.ts`
- Modify: `src/ui/SettingsPage.tsx` (button "Load Keep import" — file picker for `seed.json`, shown only when the local DB has no vehicles)
- Test: `src/import/seed.test.ts`

**Interfaces:**
- Consumes: `newRecord`, `putRaw`, `EditContext`, `RecordSet`.
- Produces: `validateSeed(json: unknown): RecordSet` (throws `Error` naming the first bad record); `loadSeed(json: unknown, ctx: EditContext): Promise<number>` (stamps every record with `ctx`, writes via `putRaw`, returns count).

Seed format: `RecordSet` JSON where records may omit base fields (they are stamped on load) but must have stable `id`s so cross-references resolve. Conversion follows spec §6. Meters: 2021 F150 `Odometer (km)`, `Engine hours (h)`; 2015 F150 `Odometer (km)`; Relay `Bike km`, `Motor km`; Sparky none. `createdBy` = owner's name. `review.md` lists: every issue and its linked entries, every todo, every service item, each km value assigned to a meter by judgement (Relay after Aug 2024), the Sparky "July 22, 2025" ordering question, and anything else not mapped one-to-one.

- [ ] **Step 1: Write failing tests**

```ts
test('seed file validates', () => expect(() => validateSeed(seedJson)).not.toThrow());
test('every reference resolves', () => {
  // each entry.vehicleId, issueId, serviceItemIds, readings keys -> existing vehicle/issue/serviceItem/meter
});
test('seed has the four vehicles', () => expect(validateSeed(seedJson).vehicles.map(v => v.name).sort())
  .toEqual(['2015 F150', '2021 F150', 'Relay', 'Sparky']));
test('loadSeed stamps and stores', async () => { /* count > 0, records have updatedByDevice === ctx.deviceId */ });
test('validateSeed rejects entry with unknown vehicle', ...)
```

- [ ] **Step 2: Run** `npx vitest run src/import` — Expected: FAIL.
- [ ] **Step 3: Convert** the Keep notes into `private/seed.json` and write `private/review.md`.
- [ ] **Step 4: Implement** `seed.ts` and the Settings button.
- [ ] **Step 5: Run** `npx vitest run src/import` — Expected: PASS.
- [ ] **Step 6: Owner review** — owner reads `private/review.md` and approves or requests corrections; apply corrections and re-run Step 5.
- [ ] **Step 7: Commit** `git add src && git commit -m "feat: Keep import seed and loader"`

---

### Task 14: PWA, deploy, device check

**Files:**
- Modify: `vite.config.ts` (`base: '/garage-log/'`; `VitePWA({ registerType: 'autoUpdate', manifest: { name: 'Garage Log', short_name: 'Garage', display: 'standalone', start_url: '/garage-log/', icons: [192, 512 png] }, workbox: { navigateFallback: '/garage-log/index.html' } })`)
- Create: `public/icon-192.png`, `public/icon-512.png`, `public/apple-touch-icon.png`, `.github/workflows/deploy.yml` (build on push to `main`, publish `dist` with `actions/deploy-pages`; injects `VITE_GOOGLE_CLIENT_ID`, `VITE_GOOGLE_API_KEY`, `VITE_SCOPE_MODE` from repo secrets/vars)
- Modify: `src/main.tsx` — on startup, if signed in and local DB has no vehicles, run `syncNow()` (iOS eviction recovery, spec §7).

- [ ] **Step 1: Build** `npm run build` — Expected: success, `dist/sw.js` and `dist/manifest.webmanifest` present.
- [ ] **Step 2: Run all tests** `npm test` — Expected: all PASS.
- [ ] **Step 3: Push and deploy**; open `https://<user>.github.io/garage-log/` — Expected: app loads.
- [ ] **Step 4: Owner loads the seed** on the Android phone via Settings, signs in, chooses folder, syncs.
- [ ] **Step 5: Device check** (spec §8): install to home screen on Android and iPhone; airplane mode on both; add one entry on each; confirm app reopens and search works offline; reconnect; within one sync both phones and desktop show both entries with correct authors.
- [ ] **Step 6: Commit** `git add . && git commit -m "feat: PWA config and GitHub Pages deploy"`
