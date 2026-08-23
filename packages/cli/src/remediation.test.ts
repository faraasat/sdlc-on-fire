import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_SKILLS } from '@sdlc-on-fire/agent-manager';
import { describe, expect, it } from 'vitest';

/**
 * Every command this CLI tells a user to run must exist (P5-AUDIT-01).
 *
 * The audit found `sdlc db:up` named in two error messages and registered
 * nowhere. Both were *remediation* text — the sentence a user reads at the
 * moment they are already stuck — so the failure mode is being sent to a
 * command that answers `unknown command` and left with nothing.
 *
 * Nothing detected it because a string is a string: it type-checks, it lints,
 * and no test asserts that prose and the command table agree. This does.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

async function sources(): Promise<string[]> {
  const entries = await fs.readdir(HERE, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.includes('.test.'))
    .map((e) => path.join(HERE, e.name));
}

/** Drop `//` lines and block comments, keeping string literals intact. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

describe('remediation text', () => {
  it('never names a `sdlc <command>` that is not registered', async () => {
    const index = await fs.readFile(path.join(HERE, 'index.ts'), 'utf8');
    const registered = new Set(
      [...index.matchAll(/\.command\('([^']+)'\)/g)].flatMap((m) =>
        m[1] === undefined ? [] : [m[1]],
      ),
    );
    // The root program name plus every registered command word.
    const known = new Set<string>(['sdlc', ...registered]);
    for (const key of registered) for (const word of key.split(' ')) known.add(word);

    const offenders: string[] = [];
    for (const file of await sources()) {
      const text = await fs.readFile(file, 'utf8');
      // Comments are excluded deliberately. The first version of this guard
      // scanned them too and flagged three prose mentions — including one that
      // names a non-existent command *on purpose*, to describe a mistake a user
      // made. A guard that reports non-defects gets switched off, so it checks
      // only text that can reach a user.
      for (const rawLine of stripComments(text).split('\n')) {
        for (const match of rawLine.matchAll(/`sdlc ([a-z][a-z0-9:_-]*)/g)) {
          const command = match[1] ?? '';
          if (!known.has(command)) offenders.push(`${path.basename(file)}: sdlc ${command}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never tells a *skill* to run a `sdlc <command>` that is not registered', async () => {
    // Same defect, worse blast radius (P6-PAYLOAD-04). The guard above scans
    // only this package, and skill prompts live in `agent-manager` — so every
    // `sdlc ...` a skill instructs a model to run was unchecked. A user reading
    // remediation text that names a missing command is stuck; a model reading a
    // prompt that names one runs it, gets `unknown command`, and improvises.
    //
    // Reads the registered skills rather than their source files: the census is
    // the data that ships, and a skill added without touching a file this test
    // knows about is exactly the case a path glob would miss.
    const index = await fs.readFile(path.join(HERE, 'index.ts'), 'utf8');
    const known = new Set<string>(['sdlc']);
    for (const match of index.matchAll(/\.command\('([^']+)'\)/g)) {
      const key = match[1];
      if (key === undefined) continue;
      known.add(key);
      for (const word of key.split(' ')) known.add(word);
    }

    const offenders: string[] = [];
    for (const skill of Object.values(CANONICAL_SKILLS)) {
      // Every field whose text reaches the model. `description` included: it is
      // what the model matches against to decide whether to load the skill.
      const prose = [
        skill.description,
        skill.role,
        skill.task,
        skill.self_verification ?? '',
        skill.stop_condition,
        skill.verify.command_template,
        ...(skill.arguments ?? []).map((argument) => argument.description ?? ''),
      ].join('\n');
      for (const match of prose.matchAll(/\bsdlc ([a-z][a-z0-9:_-]*)/g)) {
        const command = match[1] ?? '';
        if (!known.has(command)) offenders.push(`${skill.name}: sdlc ${command}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
