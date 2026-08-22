# UI verification suite (P3-UI-03)

```bash
pnpm --filter @sdlc-on-fire/ui e2e:install   # once — downloads browser binaries
pnpm --filter @sdlc-on-fire/ui e2e           # all five projects
pnpm --filter @sdlc-on-fire/ui e2e:update    # re-record baselines after an intended change
```

## Why it is not part of `pnpm check`

These need browser binaries (~400MB), a built board and a running daemon. Folding them into the per-commit suite would make every commit depend on that download. Run per release, and whenever the board changes.

## The five projects

Chromium, Firefox and WebKit because "it works in a browser" is three different claims — WebKit diverges on focus, scroll anchoring and date rendering in ways Chromium never shows, and a board is exactly the surface (drag, sticky headers, virtualized columns) where that bites. Mobile and tablet are the responsiveness matrix: a board that only works at 1280px does not work on the laptop half a team actually uses.

## The noise policy

Pixel diffing has been solved for years; the whole difficulty is suppressing noise. A visual check that diffs on every run is switched off within a week, so the config disables animations and the caret, pins `scale: 'css'`, and allows a `maxDiffPixelRatio` of 0.01 for sub-pixel text rendering rather than demanding a bit-equality no two machines produce.

The fixture matters as much as the config: card titles and their order are fixed, because a screenshot baseline compares pixels and a card whose title varies per run guarantees a diff every time.

## Baselines are platform-tagged

Playwright names them `board-webkit-darwin.png`. A Linux run writes its own set rather than failing against these — correct, and worth knowing before wondering why CI wants new files.

## What it found on its first run

`nested-interactive` — dnd-kit's `attributes` were spread onto the whole card, giving it `role="button"`, so the open-details button sat inside a button. A screen-reader user meets a button inside a button and the inner one can be unreachable. Fixed with a dedicated drag handle that is a _sibling_ of the open control. No unit test would have caught it, and it was invisible to the eye.

## Cross-environment comparison (P3-UI-05)

A different question from visual regression: not _"did this change alter the UI"_ but _"do two deployments of the same commit render the same"_. It catches what no amount of regression testing can, because none of it is a code change — fonts that resolve here and 404 there, CDN configuration, missing assets, locale and timezone defaults.

```bash
SDLC_COMPARE_URL=https://staging.example \
  pnpm --filter @sdlc-on-fire/ui e2e --project=chromium -g "cross-environment"
```

Skipped without that variable, deliberately. There is no second deployment on a laptop, and a test that invented one would compare a thing to itself and report a pass that means nothing.

Verified in both directions against two local daemons of the same build: identical deployments match, and adding one card to the second produced `14.8% of pixels differ, above the 1.00% allowance`.

`unusable` is a third verdict alongside match and differs, and it is what keeps this honest. A comparison run against captures of different sizes, or without animations frozen, has not found a difference — it has failed to look. Reporting that as a difference trains people to ignore the report; reporting it as a match is a lie.
