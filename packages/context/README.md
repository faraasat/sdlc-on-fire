# @sdlc-on-fire/context

Assembles what an agent is allowed to see, and refuses to hand it more than it can hold.

> **Internal package, prerelease `0.1.0-alpha.1`.** Published so `sdlc-on-fire` installs resolve. No stability guarantee before `0.1.0` — exports move and disappear between alphas. The supported surface is the [`sdlc-on-fire`](https://www.npmjs.com/package/sdlc-on-fire) CLI.

## Retrieval is hybrid and fused, not picked

```ts
import { hybridSearch, rerank, rrf, DEFAULT_PREFETCH } from '@sdlc-on-fire/context';

const fused = await hybridSearch(query, { prefetch: DEFAULT_PREFETCH }); // fused by `rrf`
```

Lexical (Postgres `tsvector`) and semantic (pgvector) legs run independently and are fused by reciprocal rank. Each leg **prefetches deeper than the result set**, because fusing two top-10s throws away exactly the documents fusion exists to rescue.

The cross-encoder reranker is optional, reorders but never admits, and degrades to the fused order on failure — a reranker that is down should cost you ordering, not recall.

## Freshness is not a heuristic

A vector produced by a different embedding model is stale in exactly the way a vector produced from different text is stale. The semantic leg is dropped on a model mismatch rather than blended in, and a width mismatch throws instead of returning a number that happens to compute. `evaluateRetrieval` and `packMetrics` report what a pack actually cost and covered — `assembleContextPack` refuses a budget too small to hold the required sections rather than silently truncating them.

## The firewall

Human input reaches agents through the **resolved effect** of a typed comment — never through its body text, and never through UI state. A comment's meaning is computed server-side from `(type × role)` at insert and stored in a column a trigger refuses to change.

```ts
import { renderCommentDirectives } from '@sdlc-on-fire/context';

renderCommentDirectives(comments, { agent: 'implementer' });
// reads comment.roleEffect; the body is content an agent may be *shown*,
// never evidence of what the comment is for
```

That signature is the defence: a caller cannot pass text that was never a parameter.

## Licence

MIT.
