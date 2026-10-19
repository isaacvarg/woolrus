---
description: Build one GitHub ticket with the agent-skills build loop (TDD, verify, commit), then record it on the issue
argument-hint: "[issue number] (omit for the next unblocked ticket)"
---

Implement one ticket from GitHub Issues. The build itself is exactly `/agent-skills:build` (single-task
mode); this command only replaces `tasks/todo.md` with the issue tracker. Use `gh` for every GitHub call;
`{owner}/{repo}` is inferred from the clone. Use the REST endpoints below: they expose sub-issues and
native "blocked by" links, which `gh issue view` does not.

## 1. Pick the ticket

- `$ARGUMENTS` is an issue number (with or without `#`): use it.
- Empty: find the **frontier**. Take the open `spec` issue labelled `spec approved` that comes first in
  milestone order (`gh issue list --label spec --label "spec approved" --state open --json number,milestone`).
  List its sub-issues (`gh api repos/{owner}/{repo}/issues/<spec>/sub_issues`), keep the open ones with no
  assignee and `issue_dependencies_summary.blocked_by == 0`, and take the first in sub-issue order.
  If none qualifies, say why (all done, all claimed, all blocked) and stop.

## 2. Check it can start

Read the ticket (`gh api repos/{owner}/{repo}/issues/<n>`) and stop with the reason if any check fails:

- It is open and is not itself a `spec` issue.
- Its parent (`gh api repos/{owner}/{repo}/issues/<n>/parent`) is a `spec` issue labelled `spec approved`.
- Every blocker (`gh api repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by`) is closed.
- It is unassigned, or assigned to the current user (a resumed ticket).

State the ticket's number and title before going further.

## 3. Load context

Follow "Start every session here" in `CLAUDE.md`, scoped to this ticket:

- The module spec linked from the parent issue, and the SRS sections and decisions it cites.
- The `Done:` comments on the ticket's closed blockers and on the module's other closed tickets
  (`gh api repos/{owner}/{repo}/issues/<n>/comments`). Read them before opening code.

## 4. Claim and branch

- `gh issue edit <n> --add-assignee @me`.
- Work on the module's branch, `<module-id>/<short-description>`. If one exists for the module, switch to it;
  if you're on `main`, create it. Run `git status --porcelain` first and stop if there is unrelated work.

## 5. Build

Invoke the agent-skills:incremental-implementation skill alongside agent-skills:test-driven-development and
run the `/agent-skills:build` single-task loop with the ticket's **What to build** and **Acceptance
criteria** as the task:

1. Write a failing test for the expected behaviour (RED).
2. Implement the minimum code to pass it (GREEN).
3. Run the full test suite to check for regressions, then the build. Green is defined in `SPEC.md`.
4. Commit only the files this ticket touched, with `Refs #<n>` in the message.

If a step fails, follow agent-skills:debugging-and-error-recovery. If the spec is ambiguous, or the ticket is
high-risk or irreversible (auth, permissions, secrets, destructive migrations), stop and ask, as
`/agent-skills:build` does.

## 6. Record and close

- Comment on the ticket with its `Done:` note (2–3 lines): where the code landed, the helpers the next tickets
  should reuse, and anything surprising. Start the comment with `Done:` so the next session can find it.
- Close it: `gh issue close <n> --reason completed`. The commit is on the module branch; the module's PR
  lists the tickets it carries. If that PR is abandoned, reopen them.
- Report the next frontier ticket (step 1, empty case), or say the module's tickets are all closed and
  `/agent-skills:review` is next. Then stop: one ticket per run.
