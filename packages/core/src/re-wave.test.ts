import { describe, expect, it } from 'vitest';
import type { BlastRadius } from './blast-radius.js';
import { insertionShapeFor, reWaveScope, type InFlightItem } from './re-wave.js';

const radius = (ids: string[], unexplored: string[] = []): BlastRadius => ({
  target: 'EPIC-001',
  reached: ids.map((id, index) => ({ id, hop: index === 0 ? 1 : 2 })),
  truncated: unexplored.length > 0,
  unexplored,
  ownership: [],
  regression: { scope: 'selective', reason: 'no high-risk surface' },
});

const item = (over: Partial<InFlightItem> & { id: string }): InFlightItem => ({
  lifecycleState: 'spec',
  claimedBy: null,
  prUrl: null,
  ...over,
});

describe('selective re-wave (P6-INFLIGHT-01, FEAT-INS-007)', () => {
  it('leaves an item mid-implement alone', () => {
    // Re-planning it discards work in progress to fix a plan — the trade nobody
    // would make deliberately and everybody makes by accident when the re-wave
    // is "everything the walk reached".
    const scope = reWaveScope(radius(['FEAT-001', 'FEAT-002']), [
      item({ id: 'FEAT-001', lifecycleState: 'implement' }),
      item({ id: 'FEAT-002', lifecycleState: 'spec' }),
    ]);
    expect(scope.rePlan).toEqual(['FEAT-002']);
    expect(scope.leftAlone[0]?.id).toBe('FEAT-001');
    expect(scope.leftAlone[0]?.because).toContain('discard work in progress');
  });

  it('re-plans an item still at spec, which is the point', () => {
    // Everything before implement is a plan, and re-planning a plan is what the
    // re-wave is for.
    const scope = reWaveScope(radius(['FEAT-001']), [item({ id: 'FEAT-001' })]);
    expect(scope.rePlan).toEqual(['FEAT-001']);
    expect(scope.leftAlone).toEqual([]);
  });

  it('leaves a claimed item alone, with a different reason', () => {
    // A claim is somebody's attention even at an early stage, and the fix is
    // different: mid-implement needs the plan to wait, a claim needs a
    // conversation.
    const scope = reWaveScope(radius(['FEAT-001']), [item({ id: 'FEAT-001', claimedBy: 'ana' })]);
    expect(scope.rePlan).toEqual([]);
    expect(scope.leftAlone[0]?.because).toContain('claimed by ana');
  });

  it('re-plans an id the board cannot describe', () => {
    // An id in the radius that nothing can describe is exactly the item worth a
    // second look. Silently dropping it is how the radius shrinks to what was
    // convenient.
    const scope = reWaveScope(radius(['GHOST-1']), []);
    expect(scope.rePlan).toEqual(['GHOST-1']);
  });

  it('carries the unexplored items through verbatim', () => {
    // The bound is two hops, and a radius that stops without saying it stopped
    // reads exactly like one that found everything. That warning has to survive
    // into the scope decision, or it only ever warned whoever ran the scan.
    const scope = reWaveScope(radius(['FEAT-001'], ['FAR-1', 'FAR-2']), [item({ id: 'FEAT-001' })]);
    expect(scope.unexplored).toEqual(['FAR-1', 'FAR-2']);
  });

  it('treats review as undisturbable too', () => {
    // A card at review has a diff somebody is reading. Re-planning it wastes the
    // reviewer's pass, not just the author's.
    const scope = reWaveScope(radius(['FEAT-001']), [
      item({ id: 'FEAT-001', lifecycleState: 'review' }),
    ]);
    expect(scope.rePlan).toEqual([]);
  });
});

describe('open-PR-safe insertion (P6-INFLIGHT-02, FEAT-INS-011)', () => {
  it('becomes a follow-up when the target has a PR open', () => {
    // Changing the scope of work already proposed for merge invalidates a review
    // that already happened: the reviewer approved a diff, and it is about to be
    // a different diff without the approval being withdrawn.
    const decision = insertionShapeFor(
      item({ id: 'FEAT-001', prUrl: 'https://github.com/o/r/pull/7' }),
    );
    expect(decision.shape).toBe('follow-up');
    expect(decision.because).toContain('invalidates a review');
  });

  it('mutates when no PR is open', () => {
    expect(insertionShapeFor(item({ id: 'FEAT-001' })).shape).toBe('mutate');
  });

  it('treats an empty PR url as no PR', () => {
    // A column defaulted to '' rather than NULL would otherwise turn every
    // insertion into a follow-up, and a rule that fires on everything is one
    // people learn to route around.
    expect(insertionShapeFor(item({ id: 'FEAT-001', prUrl: '' })).shape).toBe('mutate');
  });

  it('mutates a target that is not on the board yet', () => {
    expect(insertionShapeFor(undefined).shape).toBe('mutate');
  });
});
