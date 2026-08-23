# @sdlc-on-fire/core

The schemas, the pure decision logic, and the `StoragePort` every reader and writer goes through.

> **Internal package, prerelease `0.1.0-alpha.1`.** Published so `sdlc-on-fire` installs resolve. No stability guarantee before `0.1.0` — exports move and disappear between alphas. The supported surface is the [`sdlc-on-fire`](https://www.npmjs.com/package/sdlc-on-fire) CLI.

## Why there is no filesystem access in here

Every function in this package is pure, and that is enforced by having nothing to be impure with — `zod` is the only dependency. The gate logic, the lifecycle tables, the secret patterns and the capability check are all decisions about data somebody else read.

That constraint is what makes them testable at boundaries that would otherwise need a fixture:

```ts
import { capability, HUMAN_ONLY_ACTIONS } from '@sdlc-on-fire/core';

capability({
  actor: { id: 'a1', kind: 'agent', displayName: 'claude-code' },
  action: 'approve',
  cardId: 'FEAT-001',
  memberships: [{ actorId: 'a1', roleKey: 'eng-lead' }],
  rolePermissions: { 'eng-lead': ['approve'] },
  humanOnlyActions: HUMAN_ONLY_ACTIONS,
  now: '2026-08-21T00:00:00Z',
});
// → { granted: false, ground: 'agent-cannot-approve',
//     because: '"approve" is human-only and claude-code is an agent …' }
```

Note the shape: a verdict carries **why**. `granted: false` alone cannot distinguish "an agent may not do this" from "nobody granted it", and those need different fixes.

## Zod is the single type source

Every exported TypeScript type is a `z.infer` of a schema defined once here — never a hand-written interface duplicated downstream. `storage`, `db`, `daemon`, `evidence` and `context` all import their shapes from this package, so a schema change breaks the build instead of surfacing as a runtime surprise three packages away.

```ts
import { WorkItemSchema, EvidenceEnvelopeSchema } from '@sdlc-on-fire/core';

WorkItemSchema.parse(frontmatter); // throws with a path, not a boolean
```

## What is worth importing

| Export                                         | Does                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `WorkItemSchema`, `EvidenceEnvelopeSchema`     | The two shapes everything else agrees on                           |
| `StoragePort`                                  | The interface `db` implements and nothing else may bypass          |
| `capability()`, `ROLE_KEYS`, `PERMISSION_KEYS` | Who may do what, and on what grounds                               |
| `REQUIRED_STAGES`, `resolveRequiredStages()`   | The data-driven lifecycle, per preset and work type                |
| `scanForSecrets()`, `scanForInjection()`       | Pattern scanners for workspace content                             |
| `computeBlastRadius()`                         | What a change to one item reaches                                  |
| `assessSources()`                              | Source tiering: a paper is not a marketing page                    |
| `evaluateTiers()`                              | Whether required test tiers actually ran — files present ≠ passing |
| `toPosixPath()`, `relativePosix()`             | Identity paths, which are never `path.join` output                 |

## The one that looks like a utility and is not

`relativePosix()` exists because a work-item identity is a posix path on every platform, and `path.relative` returns `kanban\\_inbox\\TASK-001.md` on Windows. Using `path.join` for an identity produced 36 failing tests on windows-latest before this existed. If you are building a key, use these; if you are opening a file, use `node:path`.

## Licence

MIT.
