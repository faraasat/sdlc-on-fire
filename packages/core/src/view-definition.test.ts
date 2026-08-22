import { describe, expect, it } from 'vitest';
import {
  VIEW_MODES,
  parseViewDefinition,
  slugFromFilename,
  viewOptions,
  viewsForRole,
  type ViewDefinition,
} from './view-definition.js';

/**
 * P4-COLLAB-03 — saved views.
 *
 * The rule under test throughout is that an unrecognised value is a *reported
 * problem*, never a silent default. A view file that quietly falls back is
 * indistinguishable from one that works, and its author never learns the file
 * they are maintaining does nothing.
 */

const good = {
  name: 'Security blockers',
  mode: 'table',
  groupBy: 'risk',
  role: 'security',
  filter: { blockedOnly: true, risk: 'high' },
};

describe('parseViewDefinition', () => {
  it('accepts a complete view', () => {
    const { view, problems } = parseViewDefinition('sec-blockers', good);
    expect(problems).toEqual([]);
    expect(view?.name).toBe('Security blockers');
    expect(view?.mode).toBe('table');
    expect(view?.groupBy).toBe('risk');
    expect(view?.role).toBe('security');
    expect(view?.filter).toEqual({ blockedOnly: true, risk: 'high' });
  });

  it('defaults mode and groupBy when absent, which is not a mistake', () => {
    const { view, problems } = parseViewDefinition('minimal', { name: 'Everything' });
    expect(problems).toEqual([]);
    expect(view?.mode).toBe('board');
    expect(view?.groupBy).toBe('none');
    expect(view?.role).toBeNull();
  });

  it('rejects a misspelled mode rather than falling back to board', () => {
    const { view, problems } = parseViewDefinition('typo', { ...good, mode: 'bord' });
    expect(view).toBeNull();
    expect(problems.map((p) => p.field)).toContain('mode');
  });

  it('rejects a misspelled groupBy', () => {
    const { problems } = parseViewDefinition('typo', { ...good, groupBy: 'assignees' });
    expect(problems.map((p) => p.field)).toContain('groupBy');
  });

  it('rejects an unknown role', () => {
    const { problems } = parseViewDefinition('typo', { ...good, role: 'devops' });
    expect(problems.map((p) => p.field)).toContain('role');
  });

  it('names an unknown filter key instead of dropping it', () => {
    // The dangerous case: a typo'd filter silently ignored produces a view
    // showing more cards than its author believes it does.
    const { view, problems } = parseViewDefinition('typo', {
      ...good,
      filter: { blockedOnly: true, blockedOnyl: true },
    });
    expect(view).toBeNull();
    expect(problems.map((p) => p.field)).toContain('filter.blockedOnyl');
  });

  it('type-checks filter values', () => {
    const { problems } = parseViewDefinition('bad', { ...good, filter: { blockedOnly: 'yes' } });
    expect(problems.map((p) => p.field)).toContain('filter.blockedOnly');
  });

  it('allows a null risk, which means "any"', () => {
    const { view, problems } = parseViewDefinition('anyrisk', {
      name: 'All',
      filter: { risk: null },
    });
    expect(problems).toEqual([]);
    expect(view?.filter.risk).toBeNull();
  });

  it('requires a non-empty name', () => {
    expect(
      parseViewDefinition('x', { ...good, name: '   ' }).problems.map((p) => p.field),
    ).toContain('name');
    expect(parseViewDefinition('x', { mode: 'board' }).problems.map((p) => p.field)).toContain(
      'name',
    );
  });

  it('reports a non-mapping file rather than throwing', () => {
    // A YAML file holding a list, or nothing at all, is a common authoring
    // error and must produce a message rather than a stack trace.
    expect(parseViewDefinition('x', ['a', 'b']).problems[0]?.field).toBe('(file)');
    expect(parseViewDefinition('x', null).problems[0]?.field).toBe('(file)');
    expect(parseViewDefinition('x', 'text').problems[0]?.field).toBe('(file)');
  });

  it('collects every problem rather than stopping at the first', () => {
    // An author fixing one error per run is an author who edits the file four
    // times to learn four things the parser already knew.
    const { problems } = parseViewDefinition('bad', {
      mode: 'bord',
      groupBy: 'nope',
      role: 'devops',
    });
    expect(problems.length).toBeGreaterThanOrEqual(4);
  });

  it('covers every declared mode', () => {
    for (const mode of VIEW_MODES) {
      expect(parseViewDefinition('m', { name: 'n', mode }).view?.mode).toBe(mode);
    }
  });
});

describe('viewsForRole', () => {
  const view = (over: Partial<ViewDefinition>): ViewDefinition => ({
    slug: 's',
    name: 'n',
    mode: 'board',
    groupBy: 'none',
    filter: {},
    role: null,
    description: null,
    ...over,
  });

  it('offers an unscoped view to every role', () => {
    // A view with no role is a view for everybody, not a view for nobody.
    const views = [view({ slug: 'all', name: 'All', role: null })];
    expect(viewsForRole(views, 'qa')).toHaveLength(1);
    expect(viewsForRole(views, null)).toHaveLength(1);
  });

  it('offers a scoped view only to its role', () => {
    const views = [view({ slug: 'sec', name: 'Sec', role: 'security' })];
    expect(viewsForRole(views, 'security')).toHaveLength(1);
    expect(viewsForRole(views, 'qa')).toEqual([]);
  });

  it('shows a role both its own and the shared views', () => {
    const views = [
      view({ slug: 'sec', name: 'Sec', role: 'security' }),
      view({ slug: 'all', name: 'All', role: null }),
      view({ slug: 'qa', name: 'QA', role: 'qa' }),
    ];
    expect(viewsForRole(views, 'security').map((v) => v.slug)).toEqual(['all', 'sec']);
  });

  it('orders by name so a picker does not reshuffle when a file is added', () => {
    const views = [
      view({ slug: 'z', name: 'Zebra' }),
      view({ slug: 'a', name: 'Apple' }),
      view({ slug: 'm', name: 'Mango' }),
    ];
    expect(viewsForRole(views, null).map((v) => v.name)).toEqual(['Apple', 'Mango', 'Zebra']);
  });

  it('does not mutate the array it was given', () => {
    const views = [view({ slug: 'z', name: 'Z' }), view({ slug: 'a', name: 'A' })];
    viewsForRole(views, null);
    expect(views[0]?.slug).toBe('z');
  });
});

describe('viewOptions', () => {
  it('hands the board exactly the arguments it already takes', () => {
    // The point of the design: a view is a stored argument list, not a second
    // way to build a board.
    const { view } = parseViewDefinition('v', good);
    expect(viewOptions(view as ViewDefinition)).toEqual({
      groupBy: 'risk',
      filter: { blockedOnly: true, risk: 'high' },
    });
  });
});

describe('slugFromFilename', () => {
  it('strips the extension and lowercases', () => {
    expect(slugFromFilename('Sec-Blockers.yaml')).toBe('sec-blockers');
    expect(slugFromFilename('my-view.yml')).toBe('my-view');
  });

  it('does not rewrite the rest of the name', () => {
    // The filename is the identity. A general slugifier would let two files
    // collapse onto one slug, and the second would silently replace the first.
    expect(slugFromFilename('my view (2).yaml')).toBe('my view (2)');
  });
});
