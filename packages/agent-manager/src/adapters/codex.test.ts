import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CanonicalSkill } from '@sdlc-on-fire/core';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CodexAdapter, CODEX_CAPABILITY_TABLE, CODEX_ID, CODEX_SKILLS_DIR } from './codex.js';
import { missingCapabilityRows } from '../port.js';

/**
 * The Codex target (P8-CODEX-01, ADR-0063) and the drift check (P8-CODEX-02).
 *
 * The format facts asserted here are the vendor's own, fetched 2026-08-31 — the
 * `.agents/skills/<name>/SKILL.md` path and the `name` + `description`
 * frontmatter requirement. They are pinned by test because the whole reason
 * this adapter exists is that a wrong path produces a tree Codex ignores while
 * our doctor reports success.
 */

const skill = (over: Partial<CanonicalSkill> = {}): CanonicalSkill =>
  ({
    schema_version: '0.1.0',
    name: 'implement',
    description: 'Write the code for one work item',
    stage: 'implement',
    situation: 'always',
    tier: 'medium',
    role: 'You are the implementer.',
    task: 'Implement the card.',
    output_contract: { tool_name: 'implement_result', json_schema_ref: 'schemas/implement.json' },
    stop_condition: 'The verify command passes.',
    verify: { command_template: 'pnpm test', done_criteria_ref: 'docs/dod.md' },
    context_mode: 'inline',
    ...over,
  }) as unknown as CanonicalSkill;

