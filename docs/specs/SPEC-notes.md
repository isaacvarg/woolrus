# Spec: `notes`

**Milestone:** M2 · **Depends on:** `workflow` · **Used by:** `picking`, `packing`, `qa` (note composer in their
drawers), `exceptions` (notes on quality issues and voids), `shipping` (pushes notes to WooCommerce), `returns`,
`operations` (storage health, PII purge) · **State:** done ·
**Issue:** [#22](https://github.com/isaacvarg/woolrus/issues/22)

Project-wide commands, structure, code style, testing levels and boundaries are in [`../../SPEC.md`](../../SPEC.md);
this spec only adds what is specific to `notes`.

## Objective

Let anyone on the floor leave a note on an order, or on a line, a package or a quality issue: text, photos and one
voice memo. The next person sees it at a glance. Notes are internal unless someone allowed to talk to the customer
marks one customer-visible. Files live in private object storage, and only signed-in staff who can read the order
can fetch them.

- **SRS:** FR-NOTE-01…09, NFR-SEC-05 (short-lived attachment access), NFR-PERF-03 (don't sign every URL on load),
  §7.1 defect #8 (internal notes re-posted to Woo; the exactly-once marker is defined here, `shipping` uses it).
- **decisions.md:** Notes have `visibility` and `wooNoteId`; storage is S3-compatible (RustFS) behind an adapter;
  open item "storage bucket is not created automatically", closed here.
- **Users:** every role writes notes. Admins moderate. Admin, QA and Shipper may write to the customer.
- **Why now:** `picking` and `packing` (also M2) need a place to put "box was crushed, photo attached" and
  "customer asked for no paper invoice" before they are built.

### User stories

1. As a picker, I find a damaged jar. I add a note on that line, take two photos with the tablet camera, and save.
   The line and the order's queue row now show a note indicator.
2. As a packer, I can't type with gloves on, so I record a 20-second voice memo on the order instead.
3. As QA, I open the order and see every note grouped by what it's on (order, line, package, issue). Photos open in a
   lightbox; voice memos play inline.
4. As QA, I write "Your order ships in two boxes" and mark it **customer-visible**. When the order ships, the
   customer gets it from WooCommerce, once.
5. As the author, I fix a typo in my note, or delete it. Its files go with it. Someone else's note shows no edit
   or delete buttons for me, and the API refuses if I try.
6. As an admin, I can edit or delete anyone's note, for example to remove a photo with a customer's ID card in it.
7. As anyone, I upload a 40 MB video or a PDF by mistake and get a clear "photos and audio only, up to 15 MB" error.

## Scope

**In:**
- Create, edit, delete and list notes on an order, an order line, a package or a quality issue.
- Attachments: up to 10 photos and 1 voice memo per note. Images are checked, auto-rotated, stripped of metadata,
  resized and thumbnailed on the server. Audio is checked and stored as is.
- Visibility (internal / customer) with its own permission, and the push contract `shipping` uses.
- Author rules: author or `note.moderate`.
- Storage adapter (S3 over `fetch` with SigV4), bucket ensured on startup, a `storage` health check.
- Serving attachments through the app with auth, caching and Range support.
- Deleting stored files reliably (job), and a daily sweep for orphans.
- Note indicators: counts on queue rows, order lines and packages.
- UI: notes panel on the order detail page, plus a reusable `NoteComposer` / `NoteList` for the stage drawers.

**Out (owned elsewhere or later):**
- Posting notes to WooCommerce: `shipping` (FR-SHIP-06/10). This module defines which notes go and how they're
  marked.
- Notes on returns (`Note.returnId`): `returns` adds the target.
- Creating quality issues: `exceptions`. Notes can target an existing one now.
- Video, PDFs and other file types. More than one voice memo per note.
- Transcribing voice memos. Client-side image compression before upload (possible later, it would only save
  bandwidth).
- Purging old attachments for privacy (NFR-SEC-06): `operations`.

## Design

### Targets

A note always has `orderId`, plus at most one narrower target: `orderItemId`, `packageId` or `qualityIssueId`
(`returnId` is reserved for `returns`). The `notes_single_target` constraint already enforces this. The service
checks that the target belongs to the order (`errors.notes.targetMismatch`, `BAD_REQUEST`).

Notes are allowed in every order status, including `COMPLETED` and `CANCELLED`. They aren't workflow writes: they
don't need a claim, don't bump `Order.version` and don't write an `OrderStageEvent`. They do call
`notifyOrderChanged`, so open pages refresh their notes.

### Permissions

| Permission | Who | Allows |
|---|---|---|
| `order.read` | everyone | List notes, fetch attachments |
| `note.write` | everyone | Create notes; edit and delete **your own** |
| `note.customer` (**new**) | Admin, QA, Shipper | Create or switch a note to `CUSTOMER` |
| `note.moderate` | Admin | Edit and delete anyone's note |

Authorship is by `userId`, so a note written on a station belongs to the person who unlocked it, not the tablet.
Edit or delete by someone else without `note.moderate` → `FORBIDDEN`, `errors.notes.notAuthor` (FR-NOTE-07).

### Visibility and WooCommerce (contract for `shipping`)

- `INTERNAL` (default) and `CUSTOMER`. The UI asks for it explicitly when the author has `note.customer`; for
  everyone else it's fixed to internal (FR-NOTE-08).
- On ship, `shipping` posts every note of the order that has no `wooNoteId` yet, oldest first, **text only**:
  - `CUSTOMER` → a WooCommerce customer note (`customer_note: true`, so WooCommerce emails the customer). Body is
    the content only, no author name.
  - `INTERNAL` → a private order note, prefixed with the author's name and the target (e.g.
    `[Ana · Line: Lavender soap ×2]`). Attachments are mentioned as a count ("2 photos, 1 voice memo in Woolrus").
  - After each post it sets `wooNoteId` + `pushedToWooAt`, so a retry posts nothing twice (defect #8).
- Core exposes `notesToPush(tx, orderId)` and `markNotePushed(tx, { noteId, wooNoteId })` for that; `shipping` owns
  the HTTP call and retries.
- **A pushed note is frozen.** Editing or deleting a note with `wooNoteId` is refused (`CONFLICT`,
  `errors.notes.alreadySent`), even for admins, because WooCommerce already has it (and the customer may have it
  in their inbox). Notes added after shipping are pushed only if `shipping` pushes again (for example on repack);
  until then they stay in Woolrus.

### Services (`packages/core/src/notes/`)

| Function | Permission | Notes |
|---|---|---|
| `listNotes(db, actor, { orderId })` | `order.read` | All notes of the order, oldest first, each with author name, station name (from the create audit), target `{ kind, id, label }`, visibility, `editedAt`, `pushedToWooAt`, attachments (metadata only) and `canEdit` for the caller |
| `createNote(db, storage, actor, input)` | `note.write` (+ `note.customer` for `CUSTOMER`) | Below. Idempotent (`idempotencyKey`) |
| `updateNote(db, storage, actor, input)` | author or `note.moderate` | Change content and visibility, add files, remove attachments. Sets `editedAt`. Audited with before/after content and visibility |
| `deleteNote(db, actor, { id })` | author or `note.moderate` | Deletes the rows and enqueues file deletion in the same transaction. Audited, including the content |
| `getAttachment(db, actor, { id, variant })` | `order.read` | Returns key, content type, size for the serving route |
| `notesToPush(tx, orderId)` / `markNotePushed(tx, …)` | internal (called by `shipping` under its own permission check) | See above |
| `noteCounts(tx, orderIds)` | internal | Used by `workflow` queries for indicators |

Input for create and update (contracts, `packages/contracts/src/notes.ts`):

- `content`: trimmed, 0–4000 characters. A note needs text **or** at least one attachment
  (`errors.notes.empty`).
- `visibility`: `INTERNAL` | `CUSTOMER`.
- `target`: `{ kind: "order" }` | `{ kind: "item", id }` | `{ kind: "package", id }` | `{ kind: "issue", id }`.
- `photos`: 0–10 files; `voice`: 0–1 file with `voiceDurationMs` (1 ms–5 min, from the recorder; the server only
  range-checks it). On update the totals after adding and removing must still fit.
- Files are sent as multipart through the oRPC procedure (`oz.file()` / Zod file schema), so the route stays one
  line.

### Upload pipeline (`packages/core/src/notes/media.ts`)

Per file, before any database write:

1. **Size:** ≤ 15 MB raw (`errors.notes.fileTooLarge`). The whole request is capped at 160 MB.
2. **Type by content, not by name or header** (`errors.notes.fileType`):
   - Photos: whatever sharp can decode among JPEG, PNG, WebP. Anything else (HEIC, GIF, SVG, PDF…) is refused.
   - Voice: container magic bytes for WebM (`1A45DFA3`, what Android Chrome's MediaRecorder writes), Ogg (`OggS`),
     MP4/M4A (`ftyp`, Safari) or MP3 (`ID3` / frame sync). Stored unchanged with the detected content type.
3. **Images** (FR-NOTE-09): `sharp(...).rotate()` (apply EXIF orientation), resize to fit **2048 px** on the long
   edge (never enlarge), encode **WebP quality 80**, strip all metadata (GPS from tablet cameras). A **400 px**
   WebP thumbnail too. Record `width`, `height`, final `sizeBytes`, `contentType: image/webp`. The original
   `fileName` is kept for display only. Images over 40 megapixels are refused before decoding (decompression bombs).
4. **Keys:** `notes/<noteId>/<attachmentId>.<ext>` and `notes/<noteId>/<attachmentId>-thumb.webp`. IDs are
   generated before upload so keys are known; keys are never reused.

Then: upload all files, then commit the note and attachment rows in one transaction. If the transaction fails, the
service deletes what it just uploaded (best effort). Anything left over is caught by the sweep.

Processing runs in the web request (a resize takes well under a second at this size). `sharp` goes into
`serverExternalPackages`.

### Deleting files

- `deleteNote`, and attachments removed by `updateNote`, enqueue a `storage.delete` job with the keys in the same
  transaction (`enqueue(tx, …)`). The worker deletes them, retrying with backoff; a missing object counts as done.
  This replaces v1's delete-then-hope (FR-NOTE-06).
- **Sweep** (`storage.sweep`, daily): lists `notes/` objects older than 24 hours and deletes those with no
  `NoteAttachment` row (by `storageKey` or `thumbnailKey`). This also collects files orphaned by cascades: deleting a
  package or order line cascades its notes in Postgres, and no other module has to remember storage.
- Both jobs log counts; the sweep audits nothing (no business state changes).

### Storage adapter (`packages/core/src/adapters/storage/`)

```ts
export interface ObjectStorage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string, range?: string): Promise<StoredObject>; // { body: ReadableStream, size, contentType, contentRange? }
  delete(keys: string[]): Promise<void>;                     // missing keys are not an error
  list(prefix: string, olderThan: Date): AsyncIterable<{ key: string; lastModified: Date }>;
  ensureBucket(): Promise<void>;
  check(): Promise<"ok" | "fail">;
}
```

- `S3Storage`: `aws4fetch` signs plain `fetch` calls (path-style URLs, which RustFS needs). Config from env:
  `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` (already in `.env.example`; added to
  `turbo.json` `passThroughEnv`). Storage is infrastructure, so it isn't in Settings.
- `MemoryStorage` for tests.
- `ensureBucket()` runs when the worker starts and on first use in web (memoized). It creates the bucket if missing
  and leaves it private. Closes the decisions.md open item.
- `/api/health` gets `storage: ok | fail` (`check()` = HEAD bucket, 2 s timeout).

### Serving attachments (replaces signed URLs)

The storage container isn't reachable from the floor network, and shouldn't be. So the browser never talks to
storage:

- `GET /api/attachments/{id}` and `GET /api/attachments/{id}/thumb` (Next route handlers in `apps/web`, outside
  oRPC because they stream bytes): resolve the actor as for any request, `getAttachment` checks `order.read`, then
  stream from storage.
- Headers: the stored `Content-Type`, `Content-Length`, `Cache-Control: private, max-age=3600, immutable` (keys
  never change), `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`.
- `Range` is forwarded to storage and answered with `206` (audio seeking, and Safari won't play audio without it).
- Unauthenticated → `401`, no permission → `403`, unknown id → `404`. No URL ever grants access by itself.

This meets NFR-SEC-05's intent (access is checked on every fetch, and the browser cache ends after an hour) and
makes NFR-PERF-03 moot: listing notes signs nothing. **Deviation from FR-NOTE-03,** recorded in
`docs/decisions.md` when this ships.

### Indicators (FR-NOTE-05)

`workflow`'s queries gain counts from `noteCounts`: `noteCount` on each queue row and All Orders row (all notes of
the order), and on each line and package in `getOrder`. One grouped query per page, no N+1. The UI shows a note icon
with the count.

### API (oRPC)

| Procedure | Route |
|---|---|
| `notes.list` | `GET /orders/{orderId}/notes` |
| `notes.create` (multipart) | `POST /orders/{orderId}/notes` |
| `notes.update` (multipart) | `PATCH /notes/{id}` |
| `notes.delete` | `DELETE /notes/{id}` |

Plus the two attachment routes above. `NoteDto` attachments carry `{ id, kind, contentType, fileName, sizeBytes,
width, height, durationMs, url, thumbUrl }`, where the URLs are the app routes.

### UI

- **`NoteList`**: notes newest last, grouped by target with a filter (All / Order / Lines / Packages / Issues).
  Each shows the author, station, time, "edited", a **Customer** badge, a "Sent to WooCommerce" mark, text,
  photo thumbnails (open a React Aria modal lightbox with next/previous and swipe) and an inline `<audio controls>`.
  Edit and Delete appear only when `canEdit`; a frozen note explains why it can't change.
- **`NoteComposer`**: text area, **Add photo** (`<input type="file" accept="image/*" capture="environment"
  multiple>`, so tablets open the camera, with a gallery option too), **Record voice** (MediaRecorder; record /
  stop / replay / discard, timer, 5-minute cap), a visibility switch shown only with `note.customer`, and a target
  picker when opened from the order (opened from a line or package, the target is preset). It checks type and size
  before upload and shows progress. Touch targets ≥ 48 px.
- **Order detail page:** a Notes section with both components. Lines and packages show their note counts and open
  the composer preset to that target.
- **Queues and All Orders:** note icon + count.
- All strings in en + es.

### Schema changes (ask-first: listed here for approval)

**None.** `Note` and `NoteAttachment` already have every field (visibility, `wooNoteId`, `pushedToWooAt`,
`editedAt`, `thumbnailKey`, `contentType`, dimensions, `durationMs`). The new permission `note.customer` is code
(`permissions.ts`), not schema.

### Dependencies (approved 2026-10-20)

- `sharp` in `@woolrus/core` (already in the tree through Next; now a direct dependency). The Docker image is
  Alpine, so pnpm installs the `linuxmusl` build there.
- `aws4fetch` in `@woolrus/core`: a small zero-dependency SigV4 signer for `fetch`. No AWS SDK.

### Files expected to change

`packages/core/src/notes/**` (+ tests), `packages/core/src/adapters/storage/**`, `packages/core/src/permissions.ts`,
`packages/core/src/jobs.ts`, `packages/core/src/workflow/queries.ts`, `packages/core/src/index.ts`,
`packages/contracts/src/{notes,orders,index}.ts`, `apps/web/src/server/router.ts`,
`apps/web/src/app/api/attachments/**`, `apps/web/src/app/api/health/route.ts`,
`apps/web/src/components/notes/**`, `apps/web/src/app/(app)/orders/**`, `apps/web/src/app/(app)/queue/**`,
`apps/web/next.config.ts`, `apps/worker/src/**` (storage jobs, `ensureBucket` on start), `turbo.json`,
`packages/i18n/src/messages/{en,es}.json`, `apps/web/e2e/notes.spec.ts`, `docs/decisions.md`.

## Success criteria

1. **Targets:** a note can be created on an order, a line, a package and a quality issue of that order; a target
   from another order is refused with `errors.notes.targetMismatch`. A note with no text and no files is refused.
2. **Author rule:** the author can edit and delete their note; another Picker gets `FORBIDDEN`
   (`errors.notes.notAuthor`); an Admin succeeds. A note written on a station is authored by the unlocked user.
3. **Visibility:** a Picker or Packer creating or switching to `CUSTOMER` gets `FORBIDDEN`; QA, Shipper and Admin
   succeed.
4. Every `notes.*` procedure has an allowed and a forbidden test (a signed-out caller for reads; the rules above for
   writes).
5. **Frozen after push:** after `markNotePushed`, edit and delete fail with `errors.notes.alreadySent` for anyone,
   including Admin. `notesToPush` returns only notes without `wooNoteId`, oldest first, so calling it after marking
   all of them returns none.
6. **Upload limits:** a 16 MB file, a PDF renamed `.jpg`, an SVG, an 11th photo and a second voice memo are each
   refused with the right key, and nothing is written to storage or the database.
7. **Image processing:** a 4000×3000 JPEG with EXIF orientation 6 and GPS tags is stored as WebP, at most 2048 px on
   the long edge, upright, with no EXIF/GPS left, plus a 400 px thumbnail; the recorded width, height and size
   match the stored file.
8. **Atomicity:** if the note transaction fails after upload, the uploaded objects are deleted. An idempotent replay
   of `create` returns the same note and uploads nothing new.
9. **File deletion:** deleting a note enqueues one `storage.delete` job with all its keys in the same transaction
   (none if it rolls back); the job removes them and treats missing ones as done. The sweep deletes an unreferenced
   object older than 24 h and keeps a referenced one and a new one.
10. **Serving:** `/api/attachments/{id}` returns the bytes with the stored content type for a signed-in user,
    `401` signed out, `404` unknown; a `Range: bytes=0-99` request gets `206` with 100 bytes.
11. **Indicators:** queue rows, All Orders rows, and lines and packages in `getOrder` carry the right `noteCount`,
    and a page of 100 rows runs a constant number of queries.
12. **Storage adapter:** `S3Storage` passes the adapter test suite against `MemoryStorage` semantics, and a tagged
    live test against the dev RustFS (put, ranged get, list, delete, `ensureBucket` on a fresh bucket). Health shows
    `storage: "fail"` when the endpoint is down.
13. **E2E (tablet):** a picker adds a note to a line with a photo (fixture file) and a voice memo (fake media
    stream), sees the indicator on the line and the queue row, opens the photo in the lightbox and the audio loads;
    another user sees no Edit button on it; the picker deletes it and the indicator disappears.
14. **E2E (desktop):** QA writes a customer-visible note, sees the Customer badge, and edits it.
15. Green: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, plus the Playwright suite.

## Decisions (2026-10-20)

1. **Attachments are served through the app**, auth-checked per request, instead of presigned storage URLs. Storage
   stays off the network. Deviation from FR-NOTE-03, recorded in `docs/decisions.md`.
2. **Customer-visible notes need `note.customer`:** Admin, QA, Shipper.
3. **Internal notes are posted to WooCommerce once, as private notes**, text only, on ship (by `shipping`).
   Customer notes go as customer notes. `wooNoteId` makes both exactly-once; pushed notes are frozen.
4. **Dependencies:** `sharp` and `aws4fetch`.

## Assumptions (correct me if wrong)

1. Limits: 15 MB per file, 10 photos and 1 voice memo per note, voice memos up to 5 minutes, 4000 characters.
2. Photos are stored only as the resized WebP (2048 px); the original isn't kept.
3. Notes can be added in any order status and don't need a claim.
4. Deleting a note is a hard delete of the note and its files (the audit row keeps the text); no trash.

## Open questions

None.
