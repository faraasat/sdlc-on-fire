---
"sdlc-on-fire": patch
"@sdlc-on-fire/core": patch
"@sdlc-on-fire/db": patch
"@sdlc-on-fire/daemon": patch
"@sdlc-on-fire/storage": patch
"@sdlc-on-fire/evidence": patch
"@sdlc-on-fire/agent-manager": patch
"@sdlc-on-fire/context": patch
"@sdlc-on-fire/importers": patch
"@sdlc-on-fire/ui": patch
---

Brownfield `init`, honest exit codes, GitHub Issues sync, and READMEs that describe the product you actually use.

**`init` no longer dumps 28 files into a mature repository.** Pointing the published `alpha.1` at flask, cobra, ripgrep and got showed every one of them receiving the full greenfield scaffold. A repo that already has a `README.md` and its own `docs/` now gets 7 root files instead of 28.

**`init` no longer exits 0 when the database genuinely failed to start.** A script doing `sdlc init && sdlc verify …` was sailing straight past a workspace with no mirror. It now distinguishes a database merely *held* by another `sdlc serve` — the most ordinary setup there is, still exit 0 — from one that actually failed, which exits 1.

**Two-way GitHub Issues sync** (`sdlc tracker:sync`), live-verified against a real repository. Conflicts are refused rather than merged unless you name a policy, absence is never read as deletion, and pull requests are never mistaken for work items.

**`sdlc db:up` is no longer suggested by error messages.** It was named in two remediation strings and registered nowhere — the text you read when you are already stuck pointed at a command that does not exist.

**READMEs rewritten.** They described a CLI; the product is skills loaded in your agent's chat window. `@sdlc-on-fire/ui` had no README at all.
