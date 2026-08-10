import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DetectionResult, ToolParser } from '@sdlc-on-fire/importers';
import { detectTools, formatDetect } from './detect.js';

/**
 * `sdlc detect` (P2-IMP-02).
 *
 * The behaviour that matters is what it does with *more than one* answer, and
 * with a weak one — a detector that only ever reports its best guess is telling
 * a mid-migration repo something false about itself.
 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const stub = (
  toolId: string,
  result: Partial<DetectionResult> & Pick<DetectionResult, 'matched'>,
): ToolParser => ({
  toolId,
  dialect: 'v1',
  detect: () =>
    Promise.resolve({
      toolId,
      dialect: 'v1',
      confidence: 'high' as const,
      evidence: [`${toolId} marker`],
      ...result,
    }),
  parse: () => Promise.resolve({ items: [], warnings: [], skippedFiles: [] }),
});

describe('detectTools', () => {
  it('finds a real OpenSpec tree through the shipped parser list', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'detect-'));
    dirs.push(root);
    await fs.mkdir(path.join(root, 'openspec', 'specs', 'auth'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'openspec', 'specs', 'auth', 'spec.md'),
      '### Requirement: Login\nThe system SHALL log in.\n',
      'utf8',
    );

    const result = await detectTools(root);
    expect(result.matches.map((m) => m.toolId)).toEqual(['openspec']);
    expect(result.matches[0]?.confidence).toBe('high');
  });

  it('reports every match, not just the most confident', async () => {
    const result = await detectTools('/nowhere', [
      stub('openspec', { matched: true, confidence: 'high' }),
      stub('gsd', { matched: true, confidence: 'low' }),
    ]);
    // A repo mid-migration runs two tools at once. Reporting only the winner
    // hides exactly the one the user did not expect to still be there.
    expect(result.matches).toHaveLength(2);
    expect(result.coexisting).toBe(true);
  });

  it('omits parsers that did not match', async () => {
    const result = await detectTools('/nowhere', [
      stub('openspec', { matched: true }),
      stub('bmad', { matched: false }),
    ]);
    expect(result.matches.map((m) => m.toolId)).toEqual(['openspec']);
    expect(result.coexisting).toBe(false);
  });

  it('survives a parser that throws during detection', async () => {
    const exploding: ToolParser = {
      toolId: 'broken',
      dialect: 'v1',
      detect: () => Promise.reject(new Error('boom')),
      parse: () => Promise.resolve({ items: [], warnings: [], skippedFiles: [] }),
    };
    const result = await detectTools('/nowhere', [exploding, stub('openspec', { matched: true })]);
    // One parser's failure must not take the other answers down with it.
    expect(result.matches.map((m) => m.toolId)).toEqual(['openspec']);
  });
});

describe('formatDetect', () => {
  it('says plainly when nothing matched, and why that is fine', () => {
    const text = formatDetect({ root: '/x', matches: [], coexisting: false });
    expect(text).toContain('No supported source format found');
    // "Nothing to import" is a normal answer, not a failure to be apologised for.
    expect(text).toContain('normal answer');
  });

  it('attaches the evidence to every verdict', async () => {
    const result = await detectTools('/nowhere', [stub('openspec', { matched: true })]);
    // A bare confidence level with no reasons is a verdict nobody can check.
    expect(formatDetect(result)).toContain('openspec marker');
  });

  it('flags a less-than-high match for dry-run review, at the point of doubt', async () => {
    const result = await detectTools('/nowhere', [
      stub('gsd', { matched: true, confidence: 'medium' }),
    ]);
    const text = formatDetect(result);
    expect(text).toContain('review a dry-run');
  });

  it('does not nag about a high-confidence match', async () => {
    const result = await detectTools('/nowhere', [stub('openspec', { matched: true })]);
    expect(formatDetect(result)).not.toContain('review a dry-run');
  });

  it('orders the strongest match first', async () => {
    const result = await detectTools('/nowhere', [
      stub('weak', { matched: true, confidence: 'low' }),
      stub('strong', { matched: true, confidence: 'high' }),
    ]);
    const text = formatDetect(result);
    expect(text.indexOf('strong')).toBeLessThan(text.indexOf('weak'));
  });
});
