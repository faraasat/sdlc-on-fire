---
'@sdlc-on-fire/core': minor
'@sdlc-on-fire/db': patch
---

Add the workspace layout and config schema.

`@sdlc-on-fire/core` now owns the canonical workspace shape (ADR-0043,
contracts/06): the eight-file root whitelist, the `docs/` topic-file set, the
directories `init` creates eagerly versus lazily, and the gitignore entry that
keeps the whole hidden state directory out of git.

`WorkspaceConfigSchema` validates `.sdlcof/config.yaml`, rejecting two mistakes
that would otherwise surface much later: connected mode with no `database.url`,
and a path override that escapes the project root.

`@sdlc-on-fire/db`'s `resolveWorkspacePaths` is now a thin re-export of core's
`resolveWorkspaceLayout` rather than a second definition of the same paths.
