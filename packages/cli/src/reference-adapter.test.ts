import { describe, expect, it } from 'vitest';
import { CANONICAL_SKILLS, runDoctor, type AgentAdapter } from '@sdlc-on-fire/agent-manager';
import { COMPILE_TARGETS } from './skills.js';

/**
 * One canonical, CI-checked reference per target (P5-ADAPT-02, ADR-0034).
 *
 * Six adapters now compile the same canonical source, and the failure this file
 * exists to prevent is **drift**: five targets get updated when the schema
 * changes and the sixth quietly keeps emitting last month's shape. Nobody
 * notices, because each adapter's own tests still pass — they are testing the
 * adapter against itself.
 *
 * So the reference is not a golden file per target. Golden files break on every
 * cosmetic change and get regenerated without being read, which converts a
 * drift detector into a rubber stamp. What is pinned instead are the properties
 * that must hold for **every** target at once, checked against the live
 * `COMPILE_TARGETS` registry — so a seventh adapter is covered the moment it is
 * registered, without anybody remembering to add it here.
 */

const targets = Object.entries(COMPILE_TARGETS).map(([id, build]) => ({ id, adapter: build() }));
const skills = Object.values(CANONICAL_SKILLS);
const reference = skills[0];

describe('every registered compile target', () => {
  it('is registered under the id it reports', () => {
    // A registry key that disagrees with the adapter's own id makes `--target`
    // and every error message point at different things.
    for (const { id, adapter } of targets) expect(adapter.id, id).toBe(id);
  });

  it('covers all seven surfaces', () => {
    // P5-ADAPT-01's deliverable, asserted rather than described — plus `codex`,
    // added by P8-CODEX-01. The list is pinned rather than counted because a
    // count passes when one target is swapped for another, and this assertion
    // did its job: adding Codex failed here first.
    expect(targets.map((t) => t.id).sort()).toEqual([
      'claude-code',
      'codex',
      'copilot',
      'cursor',
      'gemini',
      'mcp',
      'opencode',
    ]);
  });

  it('compiles the reference skill to at least one non-empty file', () => {
    for (const { id, adapter } of targets) {
      const result = compile(adapter);
      expect(result.files.length, id).toBeGreaterThan(0);
      for (const file of result.files) {
        expect(file.path, id).not.toBe('');
        expect(file.content.trim(), `${id}:${file.path}`).not.toBe('');
      }
    }
  });

  it('writes only relative paths inside the project', () => {
    // A compiled artifact escaping the workspace is the one output nobody
    // reviews, because it is not in the diff.
    for (const { id, adapter } of targets) {
      for (const file of compile(adapter).files) {
        expect(file.path.startsWith('/'), `${id}:${file.path}`).toBe(false);
        expect(file.path.includes('..'), `${id}:${file.path}`).toBe(false);
      }
    }
  });

  it('accounts for every canonical field in its capability table', () => {
    // The totality guard, applied across the whole registry rather than once
    // per adapter's own test file.
    for (const { id, adapter } of targets) {
      const report = runDoctor({ skills, adapters: [adapter] });
      const holes = report.findings.filter((f) => f.severity === 'error');
      expect(holes, `${id}: ${holes.map((h) => h.message).join('; ')}`).toEqual([]);
    }
  });

  it('produces the same output twice — compilation is a function', () => {
    // A compiler that varies between runs makes every diff untrustworthy and
    // every "no changes" reassurance meaningless.
    for (const { id, adapter } of targets) {
      expect(compile(adapter), id).toEqual(compile(adapter));
    }
  });

  it('declares a max schema version it can honour', () => {
    for (const { id, adapter } of targets) {
      expect(adapter.maxSchemaVersion, id).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('never emits two files at the same path for one project', () => {
    // Two adapters may legitimately write the same path — OpenCode and Codex
    // both use AGENTS.md — but one adapter writing a path twice silently drops
    // whichever it wrote first.
    for (const { id, adapter } of targets) {
      const paths = compileAll(adapter).map((f) => f.path);
      expect(new Set(paths).size, `${id}: ${paths.join(', ')}`).toBe(paths.length);
    }
  });
});

function compile(adapter: AgentAdapter) {
  if (reference === undefined) throw new Error('no canonical skills to compile');
  return adapter.compileServer?.([reference]) ?? adapter.compileSkill(reference);
}

function compileAll(adapter: AgentAdapter) {
  if (adapter.compileServer !== undefined) return adapter.compileServer(skills).files;
  return skills.flatMap((skill) => adapter.compileSkill(skill).files);
}
