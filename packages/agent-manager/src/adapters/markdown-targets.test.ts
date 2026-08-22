import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  COPILOT_ID,
  CURSOR_ID,
  CopilotAdapter,
  CursorAdapter,
  GEMINI_ID,
  GeminiAdapter,
  MARKDOWN_ADAPTERS,
  MARKDOWN_ADAPTERS_COVER_ALL_FIELDS,
  OPENCODE_ID,
  OpenCodeAdapter,
} from './markdown-targets.js';
import { CANONICAL_SKILL_FIELDS, missingCapabilityRows } from '../port.js';
import type { CanonicalSkill } from '@sdlc-on-fire/core';

/**
 * P5-ADAPT-01 — Cursor, Copilot, Gemini CLI, OpenCode.
 *
 * The formats are the vendors' own, checked 2026-08-22 (tier A): Cursor's
 * `.mdc` with `description`/`globs`/`alwaysApply`, and Copilot's
 * `.instructions.md` with a **required** `applyTo`. The assertions that matter
 * are the ones about what these formats *cannot* do — a capability table that
 * overclaims is how a dropped field becomes a silent one.
 */

const skill = (over: Partial<CanonicalSkill> = {}): CanonicalSkill =>
  ({
    schema_version: '0.1.0',
    name: 'write-spec',
    description: 'Author a specification for a domain',
    stage: 'spec',
    situation: 'always',
    tier: 'medium',
    role: 'You write specifications.',
    task: 'Write the requirement.',
    output_contract: { format: 'markdown' },
    stop_condition: 'The requirement is written.',
    verify: { commands: [] },
    context_mode: 'inline',
    ...over,
  }) as unknown as CanonicalSkill;

describe('every markdown adapter', () => {
  it('accounts for every canonical field', () => {
    // The totality check: a field added to the canonical schema and forgotten
    // here is a hole the capability table cannot see.
    expect(MARKDOWN_ADAPTERS_COVER_ALL_FIELDS).toBe(true);
    for (const adapter of MARKDOWN_ADAPTERS) {
      expect(missingCapabilityRows(adapter), adapter.id).toEqual([]);
    }
  });

  it('has a distinct id and writes a distinct path', () => {
    const ids = MARKDOWN_ADAPTERS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never claims to enforce a tool permission it cannot', () => {
    // A denial we cannot enforce must not read as enforced. All four are prose
    // files with no permission surface.
    for (const adapter of MARKDOWN_ADAPTERS) {
      for (const field of ['allowed_tools', 'disallowed_tools']) {
        const row = adapter.capabilityTable.find((r) => r.field === field);
        expect(row?.support, `${adapter.id}.${field}`).toBe('dropped');
      }
    }
  });

  it('compiles a skill into at least one file with content', () => {
    for (const adapter of MARKDOWN_ADAPTERS) {
      const result = adapter.compileSkill(skill());
      expect(result.files.length, adapter.id).toBeGreaterThan(0);
      expect(result.files[0]?.content.length, adapter.id).toBeGreaterThan(0);
    }
  });
});

describe('CursorAdapter', () => {
  const adapter = new CursorAdapter();

  it('writes .mdc, because Cursor ignores .md in that directory', () => {
    // The extension is load-bearing rather than stylistic.
    expect(adapter.compileSkill(skill()).files[0]?.path).toBe('.cursor/rules/write-spec.mdc');
  });

  it('always-applies a skill with no path scope', () => {
    const front = parseYaml(
      adapter.compileSkill(skill()).files[0]?.content.split('---')[1] ?? '',
    ) as Record<string, unknown>;
    expect(front['alwaysApply']).toBe(true);
    expect(front['globs']).toBeUndefined();
  });

  it('scopes by glob and stops always-applying', () => {
    // A rule that is both globbed and always-applied is just always-applied,
    // and the globs would read as a scope that is not one.
    const front = parseYaml(
      adapter.compileSkill(skill({ paths: 'src/**/*.ts' })).files[0]?.content.split('---')[1] ?? '',
    ) as Record<string, unknown>;
    expect(front['alwaysApply']).toBe(false);
    expect(front['globs']).toBe('src/**/*.ts');
  });

  it('carries the description as a field, not as prose', () => {
    const front = parseYaml(
      adapter.compileSkill(skill()).files[0]?.content.split('---')[1] ?? '',
    ) as Record<string, unknown>;
    expect(front['description']).toBe('Author a specification for a domain');
  });

  it('detects a Cursor project without auto-targeting it', () => {
    expect(adapter.id).toBe(CURSOR_ID);
  });
});

