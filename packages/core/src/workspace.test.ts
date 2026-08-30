import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALWAYS_LOADED_FILES,
  INSTRUCTION_FILE_NOTE,
  rootFileSeed,
  DEFAULT_STATE_DIR,
  docsToGenerate,
  DOCS_ROOT_FILES,
  GITIGNORE_ENTRIES,
  isManagedContentPath,
  resolveWorkspaceLayout,
  ROOT_FILES,
  WorkspaceConfigSchema,
} from './workspace.js';

describe('root whitelist', () => {
  it('is exactly the eight files ADR-0043 fixes', () => {
    expect(ROOT_FILES).toHaveLength(8);
    expect(ROOT_FILES).toContain('SDLCOF.md');
  });

  it('has no duplicates', () => {
    expect(new Set(ROOT_FILES).size).toBe(ROOT_FILES.length);
    expect(new Set(DOCS_ROOT_FILES).size).toBe(DOCS_ROOT_FILES.length);
  });
});

describe('gitignore', () => {
  it('ignores the whole state directory', () => {
    // Anything less would leave a rebuildable mirror in git history.
    expect(GITIGNORE_ENTRIES).toContain(`/${DEFAULT_STATE_DIR}/`);
  });
});

/** Built the way the code builds it — see `packages/db/src/paths.test.ts`. */
const expected = (...segments: string[]): string => path.resolve('/tmp/project', ...segments);

describe('layout resolution', () => {
  it('resolves the default tree', () => {
    const layout = resolveWorkspaceLayout('/tmp/project');
    expect(layout.kanbanDir).toBe(expected('kanban'));
    expect(layout.docsDir).toBe(expected('docs'));
    expect(layout.stateDir).toBe(expected(DEFAULT_STATE_DIR));
    expect(layout.dataDir).toBe(expected(DEFAULT_STATE_DIR, 'db'));
    expect(layout.configPath).toBe(expected(DEFAULT_STATE_DIR, 'config.yaml'));
  });

  it('honours path overrides', () => {
    const layout = resolveWorkspaceLayout('/tmp/project', {
      kanban: 'board',
      docs: 'documentation',
      state_dir: '.state',
    });
    expect(layout.kanbanDir).toBe(expected('board'));
    expect(layout.docsDir).toBe(expected('documentation'));
    expect(layout.dataDir).toBe(expected('.state', 'db'));
  });

  it('absolutises a relative root', () => {
    expect(path.isAbsolute(resolveWorkspaceLayout('.').root)).toBe(true);
  });
});

describe('config schema', () => {
  it('fills every default from an empty object', () => {
    const config = WorkspaceConfigSchema.parse({});
    expect(config.paths.kanban).toBe('kanban');
    expect(config.database.mode).toBe('pglite');
    expect(config.preset).toBe('standard');
  });

  it('requires a url in connected mode', () => {
    const result = WorkspaceConfigSchema.safeParse({ database: { mode: 'connected' } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('url'))).toBe(true);
    }

    expect(
      WorkspaceConfigSchema.safeParse({
        database: { mode: 'connected', url: 'postgres://localhost/db' },
      }).success,
    ).toBe(true);
  });

  it('does not require a url in pglite mode', () => {
    expect(WorkspaceConfigSchema.safeParse({ database: { mode: 'pglite' } }).success).toBe(true);
  });

  it('rejects a path that escapes the project root', () => {
    // Managed content outside the repo would break content-in-git.
    expect(WorkspaceConfigSchema.safeParse({ paths: { kanban: '../elsewhere' } }).success).toBe(
      false,
    );
    expect(WorkspaceConfigSchema.safeParse({ paths: { docs: '/etc' } }).success).toBe(false);
  });

  it('rejects an unknown docs file in the generate list', () => {
    expect(WorkspaceConfigSchema.safeParse({ docs: { generate: ['NOPE.md'] } }).success).toBe(
      false,
    );
  });
});

