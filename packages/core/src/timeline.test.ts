import { describe, expect, it } from 'vitest';
import { formatTimeline, lifecycleTimeline, type InsertionMarker } from './timeline.js';

const NOW = Date.parse('2026-08-30T12:00:00.000Z');

const move = (
  to: string,
  hour: number,
  actor: string | null = 'ada',
): {
  work_item_id: string;
  from_state: string;
  to_state: string;
  created_at: string;
  actor: string | null;
} => ({
  work_item_id: 'TASK-001',
  from_state: '',
  to_state: to,
  created_at: `2026-08-30T${String(hour).padStart(2, '0')}:00:00.000Z`,
  actor,
});

describe('an empty history', () => {
  it('says the card has not moved, rather than showing nothing', () => {
    const timeline = lifecycleTimeline('TASK-001', [], [], NOW);
    expect(timeline.entries).toEqual([]);
    expect(timeline.elapsedMs).toBeNull();
    expect(timeline.because).toContain('not the same as having no history');
  });
});

describe('visits', () => {
  it('lists them in order', () => {
    const timeline = lifecycleTimeline(
      'TASK-001',
      [move('spec', 1), move('implement', 2), move('review', 3)],
      [],
      NOW,
    );
    expect(timeline.entries.map((e) => e.stage)).toEqual(['spec', 'implement', 'review']);
  });

  it('orders by time, not by array order', () => {
    const timeline = lifecycleTimeline('TASK-001', [move('review', 3), move('spec', 1)], [], NOW);
    expect(timeline.entries.map((e) => e.stage)).toEqual(['spec', 'review']);
  });

  it('marks a second trip through a stage as rework', () => {
    // A map of stages would collapse these into one and hide what made the
    // card slow.
    const timeline = lifecycleTimeline(
      'TASK-001',
      [move('implement', 1), move('review', 2), move('implement', 3)],
      [],
      NOW,
    );
    const implementVisits = timeline.entries.filter((e) => e.stage === 'implement');
    expect(implementVisits).toHaveLength(2);
    expect(implementVisits[0]?.reentry).toBe(false);
    expect(implementVisits[1]?.reentry).toBe(true);
    expect(implementVisits[1]?.visit).toBe(2);
    expect(timeline.reworked).toEqual(['implement']);
  });

  it('lists a reworked stage once, however many trips', () => {
    const timeline = lifecycleTimeline(
      'TASK-001',
      [
        move('implement', 1),
        move('review', 2),
        move('implement', 3),
        move('review', 4),
        move('implement', 5),
      ],
      [],
      NOW,
    );
    expect(timeline.reworked).toEqual(['implement', 'review']);
  });

  it('measures the open visit to now', () => {
    const timeline = lifecycleTimeline('TASK-001', [move('review', 10)], [], NOW);
    expect(timeline.entries[0]?.leftAt).toBeNull();
    expect(timeline.entries[0]?.ms).toBe(2 * 3_600_000);
  });

  it('carries the actor, and shows a system move as unattributed', () => {
    const timeline = lifecycleTimeline(
      'TASK-001',
      [move('spec', 1, 'ada'), move('implement', 2, null)],
      [],
      NOW,
    );
    expect(timeline.entries[0]?.actor).toBe('ada');
    expect(timeline.entries[1]?.actor).toBeNull();
  });

  it('attaches each actor to the stage they actually moved it to', () => {
    // The rows arrive out of order. Aligning visits with the input by index
    // would put grace's name on ada's transition — and every assertion about
    // the stages would still pass.
    const timeline = lifecycleTimeline(
      'TASK-001',
      [move('review', 3, 'grace'), move('spec', 1, 'ada'), move('implement', 2, 'bob')],
      [],
      NOW,
    );
    expect(timeline.entries.map((e) => [e.stage, e.actor])).toEqual([
      ['spec', 'ada'],
      ['implement', 'bob'],
      ['review', 'grace'],
    ]);
  });

  it('drops a transition with an unparseable timestamp rather than sorting on NaN', () => {
    const timeline = lifecycleTimeline(
      'TASK-001',
      [move('spec', 1), { ...move('implement', 2), created_at: 'not a date' }],
      [],
      NOW,
    );
    expect(timeline.entries.map((e) => e.stage)).toEqual(['spec']);
  });
});

