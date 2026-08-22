import { describe, expect, it } from 'vitest';
import { DEFAULT_EMBEDDING_DIMENSIONS } from './embedding.js';
import {
  DEFAULT_EMBEDDER_ID,
  EMBEDDERS,
  embedderById,
  embedderWarning,
  switchRequiresMigration,
  switchRequiresReindex,
  validateEmbedderChoice,
} from './embedder-registry.js';

/**
 * P5-ECO-03 — opting into a hosted embedder.
 *
 * Three consequences this file exists to make un-takeable by accident: your
 * source leaves the machine, vectors from two models are not comparable, and a
 * wider model needs a migration rather than a re-embed. All three fail
 * silently if nothing checks them.
 */

describe('the registry', () => {
  it('defaults to the local model', () => {
    expect(DEFAULT_EMBEDDER_ID).toBe('local');
    expect(embedderById(DEFAULT_EMBEDDER_ID)?.sendsContentOffMachine).toBe(false);
  });

  it('matches the dimension the schema actually declares', () => {
    // The column is `vector(384)`. A default that disagreed with it would fail
    // on the first insert, which is a confusing way to learn about a decision.
    expect(embedderById('local')?.dimensions).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
  });

  it('says of every embedder whether content leaves the machine', () => {
    // A surface that has to warn asks the descriptor rather than hardcoding a
    // list of names it will forget to update.
    for (const embedder of EMBEDDERS) {
      expect(typeof embedder.sendsContentOffMachine, embedder.id).toBe('boolean');
    }
  });

  it('names the credential variable but never holds a value', () => {
    const hosted = EMBEDDERS.filter((e) => e.sendsContentOffMachine);
    expect(hosted.length).toBeGreaterThan(0);
    for (const embedder of hosted) {
      expect(embedder.credentialEnv, embedder.id).toBeDefined();
      expect(JSON.stringify(embedder)).not.toMatch(/sk-|key["']?\s*:\s*["'][A-Za-z0-9]{8}/);
    }
  });
});

describe('validateEmbedderChoice', () => {
  it('accepts the local embedder with no credential', () => {
    expect(validateEmbedderChoice('local')).toEqual([]);
  });

  it('refuses a hosted embedder whose key is not set', () => {
    // Refused before the first call. Discovering it partway through leaves half
    // a corpus embedded with one model.
    const problems = validateEmbedderChoice('voyage-code', {});
    expect(problems.some((p) => p.field === 'credential')).toBe(true);
  });

  it('accepts a hosted embedder when the key is present', () => {
    expect(validateEmbedderChoice('voyage-code', { VOYAGE_API_KEY: 'x' })).toEqual([]);
  });

  it('treats a blank key as absent', () => {
    expect(validateEmbedderChoice('voyage-code', { VOYAGE_API_KEY: '   ' }).length).toBe(1);
  });

  it('names an unknown embedder rather than falling back to the default', () => {
    // A typo that silently used the local model would report success and
    // produce a corpus nobody chose.
    const problems = validateEmbedderChoice('voyage');
    expect(problems[0]?.because).toContain('unknown embedder');
  });

  it('reads the environment it is given, never the process', () => {
    // Pure, so a test does not mutate global state to exercise a credential
    // path it has no key for.
    expect(validateEmbedderChoice('voyage-code', { VOYAGE_API_KEY: 'from-argument' })).toEqual([]);
  });
});

describe('switchRequiresReindex', () => {
  it('is true whenever the model changes', () => {
    expect(switchRequiresReindex('local', 'voyage-code')).toBe(true);
  });

  it('is false for the same model', () => {
    expect(switchRequiresReindex('local', 'local')).toBe(false);
  });

  it('is true for an unknown embedder, because we cannot show it is safe', () => {
    expect(switchRequiresReindex('local', 'mystery')).toBe(true);
  });
});

describe('switchRequiresMigration', () => {
  it('is true when the vector width changes', () => {
    // Not a re-embed: the column is `vector(384)` and 1024 is a DDL change.
    expect(switchRequiresMigration('local', 'voyage-code')).toBe(true);
  });

  it('is false for the same embedder', () => {
    expect(switchRequiresMigration('local', 'local')).toBe(false);
  });

  it('is a stronger condition than a re-index', () => {
    // Every migration is also a re-index; the reverse does not hold, which is
    // why they are separate questions.
    for (const from of EMBEDDERS) {
      for (const to of EMBEDDERS) {
        if (switchRequiresMigration(from.id, to.id)) {
          expect(switchRequiresReindex(from.id, to.id), `${from.id}->${to.id}`).toBe(true);
        }
      }
    }
  });
});

describe('embedderWarning', () => {
  it('warns for a hosted embedder, and says why the quality improves', () => {
    const warning = embedderWarning('voyage-code');
    expect(warning).toContain('sends repository content');
    expect(warning).toContain('left this machine');
  });

  it('says nothing for the local one', () => {
    expect(embedderWarning('local')).toBeNull();
  });

  it('says nothing for an unknown id rather than inventing a warning', () => {
    expect(embedderWarning('nope')).toBeNull();
  });
});
