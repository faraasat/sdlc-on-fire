import { describe, expect, it } from 'vitest';
import { contextPackage, contextDependencies } from './index.js';
import { toSearchQuery } from './retrieval.js';

describe('@sdlc-on-fire/context', () => {
  it('reports its own npm name', () => {
    expect(contextPackage.name).toBe('@sdlc-on-fire/context');
  });

  it('resolves every declared workspace dependency to a real package', () => {
    expect(contextDependencies.map((p) => p.name)).toEqual(contextPackage.dependsOn);
  });
});

describe('toSearchQuery — the AND defect the A-03 eval found', () => {
  it('emits an OR expression, not a word list', () => {
    // `websearch_to_tsquery` ANDs its terms. A word list meant every realistic
    // query demanded every stem in one chunk, so retrieval returned nothing.
    expect(toSearchQuery('importer retries backoff')).toBe('importer | retries | backoff');
  });

  it('survives a whole card body — the query the real caller actually passes', () => {
    const card = `Add CSV import to the ledger. The importer should retry transient
      failures three times with exponential backoff, and report any row it cannot
      parse along with its line number. Multi-currency is out of scope.`;
    const query = toSearchQuery(card);
    // Every test before this searched for a single invented word, which is why
    // a retriever that found nothing for real input passed its suite.
    expect(query.split(' | ').length).toBeGreaterThan(20);
    expect(query).not.toMatch(/[^\p{L}\p{N}\s|]/u);
  });

  it('dedupes repeated terms', () => {
    // A term repeated in prose is not twice as relevant, and the duplicate
    // would be carried into the parsed tsquery.
    expect(toSearchQuery('retry retry retry backoff')).toBe('retry | backoff');
  });

  it('lower-cases so a term is not kept twice by capitalisation', () => {
    expect(toSearchQuery('Importer importer')).toBe('importer');
  });

  it('drops punctuation rather than escaping it', () => {
    expect(toSearchQuery('a.b, c!')).toBe('a | b | c');
  });
});
