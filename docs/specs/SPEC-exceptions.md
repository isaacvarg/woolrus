# Spec: `exceptions`

**Milestone:** M3 · **Depends on:** `workflow` (locks, gates, priority recompute, live updates), `notes` (evidence on
issues), `picking` (`reconcilePick`), `packing` (unpacking a voided unit) · **Used by:** `qa` (reads open critical
issues; embeds the report and void dialogs), `shipping` (links a label to an issue when a repack follows),
`returns` (RMAs hang off an issue), `reporting` (void and issue data, FR-QI-07) · **State:** spec approved ·
**Issue:** [#25](https://github.com/isaacvarg/woolrus/issues/25)

Project-wide commands, structure, code style, testing levels and boundaries are in [`../../SPEC.md`](../../SPEC.md);
this spec only adds what is specific to `exceptions`.

## Objective

Give the floor a way to say "this didn't go right" and give the admin a place to deal with it. Anyone can take a
line, or part of one, out of an order with a reason (a void), and the order carries on without it. Anyone can report
a quality issue with a type, a severity and photos. An admin works through the unresolved voids (after fixing them
in WooCommerce) and the open issues, and everything is recorded with who, where in the process and why.

- **SRS:** FR-VOID-01…06, FR-QI-01…06, FR-QI-08. Fixes SRS §7.1 #1 for these actions (every void and issue action
  is checked on the server) and #11's loss of voids and issues (they hang off the order line, which is no longer
  rewritten). **Not here:** FR-VOID-07 (refund or edit the line in WooCommerce), FR-QI-07 (dashboard,
  `reporting`), and the QA gate on open critical issues (FR-QA-05, `qa`).
- **Users:** every role voids and reports (`void.create`, `issue.report`). Admins resolve and delete
  (`void.resolve`, `issue.resolve`, `issue.delete`). Everyone with `order.read` sees the lists.
- **Why now:** `picking` can mark a line Out of Stock but the only way out is a void, and `packing` shows
  "too many in #2" for an over-packed line that only a void can cause. Both are waiting on this module.

### User stories

1. As a picker, a jar is out of stock. On its card I tap **Void**, choose 1 of 3, pick the reason "Out of stock"
   and confirm. The card shows 2 to pick, and when those are picked **Complete picking** appears.
2. As a packer, a customer-written note says "remove the candle". I void the candle from the unassigned items. If it
   was already in a box, it comes out of that box and the box is flagged to re-weigh.
3. I void the wrong line. While nobody has dealt with it in WooCommerce I tap **Undo void** and the line is whole
   again (back in Unassigned, back to Pending on the pick screen).
4. As an admin, I open **Voids** and see orders with unresolved voids: what was removed, why, by whom, at which
   stage. I fix the order in WooCommerce, then mark the voids resolved with a note ("Refunded $14 in Woo").
5. Someone voids every line of an order. The order shows a banner "Every item is voided" and can't leave its
   stage. The admin cancels it.
6. As QA, I find a crushed corner on a box. I report **Packaging damage**, severity Major, add two photos and a
   voice memo. The issue records that it was found in QA and that it started in Packing, and names the packer as
   responsible.
7. As QA, I change the responsible person because the box was packed by someone else.
8. As a shipper, a customer emails that the wrong scent arrived. From the Completed order I report a
   **customer-reported** Wrong item issue.
9. As an admin, I open **Issues**, filter to Open, read the notes and photos, and resolve the issue with a note.
   Only admins can resolve or delete one (FR-QI-08); everyone else can report and edit their own. A deleted issue
   takes its notes and files with it.

## Scope

**In:**
- Voids in core: void (whole or partial quantity), undo, resolve. The side effects that keep the rest of the system
  true: unpack the voided units, reconcile the pick, recompute priority, and the all-voided rule.
- Quality issues in core: report, edit, change the responsible user, resolve or dismiss, reopen, delete, list, and
  the helpers other modules call.
- Gates: **picked**, **packed** and **verified** learn the all-voided rule (an edit to `workflow`'s gates, made
  here). `activeQuantity` is clamped at 0.
- UI: **Voids** page, **Issues** page, void and report dialogs reused on the pick screen, pack screen and order
  detail, a voids and issues panel on the order detail, badges on queue rows, nav entries with counts.
