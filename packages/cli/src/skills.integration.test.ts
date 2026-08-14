import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CANONICAL_SKILLS,
  ClaudeCodeAdapter,
  type AgentAdapter,
  type CompileResult,
} from '@sdlc-on-fire/agent-manager';
import type { CanonicalSkill } from '@sdlc-on-fire/core';
import { compileSkills, doctorSkills, formatCompile } from './skills.js';

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
 * `sdlc skills doctor` / `sdlc skills compile` — the v0.1 DoD item 2 surface.
 *
 * The library underneath had tests and passed them throughout; what was missing
 * was any way for a user to reach it. So the tests that matter here are the ones
 * about the command's own contract: that the doctor runs before anything is
 * written, that a refusal writes nothing, and that compiling twice is a no-op.
 */

const dirs: string[] = [];
async function tempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-skills-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, ...RM_RETRY })),
  );
});

/** An adapter that cannot account for the canonical fields — an error finding. */
class IncompleteAdapter implements AgentAdapter {
  readonly id = 'incomplete';
  readonly capabilityTable = [];
  readonly maxSchemaVersion = '0.1.0';
  compileSkill(): CompileResult {
    return {
      files: [{ path: '.incomplete/SKILL.md', content: 'x', mode: 'overwrite' }],
      warnings: [],
    };
  }
  detect(): Promise<{ target: string; present: boolean; findings: string[] }> {
    return Promise.resolve({ target: this.id, present: false, findings: [] });
  }
}

const someSkill = (): CanonicalSkill => Object.values(CANONICAL_SKILLS)[0] as CanonicalSkill;

describe('skills doctor', () => {
  it('passes on the skills and target we actually ship', () => {
    const report = doctorSkills();
    // Findings are fine — dropped fields are reported as info. What must hold is
    // that nothing is error-severity, since that is what blocks a compile.
    expect(report.ok).toBe(true);
  });

  it('fails when a target cannot account for the canonical fields', () => {
    const report = doctorSkills({ skills: [someSkill()], adapters: [new IncompleteAdapter()] });
    // A capability row nobody filled in means a field silently vanishes on
    // compile — `allowed_tools` disappearing is a security boundary removed.
    expect(report.ok).toBe(false);
  });
});

describe('skills compile', () => {
  it('writes a real SKILL.md for every canonical skill', async () => {
    const root = await tempRoot();
    const result = await compileSkills(root);

    expect(result.files.length).toBeGreaterThan(0);
    for (const file of result.files) {
      const content = await fs.readFile(path.join(root, file.path), 'utf8');
      expect(content.startsWith('---\n')).toBe(true);
      expect(content).toContain('## Role');
    }
  });

  it('is deterministic — compiling twice changes nothing', async () => {
    const root = await tempRoot();
    await compileSkills(root);
    const second = await compileSkills(root);

    // Compilation is mechanical field projection with no model call, so a second
    // run that rewrote files would mean something non-deterministic leaked in —
    // and a skill surface that churns makes every diff unreadable.
    expect(second.files.every((file) => !file.changed)).toBe(true);
  });

  it('refuses to write anything when the pre-compile check errors', async () => {
    const root = await tempRoot();
    await expect(
      compileSkills(root, { skills: [someSkill()], adapters: [new IncompleteAdapter()] }),
    ).rejects.toThrow(/refusing to compile/);

    // Nothing on disk. A compiled surface that is wrong is worse than an absent
    // one: the agent reads it as authoritative and nothing re-checks it.
    await expect(fs.readdir(path.join(root, '.incomplete'))).rejects.toThrow();
  });

  it('writes nothing on a dry run, and still reports what would change', async () => {
    const root = await tempRoot();
    const result = await compileSkills(root, { dryRun: true });

    expect(result.files.every((file) => file.changed)).toBe(true);
    await expect(fs.readdir(path.join(root, '.claude'))).rejects.toThrow();
  });

  it('reports an unchanged compile as up to date rather than as work done', async () => {
    const root = await tempRoot();
    await compileSkills(root);
    const text = formatCompile(await compileSkills(root), false);
    expect(text).toContain('already up to date');
  });

  it('compiles to the path the Claude Code surface actually reads', async () => {
    const root = await tempRoot();
    const result = await compileSkills(root, { adapters: [new ClaudeCodeAdapter()] });
    // `.claude/skills/<name>/SKILL.md` is the contract with the agent surface;
    // a compile that lands anywhere else produces files nothing ever loads.
    expect(result.files.map((f) => f.path)).toContain('.claude/skills/spec/SKILL.md');
  });
});

describe('the MCP target, through the command (P2-AGT-01)', () => {
  it('compiles to one server document, not one file per skill', async () => {
    // The whole reason the port grew `compileServer`. A loop over
    // `compileSkill` would put every tool on disk and no server — each tool
    // present, and nothing for a client to connect to.
    const root = await tempRoot();
    const result = await compileSkills(root, { target: 'mcp' });

    expect(result.target).toBe('mcp');
    expect(result.files.map((file) => file.path)).toEqual(['.mcp/sdlc-on-fire.json']);
  });

  it('writes a document a client could read, with every skill in it', async () => {
    const root = await tempRoot();
    await compileSkills(root, { target: 'mcp' });

    const document = JSON.parse(
      await fs.readFile(path.join(root, '.mcp', 'sdlc-on-fire.json'), 'utf8'),
    ) as {
      protocolVersion: string;
      capabilities: Record<string, unknown>;
      tools: { name: string; inputSchema: Record<string, unknown> }[];
    };

    expect(document.protocolVersion).toBe('2025-11-25');
    expect(document.tools).toHaveLength(Object.keys(CANONICAL_SKILLS).length);
    // Every tool callable: the spec requires a JSON Schema object here, and a
    // tool whose `inputSchema` is missing lists fine and cannot be invoked.
    for (const tool of document.tools) {
      expect(tool.name.startsWith('sdlc__')).toBe(true);
      expect(tool.inputSchema['type']).toBe('object');
    }
    expect(document.capabilities).toEqual({ tools: { listChanged: false } });
  });

  it('recompiles to a zero diff', async () => {
    // Contract §3 point 4, and the one property the whole "regeneration is a
    // disposable build step" convention rests on.
    const root = await tempRoot();
    await compileSkills(root, { target: 'mcp' });
    const again = await compileSkills(root, { target: 'mcp' });
    expect(again.files.every((file) => !file.changed)).toBe(true);
  });

  it('does not write the Claude surface when asked for MCP', async () => {
    const root = await tempRoot();
    await compileSkills(root, { target: 'mcp' });
    await expect(fs.stat(path.join(root, '.claude'))).rejects.toThrow();
  });

  it('names an unknown target rather than defaulting to one', async () => {
    // A typo that quietly compiles to Claude Code reports success and writes to
    // the wrong surface.
    const root = await tempRoot();
    await expect(compileSkills(root, { target: 'mcp-server' })).rejects.toThrow(/unknown target/);
  });

  it('passes its own doctor', () => {
    expect(doctorSkills({ target: 'mcp' }).ok).toBe(true);
  });
});
