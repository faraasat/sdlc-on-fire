// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DecisionLog as DecisionLogData, ResearchIndex } from '@sdlc-on-fire/core/browser';
import { LifecycleTimeline } from './LifecycleTimeline.js';
import { RunViewer } from './RunViewer.js';
import { ResearchPanel } from './ResearchPanel.js';
import { DecisionLog } from './DecisionLog.js';
import type { RunRow, TimelineResponse } from '../api/client.js';

/**
 * The four views P6-SURFACE-04 adds.
 *
 * Each test here is about something the view must *not* soften: an
 * unattributed transition, a cost nobody reported, research nobody asked for,
 * a supersession chain that no longer resolves.
 */

afterEach(cleanup);

const timeline = (over: Partial<TimelineResponse> = {}): TimelineResponse => ({
  workItemId: 'TASK-001',
  entries: [],
  reworked: [],
  elapsedMs: null,
  unplacedInsertions: [],
  because: 'no transitions recorded',
  insertionsAvailable: true,
  ...over,
});

const entry = (
  stage: string,
  over: Partial<TimelineResponse['entries'][number]> = {},
): TimelineResponse['entries'][number] => ({
  stage,
  enteredAt: 0,
  leftAt: 3_600_000,
  ms: 3_600_000,
  actor: 'ada',
  visit: 1,
  reentry: false,
  insertions: [],
  ...over,
});

describe('LifecycleTimeline', () => {
  it('says why there is nothing rather than showing an empty list', () => {
    render(<LifecycleTimeline timeline={timeline()} />);
    expect(screen.getByText(/no transitions recorded/)).toBeTruthy();
  });

  it('marks a re-entry and leaves the first visit unlabelled', () => {
    render(
      <LifecycleTimeline
        timeline={timeline({
          entries: [entry('implement'), entry('implement', { visit: 2, reentry: true })],
        })}
      />,
    );
    expect(screen.getByText('visit 2')).toBeTruthy();
    expect(screen.queryByText('visit 1')).toBeNull();
  });

  it('shows an unattributed move rather than a blank', () => {
    render(
      <LifecycleTimeline timeline={timeline({ entries: [entry('spec', { actor: null })] })} />,
    );
    expect(screen.getByText('(system)')).toBeTruthy();
  });

  it('marks the stage a card is still in', () => {
    render(
      <LifecycleTimeline timeline={timeline({ entries: [entry('review', { leftAt: null })] })} />,
    );
    expect(screen.getByText('still here')).toBeTruthy();
  });

  it('says when nobody could look for insertions, not that there were none', () => {
    render(
      <LifecycleTimeline
        timeline={timeline({ entries: [entry('spec')], insertionsAvailable: false })}
      />,
    );
    expect(screen.getByText(/no insertion reader/)).toBeTruthy();
  });

  it('reports insertions whose timestamps do not fit any visit', () => {
    render(
      <LifecycleTimeline
        timeline={timeline({
          entries: [entry('spec')],
          unplacedInsertions: [{ insertionId: 'INSERT-001', at: 'x', summary: 'y' }],
        })}
      />,
    );
    expect(screen.getByText(/disagree with the transitions/)).toBeTruthy();
  });

  it('says so instead of throwing when the payload is not a timeline', () => {
    // One malformed endpoint must not blank the drawer's other sections.
    render(<LifecycleTimeline timeline={{} as unknown as TimelineResponse} />);
    expect(screen.getByText(/timeline unavailable/)).toBeTruthy();
  });
});

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'run-1',
  work_item_id: 'TASK-001',
  skill_id: 'implement',
  model: 'claude-sonnet-5',
  status: 'pass',
  failure_reason: null,
  input_tokens: 100,
  output_tokens: 50,
  cost_usd: '0.0125',
  turns: 3,
  context_pack_path: '.sdlc/context/packs/run-1.md',
  started_at: '2026-08-30T00:00:00.000Z',
  finished_at: '2026-08-30T00:00:30.000Z',
  ...over,
});

describe('RunViewer', () => {
  it('says nothing has run', () => {
    render(<RunViewer runs={[]} />);
    expect(screen.getByText(/no agent runs recorded/)).toBeTruthy();
  });

  it('distinguishes an unreported cost from a free run', () => {
    // NULL and 0 are different facts, and rendering both as $0.0000 would be
    // the view inventing the more flattering one.
    render(<RunViewer runs={[run({ cost_usd: null })]} />);
    expect(screen.getByText('cost not reported')).toBeTruthy();
  });

  it('shows a reported cost', () => {
    render(<RunViewer runs={[run()]} />);
    expect(screen.getByText('$0.0125')).toBeTruthy();
  });

  it('shows the failure reason as recorded, not reworded', () => {
    render(<RunViewer runs={[run({ status: 'fail', failure_reason: 'output-contract' })]} />);
    expect(screen.getByText(/output-contract/)).toBeTruthy();
  });

  it('names the context pack, which is what makes a run reviewable', () => {
    render(<RunViewer runs={[run()]} />);
    expect(screen.getByText('.sdlc/context/packs/run-1.md')).toBeTruthy();
  });

  it('says when a run has no pack rather than rendering a blank', () => {
    render(<RunViewer runs={[run({ context_pack_path: null })]} />);
    expect(screen.getByText(/no context pack recorded/)).toBeTruthy();
  });

  it('does not compute an elapsed time for a run that never finished', () => {
    render(<RunViewer runs={[run({ status: 'running', finished_at: null })]} />);
    expect(screen.getByText('—')).toBeTruthy();
  });
});