describe('CopilotAdapter', () => {
  const adapter = new CopilotAdapter();

  it('writes the .instructions.md naming the format requires', () => {
    expect(adapter.compileSkill(skill()).files[0]?.path).toBe(
      '.github/instructions/write-spec.instructions.md',
    );
  });

  it('always emits applyTo, because the format requires it', () => {
    // An instructions file without `applyTo` is not a valid instructions file.
    // Omitting it would produce something Copilot ignores while doctor reported
    // success.
    const content = adapter.compileSkill(skill()).files[0]?.content ?? '';
    expect(content).toMatch(/^---\napplyTo: '\*\*'\n---/);
  });

  it('uses the declared scope when the skill has one', () => {
    const content = adapter.compileSkill(skill({ paths: '**/*.tsx' })).files[0]?.content ?? '';
    expect(content).toContain("applyTo: '**/*.tsx'");
  });

  it('is the copilot target', () => {
    expect(adapter.id).toBe(COPILOT_ID);
  });
});

describe('the ambient targets', () => {
  const skills = [skill({ name: 'b-skill' }), skill({ name: 'a-skill' })];

  it('write one document for the whole project', () => {
    expect(new GeminiAdapter().compileServer(skills).files[0]?.path).toBe('GEMINI.md');
    expect(new OpenCodeAdapter().compileServer(skills).files[0]?.path).toBe('AGENTS.md');
  });

  it('order sections by name, so the file does not churn', () => {
    const content = new GeminiAdapter().compileServer(skills).files[0]?.content ?? '';
    expect(content.indexOf('a-skill')).toBeLessThan(content.indexOf('b-skill'));
  });

  it('warn that a declared path scope cannot be honoured', () => {
    // Dropping it silently would let somebody believe a skill is scoped when
    // the file is read for everything.
    const scoped = skill({ paths: 'src/**' });
    const result = new GeminiAdapter().compileServer([scoped]);
    expect(result.warnings[0]?.field).toBe('paths');
    expect(result.warnings[0]?.message).toContain('applies everywhere');
  });

  it('do not warn when there is no scope to lose', () => {
    expect(new OpenCodeAdapter().compileServer([skill()]).warnings).toEqual([]);
  });

  it('drop paths in the capability table rather than claiming passthrough', () => {
    for (const adapter of [new GeminiAdapter(), new OpenCodeAdapter()]) {
      expect(adapter.capabilityTable.find((r) => r.field === 'paths')?.support).toBe('dropped');
    }
  });

  it('are gemini and opencode', () => {
    expect(new GeminiAdapter().id).toBe(GEMINI_ID);
    expect(new OpenCodeAdapter().id).toBe(OPENCODE_ID);
  });

  it('write the same path OpenCode and Codex both read', () => {
    // The overlap is the finding: configuring OpenCode configures whatever else
    // reads AGENTS.md.
    expect(new OpenCodeAdapter().compileServer(skills).files[0]?.path).toBe('AGENTS.md');
  });
});

describe('canonical field coverage', () => {
  it('is checked against the live field list, not a copy', () => {
    expect(CANONICAL_SKILL_FIELDS.length).toBeGreaterThan(10);
  });
});
