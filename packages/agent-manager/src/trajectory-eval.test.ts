import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_FLOOR,
  MIN_HARD_CASES,
  calibrate,
  evaluate,
  mineHardCases,
  trajectoryHash,
  type GoldenEntry,
  type Trajectory,
  type TrajectoryJudge,
  type TrajectoryVerdict,
} from './trajectory-eval.js';

/**
 * P1-EVAL-01 — the trajectory harness (FEAT-QA-001).
 *
 * Every gate in this product judges an artifact; none judges the *path*. The
 * obvious harness for that is an LLM judge, and it is the one this project is
 * least entitled to trust — so every test here is about the golden set being the
 * disposer and the judge being on licence.
 */

const trajectory = (id: string, action = 'decompose'): Trajectory => ({
  id,
  agent: 'orchestrator',
  task: 'add CSV import',
  steps: [{ role: 'orchestrator', action, outcome: 'three sub-tasks' }],
});

const golden = (count: number, hard: boolean, verdict: TrajectoryVerdict = 'good'): GoldenEntry[] =>
  Array.from({ length: count }, (_, i) => ({
    trajectory: trajectory(`${hard ? 'hard' : 'easy'}-${String(i)}`),
    verdict,
    because: 'human call',
    hard,
  }));

const judgeSaying =
  (verdict: TrajectoryVerdict): TrajectoryJudge =>
  () =>
    Promise.resolve({ verdict, confidence: 0.9, because: 'because it said so' });

/** Wrong on the first `wrong` hard cases, right on everything else. */
const judgeWrongOn = (wrong: number): TrajectoryJudge => {
  let seen = 0;
  return (t) => {
    const isHard = t.id.startsWith('hard-');
    const answer: TrajectoryVerdict = isHard && seen++ < wrong ? 'bad' : 'good';
    return Promise.resolve({ verdict: answer, confidence: 0.9, because: 'x' });
  };
};

describe('calibration', () => {
  it('refuses to license off a golden set with too few hard cases', async () => {
    const result = await calibrate([...golden(20, false)], judgeSaying('good'));
    expect(result.agreement).toBe(1);
    // 100% agreement, and it licenses nothing. Every judge agrees on easy cases;
    // a rate over easy examples licenses a judge that fails on what matters.
    expect(result.licensed).toBe(false);
    expect(result.reason).toContain('hard case');
  });

  it('licenses a judge that agrees on the hard cases', async () => {
    const result = await calibrate([...golden(MIN_HARD_CASES, true)], judgeSaying('good'));
    expect(result.licensed).toBe(true);
    expect(result.hardAgreement).toBe(1);
  });

  it('refuses one that agrees on the easy cases only', async () => {
    const set = [...golden(20, false), ...golden(MIN_HARD_CASES, true)];
    // Wrong on every hard case, right on all twenty easy ones.
    const result = await calibrate(set, judgeWrongOn(MIN_HARD_CASES));
    expect(result.agreement).toBeGreaterThan(0.7);
    expect(result.hardAgreement).toBe(0);
    // The overall number is what people quote; separating them is the point.
    expect(result.licensed).toBe(false);
  });

  it('licenses exactly at the floor rather than just above it', async () => {
    const hardCount = 10;
    const set = golden(hardCount, true);
    const result = await calibrate(
      set,
      judgeWrongOn(Math.round(hardCount * (1 - CALIBRATION_FLOOR))),
    );
    expect(result.hardAgreement).toBeCloseTo(CALIBRATION_FLOOR);
    expect(result.licensed).toBe(true);
  });

  it('records what it got wrong rather than only how often', async () => {
    const set = golden(MIN_HARD_CASES, true);
    const result = await calibrate(set, judgeWrongOn(2));
    expect(result.disagreements).toHaveLength(2);
    expect(result.disagreements[0]).toMatchObject({ expected: 'good', got: 'bad' });
  });
});

describe('evaluating an unseen trajectory', () => {
  it('reports a licensed judge’s verdict', async () => {
    const calibration = await calibrate(golden(MIN_HARD_CASES, true), judgeSaying('good'));
    const outcome = await evaluate(trajectory('new'), judgeSaying('bad'), calibration);
    expect(outcome).toMatchObject({ reported: true, verdict: 'bad' });
  });

  it('returns an uncalibrated judge’s opinion as an observation, not a finding', async () => {
    const calibration = await calibrate(golden(2, true), judgeSaying('good'));
    const outcome = await evaluate(trajectory('new'), judgeSaying('bad'), calibration);
    // Withholding it silently would be its own dishonesty; reporting it as a
    // verdict would be worse. It comes back labelled.
    expect(outcome.reported).toBe(false);
    if (outcome.reported) return;
    expect(outcome.observation).toBe('bad');
    expect(outcome.reason).toContain('hard case');
  });
});

describe('hard-case mining', () => {
  it('turns disagreements into hard golden entries', async () => {
    const set = golden(MIN_HARD_CASES, true);
    const calibration = await calibrate(set, judgeWrongOn(2));
    const mined = mineHardCases(
      calibration,
      set.map((entry) => entry.trajectory),
    );

    expect(mined).toHaveLength(2);
    // Added as hard, because they demonstrably are. This is the only mechanism
    // by which the set gets harder rather than merely older.
    expect(mined.every((entry) => entry.hard)).toBe(true);
    expect(mined[0]?.verdict).toBe('good');
  });

  it('keeps the human verdict, not the judge’s', async () => {
    const set = golden(MIN_HARD_CASES, true, 'acceptable');
    const calibration = await calibrate(set, judgeSaying('bad'));
    const mined = mineHardCases(
      calibration,
      set.map((entry) => entry.trajectory),
    );
    expect(mined.every((entry) => entry.verdict === 'acceptable')).toBe(true);
  });
});

describe('trajectoryHash', () => {
  it('distinguishes two routes to the same answer', () => {
    // Collapsing them would hide exactly what this harness exists to see.
    expect(trajectoryHash(trajectory('a', 'decompose'))).not.toBe(
      trajectoryHash(trajectory('a', 'guess')),
    );
  });

  it('ignores the id, so the same path recorded twice is one entry', () => {
    expect(trajectoryHash(trajectory('a'))).toBe(trajectoryHash(trajectory('b')));
  });
});
