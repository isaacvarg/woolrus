# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo keeps its domain docs under `docs/`, not in a `GLOSSARY.md` or `docs/adr/`. Single-context: one
domain (warehouse fulfillment); the pnpm packages are layers of one app, not separate contexts.

## Before exploring, read these

- **`SPEC.md`** at the repo root: capability map, roadmap, status table and project-wide rules.
- **`docs/decisions.md`**: the agreed architecture. It is the authority when sources disagree.
- **`docs/specs/SPEC-<module-id>.md`**: the spec of the module you're working in.
- **`docs/srs.md` §1 *Definitions***: the glossary. Also §4 *Data model* for the entities, and the SRS
  sections the module spec cites.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use
the term as defined in SRS §1 *Definitions* (Order, Line item, Package, Box, Workflow status, Void, Quality issue,
Rate / Label) and the module ids from `SPEC.md`. Don't drift to synonyms.

If the concept you need isn't defined yet, that's a signal: either you're inventing language the project doesn't
use (reconsider) or there's a real gap. Propose a row for SRS §1 *Definitions* rather than creating a
`GLOSSARY.md`.

## Flag decision conflicts

If your output contradicts `docs/decisions.md`, surface it explicitly rather than silently overriding:

> _Contradicts decisions.md § Data model (notes remember `wooNoteId`), but worth reopening because…_

New decisions are proposed for `docs/decisions.md`, not written to a `docs/adr/` folder. Per `SPEC.md`
*Boundaries*, changing `docs/decisions.md` needs the user's approval first.
