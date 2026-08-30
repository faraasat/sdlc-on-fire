import { describe, expect, it } from 'vitest';
import {
  assertNoHeldOutPaths,
  DEFAULT_HELD_OUT_ROOT,
  deriveScopes,
  formatSuiteScope,
  heldOutExcludeGlobs,
  heldOutIncludeGlob,
  heldOutRootOf,
  HeldOutLeakError,
  isHeldOutChunk,
  isHeldOutPath,
  LEAK_SURFACES,
  partitionHeldOut,
  permitsPath,
  scopePaths,
  scopeToVisible,
  WorkspaceConfigSchema,
} from './index.js';

const HELD = `${DEFAULT_HELD_OUT_ROOT}/billing.test.ts`;

describe('isHeldOutPath', () => {
  it('matches the root and everything under it', () => {
    expect(isHeldOutPath(DEFAULT_HELD_OUT_ROOT)).toBe(true);
    expect(isHeldOutPath(HELD)).toBe(true);
    expect(isHeldOutPath(`${DEFAULT_HELD_OUT_ROOT}/deep/nested/a.test.ts`)).toBe(true);
  });

  it('matches on a path boundary, not a prefix', () => {
    // The failure this exists for: `startsWith` alone calls this held out, so
    // an ordinary directory disappears from the agent's view.
    expect(isHeldOutPath('tests/held-outside/a.test.ts')).toBe(false);
    expect(isHeldOutPath('tests/held-out-old/a.test.ts')).toBe(false);
  });

  it('does not care about slash direction or case', () => {
    expect(isHeldOutPath('tests\\held-out\\a.test.ts')).toBe(true);
    expect(isHeldOutPath('Tests/Held-Out/A.test.ts')).toBe(true);
    expect(isHeldOutPath('./tests/held-out/a.test.ts')).toBe(true);
  });

  it('honours a workspace that moved its root', () => {
    expect(isHeldOutPath('spec/sealed/a.test.ts', 'spec/sealed')).toBe(true);
    expect(isHeldOutPath(HELD, 'spec/sealed')).toBe(false);
  });

  it('holds nothing out for an empty root, rather than everything', () => {
    // The dangerous default: a blank root that matched every path would empty
    // the agent's file scope, and a blank root that matched none is at least a
    // visible failure.
    expect(isHeldOutPath(HELD, '')).toBe(false);
    expect(isHeldOutPath('a.ts', '   '.trim())).toBe(false);
  });

  it('tolerates a trailing slash on the root', () => {
    expect(isHeldOutPath(HELD, `${DEFAULT_HELD_OUT_ROOT}/`)).toBe(true);
  });
});

describe('isHeldOutChunk', () => {
  it('reads the path out of a chunk id', () => {
    expect(isHeldOutChunk(`${HELD}#3`)).toBe(true);
    expect(isHeldOutChunk('docs/DESIGN.md#3')).toBe(false);
  });

  it('handles an id with no fragment', () => {
    expect(isHeldOutChunk(HELD)).toBe(true);
  });

  it('strips the fragment before matching, so the root itself is recognised', () => {
    // Without the strip, `tests/held-out#0` is neither the root nor under it,
    // and a chunk of the root's own file walks straight into a pack.
    expect(isHeldOutChunk(`${DEFAULT_HELD_OUT_ROOT}#0`)).toBe(true);
  });
});

describe('partitioning', () => {
  it('separates without dropping anything', () => {
    const all = [HELD, 'src/a.ts', `${DEFAULT_HELD_OUT_ROOT}/b.test.ts`];
    const { visible, heldOut } = partitionHeldOut(all, (p) => p);
    expect(visible).toEqual(['src/a.ts']);
    expect(heldOut).toHaveLength(2);
    expect(visible.length + heldOut.length).toBe(all.length);
  });

  it('reports what it withheld, not just what survived', () => {
    const scope = scopeToVisible([HELD, 'src/a.ts']);
    expect(scope.visible).toEqual(['src/a.ts']);
    expect(scope.withheld).toEqual([HELD]);
    expect(formatSuiteScope(scope)).toContain('1 path(s) withheld');
  });

  it('says so plainly when nothing was withheld', () => {
    expect(formatSuiteScope(scopeToVisible(['src/a.ts']))).toContain('nothing held out');
  });
});

