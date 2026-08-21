# @sdlc-on-fire/evidence

Parses real tool output into typed evidence, and decides whether a gate opens. 236 exports across 52 files. This is the package the product is actually about.

> **Internal package, prerelease `0.1.0-alpha.0`.** Published so `sdlc-on-fire` installs resolve. No stability guarantee before `0.1.0` — exports move and disappear between alphas. The supported surface is the [`sdlc-on-fire`](https://www.npmjs.com/package/sdlc-on-fire) CLI.

## `evaluateGate` is pure and three-valued

```ts
import { evaluateGate, defaultV01Policy } from '@sdlc-on-fire/evidence';

const verdict = evaluateGate(defaultV01Policy(), envelopes, approvals, {
  currentHeadSha: head,
  now: new Date(),
});
// { pass: false, missing: ['typecheck'], failures: ['test failing'], abstained: [] }
```

**`missing` and `failures` are never merged.** "The check did not run" and "the check says no" ask for opposite work — write the tests versus fix the code — and a reviewer shown both in one bucket learns to treat both as noise. `abstained` is the third: a verifier that declined to conclude, which needs more context rather than a different answer.

## Parsers, and the failure they refuse to hide

```ts
import { parseVitest, parseJUnitXml, parseLcov } from '@sdlc-on-fire/evidence';
```

Vitest, Jest, node:test TAP, pytest, go test, JUnit XML, lcov, Playwright. When a runner exits 0 and produces nothing parseable, the result is recorded as **exit-code-only evidence at confidence 0.6** with the reason attached — not as a pass. An unreadable report and a green suite are different facts.

## Staleness is structural

An envelope is bound to a `git_sha`. Edit a file after the suite passed and the evidence no longer describes the tree being gated, so the gate asks for a re-run. Nothing has to remember to invalidate anything.

## Quorum, and the bug this package shipped with

`required_roles` used to _filter_ approvals, and the survivors were counted against `min_approvals`. A policy demanding `["eng-lead", "security"]` with a floor of 1 passed on one eng-lead approval and no security review. Each named role is now checked separately, the floor is an independent condition on top, and the author's own approval never counts toward either.

```ts
import { evaluateQuorum, normaliseQuorum, simulateGatePolicy } from '@sdlc-on-fire/evidence';

simulateGatePolicy(current, proposed);
// → concrete targets whose requirement moved, not "more permissive"
```

`simulateGatePolicy` borrows Cedar Analysis's idea — return the counterexample, not the verdict — and deliberately not its SMT solver: the decision space here is small and finite, so exhaustive enumeration is the complete analysis rather than an approximation of one.

## Also in here

`ci-repair` (a failed gate opens a work item, bounded, and `repairIsLegitimate` refuses a repair that deleted tests or weakened assertions), `knowledge-claim` (decompose → cite → verify → abstain), `traceability`, `spec-quality`, `doc-health`, `security-gate`.

## Licence

MIT.
