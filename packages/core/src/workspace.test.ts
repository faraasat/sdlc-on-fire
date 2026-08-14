import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
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
