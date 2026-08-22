import { describe, expect, it } from 'vitest';
import {
  advanceCursor,
  decide,
  fingerprint,
  type LocalItem,
  type RemoteItem,
  type SyncCursor,
} from './tracker-sync.js';

const local = (over: Partial<LocalItem> = {}): LocalItem => ({
  id: 'STORY-1',
  title: 'Add a thing',
  body: 'the body',
  closed: false,
  ...over,
});

const remote = (over: Partial<RemoteItem> = {}): RemoteItem => ({
  id: '42',
  title: 'Add a thing',
  body: 'the body',
  closed: false,
  updatedAt: '2026-08-23T10:00:00Z',
  foreign: false,
  ...over,
});

const cursor = (over: Partial<SyncCursor> = {}): SyncCursor => ({
  key: 'github:faraasat/sandbox:42',
  remoteId: '42',
  localFingerprint: fingerprint(local()),
  remoteUpdatedAt: '2026-08-23T10:00:00Z',
  ...over,
});

describe('fingerprint', () => {
  it('ignores key order so the same item does not resync forever', () => {
    const a: LocalItem = { id: 'S', title: 't', body: 'b', closed: false };
    const b: LocalItem = { closed: false, body: 'b', title: 't', id: 'S' };
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('changes when any synced field changes', () => {
    const base = fingerprint(local());
    expect(fingerprint(local({ title: 'other' }))).not.toBe(base);
    expect(fingerprint(local({ body: 'other' }))).not.toBe(base);
    expect(fingerprint(local({ closed: true }))).not.toBe(base);
  });

  it('does not change when only the local id changes', () => {
    // The id is our side's name for it and is not synced; folding it in would
    // make a rename look like an edit.
    expect(fingerprint(local({ id: 'STORY-999' }))).toBe(fingerprint(local()));
  });
});

describe('decide — foreign items', () => {
  it('skips a pull request before doing anything else', () => {
    const d = decide({ local: local(), remote: remote({ foreign: true }), cursor: cursor() });
    expect(d.action).toBe('skip-foreign');
  });

  it('skips a pull request even when it looks like a brand new item', () => {
    expect(decide({ remote: remote({ foreign: true }) }).action).toBe('skip-foreign');
  });
});

describe('decide — creation', () => {
  it('creates remotely when the local item has never been pushed', () => {
    expect(decide({ local: local() }).action).toBe('create-remote');
  });

  it('creates locally when the remote has an item we have never seen', () => {
    expect(decide({ remote: remote() }).action).toBe('create-local');
  });

  it('does nothing when neither side has the item', () => {
    expect(decide({}).action).toBe('none');
  });
});

describe('decide — absence is not deletion', () => {
  it('does not delete locally when a synced remote item is missing from the batch', () => {
    const d = decide({ local: local(), cursor: cursor() });
    expect(d.action).toBe('none');
    expect(d.because).toContain('absence is not deletion');
  });

  it('does not delete remotely when a synced local item is missing from the batch', () => {
    const d = decide({ remote: remote(), cursor: cursor() });
    expect(d.action).toBe('none');
    expect(d.because).toContain('absence is not deletion');
  });
});

describe('decide — steady state', () => {
  it('does nothing when neither side moved', () => {
    expect(decide({ local: local(), remote: remote(), cursor: cursor() }).action).toBe('none');
  });

  it('pushes when only the local item changed', () => {
    const d = decide({
      local: local({ title: 'edited here' }),
      remote: remote(),
      cursor: cursor(),
    });
    expect(d.action).toBe('push');
  });

  it('pulls when only the remote item changed', () => {
    const d = decide({
      local: local(),
      remote: remote({ title: 'edited there', updatedAt: '2026-08-23T11:00:00Z' }),
      cursor: cursor(),
    });
    expect(d.action).toBe('pull');
  });

  it('detects a remote change from the timestamp even when the content looks identical', () => {
    // A label or assignee change moves updatedAt without touching title/body.
    // Treating it as unchanged would leave the cursor stale and mask the *next*
    // real edit as a conflict.
    const d = decide({
      local: local(),
      remote: remote({ updatedAt: '2026-08-23T11:00:00Z' }),
      cursor: cursor(),
    });
    expect(d.action).toBe('pull');
  });
});

describe('decide — conflict', () => {
  it('refuses by default when both sides changed', () => {
    const d = decide({
      local: local({ title: 'ours' }),
      remote: remote({ body: 'theirs', updatedAt: '2026-08-23T11:00:00Z' }),
      cursor: cursor(),
    });
    expect(d.action).toBe('conflict');
    expect(d.diverged).toEqual({ local: true, remote: true });
  });

  it('resolves only when a policy is named', () => {
    const both = {
      local: local({ title: 'ours' }),
      remote: remote({ body: 'theirs', updatedAt: '2026-08-23T11:00:00Z' }),
      cursor: cursor(),
    };
    expect(decide({ ...both, policy: 'prefer-local' }).action).toBe('push');
    expect(decide({ ...both, policy: 'prefer-remote' }).action).toBe('pull');
    expect(decide({ ...both, policy: 'refuse' }).action).toBe('conflict');
  });

  it('still reports which sides moved when a policy resolved it', () => {
    // The resolution is a choice, not an absence of conflict; a caller that
    // wants to log or warn needs the divergence even on the happy path.
    const d = decide({
      local: local({ title: 'ours' }),
      remote: remote({ body: 'theirs', updatedAt: '2026-08-23T11:00:00Z' }),
      cursor: cursor(),
      policy: 'prefer-local',
    });
    expect(d.diverged).toEqual({ local: true, remote: true });
  });

  it('does not apply a policy when only one side moved', () => {
    const d = decide({
      local: local({ title: 'ours' }),
      remote: remote(),
      cursor: cursor(),
      policy: 'prefer-remote',
    });
    expect(d.action).toBe('push');
    expect(d.diverged).toBeUndefined();
  });
});

describe('decide — first link', () => {
  it('adopts silently when an unlinked pair already agrees', () => {
    expect(decide({ local: local(), remote: remote(), cursor: undefined }).action).toBe('none');
  });

  it('treats an unlinked pair that differs as a conflict rather than picking a side', () => {
    const d = decide({ local: local({ title: 'ours' }), remote: remote({ title: 'theirs' }) });
    expect(d.action).toBe('conflict');
    expect(d.because).toContain('authoritative');
  });

  it('does not let a policy silently resolve a first link', () => {
    // A policy is a statement about *edits since a known common state*. There
    // is no common state here, so prefer-local would be discarding a remote
    // item nobody ever agreed was a copy of ours.
    const d = decide({
      local: local({ title: 'ours' }),
      remote: remote({ title: 'theirs' }),
      policy: 'prefer-local',
    });
    expect(d.action).toBe('conflict');
  });

  it('counts a closed/open disagreement as a differing first link', () => {
    const d = decide({ local: local(), remote: remote({ closed: true }) });
    expect(d.action).toBe('conflict');
  });
});

describe('advanceCursor', () => {
  it('records the remote timestamp it was given, so a push does not look like a foreign edit', () => {
    const after = remote({ updatedAt: '2026-08-23T12:00:00Z' });
    const next = advanceCursor({ key: 'k', local: local({ title: 'ours' }), remote: after });
    expect(next.remoteUpdatedAt).toBe('2026-08-23T12:00:00Z');
    // The very next decide must be quiet.
    expect(decide({ local: local({ title: 'ours' }), remote: after, cursor: next }).action).toBe(
      'none',
    );
  });

  it('stores the remote id so a later pass can address the item', () => {
    expect(advanceCursor({ key: 'k', local: local(), remote: remote({ id: '99' }) }).remoteId).toBe(
      '99',
    );
  });
});
