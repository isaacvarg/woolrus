---
name: build-spec
description: Build every ticket of one spec issue unattended. Each unblocked ticket gets its own parallel session running /ticket, each finished branch is merged into the module branch, newly unblocked tickets start next, and it ends ready for /agent-skills:review.
argument-hint: "<spec issue URL or number>, e.g. https://github.com/isaacvarg/woolrus/issues/32"
disable-model-invocation: true
---

You orchestrate. You don't build tickets yourself. Each ticket is built in its own session, and you
merge the results. The user has walked away: don't stop to ask them anything unless this skill says to.
By invoking this skill, the user asked for **every ticket of this spec to run in its own session, started
as soon as it is unblocked**, and for each finished ticket branch to be merged into the module branch. That
counts as their go-ahead for every start and merge below, including starts made on turns that a
`<side-sessions-event>` began.

Use `gh` for GitHub calls and the REST endpoints from `.claude/commands/ticket.md`. `gh issue view` does not
show sub-issues or "blocked by" links.

## 1. Set up (once)

1. Parse `$ARGUMENTS` into the spec issue number (a URL or `#n`). If it's empty, stop and ask for one.
2. Check the spec: `gh api repos/{owner}/{repo}/issues/<spec>` must be open, labelled `spec` and
   `spec approved`, with sub-issues (`.../issues/<spec>/sub_issues`). Read the module id from its
   `module:<id>` label. If any check fails, stop and say why.
3. Get on the module branch, `<module-id>/<short-description>`: the existing one if there is one, otherwise
   create one from `main`. Run `git status --porcelain` and stop if the tree is dirty, because merges will
   happen in this checkout.
4. Call `mcp__ccd_host__request_keep_awake` with `until: "session_idle"`.
5. Write a ledger in your reply, then keep it current: each ticket's number, title, state (`blocked`,
   `running → <session name>`, `merged`, `needs user`) and branch.

## 2. Start the frontier

The frontier is the spec's sub-issues that are open, have `issue_dependencies_summary.blocked_by == 0`, have
no assignee (or are assigned to `@me` with no running session) and have no session in the ledger. Run at
most **4** sessions at a time and start them in sub-issue order.

Start each one with `mcp__ccd_session__start_session`, using:

- `initiation: "user_asked"`, `context: "fresh"`, `use_worktree: true`
- `source_branch`: the module branch, so the session sees every ticket merged so far
- `branch_name`: `<module-short>-<n>-<slug>`, e.g. `oa-207-role-visibility`
- `name`: `t<n>`
- `wake_when_done: true`
- `title`: `#<n> <ticket title>`
- `prompt` (fill in the numbers):

  > Run `/ticket <n>` for issue #<n> (spec #<spec>, module `<module-id>`). Two overrides to `/ticket`:
  > in step 4, **stay on this worktree's branch** and don't switch to or create the module branch,
  > because the orchestrating session merges your branch into it. Commit only on this branch, and never
  > push or open a PR. Everything else is as written: TDD, full suite and build green, a commit with
  > `Refs #<n>`, a `Done:` comment, then close the issue. If `/ticket` says to stop and ask (ambiguous spec,
  > high-risk change), stop and explain it in your final message instead of guessing. End with one line:
  > `RESULT: done <branch> <commit sha>` or `RESULT: blocked <reason>`.

- `background`: the spec issue URL, the module spec path `docs/specs/SPEC-<module-id>.md`, and a note that
  the session is one of several parallel ticket builds coordinated by an orchestrator that merges branches.

Before each start, write a bold title line and one sentence. If more than one starts at once, call
`mcp__ccd_session__mark_chapter` first. Then end your turn. The app wakes you with a
`<side-sessions-event>` when sessions finish. Don't poll.

## 3. On each `<side-sessions-event>`

For each session that reported:

1. **Verify, don't trust the note.** Check that its branch has the ticket's commit
   (`git log <module-branch>..refs/heads/<branch>`) and that the issue is closed with a `Done:` comment.
2. **`RESULT: blocked`, a missing commit, or the session is waiting on the user:** mark it `needs user`
   in the ledger with the reason and leave the issue as it is. Don't retry it, and don't build it yourself.
   Its dependents stay blocked.
3. **Done:** merge it into the module branch:
   `git merge --no-ff refs/heads/<branch> -m "Merge branch 'refs/heads/<branch>' into <module-branch>"`.
   Use the full `refs/heads/` ref. Never push the ticket branches.
   - If there's a conflict, resolve it with the mattpocock-skills:resolving-merge-conflicts skill and keep
     both tickets' behaviour. If the resolution needed real code changes, commit them separately as
     `fix(<module-id>): resolve <area> conflict from the merge of #a and #b`.
   - Then run the project's green check from `SPEC.md` (full test suite + build). If it's red, fix it
     with agent-skills:debugging-and-error-recovery and commit the fix as
     `fix(<module-id>): … after merging #<n>`. If you can't get it green, mark the ticket `needs user`,
     `git merge --abort` or revert the merge, and continue.
4. Re-fetch the sub-issues, because closing a ticket unblocks its dependents, then go back to **step 2**
   and start the new frontier. Merge before starting anything so new worktrees include the merged code.

## 4. Finish

When no session is running and no ticket can start:

1. Run the green check once more on the module branch.
2. If every sub-issue is closed and merged: update the module's row in `SPEC.md` to `in progress`, if it
   isn't already, and commit it. Don't mark it `done`, don't open a PR and don't push. Those are the
   review and ship phases.
3. Send `PushNotification` with one line, e.g.
   `#32 reporting: 7/7 tickets merged into reporting/spec, green. Ready for /agent-skills:review.`
   or `#32: 5/7 merged, #41 needs you (ambiguous rollup rule), #42 blocked by it.`
4. Final reply: the ledger, the module branch and its HEAD, any `needs user` tickets with their reasons
   and session links, and then the next step:
   **"Spec implemented and merged into `<module-branch>`. Start `/agent-skills:review`."**
   Offer to archive the finished ticket sessions, but archive them only if the user says yes.

## Rules

- One writer per ticket. Never start a second session for a ticket that has a running one.
- Never touch `main`, never force-push and never push ticket branches.
- If a woken turn has no event for a session you still think is running, check
  `mcp__ccd_session_mgmt__list_sessions` with `{"linked": true}` before deciding it's stuck.
