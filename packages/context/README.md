# @sdlc-on-fire/context

**Assembles task-scoped context packs instead of dumping files into the prompt.**

> **Internal package, prerelease.** Published so that `sdlc-on-fire` installs resolve. It carries **no stability guarantee** before `0.1.0` — exports move and disappear between alpha releases. The supported surface is the [`sdlc-on-fire`](https://www.npmjs.com/package/sdlc-on-fire) CLI.

Retrieval is hybrid: BM25 over Postgres tsvector, vector search over pgvector HNSW, fused with reciprocal rank fusion and reranked. Chunking is structure-aware — heading-aware for Markdown, fence-aware so a code block is never split down the middle.

Packs are assembled with a **stable prefix and a variable tail**, so the expensive, unchanging part of a prompt sits where a provider's cache can reuse it. Per-stage token budgets are enforced at assembly time, and the work item's own card is never truncated to fit — a budget too small to hold it fails loudly instead of quietly dropping the thing the task is about.

Also implements corrective retrieval: deterministic signals decide first, a model is consulted only in the genuinely ambiguous middle band, and the action taken for each verdict is fixed rather than chosen.

## Install

```bash
npm install @sdlc-on-fire/context@next
```

Node 20 or newer. Part of [SDLC on Fire](https://github.com/faraasat/sdlc-on-fire) — a daemon that will not let the agent lie.

## Licence

MIT.
