import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatResearchScan, newResearch, scanResearch, workspaceManifests } from './research.js';

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
 * `sdlc research` against a real tree (P2-RES-01).
 *
 * Two of these pin defects the unit tests could not have found, because both
 * were about what the command reads rather than what it decides. Running it on
 * this repository reported **one** technology — a pnpm workspace root holds
 * nothing but tooling — and asked for a research folder about the project
 * itself.
 */

const dirs: string[] = [];

async function project(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-research-'));
  dirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
  return root;
}

const manifest = (name: string, deps: Record<string, string>): string =>
  JSON.stringify({ name, dependencies: deps });

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, ...RM_RETRY })),
  );
});

describe('scanResearch', () => {
  it('reads workspace manifests, not only the root one', async () => {
    // The defect: a pnpm workspace root carries tooling and nothing else, so a
    // root-only scan reported "1 technology, all researched" over a dozen
    // unexamined dependencies — this command producing the exact failure it
    // exists to prevent.
    const root = await project({
      'package.json': manifest('root', {}),
      'packages/core/package.json': manifest('@app/core', { zod: '^4' }),
      'packages/web/package.json': manifest('@app/web', { next: '^15' }),
    });

    const result = await scanResearch(root, { today: '2026-08-14' });
    expect(result.manifests).toHaveLength(3);
    expect(result.detected.map((tech) => tech.tech).sort()).toEqual(['next', 'zod']);
  });

  it('does not ask a project to research itself', async () => {
    // Workspace members appear in each other's dependencies like anything else.
    // Collected from the manifests rather than guessed from a name prefix.
    const root = await project({
      'package.json': manifest('app', {}),
      'packages/core/package.json': manifest('@app/core', {}),
      'packages/web/package.json': manifest('@app/web', { '@app/core': 'workspace:*' }),
    });

    expect((await scanResearch(root, { today: '2026-08-14' })).detected).toEqual([]);
  });

  it('is not a passing scan when there is no manifest at all', async () => {
    // "No technologies found" and "nothing was read" produce the same list.
    const root = await project({ 'README.md': '# nothing here\n' });
    const result = await scanResearch(root, { today: '2026-08-14' });
    expect(result.ok).toBe(false);
    expect(formatResearchScan(result)).toContain('not the same as nothing to research');
  });

  it('passes once a technology has real, dated, sourced research', async () => {
    const dated = (body: string): string =>
      [
        '---',
        'tech: zod',
        'researched-on: 2026-08-01',
        'refresh-by: 2026-11-01',
        'sources:',
        '  - https://zod.dev/',
        '---',
        '',
        body.repeat(20),
      ].join('\n');

    const root = await project({
      'package.json': manifest('app', { zod: '^4' }),
      'docs/.research/zod/docs.md': dated('Schema-first validation, v4 surface. '),
      'docs/.research/zod/optimizations.md': dated('Parse once at the boundary. '),
      'docs/.research/zod/api-contract.md': dated('z.object, z.infer, superRefine. '),
      'docs/.research/zod/scaffold.md': dated('No official scaffolding CLI exists. '),
    });

    const result = await scanResearch(root, { today: '2026-08-14' });
    expect(result.ok).toBe(true);
    expect(result.verdicts[0]?.status).toBe('current');
  });

  it('fails the same folder once its refresh-by has passed', async () => {
    const root = await project({ 'package.json': manifest('app', { zod: '^4' }) });
    const dir = path.join(root, 'docs', '.research', 'zod');
    await fs.mkdir(dir, { recursive: true });
    for (const file of ['docs.md', 'optimizations.md', 'api-contract.md', 'scaffold.md']) {
      await fs.writeFile(
        path.join(dir, file),
        `---\ntech: zod\nresearched-on: 2025-01-01\nrefresh-by: 2025-04-01\nsources:\n  - https://zod.dev/\n---\n\n${'Real research, once. '.repeat(20)}`,
        'utf8',
      );
    }

    const result = await scanResearch(root, { today: '2026-08-14' });
    expect(result.ok).toBe(false);
    expect(result.verdicts[0]?.status).toBe('stale');
  });
});

describe('newResearch', () => {
  it('creates a dated skeleton that does NOT pass the check', async () => {
    // The property worth pinning. A scaffolder whose output satisfies the
    // checker has not produced research — it has produced a pass, and the next
    // person to look sees a green check over four files of prompts.
    const root = await project({ 'package.json': manifest('app', { zod: '^4' }) });

    const created = await newResearch(root, 'zod', { today: '2026-08-14' });
    expect(created.created).toHaveLength(4);
    expect(created.refreshBy).toBe('2026-11-12');

    const result = await scanResearch(root, { today: '2026-08-14' });
    expect(result.ok).toBe(false);
    expect(result.verdicts[0]?.status).toBe('unsourced');
  });

  it('never overwrites research that is already there', async () => {
    const root = await project({
      'package.json': manifest('app', { zod: '^4' }),
      'docs/.research/zod/docs.md': 'real research\n',
    });

    const created = await newResearch(root, 'zod', { today: '2026-08-14' });
    expect(created.skipped).toContain('docs/.research/zod/docs.md');
    expect(await fs.readFile(path.join(root, 'docs/.research/zod/docs.md'), 'utf8')).toBe(
      'real research\n',
    );
  });

  it('records the official CLI when the registry knows one', async () => {
    const root = await project({ 'package.json': manifest('app', { next: '^15' }) });
    await newResearch(root, 'next', { today: '2026-08-14' });

    const scaffold = await fs.readFile(path.join(root, 'docs/.research/next/scaffold.md'), 'utf8');
    expect(scaffold).toContain('npx create-next-app@latest');
    // With its source and the date it was checked — a bare command is the
    // training-data artifact ADR-0045 exists to prevent.
    expect(scaffold).toContain('https://nextjs.org/docs');
    expect(scaffold).toContain('checked 2026-08-14');
  });

  it('says no CLI is known rather than inventing one', async () => {
    const root = await project({ 'package.json': manifest('app', { zod: '^4' }) });
    await newResearch(root, 'zod', { today: '2026-08-14' });

    const scaffold = await fs.readFile(path.join(root, 'docs/.research/zod/scaffold.md'), 'utf8');
    expect(scaffold).toContain('no official CLI exists');
    expect(scaffold).not.toContain('npx create-');
  });

  it('honours the cadence rather than always using 90 days', async () => {
    const root = await project({ 'package.json': manifest('app', { next: '^15' }) });
    const created = await newResearch(root, 'next', { today: '2026-08-14', cadence: 'churning' });
    expect(created.refreshBy).toBe('2026-10-13');
  });
});

describe('workspaceManifests', () => {
  it('skips node_modules, which is not the project', async () => {
    const root = await project({
      'package.json': manifest('app', {}),
      'node_modules/left-pad/package.json': manifest('left-pad', {}),
    });
    expect(await workspaceManifests(root)).toHaveLength(1);
  });
});
