import fs from 'node:fs/promises';
import path from 'node:path';
import { relativePosix, resolveWorkspaceLayout } from '@sdlc-on-fire/core';
import {
  checkCorpusVisibility,
  checkFreshness,
  readVisibilityDoc,
  type DocRecord,
  type FreshnessReport,
  type VisibilityReport,
} from '@sdlc-on-fire/evidence';
import { parseFrontmatter } from '@sdlc-on-fire/storage';
import { createGitManager } from '@sdlc-on-fire/daemon';

/**
 * `sdlc docs` — running the freshness check (P1-DOC-01, ADR-0046).
 *
 * A doc declares what it covers and when it must be re-read in its own
 * frontmatter, so the check reads the project rather than a configuration file
 * listing the project. A doc that moves takes its declaration with it; a
 * central manifest would go stale in exactly the way this check exists to find.
 */

export interface DocsCheckResult {
  readonly report: FreshnessReport;
  readonly docsScanned: number;
  readonly since: string;
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (['node_modules', '.git', 'dist', '.sdlcof'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, root, out);
    // The identity a `DocRecord.path` carries and every link resolves against.
    else if (entry.name.endsWith('.md')) out.push(relativePosix(root, full));
  }
}

/**
 * Scans the workspace's docs.
 *
 * `covers:` and `refresh_by:` are optional frontmatter. A doc that declares
 * neither is scanned for broken links only — which is the honest treatment: we
 * know its links resolve or do not, and we know nothing about whether its
 * content still matches the code.
 */
export async function readDocs(root: string): Promise<readonly DocRecord[]> {
  const layout = resolveWorkspaceLayout(root);
  const files: string[] = [];
  await walk(layout.docsDir, layout.root, files);

  const known = new Set(files);
  const records: DocRecord[] = [];
  for (const relative of files) {
    const raw = await fs.readFile(path.join(layout.root, relative), 'utf8').catch(() => null);
    if (raw === null) continue;
    const parsed = parseFrontmatter(raw);
    const covers = Array.isArray(parsed.data['covers'])
      ? parsed.data['covers'].filter((entry): entry is string => typeof entry === 'string')
      : [];

    const links: { target: string; resolves: boolean }[] = [];
    for (const match of parsed.body.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)) {
      const target = match[1];
      if (target === undefined || target.startsWith('http')) continue;
      // Resolved on the filesystem, compared as an identity: `known` holds
      // posix strings, so a native-separator result would report every link in
      // the workspace as broken on Windows.
      const resolved = relativePosix(
        layout.root,
        path.resolve(path.dirname(path.join(layout.root, relative)), target),
      );
      links.push({ target, resolves: known.has(resolved) });
    }

    records.push({
      path: relative,
      covers,
      ...(typeof parsed.data['refresh_by'] === 'string'
        ? { refreshBy: parsed.data['refresh_by'] }
        : {}),
      links,
    });
  }
  return records;
}

/**
 * Runs the check over the change window.
 *
 * The window is a git range rather than "everything", because the question
 * ADR-0046 asks is whether *this iteration* updated the docs it affected. Over
 * all of history every doc looks stale, and a check that always fires is one
 * nobody reads.
 */
export async function checkDocs(root: string, since = 'HEAD~1'): Promise<DocsCheckResult> {
  const layout = resolveWorkspaceLayout(root);
  const git = createGitManager({ repoRoot: layout.root });
  const changed = (await git.isRepo()) ? await changedSince(layout.root, since) : [];

  const docs = await readDocs(root);
  const report = checkFreshness({
    docs,
    changedFiles: changed.filter((file) => !file.endsWith('.md')),
    changedDocs: changed.filter((file) => file.endsWith('.md')),
    now: new Date(),
  });
  return { report, docsScanned: docs.length, since };
}

async function changedSince(cwd: string, since: string): Promise<string[]> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    const { stdout } = await run('git', ['diff', '--name-only', `${since}..HEAD`], { cwd });
    return stdout.split('\n').filter((line) => line.trim() !== '');
  } catch {
    // No such range — a fresh repo with one commit, most often. Reporting
    // "everything changed" would fire every finding on a first run.
    return [];
  }
}

/** Report. Gating and advisory are labelled, never mixed into one list. */
export function formatDocsCheck(result: DocsCheckResult): string {
  const { report } = result;
  const lines = [
    `Documentation freshness — ${String(result.docsScanned)} doc(s), changes since ${result.since}`,
    '',
  ];
  const gating = report.findings.filter((finding) => finding.gating);
  for (const finding of gating) lines.push(`❌ ${finding.doc}: ${finding.detail}`);
  for (const finding of report.advisory) lines.push(`⚠️  ${finding.doc}: ${finding.detail}`);
  if (report.findings.length === 0) lines.push('✅ Nothing drifted.');
  else {
    lines.push('');
    lines.push(
      'Only broken links fail this check. The rest is heuristic — a doc-quality gate',
      'people learn to ignore is worse than none, because it turns "we do not know"',
      'into "the docs passed".',
    );
  }
  return lines.join('\n');
}

export interface DocVisibilityResult {
  readonly report: VisibilityReport;
  readonly docsScanned: number;
}

/**
 * `sdlc docs visibility` — the third dimension (P4-DOC-01, ADR-0074).
 *
 * Reuses `readDocs`'s walk rather than doing its own, so the three checks
 * always describe the same corpus. A second walk would eventually disagree
 * about which files are docs, and the two answers would differ for reasons
 * nobody could see from either report.
 */
export async function docVisibility(
  root: string,
  now: Date = new Date(),
): Promise<DocVisibilityResult> {
  const layout = resolveWorkspaceLayout(root);
  const docs = await readDocs(root);
  const parsed = await Promise.all(
    docs.map(async (doc) => {
      const raw = await fs.readFile(path.join(layout.root, doc.path), 'utf8').catch(() => '');
      const front = parseFrontmatter(raw);
      return readVisibilityDoc(doc.path, front.body, front.data);
    }),
  );
  return { report: checkCorpusVisibility(parsed, now), docsScanned: parsed.length };
}

/**
 * Report.
 *
 * Gatekeepers first, then differentiators, and **no total**. ADR-0074 forbids
 * an aggregate: a single number hides an upstream loss behind a downstream
 * gain, which is exactly what SAGEO Arena measured.
 */
export function formatDocVisibility(result: DocVisibilityResult): string {
  const { findings } = result.report;
  if (findings.length === 0) {
    return `${String(result.docsScanned)} doc(s) scanned. Nothing the evidence associates with being hard to find.`;
  }

  const lines: string[] = [];
  for (const weight of ['gatekeeper', 'differentiator'] as const) {
    const group = findings.filter((finding) => finding.weight === weight);
    if (group.length === 0) continue;
    lines.push(
      `${weight === 'gatekeeper' ? 'Gatekeepers' : 'Differentiators'} (${String(group.length)}):`,
    );
    for (const finding of group)
      lines.push(`  ${finding.path}: ${finding.check} — ${finding.detail}`);
    lines.push('');
  }
  lines.push(
    `${String(result.docsScanned)} doc(s) scanned. Findings are listed, never scored — an aggregate`,
  );
  lines.push('would hide a regression in one dimension behind an improvement in another.');
  return lines.join('\n');
}
