# Compromised-package response playbook

> P2-SEC-09 · [ADR-0033](https://github.com/faraasat/sdlc-on-fire-wrapper) · runs alongside `sdlc deps watch`

## What this covers

A package that was fine when you installed it, and is not fine now.

This is a different failure from the one the install gate catches. `sdlc deps
check` asks _should this be added_ — it stops hallucinated names, typosquats,
and packages with advisories already published. It cannot help with a real,
trusted, already-installed package whose **publish step** was compromised
afterwards.

That category is where the damage has actually been done. In the four months
before this was written: Axios (100M+ weekly downloads) was backdoored through a
hijacked maintainer account; TanStack had 84 malicious versions across 42
packages published via GitHub Actions cache poisoning and OIDC-token
exfiltration, caught only because outside researchers were watching; node-ipc,
Red Hat Cloud Services, and AsyncAPI were each separately compromised in the
same window. None were hallucinated packages. Every one exploited publishing.

**A lockfile does not prevent this.** Pinning stops your build from silently
resolving to something new. It does not stop a compromised maintainer from
publishing a version whose integrity hash is perfectly self-consistent — the
digest attests the file arrived unaltered, not that whoever published it should
have. Detection, not prevention, is what is available here.

## Detecting

```bash
sdlc deps watch
```

Polls advisories against the versions **actually installed** and reports what
changed since the last poll. Two things to know before relying on it:

- **The first run reports nothing.** It records a baseline. Flagging every
  advisory that already exists would bury the one that appears tomorrow, and a
  tool whose first output is a hundred urgent findings teaches people its
  findings are not urgent.
- **A poll that could not reach the source says so and changes nothing.** An
  unreachable advisory database returns "no advisories", which is
  indistinguishable from good news. The stored record is left untouched rather
  than overwritten with an outage's silence — otherwise the _next_ poll reports
  everything you already knew as newly discovered.

Run it on a schedule. The value is entirely in repetition; a supply-chain check
run once is a check that was true once.

`URGENT` means an advisory attached to a package that was already installed and
previously clean: nothing about your project changed and the answer changed
anyway. `REVIEW` means a package new since the last poll — the install gate
already asked about that one.

## Responding

In order. The first two are time-sensitive; the rest are not, but they are the
ones that get skipped.

### 1. Pin or remove the affected version

Do not wait for a fixed release. Pin to the last known-good version, or drop the
dependency. A compromised version sitting in the tree while you wait is a
compromised version in every build you run meanwhile.

### 2. Rotate every credential the package could have reached

This is the step that matters most and the one most often deferred, because it
is inconvenient and the damage is invisible. Assume anything in the environment
of a build that ran the affected version is exposed:

- npm / registry publish tokens
- CI secrets and OIDC-issued cloud credentials
- Anything in `.env` on a machine that ran `install`

Install-time execution is the usual vector — a `postinstall` script runs with
your credentials in scope, on your CI runner, before any test does.

### 3. Check whether you shipped while it was in the tree

If a release of your own went out while the affected version was a dependency,
your consumers have the problem too. Deprecate that release and say why. This is
the step that separates a contained incident from a propagated one, and it is
the one requiring you to make your own problem publicly visible.

### 4. Audit the compromise window

The advisory states when the bad versions were published. Between that date and
your fix, look at what ran: CI logs first, then any process that had network
access and credentials at the same time.

### 5. Write it down while it is fresh

What happened, when it was noticed, what was rotated, what was not. Both for
the postmortem and because "did we rotate that one?" is unanswerable six weeks
later.

## What this playbook does not do

It does not prevent the compromise, and it does not detect one before an
advisory exists. Between a malicious publish and its disclosure, this finds
nothing — the TanStack incident was caught by outside researchers watching,
not by advisory polling.

Detection latency is real and unmeasured here. Treating a passing
`sdlc deps watch` as proof that nothing is wrong is the same substitution this
tooling refuses everywhere else: it means no advisory has been _published_, not
that no package has been compromised.