- Schema: one index. Listed under *Schema additions*.

**Out (owned elsewhere or later):**
- Refunding or editing the line in WooCommerce from a resolved void (FR-VOID-07). Resolving only *records* what the
  admin did there. The `REFUNDED` / `LINE_EDITED` resolutions and `wooRefundId` already exist in the schema, for
  the module that adds the call.
- Blocking QA → Ready, and flagging items in QA, on an open critical issue: `qa` (FR-QA-05), using
  `openCriticalIssues` below.
- Setting `labelId` and `triggeredRepack` as part of a repack: `shipping` calls `linkIssueToRepack`. The data and
  the helper exist now (FR-QI-06 is "data only").
- Quality dashboard and CSV export (FR-QI-07): `reporting`. Creating RMAs from an issue: `returns`.
- Telling the customer about a void: nothing is sent to WooCommerce from here; the admin does it there.

## Design

### Vocabulary

- **Active quantity** of a line = `quantity − Σ quantity of its ItemVoids that aren't undone`, never below 0
  (`workflow/gates.ts` already defines it; the clamp is new, so a store-sync quantity cut below the voided total
  can't produce a negative).
- A void is **open** until it is undone or resolved. **Unresolved** means open and `resolvedAt` is null.
- **Stage of an action** (`stageFor(order)`): `PENDING → INTAKE`, `PICKING → PICKING`, `PACKING → PACKING`,
  `QA → QA`, `READY → SHIPPING`, `COMPLETED → CUSTOMER`; `ON_HOLD` uses `heldFromStatus`. Stored in
  `ItemVoid.stage` and `QualityIssue.discoveredStage`; the actor never types it.

### Void rules (`packages/core/src/exceptions/voids.ts`)

| Function | Input | Rule |
|---|---|---|
| `voidItem` | `orderId`, `orderItemId`, `quantity`, `reason` | `void.create`. Order is not COMPLETED or CANCELLED and has **no live label** (`errors.voids.liveLabels`: repack first). The line belongs to the order. `1 ≤ quantity ≤ active quantity` (`errors.voids.quantity`). Reason 1–500 characters after trim. Non-physical lines (Rush Order) can be voided. |
| `undoVoid` | `voidId` | `void.create`. The void is open and unresolved (`errors.voids.alreadyResolved` / `alreadyUndone`), the order is not COMPLETED or CANCELLED and has no live label. Sets `undoneAt`, `undoneById`. |
| `resolveVoids` | `voidIds` (1–50), `resolution`, `notes` | `void.resolve`. Every void is open and unresolved. Order status doesn't matter (Completed orders get resolved too). Notes required, 1–1000 characters. `resolution` is `HANDLED_MANUALLY`, `REFUNDED` or `LINE_EDITED`: *what the admin did in WooCommerce by hand*. `wooRefundId` stays null. All or nothing. |

Voiding needs no claim: any stage can void (FR-VOID-01), and a void is a correction to the order, not stage work.
It does refresh the holder's claim if the actor is the holder (`touchClaim`).

**One transaction per use case.** `voidItem` and `undoVoid`, in order:
1. `lockOrder` (`FOR UPDATE`): serialises with transitions, claims, packing and other voids, so two people voiding
   the last 2 units of a line can't both succeed.
2. Check the rules above; insert or update the `ItemVoid`.
3. **Unpack** (`voidItem` only): if the line's packed total now exceeds its active quantity, remove the excess from
   its `PackageItem`s, highest package number first, and call packing's `invalidate` on each touched package
   (weight kept and flagged to re-weigh; rates deleted; QA verification cleared, so a repack cycle stays safe). A
   package left empty stays: the packer decides. The packed gate reports it as it does today.
4. `reconcilePick(tx, itemId)` (picking's contract) on every void and undo.
5. `recomputePriorities(tx, { orderIds: [orderId] })` (workflow's contract). A voided Rush Order line stops making
   the order Urgent, and an undo brings it back.
6. `recordAudit` (`void.create`, `void.undo`, `void.resolve`; before/after in the payload), then
   `notifyOrderChanged` so queues and open screens refresh. `Order.version` is **not** bumped (the order's status
   didn't change; the same rule packing follows), so a void never makes a stale-version error for someone else.

`undoVoid` does **not** put units back in boxes: they return to Unassigned and the packed gate asks the packer to
pack them again. A line whose pick was reconciled to `PICKED` goes back to `PENDING` through `reconcilePick`.

### All-voided rule (FR-VOID-05)

An order is **all voided** when it has at least one line and every line has active quantity 0. The **picked**,
**packed** and **verified** gates add the unmet condition `allVoided` (`errors.workflow.allVoided`) when it holds,
so `completePicking`, `completePacking` and `completeQa` all refuse, and today's vacuous pass (no active lines → no
unmet conditions) can't move an empty order forward. `hold`, `cancel` and `forceStatus` are unaffected: the admin
cancels, or undoes a void. An order with a non-physical line left (Rush Order only) is not all voided; it keeps
today's behaviour. `OrderDetailDto` gets `allVoided: boolean`, which the UI turns into the banner.

### Quality issue rules (`packages/core/src/exceptions/issues.ts`)

| Function | Input | Rule |
|---|---|---|
| `reportIssue` | `orderId`, optional `orderItemId`, `packageId`, `type`, `severity`, `description`, optional `originStage`, `customerReported` | `issue.report`. Order is not CANCELLED. The line and the package must belong to the order. `customerReported` needs the order to be READY or COMPLETED (FR-QI-04) and sets `discoveredStage = CUSTOMER`; otherwise the order must not be COMPLETED and `discoveredStage = stageFor(order)` (FR-QI-02). Description 1–2000 characters. `responsibleUserId` is inferred (below). |
| `updateIssue` | `issueId`, any of `type`, `severity`, `description`, `originStage`, `orderItemId`, `packageId` | Reporter or `issue.resolve`. Only while `OPEN`. Re-infers the responsible user when `originStage` or the line changes *and* the responsible user was inferred rather than chosen. |
| `setResponsible` | `issueId`, `userId \| null` | Reporter or `issue.resolve` (FR-QI-03). The user must exist and be active. Marks the choice as manual. |
| `resolveIssue` | `issueId`, `outcome: "RESOLVED" \| "DISMISSED"`, `notes` | `issue.resolve` (FR-QI-05). Only while `OPEN`. Notes required (1–1000). Sets `status`, `resolutionNotes`, `resolvedById`, `resolvedAt`. |
| `reopenIssue` | `issueId` | `issue.resolve`. `RESOLVED` or `DISMISSED` → `OPEN`; clears the resolution fields; the old resolution notes are copied into an internal note on the issue first, so nothing is lost. |
| `deleteIssue` | `issueId` | `issue.delete` (Admin only, FR-QI-08, §7.1 #1). Deletes the row and cascades its notes; the stored files are deleted through the same job `notes` uses (`notes/files.ts`), enqueued in the same transaction. Audited with a snapshot of the issue. |
| `linkIssueToRepack` | `(tx, actor, { issueId, labelId })` | **Not routed**; for `shipping`. Sets `labelId` and `triggeredRepack = true` (FR-QI-06). The label must belong to the issue's order. |

**Inferring the responsible user (FR-QI-03).** From `originStage`, using data that already exists:
- `PICKING` → the line's `pickedById`, else the actor of the latest `OrderStageEvent` into `PACKING`.
- `PACKING` → the actor of the latest event into `QA`.
- `QA` → the actor of the latest event into `READY`.
- Any other origin, or no such record → `null`.
A system actor or a deactivated user is skipped (null). The UI shows the inferred name, with **Change**.

**Evidence (FR-QI-01).** Photos and voice live in `notes` with `qualityIssueId` set; this module adds nothing to
upload. The report dialog creates the issue, then offers the existing `NoteComposer` for it ("Add photos or a voice
memo", skippable). Resolving or dismissing an issue doesn't close its notes: anyone can still add one.

**Helpers for other modules** (`exceptions/queries.ts`, tested here):
- `openCriticalIssues(tx, orderId)` → `{ id, orderItemId, packageId, type }[]` for `OPEN` and `CRITICAL`.
- `hasOpenCriticalIssue(tx, orderId)`. `qa` builds its gate and its per-item flag (FR-QA-05) on these.

### Reads

- `voids.list({ status: "unresolved" \| "resolved" \| "all", search?, cursor?, limit })`: grouped by order. Each
  group has the order (number, customer, status), and its voids (line name and SKU, quantity, reason, stage, who,
  when, undone/resolved state). Newest first; search by order-number prefix or customer. `voids.counts()` →
  orders with unresolved voids, for the nav.
- `issues.list({ status: "all" \| "open" \| "resolved", severity?, type?, orderId?, search?, cursor?, limit })`
  (FR-QI-05; `resolved` includes dismissed). Rows carry type, severity, status, order number, line or package
  label, discovered and origin stage, reporter, responsible, age, note count. Critical open first, then newest.
  `issues.get({ issueId })` adds the description, resolution, and the order link.
- `OrderDetailDto` gains `voids` (all, with state) and `issues` (all, brief). Queue rows gain
  `openIssueCount`, `topOpenSeverity` and `unresolvedVoidCount`, computed in the existing queue query with one
  grouped subquery each (the 2,000-order benchmark in workflow must still pass).
- All reads need `order.read`. Notes on an issue are read through `notes.list`.

### API (oRPC, `packages/contracts/src/voids.ts`, `issues.ts`)

| Procedure | Route |
|---|---|
| `voids.void` | `POST /orders/{orderId}/voids` |
| `voids.undo` | `POST /voids/{voidId}/undo` |
| `voids.resolve` | `POST /voids/resolve` |
| `voids.list` / `voids.counts` | `GET /voids`, `GET /voids/counts` |
| `issues.report` | `POST /orders/{orderId}/issues` |
| `issues.update` | `PATCH /issues/{issueId}` |
| `issues.setResponsible` | `POST /issues/{issueId}/responsible` |
| `issues.resolve` / `reopen` | `POST /issues/{issueId}/resolve`, `…/reopen` |
| `issues.delete` | `DELETE /issues/{issueId}` |
| `issues.list` / `get` / `counts` | `GET /issues`, `GET /issues/{issueId}`, `GET /issues/counts` |

`voids.void` returns the updated line (`quantity`, `activeQuantity`, `pickStatus`, packed total) and the new void,
so the pick and pack screens update in one round trip. Error keys live under `errors.voids.*`, `errors.issues.*`;
no literal English.

### Schema additions (ask-first: listed here for approval)

One migration, no new tables, no new permissions (the five exist and already map to the right roles), no settings:
- `@@index([orderItemId])` on `ItemVoid`: every gate, queue row and pick screen sums a line's voids; today only
  `orderId` is indexed.
- `@@index([orderId, status])` on `QualityIssue`: the per-order open-issue lookups behind the badges and
  `hasOpenCriticalIssue`.
- `QualityIssue.responsibleManual Boolean @default(false) @map("responsible_manual")`: true once a person chose the
  responsible user, so editing the origin stage doesn't overwrite it.

The init migration's hand-written constraints (including `item_voids_quantity_positive`) stay. The rule that open
voids can't exceed a line's quantity spans rows, so it's enforced in the service under the order lock and covered
by a concurrency test, not by a constraint.

### UI (`apps/web/src/app/(app)/`)

- **Components** (`components/exceptions/`): `VoidDialog` (line, quantity stepper defaulting to the whole active
  quantity, reason chips "Out of stock", "Damaged", "Customer request", "Other" over a text field, confirm),
  `ReportIssueDialog` (type, severity, description, discovered stage shown read-only, origin stage select, and
  customer-reported checkbox on Ready and Completed orders, then the notes composer), `IssueCard`, `VoidRow`.
  They take callbacks, so `qa` embeds them on its screen without changes.
- **Pick screen:** each line's menu gains **Void** (the way out of Out of Stock, and the OOS banner links to it),
  **Report issue**. **Pack screen:** the same on unassigned items, **Report packaging issue** on a package. A void
  that empties the order shows the all-voided banner and hides **Complete**.
- **`orders/[id]`:** lines show voided quantity ("1 of 3 voided: out of stock", **Undo** while unresolved), an
  **Exceptions** panel with voids and issues (open first), **Void** and **Report issue** buttons, the all-voided
  banner. The page follows SSE like the rest.
- **`voids`:** orders with unresolved voids, a select checkbox per void, **Resolve** opens a dialog (outcome select,
  required note) for the selected or all of an order's voids. Tabs: Unresolved / Resolved. Admin sees the buttons;
  others read.
- **`issues`:** filter bar (All / Open / Resolved, severity, type), table, row opens a drawer with the description,
  facts, `NoteList`, **Resolve / Dismiss / Reopen**, **Change responsible**, and **Delete** (Admin only, with a
  confirmation). Open Critical rows are red with an icon and the word, not colour alone.
- **Nav:** **Voids** (count of orders with unresolved voids) and **Issues** (count open, a red dot when any is
  critical), under All Orders. **Queue rows:** a small badge for open issues (severity icon) and a void icon.
- Tablet-sized targets (NFR-UX-01), React Aria dialogs, `en` and `es` strings, toasts for results (NFR-UX-04).

### Dev data

`seedDemoOrders` gains: an order with a partial void (1 of 3) unresolved, one fully voided order, one resolved
void, an open Critical issue with a note, a customer-reported issue on a Completed order and a resolved one.

### Files expected to change

`packages/core/src/exceptions/{voids,issues,queries,stage}.ts` (+ tests), `packages/core/src/workflow/{gates,detail,queries}.ts`
(all-voided, clamp, DTO fields, row badges), `packages/core/src/packing/service.ts` (export `invalidate`),
`packages/core/src/index.ts`, `packages/core/src/permissions.test.ts` (no new permission; assertion coverage),
`packages/core/test/factories.ts`, `packages/contracts/src/{voids,issues,orders,index}.ts`,
`apps/web/src/server/router.ts`, `apps/web/src/components/exceptions/**`,
`apps/web/src/app/(app)/{voids/**,issues/**,pick/**,pack/**,orders/[id]/**,queue/**,queue-nav.tsx}`,
`packages/db/prisma/schema/{orders,quality}.prisma` + one migration, `packages/db/prisma/seed.ts`,
`packages/i18n/src/messages/{en,es}.json`, `apps/web/e2e/exceptions.spec.ts`, `SPEC.md` status.

## Success criteria

1. **Void rules (FR-VOID-01, 02, 06):** voiding 1 of 3 leaves active quantity 2 and records one `ItemVoid` with
   the stage of the order; a second void of 2 leaves 0; a third is refused (`quantity`). Quantity 0, negative,
   above active, a line from another order, an empty reason, a COMPLETED or CANCELLED order, and an order with a
   live label are each refused and change nothing. Allowed from Pending, Picking, Packing, QA, Ready (no label) and
   On Hold, by any role, with no claim.
2. **Undo (FR-VOID-03):** an open, unresolved void is undone and the line is whole again; an undone or resolved
   void can't be undone; the order is locked out as in 1.
3. **Concurrency:** two simultaneous voids of the last 2 units of a line (1 each, then 2 each) never leave the
   line with a negative active quantity; a void racing `completePicking` either lands first (and the gate sees it)
   or second (and the transition has already happened), never both half.
4. **Unpack:** a line of 6 with 4 in Package 1 and 2 in Package 2, voided by 3, ends with 3 packed in total: 1
   left in Package 1 and 0 in Package 2 (excess taken from the highest package first). Touched packages are flagged to re-weigh,
   their rates are gone and their items' QA verification is cleared. A package left empty remains. Undo returns
   the units to Unassigned, not to a box.
5. **Pick reconcile:** voiding the missing units of an `OUT_OF_STOCK` line turns it `PICKED` and the **picked** gate
   passes; undo returns it to `PENDING`. The five `reconcilePick` cases are exercised through `voidItem` /
   `undoVoid`, not only directly.
6. **Priority:** voiding a Rush Order line drops the order out of Urgent; undoing it restores Urgent.
7. **All voided (FR-VOID-05):** voiding every line makes `completePicking`, `completePacking` and `completeQa`
   fail with `allVoided` (each from its own stage), the detail DTO says `allVoided: true`, cancel and hold still
   work, and undoing one void clears it. An order whose only other line is non-physical is not all voided.
8. **Resolve (FR-VOID-04):** an Admin resolves several voids across orders in one call; one already-resolved or
   undone void makes the whole call fail and changes nothing; a note is required; a Picker is forbidden. A
   resolved void can't be undone. `wooRefundId` stays null.
9. **Lists:** `voids.list` shows orders with unresolved voids, newest first, searchable by order prefix, and
   `counts` agrees; `issues.list` filters All / Open / Resolved (dismissed counts as resolved), by severity and by
   type, and puts open Critical first.
10. **Report (FR-QI-01, 02, 04):** every type and severity is accepted; discovered stage comes from the order
    status; a line or package from another order is refused; `customerReported` is accepted on Ready and
    Completed and refused on Packing; a non-customer report on a COMPLETED order is refused; a CANCELLED order
    refuses all.
11. **Responsible (FR-QI-03):** origin Picking → the line's picker; Packing → who completed packing; QA → who
    completed QA; none recorded → null. Changing the origin re-infers unless a person chose; `setResponsible`
    accepts an active user and rejects an unknown or deactivated one.
12. **Resolve and delete (FR-QI-05, 08):** resolve and dismiss need notes and an Admin; a QA user's resolve and
    delete are forbidden; reopen restores `OPEN` and keeps the old resolution text as an internal note; only
    `OPEN` issues can be edited or resolved; delete removes the issue, its notes and its stored files.
13. **Repack link (FR-QI-06):** `linkIssueToRepack` sets the label and `triggeredRepack`, and refuses a label from
    another order.
14. **QA helpers:** `openCriticalIssues` and `hasOpenCriticalIssue` count only `OPEN` + `CRITICAL`, per order.
15. **Recording:** every write records one audit event with before/after and emits `order_changed`;
    `Order.version` is unchanged by voids and issues.
16. **Permissions:** every procedure has an "allowed" and a "forbidden" test through `/api/v1` (unauthenticated is
    `UNAUTHORIZED`, a role without the permission is `FORBIDDEN`, and a forbidden caller learns nothing about the
    order).
17. **Performance:** `voids.void` and `issues.report` server time under 300 ms p95 in an integration benchmark;
    `orders.queue` with 2,000 open orders (some with voids and issues) still under 1 s p95 (NFR-PERF-01).
18. **E2E (desktop + tablet):** a picker marks a line Out of Stock, voids the missing units from the banner and
    completes picking → a packer packs and voids one boxed unit, sees the re-weigh flag → QA reports a Major
    packaging issue with a photo → an admin sees **Voids** and **Issues** counts, resolves the void with a note and
    resolves the issue → an all-voided order shows the banner and its **Complete** is hidden → a QA user doesn't
    see **Delete**; an admin deletes an issue.
19. Green: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` plus Playwright.

## Assumptions (correct me if wrong)

1. Voids are an order correction, not stage work: no claim is needed and the order's `version` doesn't change.
2. A void is refused while the order has a live label; the way past is **Repack** (`shipping`), which voids the
   labels. Until `shipping` exists nobody reaches Ready with a label, so this only matters from M4.
3. Resolving a void records what the admin did in WooCommerce by hand. Nothing is sent to WooCommerce, and the
   customer isn't told from here.
4. Evidence on a quality issue is a note with photos and a voice memo (`notes`); no separate evidence table.
5. "Responsible" is inferred from the stage events and `pickedById` that already exist; packing has no per-item
   packer, so Packing means whoever completed packing.
6. Dismissed is a resolved outcome ("not actually an issue"), shown under Resolved.
7. Anyone with `void.create` can undo an unresolved void, not only its author; the audit shows who did what.
8. Voiding a non-physical line (Rush Order) is allowed and counts as the order's void.

## Decisions (2026-10-26)

1. **Woo refund (FR-VOID-07):** out. Resolving a void only records how the admin handled it in WooCommerce.
2. **Voids and labels:** a void or undo is refused while the order has a live label; repack first.
3. **Who and when:** every floor role can void and report in any non-terminal stage; Admin resolves voids and
   issues and alone deletes issues; customer-reported issues come from Ready or Completed orders.
4. **Critical issues:** this module only exposes `hasOpenCriticalIssue` / `openCriticalIssues`; `qa` adds the gate.

## Open questions

None open. Corrections to the assumptions above are welcome before approval.
