# SDLC on Fire

**A local-first, full-lifecycle SDLC execution framework for coding agents.**

> A daemon that won't let the agent lie, running on a context engine that doesn't rot.

Coding agents today can mark work "done" on their own say-so, and get slower and less accurate as a codebase grows. SDLC on Fire turns a repository into a governed workspace where **agents do the coding and a local daemon enforces the process**:

- **Evidence gates, not self-report.** A lifecycle transition requires real, machine-captured evidence — parsed test output, coverage deltas, build and typecheck results — bound to the current commit. An agent's claim that something works is never sufficient.
- **A context engine that stays cheap and accurate.** Task-scoped context packs assembled from retrieval over your repo, with per-stage token budgets and cache-aware ordering, instead of dumping files into the prompt.
- **Local-first, no lock-in.** Markdown in git is the source of truth for content; the local database is a rebuildable mirror. Your data stays yours and stays inspectable.

## Status

**Pre-release and under active development. Nothing is published to npm yet, and there is no supported public API.** Interfaces will change without notice until the first release. Please don't build on it yet.

The first release (`0.1.0`) targets a solo, CLI-only workflow: initialise a project, drive a feature from spec to an opened pull request, and have the daemon — not the agent — run the verification that decides whether "done" is allowed.

## Stack

TypeScript / Node, pnpm workspaces. Local Postgres with pgvector (zero-config on first run). Claude Code support first, with additional agent surfaces compiled from one canonical source.

## Development

Requires Node ≥ 20 and pnpm ≥ 9 (the repo pins pnpm via `packageManager`; `corepack enable` is enough).

```bash
pnpm install
pnpm check     # format:check → lint → typecheck → test → build
```

| Script                      | What it does                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm build`                | `tsc --build` emits `.d.ts`, `tsup` emits the JS bundle — per package, in dependency order |
| `pnpm typecheck`            | `tsc --build` across the project-reference graph                                           |
| `pnpm test`                 | Vitest over every package (cross-package imports alias to source, so no build needed)      |
| `pnpm lint` / `pnpm format` | ESLint (type-checked rules) / Prettier                                                     |
| `pnpm clean`                | Drops `dist/` and the TypeScript build cache                                               |
| `pnpm changeset`            | Records a release note; every package versions in lockstep                                 |

### Packages

`core` (object model, schemas, `StoragePort`) · `storage` (Markdown reader/writer, watcher) · `db` (Postgres adapter, migrations, pgvector) · `agent-manager` (canonical skills, agent compilers) · `context` (context packs, retrieval) · `evidence` (output parsers, gate evaluation) · `daemon` (the long-running local process) · `cli` (the published `sdlc` binary).

Only `cli` publishes as `sdlc-on-fire`; the rest publish under `@sdlc-on-fire/*` at the same version.

## License

[MIT](LICENSE) © 2026 Farasat Ali
