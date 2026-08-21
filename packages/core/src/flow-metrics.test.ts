import { describe, expect, it } from 'vitest';
import {
  bottleneck,
  cycleTime,
  flowEfficiency,
  leadTime,
  rework,
  stageDurations,
  stageStats,
  stageVisits,
  visitsByCard,
  type TransitionRow,
} from './flow-metrics.js';

/**
 * P3-MET-01 — flow metrics.
 *
 * The distinction these exist for is wait time versus active time. Cycle time
 * alone says a card took nine days; it cannot say whether that was nine days of
 * work or one day of work and eight days queueing, and those ask for opposite
 * fixes.
 */

const HOUR = 3_600_000;
const at = (hours: number): string => new Date(Date.UTC(2026, 7, 1, hours)).toISOString();

const row = (stage: string, hours: number, card = 'FEAT-1'): TransitionRow => ({
  work_item_id: card,
  from_state: null,
  to_state: stage,
  created_at: at(hours),
});

describe('stageVisits', () => {
  it('turns transitions into ordered visits with durations', () => {
    const visits = stageVisits(
      [row('spec', 0), row('implement', 2), row('done', 6)],
      Date.parse(at(6)),
    );
    expect(visits.map((visit) => [visit.stage, visit.ms])).toEqual([
      ['spec', 2 * HOUR],
      ['implement', 4 * HOUR],
      ['done', 0],
    ]);
  });

  it('orders by timestamp, not by array position', () => {
    // Rows arrive from a query; assuming insertion order would silently
    // mis-measure every card whose transitions came back unordered.
    const visits = stageVisits(
      [row('done', 6), row('spec', 0), row('implement', 2)],
      Date.parse(at(6)),
    );
    expect(visits.map((visit) => visit.stage)).toEqual(['spec', 'implement', 'done']);
  });

  it('measures an open visit up to now, rather than reporting nothing', () => {
    // A card that has sat in review for a week is the most interesting row on
    // a bottleneck report; a null duration would drop exactly those.
    const visits = stageVisits([row('review', 0)], Date.parse(at(9)));
    expect(visits[0]?.leftAt).toBeNull();
    expect(visits[0]?.ms).toBe(9 * HOUR);
  });

  it('records a re-entered stage as a separate visit', () => {
    // Rework is normal and is exactly what a flow metric should surface. A map
    // keyed by stage would collapse three trips through implement into one.
    const visits = stageVisits(
      [row('implement', 0), row('review', 2), row('implement', 3), row('done', 5)],
      Date.parse(at(5)),
    );
    expect(visits.filter((visit) => visit.stage === 'implement')).toHaveLength(2);
  });

  it('ignores a row with an unparseable timestamp instead of producing NaN', () => {
    const visits = stageVisits([
      { work_item_id: 'x', from_state: null, to_state: 'spec', created_at: 'not a date' },
      row('done', 1),
    ]);
    expect(visits.map((visit) => visit.stage)).toEqual(['done']);
  });

  it('is empty for a card with no transitions', () => {
    expect(stageVisits([])).toEqual([]);
  });
});

describe('leadTime and cycleTime', () => {
  const visits = stageVisits(
    [row('spec', 4), row('implement', 6), row('done', 10)],
    Date.parse(at(10)),
  );

  it('measures lead time from creation, including the queue before work started', () => {
    // A card created Monday and picked up Friday waited four days the customer
    // experienced and the team did not. Dropping that makes the number
    // flattering and useless.
    expect(leadTime(visits, at(0))).toBe(10 * HOUR);
  });

  it('measures cycle time from the first stage, excluding that queue', () => {
    expect(cycleTime(visits)).toBe(6 * HOUR);
  });

  it('returns null for a card that is not done, rather than a partial number', () => {
    const open = stageVisits([row('spec', 0), row('implement', 2)], Date.parse(at(9)));
    expect(cycleTime(open)).toBeNull();
    expect(leadTime(open, at(0))).toBeNull();
  });

  it('returns null for an unparseable creation time', () => {
    expect(leadTime(visits, 'whenever')).toBeNull();
  });
});

