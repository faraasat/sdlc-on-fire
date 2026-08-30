import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPILE_TARGETS, detectTargets } from './skills.js';

/**
 * `sdlc skills targets` (P8-CODEX-01).
 *
 * The command exists because `AgentAdapter.detect()` had **no caller** — seven
 * adapters implemented it and the only `.detect(` in the tree was the
 * importer's. These assertions are what stop it becoming an orphan again.
 */
describe('detectTargets', () => {
  it('asks every registered target, not just the ones that answer', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'targets-'));
    try {
      const reports = await detectTargets(root);
      expect(reports.map((report) => report.target).sort()).toEqual(
        Object.keys(COMPILE_TARGETS).sort(),
      );
      // An empty directory is every target absent — never an error, and never
      // a silently short list.
      expect(reports.every((report) => !report.present)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('finds Codex by its own directory rather than by the shared convention', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'targets-'));
    try {
      await fs.mkdir(path.join(root, '.agents', 'skills'), { recursive: true });
      const reports = await detectTargets(root);
      const codex = reports.find((report) => report.target === 'codex');
      const opencode = reports.find((report) => report.target === 'opencode');
      expect(codex?.present).toBe(true);
      // `AGENTS.md` is the cross-tool convention. Without it, OpenCode has no
      // signal — which is the overlap worth being able to see.
      expect(opencode?.present).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('is sorted, so two runs on the same tree produce the same report', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'targets-'));
    try {
      const names = (await detectTargets(root)).map((report) => report.target);
      expect(names).toEqual([...names].sort());
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
