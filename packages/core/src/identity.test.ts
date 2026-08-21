import { describe, expect, it } from 'vitest';
import { canAttribute, resolveIdentity, type Actor } from './identity.js';

/**
 * P3-UI-01 — identity resolution.
 *
 * The property under test is that every weakening of the evidence weakens the
 * result. An actor decides what a person may do, so a resolution that guesses
 * in the permissive direction hands somebody else's approval rights to whoever
 * opened the page.
 */

const human = (id: string, email: string | null = null): Actor => ({
  id,
  kind: 'human',
  displayName: id,
  email,
});
const agent = (id: string): Actor => ({ id, kind: 'agent', displayName: id, email: null });

describe('resolveIdentity', () => {
  it('prefers a token over everything else', () => {
    const identity = resolveIdentity({
      token: 't',
      tokenActorId: 'alice',
      gitEmail: 'bob@example.com',
      actors: [human('alice', 'alice@example.com'), human('bob', 'bob@example.com')],
    });
    expect(identity.actor?.id).toBe('alice');
    expect(identity.ground).toBe('token');
    expect(identity.attributable).toBe(true);
  });

  it('stops on a token that maps to nobody, rather than falling through', () => {
    // Falling through would let an invalid credential become solo mode — an
    // upgrade in access won by presenting a bad token.
    const identity = resolveIdentity({
      token: 'bogus',
      tokenActorId: 'nobody',
      actors: [human('alice', 'alice@example.com')],
    });
    expect(identity.actor).toBeNull();
    expect(identity.ground).toBe('none');
    expect(identity.attributable).toBe(false);
  });

  it('resolves from git email, case- and whitespace-insensitively', () => {
    const identity = resolveIdentity({
      gitEmail: '  Alice@Example.COM ',
      actors: [human('alice', 'alice@example.com'), human('bob', 'bob@example.com')],
    });
    expect(identity.actor?.id).toBe('alice');
    expect(identity.ground).toBe('git-email');
    expect(identity.attributable).toBe(true);
  });

  it('refuses when two actors share an email, rather than picking one', () => {
    // A plausible answer would hide a real data problem.
    const identity = resolveIdentity({
      gitEmail: 'shared@example.com',
      actors: [human('a', 'shared@example.com'), human('b', 'shared@example.com')],
    });
    expect(identity.actor).toBeNull();
    expect(identity.because).toContain('share the email');
  });

  it('falls back to solo mode, but never marks it attributable', () => {
    // The whole point of the distinction. A single developer should not have to
    // configure an identity to read their own board, but "there is one human
    // here, so you must be them" is an inference about an empty room.
    const identity = resolveIdentity({ actors: [human('solo'), agent('claude')] });
    expect(identity.actor?.id).toBe('solo');
    expect(identity.ground).toBe('solo-implicit');
    expect(identity.attributable).toBe(false);
    expect(canAttribute(identity)).toBe(false);
  });

  it('does not use solo mode once a second human exists', () => {
    const identity = resolveIdentity({ actors: [human('a'), human('b')] });
    expect(identity.actor).toBeNull();
    expect(identity.ground).toBe('none');
  });

  it('does not count agents towards the solo-mode population', () => {
    // Otherwise adding a second agent target would silently disable solo mode
    // for a developer who is still working alone.
    const identity = resolveIdentity({ actors: [human('solo'), agent('a1'), agent('a2')] });
    expect(identity.ground).toBe('solo-implicit');
  });

  it('never resolves an agent as the UI identity', () => {
    // Agents are actors, never approvers (architecture §5). A browser session
    // resolving to an agent would route around that structurally.
    const identity = resolveIdentity({ actors: [agent('claude')] });
    expect(identity.actor).toBeNull();
    expect(identity.because).toContain('no human actors');
  });

  it('says why, on every path', () => {
    // The ground is carried to the caller rather than flattened into "logged
    // in": a UI that cannot say why it thinks you are the engineering lead
    // should not be acting as one.
    for (const input of [
      { actors: [] },
      { actors: [human('solo')] },
      { gitEmail: 'x@y.z', actors: [human('a', 'a@b.c')] },
      { token: 't', tokenActorId: 'a', actors: [human('a')] },
    ]) {
      const identity = resolveIdentity(input);
      expect(identity.because.length, JSON.stringify(input)).toBeGreaterThan(0);
    }
  });
});

describe('canAttribute', () => {
  it('requires attributability, not merely an actor', () => {
    const solo = resolveIdentity({ actors: [human('solo')] });
    expect(solo.actor).not.toBeNull();
    expect(canAttribute(solo)).toBe(false);

    const tokened = resolveIdentity({ token: 't', tokenActorId: 'a', actors: [human('a')] });
    expect(canAttribute(tokened)).toBe(true);
  });

  it('refuses an agent even if something marked it attributable', () => {
    expect(
      canAttribute({
        actor: agent('claude'),
        ground: 'token',
        because: 'forced',
        attributable: true,
      }),
    ).toBe(false);
  });
});