describe('CodexAdapter', () => {
  const adapter = new CodexAdapter();

  it('writes to .agents/skills, which is not the directory anybody guesses', () => {
    // `.codex/` is the natural guess and it is wrong. Guessing it would produce
    // a tree Codex silently ignores while `agents doctor` reported success —
    // the same shape as Cursor's load-bearing `.mdc` extension.
    const result = adapter.compileSkill(skill());
    expect(result.files[0]?.path).toBe('.agents/skills/implement/SKILL.md');
    expect(CODEX_SKILLS_DIR).toBe('.agents/skills');
  });

  it('emits exactly the two frontmatter fields Codex documents as required', () => {
    // Not a copy of the Claude table. Codex says richer metadata belongs in
    // `agents/openai.yaml`, so inventing frontmatter fields here would repeat
    // the compiled-`arguments`-block mistake against a different vendor.
    const content = adapter.compileSkill(skill()).files[0]?.content ?? '';
    const frontmatter = content.split('---')[1] ?? '';
    expect(frontmatter).toContain('name: implement');
    expect(frontmatter).toContain('description:');
    expect(frontmatter).not.toContain('allowed-tools');
    expect(frontmatter).not.toContain('stage:');
  });

  it('warns that a declared tool restriction is not enforced', () => {
    // The security-relevant difference. Claude Code's frontmatter narrows what a
    // skill may reach; Codex's does not, so the canonical skill says a boundary
    // exists and the compiled artifact does not carry it.
    const result = adapter.compileSkill(skill({ allowed_tools: ['Read', 'Bash'] }));
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ field: 'allowed_tools', target: CODEX_ID });
    expect(result.warnings[0]?.message).toContain('does not enforce');
  });

  it('warns separately for disallowed_tools', () => {
    const result = adapter.compileSkill(
      skill({ allowed_tools: ['Read'], disallowed_tools: ['Bash'] }),
    );
    expect(result.warnings.map((warning) => warning.field).sort()).toEqual([
      'allowed_tools',
      'disallowed_tools',
    ]);
  });

  it('stays quiet when no restriction was declared', () => {
    // A warning on every skill is a warning nobody reads.
    expect(adapter.compileSkill(skill()).warnings).toEqual([]);
  });

  it('accounts for every canonical field — the totality check', () => {
    // This has caught a real hole before: `situation` joined the schema and no
    // adapter table mentioned it, so a field was silently compiled away.
    expect(missingCapabilityRows(adapter)).toEqual([]);
  });

  it('names no field twice', () => {
    const fields = CODEX_CAPABILITY_TABLE.map((row) => row.field);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it('is deterministic — the same skill compiles byte-identically', () => {
    const a = adapter.compileSkill(skill()).files[0]?.content;
    const b = adapter.compileSkill(skill()).files[0]?.content;
    expect(a).toBe(b);
  });

  describe('detect', () => {
    it('finds .agents/skills, the signal specific to Codex', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-detect-'));
      try {
        await fs.mkdir(path.join(root, CODEX_SKILLS_DIR), { recursive: true });
        const report = await adapter.detect(root);
        expect(report.present).toBe(true);
        expect(report.findings.join(' ')).toContain('.agents/skills');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('reports an empty project as absent rather than erroring', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-detect-'));
      try {
        const report = await adapter.detect(root);
        expect(report).toMatchObject({ target: CODEX_ID, present: false, findings: [] });
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });
});

/**
 * P8-CODEX-02 — the drift check.
 *
 * R-10 and R-11 are both about the Claude Code and Codex surfaces evolving
 * apart. Until now that risk had no detector, which means it would have been
 * discovered by a user. These assertions are the detector: they compile one
 * canonical skill to both targets and pin the properties that must hold
 * together, so a change to one that does not reach the other fails CI.
 */
describe('Claude Code and Codex do not drift apart', () => {
  const claude = new ClaudeCodeAdapter();
  const codex = new CodexAdapter();
  const one = skill();

  it('both emit exactly one file, at a per-skill path', () => {
    const claudeFiles = claude.compileSkill(one).files;
    const codexFiles = codex.compileSkill(one).files;
    expect(claudeFiles).toHaveLength(1);
    expect(codexFiles).toHaveLength(1);
    expect(claudeFiles[0]?.path).toContain(`/${one.name}/SKILL.md`);
    expect(codexFiles[0]?.path).toContain(`/${one.name}/SKILL.md`);
  });

  it('they write to different directories — the same path would be one target, not two', () => {
    expect(claude.compileSkill(one).files[0]?.path).not.toBe(
      codex.compileSkill(one).files[0]?.path,
    );
  });

  it('both carry the skill description, so neither loses it in a refactor', () => {
    for (const adapter of [claude, codex]) {
      expect(adapter.compileSkill(one).files[0]?.content).toContain(one.description);
    }
  });

  it('both carry the stop condition — the line that makes a skill refuse to self-declare done', () => {
    for (const adapter of [claude, codex]) {
      expect(adapter.compileSkill(one).files[0]?.content).toContain(one.stop_condition);
    }
  });

  it('neither puts the daemon`s verify command in the agent`s artifact', () => {
    // Architecture §5: the daemon runs verify and parses it; the agent never
    // does. Compiling the command into the prompt would be an invitation to run
    // it and report the result, which is the self-report the whole product
    // refuses. Asserted for *both* targets, because this is exactly the kind of
    // convenience a new adapter adds without noticing what it undoes.
    for (const adapter of [claude, codex]) {
      expect(adapter.compileSkill(one).files[0]?.content).not.toContain(
        one.verify.command_template,
      );
    }
  });

  it('every canonical field is accounted for by both tables', () => {
    expect(missingCapabilityRows(claude)).toEqual([]);
    expect(missingCapabilityRows(codex)).toEqual([]);
  });

  it('the two disagree about tool restrictions, and only one of them warns', () => {
    // This is the difference that matters and it must stay visible. If Codex
    // ever gains a tool field, this test fails and the capability table has to
    // be revisited — which is the point of a drift check.
    const restricted = skill({ allowed_tools: ['Read'] });
    expect(claude.compileSkill(restricted).warnings).toEqual([]);
    expect(codex.compileSkill(restricted).warnings.length).toBeGreaterThan(0);

    // Asserted on the artifact rather than on the table's label, because the
    // label is a description and the file is the fact. Claude Code emits a real
    // `allowed-tools` frontmatter key; Codex emits nothing the runtime reads.
    expect(claude.compileSkill(restricted).files[0]?.content).toContain('allowed-tools');
    expect(codex.compileSkill(restricted).files[0]?.content).not.toContain('allowed-tools');

    const codexRow = codex.capabilityTable.find((row) => row.field === 'allowed_tools');
    expect(codexRow?.support).toBe('dropped');
    expect(codexRow?.nativeField).toBeUndefined();
  });
});