describe('flowEfficiency', () => {
  it('separates work from waiting', () => {
    const visits = stageVisits(
      [row('triage', 0), row('implement', 8), row('review', 10), row('done', 14)],
      Date.parse(at(14)),
    );
    const efficiency = flowEfficiency(visits);
    expect(efficiency.waitMs).toBe(12 * HOUR); // triage 8 + review 4
    expect(efficiency.activeMs).toBe(2 * HOUR);
    expect(efficiency.ratio).toBeCloseTo(2 / 14, 5);
  });

  it('is null, not zero, when there is nothing to measure', () => {
    // Zero is a real and alarming answer — everything queued. A card with no
    // history reporting the same number makes an empty dashboard a crisis.
    expect(flowEfficiency([]).ratio).toBeNull();
  });

  it('takes the wait stages as an argument rather than guessing them', () => {
    // Whether `approval` is waiting is a statement about how a team works.
    const visits = stageVisits([row('approval', 0), row('done', 4)], Date.parse(at(4)));
    expect(flowEfficiency(visits, ['approval']).activeMs).toBe(0);
    expect(flowEfficiency(visits, []).waitMs).toBe(0);
  });
});

describe('stageStats and bottleneck', () => {
  const visits = stageVisits(
    [row('spec', 0), row('implement', 1), row('review', 9), row('done', 10)],
    Date.parse(at(10)),
  );

  it('ranks stages by total time', () => {
    expect(stageStats(visits)[0]?.stage).toBe('implement');
  });

  it('names the binding constraint', () => {
    // Theory of Constraints' one useful claim: optimising anywhere but the
    // constraint does not move throughput at all.
    expect(bottleneck(visits)?.stage).toBe('implement');
    expect(bottleneck(visits)?.totalMs).toBe(8 * HOUR);
  });

  it('ranks by total rather than mean, so a widely-slow stage outranks a rare disaster', () => {
    const many = stageVisits(
      [
        row('review', 0),
        row('spec', 1),
        row('review', 2),
        row('spec', 3),
        row('review', 4),
        row('done', 9),
      ],
      Date.parse(at(9)),
    );
    // spec: 1h + 1h = 2h over 2 visits (mean 1h). review: 1h + 1h + 5h = 7h.
    expect(bottleneck(many)?.stage).toBe('review');
  });

  it('is null with nothing to rank', () => {
    expect(bottleneck([])).toBeNull();
  });

  it('reports totals per stage', () => {
    expect(stageDurations(visits).get('implement')).toBe(8 * HOUR);
  });
});

describe('rework', () => {
  it('counts cards that went backwards, and where', () => {
    // Invisible in cycle time: a card that ping-pongs three times and one that
    // walks straight through can take the same nine days.
    const transitions = [
      row('implement', 0, 'A'),
      row('review', 1, 'A'),
      row('implement', 2, 'A'),
      row('review', 3, 'A'),
      row('done', 4, 'A'),
      row('implement', 0, 'B'),
      row('done', 2, 'B'),
    ];
    const summary = rework(visitsByCard(transitions, Date.parse(at(4))));
    expect(summary.cardsWithRework).toBe(1);
    expect(summary.totalRevisits).toBe(2);
    expect(summary.hotspots[0]?.stage).toBe('implement');
  });

  it('reports nothing for a clean run', () => {
    const summary = rework(visitsByCard([row('spec', 0), row('done', 1)], Date.parse(at(1))));
    expect(summary).toEqual({ cardsWithRework: 0, totalRevisits: 0, hotspots: [] });
  });
});

describe('visitsByCard', () => {
  it('keeps cards separate', () => {
    const byCard = visitsByCard([row('spec', 0, 'A'), row('spec', 0, 'B')], Date.parse(at(1)));
    expect([...byCard.keys()].sort()).toEqual(['A', 'B']);
  });
});
