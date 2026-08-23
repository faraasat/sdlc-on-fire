# @sdlc-on-fire/ui

The board. A React client over the same database the CLI reads — not a second source of truth, and deliberately not a second way to change things.

> **Internal package, prerelease `0.1.0-alpha.1`.** Published so `sdlc-on-fire` installs resolve cleanly. Exports move between alphas. The supported surface is the [`sdlc-on-fire`](https://www.npmjs.com/package/sdlc-on-fire) CLI, which serves this with `sdlc serve`.

## Read-mostly, on purpose

Most of what you see here is read-only, and that is a decision rather than an unfinished feature ([ADR-0016](https://github.com/faraasat/sdlc-on-fire)).

A board that lets you drag a card into "Done" is a board that lets you skip a gate. The whole product rests on state changing only when the daemon has evidence it should, so the UI shows you that state and sends you to the CLI to change it. Approvals, gate overrides and lifecycle transitions all go through commands that record who did it and why.

What you get instead is the thing a terminal is bad at: seeing everything at once.

## What is in here

- **Three views over one item set** — `BoardView`, `TableView`, `RoadmapView`, switched by `ViewPicker`. Same data, three shapes.
- **`CardDrawer`** — the deep view of one work item: spec, evidence, gate state, comments.
- **`ActivityFeed`** — resolved comment effects as they happen. It renders the server-computed `role_effect` and never re-derives meaning client-side, because a client that decides what a comment _meant_ is a client that can be argued with.
- **`PresenceBar`** and **`ConnectionDot`** — who is here, and whether you are actually connected. A stale board that looks live is worse than one that admits it dropped.
- **`MetricsView`** — flow and DORA over `/api/metrics`.

## Realtime without polling

Postgres `AFTER INSERT/UPDATE` triggers emit `NOTIFY`; the daemon holds a single `LISTEN` connection and fans changes out over one WebSocket. The board updates because the database said something changed — not because a timer fired and asked.

TanStack Query owns server state and optimistic updates. Zustand owns the small amount that is genuinely client-side, like which view you picked.

## Solo-simple by default

The board renders flat. No swimlanes, no role filter chips, no ceremony — a single developer should not have to dismiss a team's worth of UI to see three cards. Swimlanes and role-based saved views exist and are opt-in, and they appear when there is more than one person to justify them.

## Licence

MIT.
