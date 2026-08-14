import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ORCHESTRATOR_KEY, RoleDefinitionSchema, type RoleDefinition } from '@sdlc-on-fire/core';
import { deriveRoles, formatRoles } from './roles.js';

/**
 * Teardown retries, because Windows keeps a file locked while anything holds it.
 *
 * A child process that has just exited can still own its handles for a moment,
 * and removing the directory then fails with EBUSY — which Vitest reports as a
 * failed suite even though every assertion in it passed. Retrying is the
 * documented remedy, and is a no-op on platforms without the problem.
 */
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

/**
 * `sdlc roles` — deriving a team from a real project (P2-AGENT-01).
 *
 * The last case is the important one, and it is the one that would have caught
 * both defects this task found. The registry's triggers were written by a person
 * thinking about an ecosystem (`drizzle`, `postgres`, `node`) while the stack
 * detector reports what manifests actually say (`drizzle-orm`, `pg`,
 * `typescript`), and nothing had ever compared the two vocabularies — every unit
 * test supplied its own triggers *and* its own stack, so they always agreed.
 */

const dirs: string[] = [];

async function project(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-roles-'));
  dirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
  return root;
}

const role = (overrides: Record<string, unknown>): RoleDefinition =>
  RoleDefinitionSchema.parse({
    persona: 'p',
    contextScope: ['**/*'],
    tools: ['read'],
    tier: 'medium',
    techniques: ['chain-of-thought'],
    ...overrides,
  });

const manifest = (deps: Record<string, string>): string =>
  JSON.stringify({ name: 'app', dependencies: deps });

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, ...RM_RETRY })),
  );
});

describe('deriveRoles', () => {
  const registry = [
    role({ key: ORCHESTRATOR_KEY, triggers: [], contextScope: [], tools: [], tier: 'high' }),
    role({ key: 'sql', triggers: ['drizzle-orm', 'pg'] }),
    role({ key: 'react', triggers: ['react'] }),
    role({ key: 'reviewer', triggers: ['*'] }),
  ];

  it('derives a specialist only for what the project has', async () => {
    const root = await project({ 'package.json': manifest({ pg: '^8' }) });
    const keys = (await deriveRoles(root, registry)).roles.map((r) => r.key);
    expect(keys).toContain('sql');
    expect(keys).not.toContain('react');
  });

  it('always includes the orchestrator and the stack-independent roles', async () => {
    // The reviewer's `triggers: ['*']` was compared as a literal, so it appeared
    // only for a project depending on a package called `*`. Nothing noticed,
    // because nothing had derived a team from a real project.
    const root = await project({ 'package.json': manifest({}) });
    const keys = (await deriveRoles(root, registry)).roles.map((r) => r.key);
    expect(keys).toEqual([ORCHESTRATOR_KEY, 'reviewer']);
  });

  it('matches a trigger against a package name, not only the technology name', async () => {
    const root = await project({
      'package.json': manifest({ '@supabase/supabase-js': '^2' }),
    });
    const withPackageTrigger = [
      ...registry,
      role({ key: 'supabase', triggers: ['@supabase/supabase-js'] }),
    ];
    const result = await deriveRoles(root, withPackageTrigger);
    expect(result.roles.map((r) => r.key)).toContain('supabase');
    // Reported by technology, so the summoning reads the way a person thinks.
    expect(result.roles.find((r) => r.key === 'supabase')?.summonedBy).toEqual(['supabase']);
  });

  it('names the technologies no specialist covers', async () => {
    const root = await project({ 'package.json': manifest({ pg: '^8', yaml: '^2' }) });
    const result = await deriveRoles(root, registry);
    expect(result.uncovered).toEqual(['yaml']);
    expect(formatRoles(result)).toContain('No specialist for: yaml');
  });

  it('does not fail merely because a technology has no specialist', async () => {
    // The registry not having grown yet is not a defect, and failing on it would
    // make every real project's first run red.
    const root = await project({ 'package.json': manifest({ yaml: '^2' }) });
    expect((await deriveRoles(root, registry)).ok).toBe(true);
  });

  it('reports a team too wide to dispatch', async () => {
    // ADR-0059's own risk: "a 6-technology stack could imply a dozen roles". A
    // team that cannot run at once is a plan rather than a team.
    const wide = [
      registry[0] as RoleDefinition,
      ...Array.from({ length: 9 }, (_, i) =>
        role({ key: `r${String(i)}`, triggers: [`dep${String(i)}`] }),
      ),
    ];
    const root = await project({
      'package.json': manifest(
        Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`dep${String(i)}`, '^1'])),
      ),
    });

    const result = await deriveRoles(root, wide);
    expect(result.ok).toBe(false);
    expect(result.findings.join(' ')).toContain('role explosion');
  });

  it('counts specialists against the cap, not the orchestrator', async () => {
    // At exactly the cap this must pass. The orchestrator does not occupy a
    // concurrency slot — it is the thing dispatching into them — and counting
    // it would report an explosion one specialist early, every time.
    const atCap = [
      registry[0] as RoleDefinition,
      ...Array.from({ length: 8 }, (_, i) =>
        role({ key: `r${String(i)}`, triggers: [`dep${String(i)}`] }),
      ),
    ];
    const root = await project({
      'package.json': manifest(
        Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`dep${String(i)}`, '^1'])),
      ),
    });

    const result = await deriveRoles(root, atCap);
    expect(result.roles).toHaveLength(9);
    expect(result.ok).toBe(true);
  });

  it('fails on a structurally broken registry', async () => {
    // A registry problem is a defect, and unlike an uncovered technology it
    // must stop the run — the roles it describes cannot be dispatched as
    // written.
    const broken = [
      registry[0] as RoleDefinition,
      role({ key: 'sql', triggers: ['pg'] }),
      role({ key: 'sql', triggers: ['postgres'] }),
    ];
    const root = await project({ 'package.json': manifest({ pg: '^8' }) });

    const result = await deriveRoles(root, broken);
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('does not offer a specialist for the project’s own packages', async () => {
    const root = await project({
      'package.json': JSON.stringify({ name: 'app' }),
      'packages/core/package.json': JSON.stringify({ name: '@app/core' }),
      'packages/web/package.json': JSON.stringify({
        name: '@app/web',
        dependencies: { '@app/core': 'workspace:*' },
      }),
    });
    expect((await deriveRoles(root, registry)).technologies).toEqual([]);
  });

  it('derives real specialists for this repository’s own stack', async () => {
    // Dogfooding as a check, and it is the one that closes the vocabulary gap:
    // the shipped registry's triggers and the detector's output are written by
    // different hands, and nothing else compares them. A registry whose triggers
    // drift from what manifests actually say still passes every unit test —
    // they supply both halves and so always agree.
    const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const result = await deriveRoles(repo);

    const specialists = result.roles
      .map((r) => r.key)
      .filter((key) => key !== ORCHESTRATOR_KEY && key !== 'reviewer');
    expect(specialists.length).toBeGreaterThan(0);
    expect(specialists).toContain('sql');
    expect(result.violations).toEqual([]);
  }, 60_000);
});
