import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanonicalSkillSchema, type CanonicalSkill } from '@sdlc-on-fire/core';
import { afterEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../doctor.js';
import { missingCapabilityRows } from '../port.js';
import { ClaudeCodeAdapter, CLAUDE_COVERS_ALL_FIELDS } from './claude-code.js';

function skill(overrides: Record<string, unknown> = {}): CanonicalSkill {
  return CanonicalSkillSchema.parse({
    schema_version: '0.1.0',
    name: 'implement',
    description: 'Implement a scoped task.',
    stage: 'implement',
    tier: 'medium',
    context_pack_spec_ref: 'context-packs/implement.yaml',
    role: 'You are the Implementer agent.',
    constitution_excerpt_ref: 'constitution#engineering',
    task: 'Implement {{task_id}}.',
    output_contract: { tool_name: 'implement_output', json_schema_ref: 'schemas/impl.json' },
    stop_condition: 'Stop after one report.',
    verify: { command_template: 'pnpm test', done_criteria_ref: 'task#done' },
    ...overrides,
  });
}

const adapter = new ClaudeCodeAdapter();
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('capability totality', () => {
  it('accounts for every canonical field', () => {
    expect(CLAUDE_COVERS_ALL_FIELDS).toBe(true);
    expect(missingCapabilityRows(adapter)).toEqual([]);
  });
});

describe('compilation', () => {
  it('writes to the Claude Code skill path', () => {
    const [file] = adapter.compileSkill(skill()).files;
    expect(file?.path).toBe('.claude/skills/implement/SKILL.md');
  });

  it('is deterministic — same input, byte-identical output', () => {
    // Contract §3 requirement 1. A non-deterministic compiler makes every
    // regeneration a spurious diff.
    const a = adapter.compileSkill(skill()).files[0]?.content;
    const b = adapter.compileSkill(skill()).files[0]?.content;
    expect(a).toBe(b);
  });

  it('maps tier to effort rather than to a model id', () => {
    const content = adapter.compileSkill(skill({ tier: 'high' })).files[0]?.content ?? '';
    expect(content).toContain('effort: high');
    expect(content).not.toContain('claude-');
  });

  it('omits context for inline skills and emits it for fork', () => {
    // `inline` is Claude Code's default, so emitting it would be noise.
    expect(adapter.compileSkill(skill()).files[0]?.content).not.toContain('context:');
    expect(adapter.compileSkill(skill({ context_mode: 'fork' })).files[0]?.content).toContain(
      'context: fork',
    );
  });

  it('passes tool grants through under Claude native names', () => {
    const content =
      adapter.compileSkill(skill({ allowed_tools: ['Read'], disallowed_tools: ['Bash'] })).files[0]
        ?.content ?? '';
    expect(content).toContain('allowed-tools:');
    expect(content).toContain('disallowed-tools:');
  });

  it('keeps slots unresolved in the compiled template', () => {
    // The compiled file is a template the surface fills at invocation.
    expect(adapter.compileSkill(skill()).files[0]?.content).toContain('{{task_id}}');
  });

  it('renders the output contract into the body', () => {
    const content = adapter.compileSkill(skill()).files[0]?.content ?? '';
    expect(content).toContain('implement_output');
    expect(content).toContain('## Role');
    expect(content).toContain('## Stop condition');
  });

  it('never emits doctor-only fields', () => {
    const content =
      adapter.compileSkill(
        skill({
          deprecation: { deprecated_since: '0.1.0', removal_tier: 'warn' },
        }),
      ).files[0]?.content ?? '';
    expect(content).not.toContain('deprecated_since');
  });

  it('warns on a deprecated skill without refusing to compile it', () => {
    // Refusing would break a working workspace on upgrade.
    const result = adapter.compileSkill(
      skill({ deprecation: { deprecated_since: '0.1.0', removal_tier: 'warn' } }),
    );
    expect(result.files).toHaveLength(1);
    expect(result.warnings.some((w) => w.field === 'deprecation')).toBe(true);
  });
});

describe('detection', () => {
  it('reports absence with evidence rather than a bare boolean', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-detect-'));
    tempDirs.push(dir);

    const report = await adapter.detect(dir);
    expect(report.present).toBe(false);
    expect(report.findings).toEqual([]);
  });

  it('finds a Claude Code project', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-detect-'));
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), '# x');

    const report = await adapter.detect(dir);
    expect(report.present).toBe(true);
    expect(report.findings).toContain('found CLAUDE.md');
  });
});

describe('doctor', () => {
  it('passes a clean skill against a complete adapter', () => {
    const report = runDoctor({ skills: [skill()], adapters: [adapter] });
    expect(report.ok).toBe(true);
    expect(report.findings.some((f) => f.severity === 'error')).toBe(false);
  });

  it('errors on a skill from a future schema version instead of compiling it', () => {
    const report = runDoctor({
      skills: [skill({ schema_version: '9.0.0' })],
      adapters: [adapter],
    });
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.field).toBe('schema_version');
  });

  it('errors when an adapter forgot a capability row', () => {
    const broken = new ClaudeCodeAdapter();
    Object.defineProperty(broken, 'capabilityTable', {
      value: [{ field: 'name', support: 'mapped' as const }],
    });

    const report = runDoctor({ skills: [skill()], adapters: [broken] });
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.field === 'allowed_tools')).toBe(true);
  });

  it('reports a dropped field only when the skill actually sets it', () => {
    const withVerifyOnly = runDoctor({ skills: [skill()], adapters: [adapter] });
    // `verify` is always set, so it is reported; `deprecation` is not set here.
    expect(withVerifyOnly.findings.some((f) => f.field === 'verify')).toBe(true);
    expect(withVerifyOnly.findings.some((f) => f.field === 'deprecation')).toBe(false);
  });

  it('does not let warnings fail the run', () => {
    const report = runDoctor({
      skills: [skill({ deprecation: { deprecated_since: '0.1.0', removal_tier: 'warn' } })],
      adapters: [adapter],
    });
    expect(report.findings.some((f) => f.severity === 'warning')).toBe(true);
    expect(report.ok).toBe(true);
  });
});
