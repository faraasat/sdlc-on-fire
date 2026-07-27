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

## License

[MIT](LICENSE) © 2026 Farasat Ali