describe('assertNoHeldOutPaths', () => {
  it('passes a clean list', () => {
    expect(() => assertNoHeldOutPaths('context-pack', ['src/a.ts'])).not.toThrow();
  });

  it('throws, naming the surface and the paths', () => {
    try {
      assertNoHeldOutPaths('context-pack', ['src/a.ts', HELD]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(HeldOutLeakError);
      expect((error as HeldOutLeakError).surface).toBe('context-pack');
      expect((error as HeldOutLeakError).paths).toEqual([HELD]);
      expect((error as Error).message).toContain('context-pack');
    }
  });

  it('refuses rather than filtering — a quiet filter is a bug that keeps working', () => {
    expect(() => assertNoHeldOutPaths('agent-file-scope', [HELD])).toThrow(HeldOutLeakError);
  });
});

describe('runner globs', () => {
  it('excludes the set from a default include', () => {
    expect(heldOutExcludeGlobs()).toEqual(['tests/held-out/**', '**/tests/held-out/**']);
  });

  it('selects only the set for the daemon run', () => {
    expect(heldOutIncludeGlob()).toBe('tests/held-out/**/*.test.*');
  });

  it('derives both from the same root, so moving it moves both', () => {
    expect(heldOutExcludeGlobs('spec/sealed')[0]).toContain('spec/sealed');
    expect(heldOutIncludeGlob('spec/sealed')).toContain('spec/sealed');
  });
});

describe('the agent scope', () => {
  it('permits an ordinary path at every stage that can read', () => {
    for (const stage of ['implement', 'review', 'spec']) {
      expect(permitsPath(deriveScopes({ stage }), 'src/billing.ts')).toBe(true);
    }
  });

  it('refuses a held-out path at every stage, whatever the scopes', () => {
    // There is no scope that turns this on — the same reasoning as `main:push`
    // being absent from the vocabulary rather than withheld.
    for (const stage of ['implement', 'review', 'spec', 'retrospective', 'unknown-stage']) {
      expect(permitsPath(deriveScopes({ stage }), HELD)).toBe(false);
    }
  });

  it('carries the root on the grant, so a printed grant says what it could not see', () => {
    expect(deriveScopes({ stage: 'implement' }).heldOutRoot).toBe(DEFAULT_HELD_OUT_ROOT);
    expect(deriveScopes({ stage: 'implement', heldOutRoot: 'spec/sealed' }).heldOutRoot).toBe(
      'spec/sealed',
    );
  });

  it('honours a moved root when filtering a list', () => {
    const grant = deriveScopes({ stage: 'implement', heldOutRoot: 'spec/sealed' });
    const scope = scopePaths(grant, ['spec/sealed/a.test.ts', HELD]);
    expect(scope.withheld).toEqual(['spec/sealed/a.test.ts']);
    // And the conventional root is *not* held out in this workspace.
    expect(scope.visible).toEqual([HELD]);
  });
});

describe('the configured root', () => {
  it('defaults to the conventional one', () => {
    expect(WorkspaceConfigSchema.parse({}).testing.held_out_root).toBe(DEFAULT_HELD_OUT_ROOT);
  });

  it('refuses a root that escapes the project', () => {
    for (const bad of ['/etc/held-out', '../sibling/held-out']) {
      const parsed = WorkspaceConfigSchema.safeParse({ testing: { held_out_root: bad } });
      expect(parsed.success).toBe(false);
    }
  });

  it('resolves through one function, so the default lives in one place', () => {
    expect(heldOutRootOf(null)).toBe(DEFAULT_HELD_OUT_ROOT);
    expect(heldOutRootOf(undefined)).toBe(DEFAULT_HELD_OUT_ROOT);
    expect(heldOutRootOf({})).toBe(DEFAULT_HELD_OUT_ROOT);
    expect(heldOutRootOf({ testing: { held_out_root: 'spec/sealed' } })).toBe('spec/sealed');
    // A blank value is a config someone half-edited, not a request to hold
    // nothing out — defaulting withholds more, which is the safe direction.
    expect(heldOutRootOf({ testing: { held_out_root: '   ' } })).toBe(DEFAULT_HELD_OUT_ROOT);
  });

  it('resolves what the schema produced, not a second reading of it', () => {
    const config = WorkspaceConfigSchema.parse({ testing: { held_out_root: 'spec/sealed' } });
    expect(heldOutRootOf(config)).toBe('spec/sealed');
  });

  it('accepts a relative root inside the project', () => {
    const parsed = WorkspaceConfigSchema.safeParse({ testing: { held_out_root: 'spec/sealed' } });
    expect(parsed.success).toBe(true);
  });
});

describe('the surfaces are enumerated, not scattered', () => {
  it('names all four', () => {
    expect([...LEAK_SURFACES]).toEqual([
      'context-pack',
      'agent-file-scope',
      'agent-verify-command',
      'retrieval-index',
    ]);
  });
});
