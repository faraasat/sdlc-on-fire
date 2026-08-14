# @sdlc-on-fire/storage

**The typed Markdown reader and writer — the only sanctioned way work-item files are written.**

> **Internal package, prerelease.** Published so that `sdlc-on-fire` installs resolve. It carries **no stability guarantee** before `0.1.0` — exports move and disappear between alpha releases. The supported surface is the [`sdlc-on-fire`](https://www.npmjs.com/package/sdlc-on-fire) CLI.

Two guarantees live here and nowhere else.

**Nothing reaches disk without validating against the object model.** A file that would fail the schema is refused before it is written, rather than discovered later by whatever tries to read it.

**A work item at a terminal stage is never edited in place.** The check reads the frontmatter _about to be overwritten_, not the incoming object — an agent that sets `lifecycle_state: implement` on a finished task does not thereby unlock it. Writing a finished item requires verifiable grounds (an approved insertion whose blast radius reaches it, or an attestation that its own evidence contradicts the claim), and even then the write may only touch operational fields; content and body must come through byte-identical.

Frontmatter round-trips deterministically, so a one-field change produces a one-line diff.

## Install

```bash
npm install @sdlc-on-fire/storage@next
```

Node 20 or newer. Part of [SDLC on Fire](https://github.com/faraasat/sdlc-on-fire) — a daemon that will not let the agent lie.

## Licence

MIT.
