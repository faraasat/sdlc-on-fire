# @sdlc-on-fire/storage

Reads and writes work-item Markdown. The layer that keeps your project in files a human can diff.

> **Internal package, prerelease `0.1.0-alpha.1`.** Published so `sdlc-on-fire` installs resolve. No stability guarantee before `0.1.0` — exports move and disappear between alphas. The supported surface is the [`sdlc-on-fire`](https://www.npmjs.com/package/sdlc-on-fire) CLI.

## Two guarantees, and they live nowhere else

**Nothing reaches disk without validating against the object model.** A file that would fail `WorkItemSchema` is refused before it is written, not discovered later by whatever tries to read it.

**A work item at a terminal stage is never edited in place.** The check reads the frontmatter _about to be overwritten_, not the incoming object:

```ts
import { writeWorkItem } from '@sdlc-on-fire/storage';

// TASK-001 is on disk with lifecycle_state: done
await writeWorkItem(path, { ...item, lifecycleState: 'implement' });
// → throws: refuses to write a terminal item
```

That ordering is the whole guarantee. An agent that sets `lifecycle_state: implement` on a finished task does not thereby unlock it — the incoming object is what is being _checked_, so it cannot also be the thing that authorises the check.

Writing a finished item at all requires verifiable grounds — an approved insertion whose blast radius reaches it, or an attestation that its own evidence contradicts the claim — and even then only operational fields may move. The body must come through byte-identical, which is checked rather than asked for.

## Frontmatter round-trips

```ts
import { parseFrontmatter, serializeFrontmatter } from '@sdlc-on-fire/storage';

const { data, body } = parseFrontmatter(await fs.readFile(file, 'utf8'));
```

Key order and formatting survive a read/write cycle, so a tool-written file does not produce a diff against a hand-written one that says the same thing.

## Licence

MIT.
