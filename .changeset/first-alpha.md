---
'@sdlc-on-fire/agent-manager': minor
'@sdlc-on-fire/importers': minor
'@sdlc-on-fire/evidence': minor
'@sdlc-on-fire/context': minor
'@sdlc-on-fire/storage': minor
'@sdlc-on-fire/daemon': minor
'@sdlc-on-fire/core': minor
'@sdlc-on-fire/db': minor
'sdlc-on-fire': minor
---

First public prerelease.

The walking skeleton runs end to end: `sdlc init` scaffolds a workspace with a
zero-config local database, `sdlc new` creates a work item as Markdown with typed
frontmatter, `sdlc verify` executes the item's own check and parses the real
output, and `sdlc advance` refuses to move the item when that output says the
check failed.

Exit code 0 is not treated as "tests passed": a command with no machine-readable
output records exit-code-only evidence at reduced confidence and prints how to
fix it. Evidence is bound to a commit and a working-tree hash, so a run that
passed against a different tree is reported stale rather than accepted.

Also in this release: dependency install gate against live OSV advisories,
secret and prompt-injection scanning, high-risk-surface review routing,
branch-per-work-item git management with PR bodies rendered from recorded
evidence, hard insertion with blast-radius analysis, selective gate re-open, and
merge-conflict review that refuses a silently dropped side.

Published under the `next` tag. Interfaces will change without warning before
`0.1.0`; only the `sdlc` CLI is a supported surface.
