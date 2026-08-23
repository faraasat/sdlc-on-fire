import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { countExistingFiles, init } from './commands.js';

/**
 * Brownfield detection, across repository shapes that are not ours.
 *
 * The first version asked for `README.md` **and** a `docs/` directory holding at
 * least one `.md`. Validated against hono, which has exactly that shape. It then
 * shipped in `0.1.0-alpha.2` and gave the full 28-file greenfield scaffold to
 * every repository that does not:
 *
 *   flask     `docs/` full of Sphinx `.rst`, no `.md` at all
 *   cobra     no `docs/` directory
 *   ripgrep   no `docs/` directory
 *   got       documentation lives in `documentation/`
 *
 * The rule was not wrong about hono. It was a JavaScript-ecosystem assumption
 * about where documentation lives, wearing the costume of a general test — so
 * these cases are pinned by *shape*, not by repository name.
 */
const roots: string[] = [];
async function repo(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-brown-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body, 'utf8');
  }
  return root;
}
afterAll(async () => {
  for (const r of roots) await fs.rm(r, { recursive: true, force: true });
});

/** n source files, the way any real project has them. */
function sources(n: number, ext: string): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`src/mod${String(i)}${ext}`, '// code\n']),
  );
}

describe('an established project is not given a greenfield scaffold', () => {
  it('a Python project whose docs are .rst, like flask', async () => {
    const root = await repo({
      'README.md': '# proj\n',
      'docs/index.rst': 'Docs\n====\n',
      'docs/api.rst': 'API\n===\n',
      'pyproject.toml': '[project]\nname="p"\n',
      ...sources(10, '.py'),
    });
    const result = await init(root);
    expect(result.created.length).toBeLessThan(15);
  }, 120_000);

  it('a Go project with no docs directory at all, like cobra', async () => {
    const root = await repo({
      'README.md': '# c\n',
      'go.mod': 'module c\n',
      ...sources(12, '.go'),
    });
    expect((await init(root)).created.length).toBeLessThan(15);
  }, 120_000);

  it('a Rust project, like ripgrep', async () => {
    const root = await repo({
      'README.md': '# rg\n',
      'Cargo.toml': '[package]\nname="rg"\n',
      ...sources(12, '.rs'),
    });
    expect((await init(root)).created.length).toBeLessThan(15);
  }, 120_000);

  it('a TypeScript project that names the folder `documentation/`, like got', async () => {
    const root = await repo({
      'README.md': '# got\n',
      'documentation/1-usage.md': '# usage\n',
      'package.json': '{"name":"g"}',
      ...sources(10, '.ts'),
    });
    expect((await init(root)).created.length).toBeLessThan(15);
  }, 120_000);

  it('a project with no README at all is still recognised by its code', async () => {
    // A README is a documentation convention, not evidence of a project. Firmware
    // and internal repos routinely have neither one nor a docs folder.
    const root = await repo(sources(14, '.c'));
    expect((await init(root)).created.length).toBeLessThan(15);
  }, 120_000);
});

describe('a genuinely new project still gets the full scaffold', () => {
  it('an empty directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-green-'));
    roots.push(root);
    expect((await init(root)).created.length).toBeGreaterThan(20);
  }, 120_000);

  it('a directory holding only what `npm init` writes', async () => {
    const root = await repo({ 'package.json': '{"name":"new","version":"1.0.0"}' });
    expect((await init(root)).created.length).toBeGreaterThan(20);
  }, 120_000);

  it('--full forces the whole scaffold even on an established project', async () => {
    const root = await repo({ 'README.md': '#\n', ...sources(20, '.ts') });
    expect((await init(root, { scaffold: 'full' })).created.length).toBeGreaterThan(20);
  }, 120_000);

  it('--minimal forces the small one even on an empty directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-min-'));
    roots.push(root);
    expect((await init(root, { scaffold: 'minimal' })).created.length).toBeLessThan(15);
  }, 120_000);
});

describe('the count does not walk what it should not', () => {
  it('ignores node_modules, so an unbuilt project is not called established', async () => {
    // Otherwise a brand-new project becomes "established" the moment it installs
    // a dependency, which is the first thing anybody does.
    const root = await repo({
      'package.json': '{"name":"new"}',
      ...Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`node_modules/pkg${String(i)}/index.js`, '\n']),
      ),
    });
    expect((await init(root)).created.length).toBeGreaterThan(20);
  }, 120_000);

  it('ignores .git, so a fresh repo is not established by its own objects', async () => {
    const root = await repo({
      ...Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`.git/objects/ab/${String(i)}`, '\n']),
      ),
    });
    expect((await init(root)).created.length).toBeGreaterThan(20);
  }, 120_000);
});

describe('countExistingFiles stops as soon as the answer is decided', () => {
  it('never counts past the limit, however many files there are', async () => {
    // The brownfield verdict is identical with or without the early stop, so
    // nothing else can observe it — and an optimisation nothing observes gets
    // deleted by the next reader as dead weight. A monorepo with 40,000 files
    // must not pay for a full walk to learn what its tenth file already said.
    const root = await repo(
      Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`src/f${String(i)}.ts`, '\n'])),
    );
    expect(await countExistingFiles(root, 10)).toBe(10);
    expect(await countExistingFiles(root, 25)).toBe(25);
  }, 120_000);

  it('returns the true count when it is below the limit', async () => {
    const root = await repo({ 'a.ts': '\n', 'b.ts': '\n', 'c.ts': '\n' });
    expect(await countExistingFiles(root, 10)).toBe(3);
  }, 120_000);
});
