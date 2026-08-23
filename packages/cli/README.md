# sdlc-on-fire

**A daemon that will not let a coding agent mark its own work done.**

Your agent says the tests pass. It says the edge case is handled, the change is complete, the migration is safe. That report comes from the same process that wrote the code, carrying the same blind spots, and when it is wrong there is nothing downstream that can tell.

This puts something between the agent and the word "done". The agent writes the code. **The daemon runs the checks, reads the real output, and decides whether the work item may move.** Not a linter you can disable, not a prompt asking the model to be careful — a separate process that runs your actual test command and looks at the actual exit code.

```console
$ sdlc advance FEAT-001
FEAT-001: BLOCKED at "discovery" (wanted "spec")
  ✗ echo-back: FEAT-001 has not restated what it understood. Building the wrong
    thing is the most common way this goes wrong, and it is cheapest to catch
    here — record the restatement, then `sdlc echo approve`.
  ✗ gate: test failing evidence says the check did not pass — fix the code,
    then re-verify
```

> **Prerelease: `0.1.0-alpha.1`.** Interfaces move between alphas and parts of the product are unfinished — there is [an honest list](#what-is-not-finished) below rather than a roadmap that implies otherwise. Worth trying on a real repo. Not worth building a company process on yet.

---

## You do not live in this CLI

That is the part most tools get backwards, so it is worth saying early.

**You work where you already work** — Claude Code, Cursor, Copilot, Gemini, OpenCode, or an MCP client. `sdlc` compiles its skills into whatever agent surface you use, and your agent loads them the way it loads any other skill. There is no new chat window and no new editor.

```console
$ sdlc skills compile --target claude-code
compiled 5 skill(s) → claude-code
  ✎ .claude/skills/implement/SKILL.md  (4691 bytes)
  ✎ .claude/skills/resolve-conflict/SKILL.md  (6362 bytes)
  ✎ .claude/skills/retrospective/SKILL.md  (2517 bytes)
  ✎ .claude/skills/review/SKILL.md  (5119 bytes)
  ✎ .claude/skills/spec/SKILL.md  (4713 bytes)
```

One canonical source, six targets, compiled — not six copies you keep in sync by hand.

The CLI is the **spine**, not the interface. You touch it to ask what happens next and to let the daemon check the work. Everything in between happens in your agent, in your editor, in your normal loop.

And notice what the compiled skills do **not** contain: any instruction to run the tests and report back. That is deliberate. A skill that says *"run the suite and tell me the result"* has handed the grading back to the thing being graded. The `implement` skill says the opposite, in as many words:

> *Do not report that tests pass — the daemon runs verify and reads the output itself.*

---

## The loop

Ask what is next. The answer includes which skill to load and the context to load it with:

```console
$ sdlc instructions FEAT-001
FEAT-001 — CSV export for reports
  stage:  discovery (standard/feature)
  next:   spec
  skill:  spec → spec_output
  tokens: ~110 (98 cacheable, 89%)

Write the spec for FEAT-001. Every acceptance criterion MUST be in
GIVEN/WHEN/THEN form and MUST be checkable by a command, not by reading.
State non-goals explicitly.
```

That `89% cacheable` is not decoration. Packs are assembled stable-content-first so your provider's prompt cache actually hits, and the number is reported so you can see when it stops.

Your agent does the work. Then the daemon checks it — **it runs your command itself**:

```console
$ sdlc verify FEAT-001
FEAT-001: FAILED (exit 1)
  command:  ./run-tests.sh
  exit:     1  (1694ms)
  evidence: #1 recorded by the daemon, not claimed by an agent
  ⚠ no test count could be read — this is exit-code-only evidence (confidence 0.6).
    Add a machine-readable reporter to the verify command (e.g. `--reporter=json`
    for Vitest/Jest, or `--test-reporter=tap` for node:test) to record real counts.
```

Two things there are the whole point. **"recorded by the daemon, not claimed by an agent"** — the evidence has a provenance, and a claim is not evidence. And the warning: an exit code alone is weak evidence, so it is scored 0.6 and *says so*, with the fix. A tool that silently treated `exit 0` as "tests passed" is how you end up trusting a suite that ran zero tests.

Then the gate decides. Green evidence, and the card moves. Red, and it does not.

---

## Install

```bash
npm install -g sdlc-on-fire
```

Node 20+. `sdlc init` provisions a local PGlite database inside the workspace — no Docker, no connection string, no `docker compose up` before you can try anything. Point it at a real Postgres later by setting `database.url`; the schema and every code path are identical.

```console
$ sdlc init
Workspace initialised.
  root:    /tmp/demo
  created: 30 file(s)
  db:      PGlite ready
```

---

## Content in git, state in the database

Your specs, plans, decisions and cards are **Markdown and YAML in your repo**. They diff, they review in a PR, they survive this tool being deleted. The database is a mirror — state, embeddings, retrieval indexes — and it is rebuildable from git alone:

```bash
sdlc db:rebuild   # drops the mirror, reconstructs it from the files
```

If that command ever cannot reproduce your project, the tool has a bug. That is the invariant, and it is why the database is never allowed to be the only place something lives.

---

## Coming from another tool

You do not have to start over. Point it at what you already have:

```bash
sdlc detect          # what is this repo already using?
sdlc import --from openspec
```

Importers exist for **Spec Kit, OpenSpec, GSD and BMAD**, with per-tool fidelity that is *declared rather than assumed* — the exporter states what it drops, and a round-trip gate fails if reality disagrees with the declaration. That gate caught our own GSD exporter claiming `moderate` fidelity while silently dropping identifiers.

---

## What is not finished

Every feature was audited against the code at a *reachable and tested* bar. **~68% built, ~15% partial, ~16% missing.** The gaps that would affect you most:

- **Five skills ship, not thirty.** `spec`, `implement`, `review`, `retrospective`, `resolve-conflict`. The compiler and all six targets are done; the library is thin. Planning skills (`discovery`, `decompose`, `architecture`) are the next batch.
- **Retrieval precision is not measured yet.** Hybrid search works and the cache-aware assembly is real, but until precision@k is reported, "a context engine that doesn't rot" is an architecture claim without an instrument behind it.
- **Agent runs are not recorded.** The table and the API exist; nothing writes rows yet, so the run viewer is empty.
- **`db:up` / `db:down` do not exist.** Use `sdlc db:rebuild`.
- **Two-way tracker sync ships for GitHub Issues only.** Linear and Jira are built on the same primitives and waiting on credentials to verify against.

Nothing above is hidden behind a "coming soon". The full audit, feature by feature, is in the repository.

---

## Reading the room

If you want the fastest possible path from prompt to code, this is not that — it deliberately adds a step where something checks the work. If you have been burned by an agent that confidently shipped a broken change, that step is the entire product.

---

## Licence

MIT. Free forever, no paywalled QA tier, no enterprise edition.
