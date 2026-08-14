import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkGuide, createInitiative, docHealth } from './initiative.js';
import { init } from './commands.js';

/** P1-DOC-02 end to end. */

let root: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-init-')));
  await init(root, { database: 'skip' });
}, 60_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('init scaffolding', () => {
  it('creates the handoff folder and both indexes', async () => {
    await expect(fs.stat(path.join(root, 'docs', 'handoff', 'README.md'))).resolves.toBeDefined();
    // Index-first: a folder without a README is one an agent has to scan.
    await expect(
      fs.stat(path.join(root, 'docs', 'architectural-design-decisions', 'README.md')),
    ).resolves.toBeDefined();
  }, 60_000);

  it('says in the ADR index which decisions belong there', async () => {
    const text = await fs.readFile(
      path.join(root, 'docs', 'architectural-design-decisions', 'README.md'),
      'utf8',
    );
    expect(text).toContain('outside');
    expect(text).toContain('promoted');
  }, 60_000);
});

describe('createInitiative', () => {
  it('scaffolds the whole folder rather than one file at a time', async () => {
    const result = await createInitiative(root, {
      kind: 'feature',
      title: 'CSV import',
      date: '2026-08-10',
    });
    expect(result.dir).toContain('plan-2026-08-10-feature-csv-import');
    // The files created lazily are the ones never created: nobody opens an
    // empty initiative and thinks "this needs a UAT file".
    for (const file of ['qna.md', 'human-loop.md', 'VERIFICATION.md', 'UAT.md']) {
      expect(result.created.some((entry) => entry.endsWith(file))).toBe(true);
    }
    await expect(
      fs.stat(path.join(root, result.dir, 'decisions', 'README.md')),
    ).resolves.toBeDefined();
  }, 60_000);

  it('separates UAT from verification and says why', async () => {
    const result = await createInitiative(root, {
      kind: 'feature',
      title: 'CSV import',
      date: '2026-08-10',
    });
    const uat = await fs.readFile(path.join(root, result.dir, 'UAT.md'), 'utf8');
    // A passing suite and a satisfied user are different claims, and one has
    // never implied the other.
    expect(uat).toContain('different claims');
  }, 60_000);

  it('uses the date it was given, not today', async () => {
    const result = await createInitiative(root, {
      kind: 'sprint',
      title: 'hardening',
      date: '2025-01-02',
    });
    // A folder name that silently means "whenever this ran" is one that lies
    // later.
    expect(result.dir).toContain('plan-2025-01-02-sprint');
  }, 60_000);

  it('does not clobber an existing initiative', async () => {
    const input = { kind: 'feature' as const, title: 'CSV import', date: '2026-08-10' };
    await createInitiative(root, input);
    await fs.writeFile(
      path.join(root, 'docs', '.plan', 'plan-2026-08-10-feature-csv-import', 'qna.md'),
      'real content',
      'utf8',
    );
    const again = await createInitiative(root, input);
    expect(again.skipped.some((entry) => entry.endsWith('qna.md'))).toBe(true);
  }, 60_000);
});

describe('docHealth', () => {
  it('runs over the real workspace and never fails', async () => {
    const result = await docHealth(root);
    expect(result.report.ok).toBe(true);
    expect(result.docsScanned).toBeGreaterThan(0);
  }, 60_000);

  it('finds an orphan nobody links to', async () => {
    await fs.writeFile(
      path.join(root, 'docs', 'stray.md'),
      '# Stray\n\nnobody links here\n',
      'utf8',
    );
    const result = await docHealth(root);
    expect(result.report.findings.some((f) => f.doc === 'docs/stray.md')).toBe(true);
  }, 60_000);
});

describe('checkGuide (P1-DOC-03)', () => {
  const GOOD = [
    '# Importing a spreadsheet',
    '',
    'You can bring your data in from a spreadsheet. The tool reads each row.',
    'Rows it cannot read are listed for you.',
    '',
    '```mermaid',
    'flowchart LR',
    '  accTitle: How your spreadsheet becomes data',
    '  accDescr: Three steps, left to right.',
    '  A[You upload] --> B[We read it] --> C[You check]',
    '  classDef step fill:#1B4965,stroke:#0B2A3D,stroke-width:2px',
    '```',
    '',
  ].join('\n');

  it('passes a plain guide with an accessible diagram', async () => {
    await fs.writeFile(path.join(root, 'docs', 'guide.md'), GOOD, 'utf8');
    const result = await checkGuide(root, 'docs/guide.md');
    expect(result.ok).toBe(true);
  }, 60_000);

  it('fails on product jargon', async () => {
    await fs.writeFile(
      path.join(root, 'docs', 'guide.md'),
      GOOD.replace('The tool reads each row.', 'Each work item gets a context pack.'),
      'utf8',
    );
    const result = await checkGuide(root, 'docs/guide.md');
    // The usual failure is the implementer writing the guide in the vocabulary
    // they have been using all day, where it reads fine to them.
    expect(result.ok).toBe(false);
  }, 60_000);

  it('fails a diagram missing its accessibility hooks', async () => {
    await fs.writeFile(
      path.join(root, 'docs', 'guide.md'),
      GOOD.replace('  accDescr: Three steps, left to right.\n', ''),
      'utf8',
    );
    const result = await checkGuide(root, 'docs/guide.md');
    expect(result.ok).toBe(false);
    expect(result.diagrams[0]?.findings.some((f) => f.rule === 'acc-descr')).toBe(true);
  }, 60_000);
});
