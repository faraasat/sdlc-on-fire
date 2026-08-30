import { describe, expect, it } from 'vitest';
import type { IrNode } from '@sdlc-on-fire/importers';
import { targetPathFor } from './import.js';

/**
 * Filename collisions (P8-MIGRATE-01).
 *
 * Found by importing `radius-project/radius` — a real project from the wild,
 * 3,834 files, using Spec Kit for real. It produced **51 spec nodes and 48
 * files**: three specs silently lost, and a re-run reporting three conflicts on
 * paths the first run had written itself.
 *
 * Our own round-trip fixtures could not see it, because we wrote them with
 * unique identifiers. Spec Kit numbers `FR-001` independently per feature
 * directory, so any repository with more than one feature collides.
 */
describe('targetPathFor', () => {
  const node = (sourcePath: string, id: string): IrNode =>
    ({
      kind: 'spec',
      title: 'A spec',
      body: 'body',
      preservedIdentifiers: [],
      externalRef: { source_tool: 'speckit', source_path: sourcePath, source_id_or_hash: id },
    }) as unknown as IrNode;

  it('gives two features with the same identifier set different files', () => {
    // The exact shape that lost three specs on a real repository.
    const a = targetPathFor('/w', node('specs/001-alpha/spec.md', 'FR-001-FR-002'));
    const b = targetPathFor('/w', node('specs/002-beta/spec.md', 'FR-001-FR-002'));
    expect(a).not.toBe(b);
  });

  it('gives the same node the same file every time', () => {
    // Without this the import is never idempotent: every run writes a new name.
    const one = node('specs/001-alpha/spec.md', 'FR-001');
    expect(targetPathFor('/w', one)).toBe(targetPathFor('/w', one));
  });

  it('separates two identifier sets that share a 40-character prefix', () => {
    // The old 48-character truncation collided long lists whose sets differed.
    const long = 'FR-001-FR-002-FR-003-FR-004-FR-005-FR-006-FR-007-FR-008';
    const a = targetPathFor('/w', node('specs/001/spec.md', `${long}-FR-009`));
    const b = targetPathFor('/w', node('specs/001/spec.md', `${long}-FR-010`));
    expect(a).not.toBe(b);
  });

  it('keeps the identifiers readable in the name', () => {
    // A bare hash would be collision-free and unusable. Somebody scanning
    // `docs/_imported/spec/` needs to see what a file is about.
    expect(targetPathFor('/w', node('specs/001/spec.md', 'FR-001-FR-002'))).toContain(
      'FR-001-FR-002',
    );
  });

  it('still produces a name when the identifier part is empty', () => {
    expect(targetPathFor('/w', node('specs/001/spec.md', ''))).toMatch(/\/[0-9a-f]{8}\.md$/);
  });

  it('routes specs to docs and everything else to kanban', () => {
    expect(targetPathFor('/w', node('s.md', 'FR-1'))).toContain('docs');
    const task = { ...node('s.md', 'T-1'), kind: 'task' } as unknown as IrNode;
    expect(targetPathFor('/w', task)).toContain('kanban');
  });
});
