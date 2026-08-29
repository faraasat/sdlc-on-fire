import { describe, expect, it } from 'vitest';
import {
  admitCheckRun,
  checkNames,
  formatAdmission,
  selectRun,
  type CheckRun,
} from './ci-status.js';
import { CiStatusEvidenceSchema } from './evidence.js';

const SHA = 'a'.repeat(40);

const run = (over: Partial<CheckRun> = {}): CheckRun => ({
  name: 'test',
  status: 'completed',
  conclusion: 'success',
  head_sha: SHA,
  html_url: 'https://github.com/o/r/runs/1',
  ...over,
});

describe('admitting a check run', () => {
  it('admits a completed success', () => {
    const admission = admitCheckRun([run()], 'test');
    expect(admission.admitted).toBe(true);
    expect(admission.payload?.ok).toBe(true);
    // And the payload is the shape the contract pins.
    expect(CiStatusEvidenceSchema.safeParse(admission.payload).success).toBe(true);
  });

  it('admits a failure as failing evidence, not as an error', () => {
    const admission = admitCheckRun([run({ conclusion: 'failure' })], 'test');
    expect(admission.admitted).toBe(true);
    expect(admission.payload?.ok).toBe(false);
  });

  it('refuses when the ref has no checks at all', () => {
    const admission = admitCheckRun([], 'test');
    expect(admission.admitted).toBe(false);
    expect(admission.refusal).toBe('no-checks');
  });

  it('refuses a check that is not there, and says what is', () => {
    const admission = admitCheckRun([run({ name: 'lint' })], 'test');
    expect(admission.refusal).toBe('check-not-found');
    expect(admission.reason).toContain('lint');
  });

  it('refuses a check that has not finished', () => {
    for (const status of ['queued', 'in_progress']) {
      const admission = admitCheckRun([run({ status, conclusion: null })], 'test');
      expect(admission.refusal).toBe('not-finished');
      expect(admission.payload).toBeUndefined();
    }
  });

  it('refuses a completed check with no conclusion — the provider contradicting itself', () => {
    expect(admitCheckRun([run({ conclusion: null })], 'test').refusal).toBe('not-finished');
  });

  it('refuses a conclusion this version does not know', () => {
    const admission = admitCheckRun([run({ conclusion: 'gave_up' })], 'test');
    expect(admission.refusal).toBe('unknown-conclusion');
    expect(admission.admitted).toBe(false);
  });
});

describe('what counts as a pass', () => {
  // The whole point of the feature, and the easiest thing to get wrong.
  it.each([
    ['success', true],
    ['failure', false],
    ['neutral', false],
    ['skipped', false],
    ['cancelled', false],
    ['timed_out', false],
    ['action_required', false],
  ])('%s → ok=%s', (conclusion, ok) => {
    expect(admitCheckRun([run({ conclusion })], 'test').payload?.ok).toBe(ok);
  });

  it('does not read a skipped job as an approving one', () => {
    // A path filter skipping a job is the ordinary case, which is exactly why
    // treating skipped as green would manufacture passes at scale.
    expect(admitCheckRun([run({ conclusion: 'skipped' })], 'test').payload?.ok).toBe(false);
  });
});

describe('choosing among repeated names', () => {
  it('prefers a completed run over a queued re-run', () => {
    const runs = [run({ status: 'queued', conclusion: null }), run({ conclusion: 'failure' })];
    expect(selectRun(runs, 'test')?.conclusion).toBe('failure');
    expect(admitCheckRun(runs, 'test').payload?.conclusion).toBe('failure');
  });

  it('returns null for a name that is absent', () => {
    expect(selectRun([run()], 'nope')).toBeNull();
  });

  it('falls back to the first run when none has completed', () => {
    const runs = [run({ status: 'in_progress', conclusion: null })];
    expect(selectRun(runs, 'test')?.status).toBe('in_progress');
  });
});

describe('the payload', () => {
  it('carries the provider vocabulary unrenamed', () => {
    const payload = admitCheckRun([run({ conclusion: 'timed_out' })], 'test').payload;
    expect(payload?.conclusion).toBe('timed_out');
  });

  it('carries the sha the check actually ran on, not the one asked for', () => {
    const other = 'b'.repeat(40);
    expect(admitCheckRun([run({ head_sha: other })], 'test').payload?.head_sha).toBe(other);
  });

  it('omits the url rather than emitting an empty one', () => {
    expect(admitCheckRun([run({ html_url: null })], 'test').payload?.url).toBeUndefined();
    expect(admitCheckRun([run({ html_url: '' })], 'test').payload?.url).toBeUndefined();
  });

  it('records the provider it was told about', () => {
    expect(admitCheckRun([run()], 'test', 'buildkite').payload?.provider).toBe('buildkite');
  });
});

describe('checkNames', () => {
  it('dedupes re-runs and sorts', () => {
    expect(checkNames([run({ name: 'b' }), run({ name: 'a' }), run({ name: 'b' })])).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('formatAdmission', () => {
  it('says why nothing was written', () => {
    expect(formatAdmission(admitCheckRun([], 'test'), 'test')).toContain('no evidence written');
  });

  it('names the conclusion when it records a failure', () => {
    const text = formatAdmission(admitCheckRun([run({ conclusion: 'neutral' })], 'test'), 'test');
    expect(text).toContain('neutral');
    expect(text).toContain('is not a pass');
  });
});
