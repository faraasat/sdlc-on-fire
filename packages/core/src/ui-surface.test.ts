import { describe, expect, it } from 'vitest';
import { detectUiSurface, isUiPath } from './ui-surface.js';
import {
  SITUATIONS_FROM_DIFF,
  SITUATIONS_NOT_FROM_DIFF,
  situationsFromDiff,
} from './situations.js';
import { SKILL_SITUATIONS } from './skill.js';

describe('ui surface detection (P6-PAYLOAD-05)', () => {
  it('recognises components and stylesheets wherever they live', () => {
    expect(isUiPath('src/Button.tsx')).toBe(true);
    expect(isUiPath('web/App.vue')).toBe(true);
    expect(isUiPath('assets/main.scss')).toBe(true);
    expect(isUiPath('src/components/Card.ts')).toBe(true);
    expect(isUiPath('tailwind.config.js')).toBe(true);
  });

  it('does not fire on code that merely has an interface-sounding name', () => {
    // The directory rule is anchored to a path segment on purpose. Matching
    // `component` anywhere in the string makes every registry, factory and
    // helper into UI, and a detector that fires on everything dispatches an
    // agent nobody wanted.
    expect(isUiPath('src/lib/component-registry.ts')).toBe(false);
    expect(isUiPath('src/pagination.ts')).toBe(false);
    expect(isUiPath('server/db/migrate.ts')).toBe(false);
    // The anchor specifically: these contain `pages/` and `styles/` as
    // substrings and are a directory segment away from being interface.
    expect(isUiPath('content/subpages/guide.md')).toBe(false);
    expect(isUiPath('data/hairstyles/index.json')).toBe(false);
  });

  it('excludes tests and stories', () => {
    // Fixing an assertion in `Button.test.tsx` is a change to a test. Exploring
    // the interface because of it is the noise that teaches people to ignore it.
    expect(isUiPath('src/Button.test.tsx')).toBe(false);
    expect(isUiPath('src/Button.stories.tsx')).toBe(false);
    expect(isUiPath('src/__tests__/Card.tsx')).toBe(false);
  });

  it('keeps the order it was given', () => {
    expect(detectUiSurface(['a.ts', 'b.tsx', 'c.md', 'd.css'])).toEqual(['b.tsx', 'd.css']);
  });
});

describe('situations from a diff (P6-PAYLOAD-05)', () => {
  it('detects a UI change without calling it a risk', () => {
    // Deliberately separate from risk-surface: a button label does not need a
    // security reviewer, and putting `ui` in the risk table would mean it did.
    expect(situationsFromDiff([{ path: 'src/Button.tsx' }])).toEqual(['touches-ui']);
  });

  it('detects a high-risk surface', () => {
    expect(situationsFromDiff([{ path: 'src/auth.ts' }])).toEqual(['high-risk-surface']);
  });

  it('reports both when a change is both', () => {
    const both = situationsFromDiff([{ path: 'src/auth/LoginForm.tsx' }]);
    expect(both).toContain('high-risk-surface');
    expect(both).toContain('touches-ui');
  });

  it('reports nothing for an ordinary change', () => {
    expect(situationsFromDiff([{ path: 'src/format.ts' }])).toEqual([]);
  });

  it('accounts for every situation in the vocabulary', () => {
    // Totality, the same shape as SKILL_STAGES_OUTSIDE_LIFECYCLE. Without this
    // the coverage claim would be "the situations this function produces are
    // valid", which is true of a function that produces none — and a situation
    // nothing computes is a dispatch path that only looks like one.
    // Asserted against the two censuses directly. There was a helper computing
    // this difference and mutation testing killed it: `return []` broke nothing,
    // because the check was always really about the lists.
    expect([...SITUATIONS_FROM_DIFF, ...Object.keys(SITUATIONS_NOT_FROM_DIFF)].sort()).toEqual(
      [...SKILL_SITUATIONS].sort(),
    );
  });
});
