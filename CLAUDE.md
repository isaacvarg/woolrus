# Woolrus V2

Warehouse fulfillment for one WooCommerce store: import orders, pick, pack, QA, buy labels, ship.
Rebuild of v1 (kept at git tag `v1-legacy`; don't copy from it).

## Start every session here

1. Read [`SPEC.md`](SPEC.md): the capability map, the roadmap, the status table, and the project-wide commands,
   code style, testing strategy and boundaries. Those rules apply to all work.
2. Find the module to work on: the one the user names, or **next up** per `SPEC.md` (first module in roadmap order
   whose dependencies are `done`). On GitHub that's the first open `spec` issue, in milestone order, with no open
   blockers.
3. Load only what that module needs: its spec in `docs/specs/SPEC-<module-id>.md`, the SRS sections it cites in
   [`docs/srs.md`](docs/srs.md), and the code it touches. [`docs/decisions.md`](docs/decisions.md) is the
   authority when sources disagree.
4. If the module's spec issue has open tickets, continue with `/ticket` (no number picks the next unblocked one).
   It reads the `Done:` comments on the closed tickets it depends on before opening code.
5. When a ticket is done, `/ticket` comments a `Done:` note on it (2–3 lines: where the code landed, the helpers
   the next tickets should reuse, anything surprising) and closes it. It saves the next session from re-exploring.

## Work tracking (GitHub Issues)

Work is tracked on GitHub, mirroring `SPEC.md`:

- **Milestones** `M1`…`M5` are the roadmap milestones.
- **Spec issues** (`[spec] <module-id>: …`, labels `spec` + `module:<module-id>`): one per module, in its
  milestone. The body points at `docs/specs/SPEC-<module-id>.md`, which stays the source of truth; never copy the
  spec into the issue. Native "blocked by" links follow the roadmap order. Label `spec approved` once the spec is
  approved; close the issue when the module ships.
- **Tickets** are sub-issues of their spec issue: vertical slices, each with acceptance criteria and native
  "blocked by" links to the tickets that gate it. Give each one the `module:<module-id>` label and the milestone.

The `SPEC.md` status table stays the summary and links each module's spec issue.

## Workflow (agent-skills + Matt Pocock's skills)

Each module goes through gated phases. **Stop for the user's approval at the end of each phase.**

| Phase | Skill | Output |
|---|---|---|
| Specify | `/agent-skills:spec` | `docs/specs/SPEC-<module-id>.md`, status `spec draft` → `spec approved`, spec issue labelled `spec approved` |
| Tickets | `/to-tickets #<spec issue>` | ticket sub-issues with blocking links, status `planned` |
| Implement | `/ticket [n]` (the `/agent-skills:build` loop, one ticket per run) | code + tests, ticket closed with a `Done:` comment, status `in progress` |
| Review | `/agent-skills:review` | findings fixed |
| Ship | `/agent-skills:ship`, then a PR | status `done`; spec issue closed |

Use `/ticket`, not Matt's `/implement`: it keeps the agent-skills build loop. `/to-tickets` and Matt's other
tracker skills read the tracker setup written by `/setup-matt-pocock-skills`.

One module per branch and PR where practical (`<module-id>/<short-description>`). Each PR links to the spec
section it implements, lists the tickets it carries, closes its spec issue when the module ships (`Closes #<n>`),
and updates the status table in `SPEC.md`.

## Agent skills

### Issue tracker

GitHub Issues on `isaacvarg/woolrus` via `gh`: one spec issue per module, tickets as its sub-issues. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five default roles, each label string equal to its role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context, using the project's own docs (`docs/decisions.md`, `docs/srs.md`, `docs/specs/`); no `GLOSSARY.md`
or `docs/adr/`. See `docs/agents/domain.md`.

## Things that bite

- `.env` lives at the repo root and is loaded by every app; copy from `.env.example`.
- The v1 dev stack may be running (compose project `woolrus`, ports 5432/8080/9000). V2's is `woolrus-v2-dev` on
  5442/8090/9010. Never touch v1's containers or volumes.
- The local WooCommerce at :8090 accepts the fixed dev key in `.env.example` (a dev-only mu-plugin allows basic auth
  over HTTP). Magic-link sign-in prints the link in the web server log; `ADMIN_EMAILS` users become Admin.
- Prisma 7 generates the client into `packages/db/src/generated` (`pnpm db:generate`). The init migration ends
  with hand-written constraints that must survive any migration edits.
- Turborepo runs in strict env mode: a task only sees env vars declared in `turbo.json`.
- Next.js 16 differs from most training data. Before writing Next code, read the matching guide in
  `apps/web/node_modules/next/dist/docs/`. `agentRules: false` in `next.config.ts` stops `next dev` from
  generating `apps/web/AGENTS.md`; don't commit that file.
- TypeScript is pinned to 6.0.x on purpose (TS 7 isn't supported by the Next/Prisma tooling yet).
