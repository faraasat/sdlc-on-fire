import { describe, expect, it } from 'vitest';
import {
  RFC2119_KEYWORDS,
  archivePath,
  blocks,
  changePath,
  findKeywords,
  parseScenarios,
  specPath,
  validateRequirement,
  validateSpec,
  type AuthoredRequirement,
} from './spec-authoring.js';

/**
 * P4-BROWN-01 — native brownfield authoring.
 *
 * Two refusals do the real work, and every other assertion here exists to keep
 * them honest: a requirement that cannot be violated, and a scenario that
 * cannot fail. The second is the same defect this product exists to refuse from
 * an agent — something that reads as a test and passes unconditionally.
 */

const req = (over: Partial<AuthoredRequirement> = {}): AuthoredRequirement => ({
  title: 'Retries are bounded',
  body: 'The system MUST retry at most three times.',
  keywords: ['MUST'],
  scenarios: [
    { given: ['a failing call'], when: ['it is retried'], then: ['it stops after three'] },
  ],
  ...over,
});

describe('findKeywords', () => {
  it('finds a normative keyword', () => {
    expect(findKeywords('The system MUST retry.')).toEqual(['MUST']);
  });

  it('ignores lowercase, because RFC 8174 says only uppercase is normative', () => {
    // "the system should be fast" is a wish; "the system SHOULD retry" is a
    // requirement. Matching case-insensitively would silently promote every
    // casual sentence in the document into a testable obligation.
    expect(findKeywords('the system should be fast and may be slow')).toEqual([]);
  });

  it('reports MUST NOT as MUST NOT, never as MUST', () => {
    // The one place a mis-parse inverts the requirement's meaning.
    expect(findKeywords('The system MUST NOT retry.')).toEqual(['MUST NOT']);
  });

  it('reports SHOULD NOT and SHALL NOT whole', () => {
    expect(findKeywords('It SHOULD NOT log. It SHALL NOT crash.')).toEqual([
      'SHOULD NOT',
      'SHALL NOT',
    ]);
  });

  it('returns keywords in order of appearance', () => {
    expect(findKeywords('It MAY log, but it MUST NOT crash, and SHOULD retry.')).toEqual([
      'MAY',
      'MUST NOT',
      'SHOULD',
    ]);
  });

  it('does not match a keyword inside a word', () => {
    expect(findKeywords('The MUSTARD is optional')).toEqual([]);
  });

  it('recognises every declared keyword', () => {
    for (const keyword of RFC2119_KEYWORDS) {
      expect(findKeywords(`It ${keyword} happen.`)).toContain(keyword);
    }
  });
});

describe('parseScenarios', () => {
  it('parses a whole scenario', () => {
    const [scenario] = parseScenarios(
      ['GIVEN a failing call', 'WHEN it is retried', 'THEN it stops after three'].join('\n'),
    );
    expect(scenario?.given).toEqual(['a failing call']);
    expect(scenario?.when).toEqual(['it is retried']);
    expect(scenario?.then).toEqual(['it stops after three']);
  });

  it('starts a new scenario at each GIVEN', () => {
    const scenarios = parseScenarios(
      ['GIVEN a', 'WHEN b', 'THEN c', '', 'GIVEN d', 'WHEN e', 'THEN f'].join('\n'),
    );
    expect(scenarios).toHaveLength(2);
  });

  it('continues the open clause on AND rather than splitting the scenario', () => {
    // Treating a trailing AND as a fresh clause splits one scenario into two,
    // each missing half its setup.
    const [scenario] = parseScenarios(
      ['GIVEN a', 'AND b', 'WHEN c', 'AND d', 'THEN e', 'AND f'].join('\n'),
    );
    expect(scenario?.given).toEqual(['a', 'b']);
    expect(scenario?.when).toEqual(['c', 'd']);
    expect(scenario?.then).toEqual(['e', 'f']);
  });

  it('accepts list-marker syntax', () => {
    const [scenario] = parseScenarios(['- GIVEN a', '- WHEN b', '- THEN c'].join('\n'));
    expect(scenario?.then).toEqual(['c']);
  });

  it('ignores WHEN and THEN with no GIVEN to attach to', () => {
    expect(parseScenarios(['WHEN b', 'THEN c'].join('\n'))).toEqual([]);
  });

  it('finds nothing in prose', () => {
    expect(parseScenarios('The system retries three times.')).toEqual([]);
  });
});

describe('validateRequirement', () => {
  it('accepts a well-formed requirement', () => {
    expect(validateRequirement(req())).toEqual([]);
  });

  it('refuses a requirement with no RFC-2119 keyword', () => {
    const problems = validateRequirement(req({ keywords: [] }));
    expect(problems[0]?.severity).toBe('refusal');
    expect(problems[0]?.because).toContain('cannot be violated');
  });

  it('refuses a scenario with no THEN', () => {
    // It reads as a test and passes unconditionally — worse than no test.
    const problems = validateRequirement(
      req({ scenarios: [{ given: ['a'], when: ['b'], then: [] }] }),
    );
    expect(
      problems.some((p) => p.severity === 'refusal' && p.because.includes('cannot fail')),
    ).toBe(true);
  });

  it('only advises when a scenario has no WHEN', () => {
    const problems = validateRequirement(
      req({ scenarios: [{ given: ['a'], when: [], then: ['c'] }] }),
    );
    expect(problems.every((p) => p.severity === 'advice')).toBe(true);
  });

  it('only advises when there is no scenario at all', () => {
    // A spec is prose somebody lives with; a validator that refuses on style is
    // one they switch off.
    const problems = validateRequirement(req({ scenarios: [] }));
    expect(blocks(problems)).toBe(false);
  });

  it('lets a REMOVED delta carry no keyword and no scenario', () => {
    // It deletes a requirement rather than stating one.
    const problems = validateRequirement(req({ delta: 'REMOVED', keywords: [], scenarios: [] }));
    expect(blocks(problems)).toBe(false);
  });

  it('still refuses an ADDED delta with no keyword', () => {
    expect(blocks(validateRequirement(req({ delta: 'ADDED', keywords: [] })))).toBe(true);
  });

  it('names the requirement in every problem, not just the file', () => {
    const problems = validateRequirement(req({ title: 'Specific title', keywords: [] }));
    expect(problems[0]?.requirement).toBe('Specific title');
  });
});

describe('validateSpec', () => {
  it('refuses two requirements sharing a title', () => {
    // Requirements are referenced by title in changes and in review, so two
    // with one name make every reference ambiguous — invisibly, until somebody
    // resolves it the wrong way.
    const problems = validateSpec([req({ title: 'Same' }), req({ title: 'Same' })]);
    expect(problems.some((p) => p.severity === 'refusal' && p.because.includes('appears 2'))).toBe(
      true,
    );
  });

  it('accepts distinct titles', () => {
    expect(blocks(validateSpec([req({ title: 'A' }), req({ title: 'B' })]))).toBe(false);
  });

  it('accepts an empty spec rather than inventing a problem', () => {
    expect(validateSpec([])).toEqual([]);
  });
});

describe('paths', () => {
  it('places specs, changes and the archive where the delta model expects', () => {
    expect(specPath('billing')).toBe('specs/billing/spec.md');
    expect(changePath('add-retries')).toBe('changes/add-retries/proposal.md');
    expect(archivePath('add-retries')).toBe('changes/archive/add-retries/proposal.md');
  });

  it('archives rather than deletes', () => {
    // The delta is the record of *why* the spec says what it says. A project
    // that deletes landed changes keeps the conclusion and throws away the
    // argument.
    expect(archivePath('x')).toContain('archive');
  });
});
