import { describe, expect, it } from 'vitest';
import {
  BUNDLE_SECTIONS,
  DEFAULT_BUNDLE_BUDGET,
  buildWebBundle,
  estimate,
  type BundleArtifact,
} from './web-bundle.js';

/**
 * P5-ECO-01 — the web-bundle planning export.
 *
 * The failure this defends against is silent truncation at the far end: a
 * bundle pasted into a chat window, cut off by whatever it was pasted into,
 * read by somebody who cannot see that it happened. Every assertion about
 * omissions is about making that visible *inside the pasted text*, not just in
 * the terminal of whoever ran the command.
 */

const art = (over: Partial<BundleArtifact> = {}): BundleArtifact => ({
  section: 'stories',
  title: 'a story',
  body: 'body text',
  ...over,
});

describe('buildWebBundle', () => {
  it('includes everything when it fits', () => {
    const bundle = buildWebBundle([art({ section: 'constitution', title: 'C' }), art()]);
    expect(bundle.complete).toBe(true);
    expect(bundle.included).toBe(2);
    expect(bundle.omitted).toEqual([]);
  });

  it('orders by role in the argument, not by size', () => {
    // The constitution is what a model cannot infer from the rest; the
    // hundredth story is what it can. Sorting by size would not keep the bundle
    // interpretable at every budget.
    const bundle = buildWebBundle([
      art({ section: 'stories', title: 'S' }),
      art({ section: 'constitution', title: 'C' }),
      art({ section: 'architecture', title: 'A' }),
    ]);
    expect(bundle.text.indexOf('### C')).toBeLessThan(bundle.text.indexOf('### A'));
    expect(bundle.text.indexOf('### A')).toBeLessThan(bundle.text.indexOf('### S'));
  });

  it('keeps a caller’s ordering within a section', () => {
    const bundle = buildWebBundle([art({ title: 'first' }), art({ title: 'second' })]);
    expect(bundle.text.indexOf('first')).toBeLessThan(bundle.text.indexOf('second'));
  });

  it('drops what does not fit and names it', () => {
    const big = art({ section: 'stories', title: 'huge', body: 'x'.repeat(8000) });
    const bundle = buildWebBundle([art({ section: 'constitution', title: 'C' }), big], {
      budget: 500,
    });
    expect(bundle.complete).toBe(false);
    expect(bundle.omitted.map((o) => o.title)).toEqual(['huge']);
    expect(bundle.included).toBe(1);
  });

  it('puts the omission notice inside the pasted text', () => {
    // Whoever reads the bundle in a chat window is not the person who ran the
    // command. A truncation only the terminal knew about is invisible to them.
    const bundle = buildWebBundle(
      [
        art({ section: 'constitution', title: 'C' }),
        art({ title: 'dropped', body: 'y'.repeat(8000) }),
      ],
      { budget: 500 },
    );
    expect(bundle.text).toContain('## Omitted (1)');
    expect(bundle.text).toContain('dropped');
  });

  it('keeps filling after one artifact does not fit', () => {
    // Refusing a later, smaller artifact because something bigger came first
    // wastes budget for no reason a reader could explain.
    const bundle = buildWebBundle(
      [
        art({ section: 'epics', title: 'huge', body: 'x'.repeat(20_000) }),
        art({ section: 'epics', title: 'small', body: 'tiny' }),
      ],
      { budget: 600 },
    );
    expect(bundle.omitted.map((o) => o.title)).toEqual(['huge']);
    expect(bundle.text).toContain('small');
  });

  it('never exceeds the budget it was given', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      art({ title: `s${String(i)}`, body: 'z'.repeat(400) }),
    );
    for (const budget of [200, 1_000, 5_000]) {
      const bundle = buildWebBundle(many, { budget });
      // The notice is accounted for, so the reported total is the real one.
      expect(bundle.tokens, `budget ${String(budget)}`).toBeLessThanOrEqual(
        budget + estimate(bundle.text.slice(bundle.text.indexOf('## Omitted'))),
      );
      expect(bundle.included + bundle.omitted.length).toBe(200);
    }
  });

  it('accounts for every artifact, included or omitted', () => {
    // Nothing may vanish: an artifact that is neither in the text nor in the
    // omission list is the exact silent loss this is arranged to prevent.
    const artifacts = Array.from({ length: 40 }, (_, i) => art({ title: `t${String(i)}` }));
    const bundle = buildWebBundle(artifacts, { budget: 300 });
    expect(bundle.included + bundle.omitted.length).toBe(40);
  });

  it('writes one heading per section, not one per artifact', () => {
    const bundle = buildWebBundle([art({ title: 'a' }), art({ title: 'b' })]);
    expect(bundle.text.match(/^## Stories$/gm) ?? []).toHaveLength(1);
  });

  it('names the project in the header', () => {
    expect(buildWebBundle([], { project: 'hono' }).text).toContain('hono');
  });

  it('says the plan is the plan, not a model’s output', () => {
    expect(buildWebBundle([]).text).toContain('nothing');
    expect(buildWebBundle([]).text).toContain('decision made by a model');
  });

  it('handles an empty plan without producing a broken document', () => {
    const bundle = buildWebBundle([]);
    expect(bundle.complete).toBe(true);
    expect(bundle.included).toBe(0);
    expect(bundle.text).toContain('# Planning bundle');
  });

  it('leaves room for the conversation the bundle is pasted into', () => {
    // A bundle sized to fill the window leaves no room for the question it was
    // assembled to answer.
    expect(DEFAULT_BUNDLE_BUDGET).toBeLessThan(100_000);
  });

  it('covers every declared section', () => {
    const bundle = buildWebBundle(
      BUNDLE_SECTIONS.map((section) => art({ section, title: section })),
    );
    for (const section of BUNDLE_SECTIONS) expect(bundle.text).toContain(section);
  });
});
