import { describe, expect, it } from 'vitest';
import { buildProgram, cliPackage, cliDependencies } from './index.js';

describe('sdlc-on-fire', () => {
  it('reports its own npm name', () => {
    expect(cliPackage.name).toBe('sdlc-on-fire');
  });

  it('resolves every declared workspace dependency to a real package', () => {
    expect(cliDependencies.map((p) => p.name)).toEqual(cliPackage.dependsOn);
  });
});

describe('appetite is a scoping decision, not a per-task field (P1-SKILL-04)', () => {
  it('refuses --appetite on a task', async () => {
    // The object schemas are permissive on purpose — unmodelled frontmatter keys
    // are preserved rather than rejected — so the level at which an appetite is
    // meaningful is enforced where it is chosen. A task's appetite is its
    // parent's, and recording one per task turns a scoping decision into
    // paperwork.
    const program = buildProgram().exitOverride();
    await expect(
      program.parseAsync(['node', 'sdlc', 'new', 'task', 'x', '--appetite', 'small-batch']),
    ).rejects.toThrow(/applies to epics and features/);
  });

  it('refuses a value outside the vocabulary, naming the valid ones', async () => {
    const program = buildProgram().exitOverride();
    await expect(
      program.parseAsync(['node', 'sdlc', 'new', 'feature', 'x', '--appetite', '2 weeks']),
    ).rejects.toThrow(/expected one of small-batch, big-batch/);
  });
});