describe('insertions', () => {
  const marker = (hour: number, id = 'INSERT-001'): InsertionMarker => ({
    insertionId: id,
    at: `2026-08-30T${String(hour).padStart(2, '0')}:00:00.000Z`,
    summary: 'scope added mid-flight',
  });

  it('places one inside the visit it landed in', () => {
    const timeline = lifecycleTimeline(
      'TASK-001',
      [move('implement', 1), move('review', 5)],
      [marker(3)],
      NOW,
    );
    expect(timeline.entries[0]?.insertions.map((m) => m.insertionId)).toEqual(['INSERT-001']);
    expect(timeline.entries[1]?.insertions).toEqual([]);
  });

  it('places one landing exactly on a boundary in the visit it starts', () => {
    // A closed interval would put it in both and double it.
    const timeline = lifecycleTimeline(
      'TASK-001',
      [move('implement', 1), move('review', 5)],
      [marker(5)],
      NOW,
    );
    expect(timeline.entries[0]?.insertions).toEqual([]);
    expect(timeline.entries[1]?.insertions).toHaveLength(1);
  });

  it('places one in an open visit', () => {
    const timeline = lifecycleTimeline('TASK-001', [move('review', 1)], [marker(6)], NOW);
    expect(timeline.entries[0]?.insertions).toHaveLength(1);
  });

  it('carries one that falls outside every visit rather than dropping it', () => {
    // Its timestamp disagrees with the transitions. Showing nothing would hide
    // a real record from the one view meant to explain the card.
    const timeline = lifecycleTimeline('TASK-001', [move('implement', 5)], [marker(1)], NOW);
    expect(timeline.entries[0]?.insertions).toEqual([]);
    expect(timeline.unplacedInsertions.map((m) => m.insertionId)).toEqual(['INSERT-001']);
  });

  it('treats an unparseable insertion timestamp as unplaced, not as matching', () => {
    const timeline = lifecycleTimeline(
      'TASK-001',
      [move('implement', 1)],
      [{ insertionId: 'INSERT-002', at: 'whenever', summary: 'x' }],
      NOW,
    );
    expect(timeline.unplacedInsertions).toHaveLength(1);
  });
});

describe('elapsed', () => {
  it('runs from the first transition to now while the card is open', () => {
    const timeline = lifecycleTimeline('TASK-001', [move('spec', 10)], [], NOW);
    expect(timeline.elapsedMs).toBe(2 * 3_600_000);
  });

  it('runs to the last transition once the card has left its last stage', () => {
    const timeline = lifecycleTimeline('TASK-001', [move('spec', 1), move('done', 4)], [], NOW);
    // The last visit is still open, so elapsed runs to now.
    expect(timeline.elapsedMs).toBe(11 * 3_600_000);
  });
});

describe('formatTimeline', () => {
  it('says a card has not moved', () => {
    expect(formatTimeline(lifecycleTimeline('TASK-001', [], [], NOW))).toContain('has not moved');
  });

  it('marks the visit number only on a re-entry', () => {
    const text = formatTimeline(
      lifecycleTimeline(
        'TASK-001',
        [move('implement', 1), move('review', 2), move('implement', 3)],
        [],
        NOW,
      ),
    );
    expect(text).toContain('implement (visit 2)');
    expect(text.split('\n').filter((l) => l.includes('implement (visit 1)'))).toEqual([]);
  });

  it('names an unattributed move rather than leaving a blank', () => {
    expect(
      formatTimeline(lifecycleTimeline('TASK-001', [move('spec', 1, null)], [], NOW)),
    ).toContain('(system)');
  });

  it('says when an insertion could not be placed, and why', () => {
    const text = formatTimeline(
      lifecycleTimeline(
        'TASK-001',
        [move('implement', 5)],
        [{ insertionId: 'INSERT-001', at: '2026-08-30T01:00:00.000Z', summary: 'x' }],
        NOW,
      ),
    );
    expect(text).toContain('disagree with the transitions');
  });
});
