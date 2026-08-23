/**
 * Which files in a change are user interface (P6-PAYLOAD-05, FEAT-SKILL-007).
 *
 * FEAT-SKILL-007 asks for a **conditional** skill — `ui-explore` runs "before
 * UI-touching work is planned" — and a condition needs something that computes
 * it. Declaring `situation: 'touches-ui'` without this file would put a value in
 * a closed enum that nothing produces, which reads in review exactly like a
 * dispatch path that works. That is the defect the enum was closed to prevent,
 * and this phase has already found five read paths with no writer.
 *
 * Deliberately **not** a risk surface. `risk-surface.ts` answers "could this
 * change hurt someone" and adding `ui` to it would mean every button label
 * asking for a security reviewer, which is how a gate becomes something people
 * learn to click through. Touching UI is not dangerous; it is a reason to look
 * at what the interface already does before inventing a third way to do it.
 *
 * Paths only, no content rules. A content rule for UI would key on `className`
 * or `styled` and fire on the test file, the storybook entry and the doc
 * example — and unlike a risk finding, a false positive here has no reviewer to
 * dismiss it, it just dispatches an agent nobody wanted.
 */

/** Extensions that are a component or a stylesheet whatever the folder says. */
const UI_EXTENSIONS =
  /\.(?:tsx|jsx|vue|svelte|astro|css|scss|sass|less|styl)$|\.module\.(?:ts|js)$/i;

/**
 * Folders that mean interface in the conventions this product's users have.
 *
 * Anchored to a path segment rather than matched anywhere in the string:
 * `src/components/` is UI, and `src/lib/component-registry.ts` is not.
 */
const UI_DIRECTORIES = /(?:^|\/)(?:components?|pages|views|screens|layouts|styles|ui|app)\//i;

/** Design assets that are the interface even though nothing imports them as code. */
const UI_ASSETS = /(?:^|\/)(?:tailwind\.config|theme|design-tokens)\.[a-z]+$/i;

/**
 * Test and story files are excluded.
 *
 * A change to `Button.test.tsx` is a change to a test. Dispatching a
 * UI-exploration pass because someone fixed an assertion is the noise that
 * teaches people to ignore the thing.
 */
const NOT_UI = /\.(?:test|spec|stories|story)\.[a-z]+$|(?:^|\/)__tests__\//i;

export function isUiPath(filePath: string): boolean {
  if (NOT_UI.test(filePath)) return false;
  return UI_EXTENSIONS.test(filePath) || UI_DIRECTORIES.test(filePath) || UI_ASSETS.test(filePath);
}

/** The UI files a change touched, in the order they were given. */
export function detectUiSurface(paths: readonly string[]): readonly string[] {
  return paths.filter((path) => isUiPath(path));
}
