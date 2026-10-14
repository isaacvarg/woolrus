# Woolrus V2

Warehouse fulfillment for one WooCommerce store: import orders, pick, pack, QA, buy labels, ship.
Rebuild of v1 (kept at git tag `v1-legacy`; don't copy from it).

## Start every session here

1. Read [`SPEC.md`](SPEC.md): the capability map, the roadmap, the status table, and the project-wide commands,
   code style, testing strategy and boundaries. Those rules apply to all work.
2. Find the module to work on: the one the user names, or **next up** per `SPEC.md` (first module in roadmap order
   whose dependencies are `done`).
3. Load only what that module needs: its spec in `docs/specs/SPEC-<module-id>.md`, the SRS sections it cites in
   [`docs/srs.md`](docs/srs.md), and the code it touches. [`docs/decisions.md`](docs/decisions.md) is the
   authority when sources disagree.
4. If `tasks/plan.md` / `tasks/todo.md` exist, they belong to the module in progress — continue from the first
   unchecked task.

## Workflow (addyosmani/agent-skills)

Each module goes through gated phases. **Stop for the user's approval at the end of each phase.**

| Phase | Skill | Output |
|---|---|---|
| Specify | `/agent-skills:spec` | `docs/specs/SPEC-<module-id>.md`, status `spec draft` → `spec approved` |
| Plan + tasks | `/agent-skills:plan` | `tasks/plan.md`, `tasks/todo.md`, status `planned` |
| Implement | `/agent-skills:build` (TDD, one task at a time) | code + tests, status `in progress` |
| Review | `/agent-skills:review` | findings fixed |
| Ship | `/agent-skills:ship`, then a PR | status `done`; `tasks/` cleared for the next module |

One module per branch and PR where practical (`<module-id>/<short-description>`). Each PR links to the spec
section it implements and updates the status table in `SPEC.md`.

## Things that bite

- `.env` lives at the repo root and is loaded by every app; copy from `.env.example`.
- The v1 dev stack may be running (compose project `woolrus`, ports 5432/8080/9000). V2's is `woolrus-v2-dev` on
  5442/8090/9010. Never touch v1's containers or volumes.
- The local WooCommerce at :8090 accepts the fixed dev key in `.env.example` (a dev-only mu-plugin allows basic auth
  over HTTP). Magic-link sign-in prints the link in the web server log; `ADMIN_EMAILS` users become Admin.
- Prisma 7 generates the client into `packages/db/src/generated` (`pnpm db:generate`). The init migration ends
  with hand-written constraints that must survive any migration edits.
- Turborepo runs in strict env mode: a task only sees env vars declared in `turbo.json`.
- TypeScript is pinned to 6.0.x on purpose (TS 7 isn't supported by the Next/Prisma tooling yet).
