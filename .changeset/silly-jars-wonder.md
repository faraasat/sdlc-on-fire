---
'@sdlc-on-fire/storage': minor
---

Add the typed Markdown reader/writer.

`packages/storage` now owns the only sanctioned path for reading and writing
work-item files. Frontmatter re-serialization is deterministic — canonical key
order, no line reflowing, `undefined` dropped rather than emitted as `null` — so
a one-field status flip produces a one-line diff instead of a whole-file rewrite.

The typed writer enforces two things no caller can skip: nothing reaches disk
without validating against the object model, and a work item whose *on-disk*
stage is terminal is never edited in place (ADR-0013). The terminal check reads
the frontmatter about to be overwritten, so an agent cannot unlock a finished
item by claiming it is back in progress.

Uses `yaml` rather than `gray-matter` — see ADR-0069.
