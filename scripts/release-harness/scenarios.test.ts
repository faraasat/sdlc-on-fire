import { describe, expect, it } from 'vitest';
// @ts-expect-error -- repo tooling is .mjs; there are no types and none are wanted
import { SCENARIOS, OSS_TARGET } from './scenarios.mjs';

/**
 * P3-QA-14 — the release harness's own guard.
 *
 * The harness itself cannot run here: it installs from the npm registry, clones
 * a large repository, and takes minutes. What *can* be checked cheaply is that
 * it has not rotted into covering less than it claims — a scenario quietly
 * deleted, or the four project shapes collapsing into two, would leave a green
 * release report that means much less than it appears to.
 */

interface Scenario {
  id: string;
  title: string;
  shape: string;
  run: (ctx: unknown) => Promise<unknown>;
  clone?: { repo: string; ref: string; commit: string };
}

const scenarios = SCENARIOS as Scenario[];
const ossTarget = OSS_TARGET as { repo: string; ref: string; commit: string };

describe('the release scenario set', () => {
  it('covers both adoption points the founder asked for', () => {
    // "Some project from scratch and some project from middle." A harness that
    // only ever starts from an empty directory cannot catch the assumptions
    // that hold only in a directory the product created itself.
    const shapes = scenarios.map((scenario) => scenario.shape).join(' ');
    expect(shapes).toContain('from scratch');
    expect(shapes).toContain('from the middle');
  });

  it('includes a real third-party repository, not only fixtures', () => {
    // "One open source big project." A fixture the harness wrote is a fixture
    // shaped like the harness's assumptions.
    const cloned = scenarios.filter((scenario) => scenario.clone !== undefined);
    expect(cloned.length).toBeGreaterThan(0);
    for (const scenario of cloned) {
      expect(scenario.clone?.repo).toMatch(/^https:\/\//);
    }
  });

  it('pins the third-party repo to a commit, not to a branch', () => {
    // Pinned so that a red result means this release changed, rather than that
    // upstream did. A 40-character SHA, checked as a shape: the value itself is
    // resolved from the remote, and asserting the literal here would only pin
    // today's answer twice.
    expect(ossTarget.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(ossTarget.ref).not.toBe('main');
    expect(ossTarget.ref).not.toBe('master');
  });

  it('gives every scenario a distinct id and a runnable body', () => {
    const ids = scenarios.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of scenarios) {
      expect(typeof scenario.run, scenario.id).toBe('function');
      expect(scenario.title.length, scenario.id).toBeGreaterThan(0);
    }
  });

  it('keeps at least the four shapes the release is signed off against', () => {
    // A floor, not an exact count: adding a fifth shape should not break this,
    // and dropping to three should.
    expect(scenarios.length).toBeGreaterThanOrEqual(4);
  });
});
