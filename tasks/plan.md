# Implementation Plan: `workflow`

Spec: [`docs/specs/SPEC-workflow.md`](../docs/specs/SPEC-workflow.md) · Branch: `workflow/state-machine` ·
Tasks: [`todo.md`](todo.md)

## Overview

Make order status server-owned. Core gets a pure state machine and gates, one transition function (locking,
claims, stage events, audit, notify), claims with lazy expiry, queue/order reads, and priority rules. The API
exposes them as thin oRPC routes. The web app gets queues, All Orders, order detail, a priority-rules admin page
and live updates over SSE. Two columns are added (`Settings.claimExpiryMinutes`, `Product.physical`).

## Architecture decisions

- **Pure core first.** `machine.ts` (transition table) and `priority.ts` (`computePriority`) are pure and unit-tested.
  Gates take already-loaded rows (`evaluateGate(kind, snapshot)`), so the rules are pure too. A thin
  `loadGateSnapshot(tx, orderId)` does the I/O. This keeps the exhaustive tests fast and makes the integration tests
  about locking and persistence.
- **One `transition()` for every move.** The public functions (`beginPicking`, `hold`, …) only choose the kind.
  Locking is `SELECT … FOR UPDATE` plus a `version` check, so concurrent writers serialize and the loser gets
  `errors.workflow.stale`.
- **Claims share the transition's locking and audit.** But they don't write stage events, and expiry is computed at
  read time (`isClaimLive(order, settings, now)`), so no cleanup job is needed.
- **`allowedActions` is computed in core** from the machine, the actor's permissions and the claim. The UI renders
  only those buttons, and the server re-checks everything anyway.
- **Notify inside the transaction** (`pg_notify` via `$executeRaw`), so events fire only on commit. The web process
  holds one dedicated `pg` client for `LISTEN` (not the Prisma pool) and fans out to SSE subscribers in memory.
- **Test fixtures:** a `packages/core/test/factories.ts` builder (`orderFactory(db, { status, lines, packages,
  labels })`) is used by gate, transition, claim and query tests, and by the perf benchmark.
- **Routes stay one line.** Permission and gate tests live in core integration tests (as for `settings`).
  Contracts get schema tests for the tricky inputs (rule conditions, transition inputs).

## Dependency graph

```
T1 schema + factories ─┬─ T2 claimExpiry setting
                       ├─ T3 machine ── T4 gates ── T5 transition engine ─┬─ T6 hold/cancel/force/repack/ship
                       │                                                  ├─ T7 claims
                       │                                                  └─ T8 orders contract + router (mutations)
                       │                                                         └─ T9 SSE live (risk spike)
                       ├─ T10 queue reads ── T11 detail/history/all-orders reads
                       │        └─ T12 demo seed
                       │              ├─ T13 nav + queue pages ── T14 order detail page ── T15 All Orders page
                       │              └─ T19 client live invalidation (needs T9, T13)
                       └─ T16 priority evaluator ── T17 rules service + job ── T18 rules admin UI
T20 e2e + perf benchmark (needs all)
```

## Phases

1. **Foundation (T1–T4):** schema, setting, machine, gates. Pure logic proven exhaustively.
2. **Transitions and claims (T5–T9):** every mutation works through the API, and the risky SSE piece is proven
   early.
3. **Reads and UI (T10–T15):** queues, detail, All Orders, usable with seeded demo orders.
4. **Priority (T16–T18):** rules, recompute, admin UI.
5. **Live and finish (T19–T20):** client live refresh, e2e, the performance check, and a spec/status update.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| SSE + `LISTEN` inside Next.js route handlers (long-lived connections, dev HMR, one listener per process) | High | Spike it in T9 right after the mutations exist. Keep the fallback (30 s polling) so the UI never depends on it. Close the listener on `SIGTERM`. |
| Deadlocks in `claimMany` / concurrent transitions | Med | Lock rows in id order. A real-concurrency test with two Prisma clients. |
| Gate logic drifting from what picking/packing/qa will write | Med | Gates read only existing columns. The `factories.ts` shapes become the reference that stage modules' tests reuse. |
| Queue query under 1 s at 2,000 orders (search with `ILIKE` on customer name) | Med | Use the existing `(status, priority, orderedAt)` index and keyset paging. Benchmark in T20. If it's slow, add a `pg_trgm` index, which needs approval (migration). |
| New dependency for `LISTEN` | Low | `pg` is already present via `@prisma/adapter-pg`. Use it directly; if it isn't a direct dependency of `apps/web`, adding it is an ask-first change, so ask in T9. |
| Migration touching the init's hand-written constraints | Low | A new migration only adds columns; `migrate:check` runs in T1. |

## Open questions

- Is Rush Order marked Virtual in WooCommerce? (Spec open question 1; it only affects `store-sync`. The demo seed
  sets `physical = false` directly.)
