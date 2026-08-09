---
'@sdlc-on-fire/daemon': minor
---

Add the Git Manager: branch, worktree, commit, diff, and the bookkeeping split.

`createGitManager()` wraps `simple-git` with the operations the daemon needs to
drive branch-per-work-item and worktree-isolated waves. Branches and worktrees
are created here rather than by hand, so a branch stays traceable to its work
item without a lookup.

`buildBranchName()` generates `<type>/<epic>-<feature>-<task-id>-<slug>` per
ADR-0048, slugifying the hierarchy while preserving the task ID verbatim — the ID
is the anchor `git log --grep` relies on.

Commits classify their own change set: a commit touching only tool-managed paths
(`kanban/`, `docs/`, `.sdlcof/`) automatically carries the `Sdlc-Bookkeeping: true`
trailer, so product history can be filtered from workspace bookkeeping without a
separate branch or ref. The classification is a deterministic rule, not a
commit-message convention.
