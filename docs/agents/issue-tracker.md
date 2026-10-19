# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations. Only `/to-tickets`
reads this file; see *Agent skills* in `CLAUDE.md`.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --json number,title,body,labels,comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Make an issue a sub-issue of a parent**: `gh issue create --parent <parent> ...`, or `gh issue edit <parent> --add-sub-issue <child>` afterwards (`gh` 2.94+).
- **Blocking**: GitHub's native issue dependencies. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). A ticket is unblocked when every blocker is closed.
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.

## This repo

Work tracking mirrors `SPEC.md` (see *Work tracking* in `CLAUDE.md`):

- **Milestones** `M1`…`M5` are the roadmap milestones.
- **Spec issues**, one per module: titled `[spec] <module-id>: …`, labelled `spec` + `module:<module-id>`, in
  their milestone, with native "blocked by" links in roadmap order. The body points at
  `docs/specs/SPEC-<module-id>.md`, which stays the source of truth: never copy the spec into an issue.
  `spec approved` is added once the spec is approved; the issue closes when the module ships.
- **Tickets**: `/to-tickets #<spec issue>` publishes them as sub-issues of the spec issue. Give each one the
  `module:<module-id>` label, the spec issue's milestone and `ready-for-agent`.
- **Building a ticket**: use the project's `/ticket` command, not `/implement`. It runs the agent-skills build
  loop, then comments a `Done:` note on the ticket and closes it.