const research = (over: Partial<ResearchIndex> = {}): ResearchIndex => ({
  byTopic: [],
  total: 0,
  unlinked: [],
  uncited: [],
  because: 'no research recorded yet',
  ...over,
});

describe('ResearchPanel', () => {
  it('says there is none', () => {
    render(<ResearchPanel index={research()} />);
    expect(screen.getByText(/no research recorded yet/)).toBeTruthy();
  });

  it('leads with the research nobody asked for', () => {
    render(
      <ResearchPanel
        index={research({
          total: 1,
          unlinked: ['r1'],
          byTopic: [
            {
              topic: 'retrieval',
              entries: [
                {
                  id: 'r1',
                  title: 'Hybrid search',
                  filePath: 'docs/r1.md',
                  topic: 'retrieval',
                  relatedWorkItems: [],
                  sources: [],
                  updatedAt: '2026-08-30T00:00:00.000Z',
                },
              ],
            },
          ],
        })}
      />,
    );
    expect(screen.getByText(/research nobody asked for/)).toBeTruthy();
    expect(screen.getByText('not linked to a work item')).toBeTruthy();
  });
});

const log = (over: Partial<DecisionLogData> = {}): DecisionLogData => ({
  entries: [],
  unidentified: [],
  chains: [],
  issues: [],
  because: 'no decisions recorded yet',
  ...over,
});

describe('DecisionLog', () => {
  it('says there are none', () => {
    render(<DecisionLog log={log()} />);
    expect(screen.getByText(/no decisions recorded yet/)).toBeTruthy();
  });

  it('shows a broken chain as broken, not as a clean list', () => {
    render(
      <DecisionLog
        log={log({
          entries: [
            {
              id: 'ADR-0001',
              adrId: 'ADR-0001',
              title: 'First',
              filePath: 'docs/ADR-0001.md',
              status: 'superseded',
              supersedes: null,
              supersededBy: null,
              identified: true,
              updatedAt: '2026-08-30T00:00:00.000Z',
            },
          ],
          chains: [['ADR-0001']],
          issues: [
            {
              adrId: 'ADR-0001',
              problem: 'superseded-without-successor',
              because: 'marked superseded with nothing naming the replacement',
            },
          ],
        })}
      />,
    );
    expect(screen.getByText(/superseded-without-successor/)).toBeTruthy();
  });

  it('renders a chain in order', () => {
    render(
      <DecisionLog
        log={log({
          entries: [
            {
              id: 'ADR-0001',
              adrId: 'ADR-0001',
              title: 'First',
              filePath: 'a',
              status: 'superseded',
              supersedes: null,
              supersededBy: 'ADR-0002',
              identified: true,
              updatedAt: '2026-08-30T00:00:00.000Z',
            },
            {
              id: 'ADR-0002',
              adrId: 'ADR-0002',
              title: 'Second',
              filePath: 'b',
              status: 'accepted',
              supersedes: 'ADR-0001',
              supersededBy: null,
              identified: true,
              updatedAt: '2026-08-30T00:00:00.000Z',
            },
          ],
          chains: [['ADR-0001', 'ADR-0002']],
        })}
      />,
    );
    expect(screen.getByText('ADR-0001')).toBeTruthy();
    expect(screen.getByText('ADR-0002')).toBeTruthy();
    expect(screen.getByText('Second')).toBeTruthy();
  });

  it('says a record has no adr_id rather than rendering its path as one', () => {
    render(
      <DecisionLog
        log={log({
          entries: [
            {
              id: 'docs/adr/README.md',
              adrId: 'docs/adr/README.md',
              title: 'Index',
              filePath: 'docs/adr/README.md',
              status: 'unknown',
              supersedes: null,
              supersededBy: null,
              identified: false,
              updatedAt: '2026-08-30T00:00:00.000Z',
            },
          ],
          unidentified: ['docs/adr/README.md'],
          chains: [['docs/adr/README.md']],
        })}
      />,
    );
    expect(screen.getByText(/declare no/)).toBeTruthy();
  });

  it('names a chain link that is not in the log', () => {
    render(
      <DecisionLog
        log={log({
          entries: [
            {
              id: 'ADR-0001',
              adrId: 'ADR-0001',
              title: 'First',
              filePath: 'a',
              status: 'accepted',
              supersedes: null,
              supersededBy: null,
              identified: true,
              updatedAt: '2026-08-30T00:00:00.000Z',
            },
          ],
          chains: [['ADR-0001', 'ADR-0099']],
        })}
      />,
    );
    expect(screen.getByText('(not in the log)')).toBeTruthy();
  });
});
