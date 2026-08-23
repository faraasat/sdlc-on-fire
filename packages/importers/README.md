# @sdlc-on-fire/importers

Reads other spec-driven tools' formats into one intermediate representation — and states what it drops rather than pretending it dropped nothing.

> **Internal package, prerelease `0.1.0-alpha.1`.** Published so `sdlc-on-fire` installs resolve. No stability guarantee before `0.1.0` — exports move and disappear between alphas. The supported surface is the [`sdlc-on-fire`](https://www.npmjs.com/package/sdlc-on-fire) CLI.

## Supported, with honest fidelity tiers

| Source   | Fidelity    | What survives                                 |
| -------- | ----------- | --------------------------------------------- |
| OpenSpec | high        | specs, changes, archive deltas                |
| Spec Kit | moderate    | spec and plan structure; some prose placement |
| GSD      | moderate    | phases and tasks                              |
| BMAD     | best-effort | shape only                                    |

Fidelity is declared per format rather than implied, because an importer that silently drops half a document is worse than one that refuses it.

```ts
import { detectAll, planImport, applyImport } from '@sdlc-on-fire/importers';

detectAll(files); // → every supported format found
const plan = planImport(nodes); // → ordered, cycle-checked; throws ImportCycleError
```

## The IR is tool-independent

Every parser — `OpenSpecParser`, `SpecKitParser`, `Gsd2Parser`, `BmadV4Parser`, `BmadV6Parser` — produces the same `IrNodeSchema` shape, so the round-trip exporter (planned, unbuilt — P4-EXP-01) has one thing to write from rather than five. Nothing in the IR names a source tool.

`planImport` orders writes by `WRITE_ORDER` and refuses a cyclic relation graph with `ImportCycleError` instead of producing a half-written tree.

## What an import does not do

It does not invent lifecycle state, evidence or approvals. An imported item arrives at the earliest stage that its content actually supports, because an import that arrives at `done` is asserting a gate passed that nobody ran.

## Licence

MIT.