describe('docsToGenerate', () => {
  it('generates every topic file by default', () => {
    expect(docsToGenerate(WorkspaceConfigSchema.parse({}))).toEqual(DOCS_ROOT_FILES);
  });

  it('narrows to the requested subset', () => {
    const config = WorkspaceConfigSchema.parse({ docs: { generate: ['README.md', 'TESTING.md'] } });
    expect(docsToGenerate(config)).toEqual(['README.md', 'TESTING.md']);
  });

  it('returns canonical order regardless of config order', () => {
    const config = WorkspaceConfigSchema.parse({ docs: { generate: ['TESTING.md', 'README.md'] } });
    // Config order must not leak into the generated tree.
    expect(docsToGenerate(config)).toEqual(['README.md', 'TESTING.md']);
  });
});

describe('managed content paths', () => {
  it('recognises kanban and docs', () => {
    expect(isManagedContentPath('kanban/epics/EPIC-001-x/epic.md')).toBe(true);
    expect(isManagedContentPath('docs/ARCHITECTURE.md')).toBe(true);
  });

  it('excludes the hidden state directory', () => {
    // Machine state is gitignored and must never be synced as content.
    expect(isManagedContentPath('.sdlcof/db/base')).toBe(false);
  });

  it('excludes product source', () => {
    expect(isManagedContentPath('src/index.ts')).toBe(false);
  });

  it('does not match a lookalike prefix', () => {
    expect(isManagedContentPath('docs-site/index.html')).toBe(false);
  });

  it('follows path overrides', () => {
    expect(isManagedContentPath('board/x.md', { kanban: 'board' })).toBe(true);
    expect(isManagedContentPath('kanban/x.md', { kanban: 'board' })).toBe(false);
  });
});

/**
 * The instruction-file note (P8-CLOSE-04, closing Q-06's consequence).
 *
 * `CLAUDE.md` and `AGENTS.md` are read every agent turn, outside our pack and
 * outside our control. Q-06 measured that we scaffold them as empty headings —
 * so the product pays none of the always-loaded cost — and that we say nothing
 * about what belongs in them, which leaves a user free to recreate the null
 * result inside our own scaffold.
 */
describe('rootFileSeed', () => {
  it('gives an ordinary root file just its heading', () => {
    expect(rootFileSeed('SOUL.md')).toBe('# SOUL\n');
  });

  it('gives the always-loaded files the note as well', () => {
    for (const file of ALWAYS_LOADED_FILES) {
      const seed = rootFileSeed(file);
      expect(seed.startsWith(`# ${file.replace(/\.md$/, '')}\n`)).toBe(true);
      expect(seed).toContain('Loaded on every agent turn');
      expect(seed).toContain('docs/');
    }
  });

  it('writes the note as an HTML comment, so it renders as nothing', () => {
    // Visible to whoever edits the file and to the agent reading it raw;
    // invisible in rendered markdown, so it is not something a user has to
    // delete before the file looks like theirs.
    expect(INSTRUCTION_FILE_NOTE.trimStart().startsWith('<!--')).toBe(true);
    expect(INSTRUCTION_FILE_NOTE.trimEnd().endsWith('-->')).toBe(true);
  });

  it('keeps the note small enough not to be the thing it warns about', () => {
    // A long explanation of why always-loaded context is expensive would itself
    // be always-loaded context. Q-06 measured the pair at 61 bytes; the note
    // roughly quadruples that and stays far under any budget that matters.
    expect(INSTRUCTION_FILE_NOTE.length).toBeLessThan(400);
  });

  it('names both always-loaded files, and only those', () => {
    // A third file added to this list would start paying the per-turn cost, so
    // the list is asserted rather than trusted to stay short.
    expect([...ALWAYS_LOADED_FILES]).toEqual(['CLAUDE.md', 'AGENTS.md']);
    for (const file of ALWAYS_LOADED_FILES) expect(ROOT_FILES).toContain(file);
  });

  it('never leaves a scaffolded file empty', () => {
    for (const file of ROOT_FILES) expect(rootFileSeed(file).trim()).not.toBe('');
  });
});
