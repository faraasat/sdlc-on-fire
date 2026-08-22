import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { startHarness, type Harness } from './fixture.js';

/**
 * The board, in a real browser (P3-UI-03).
 *
 * Every assertion here covers something a jsdom test structurally cannot see:
 * layout, focus order, whether a drag actually drops, and whether the thing
 * renders at all in an engine that is not Chromium.
 */

const PORT = 4699;
let harness: Harness;

test.beforeAll(async () => {
  harness = await startHarness(PORT);
});

test.afterAll(async () => {
  await harness?.stop();
});

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Add OAuth login')).toBeVisible();
});

test('renders the board with every column', async ({ page }) => {
  // The names as the DOM holds them, not as the CSS renders them. The headings
  // are uppercased with `text-transform`, which changes the pixels and not the
  // accessible name — so asserting 'BACKLOG' tests the stylesheet and fails
  // against the actual accessibility tree.
  for (const column of ['Backlog', 'Discovery', 'Spec', 'Plan', 'In Progress', 'Review', 'Done']) {
    await expect(page.getByRole('heading', { name: column, exact: true })).toBeVisible();
  }
});

test('opens a card drawer on click rather than starting a drag', async ({ page }) => {
  // The defect found by hand on the running board: the pointer sensor claimed
  // mousedown anywhere in the card, so clicking an id started a drag that
  // immediately dropped back. This is the regression test that needed a cursor.
  await page.getByRole('button', { name: /open details for FEAT-001/i }).click();
  await expect(page.getByRole('dialog', { name: /FEAT-001/ })).toBeVisible();
  await expect(page.getByText(/no gate has run on this card/i)).toBeVisible();
});

test('closes the drawer with the keyboard', async ({ page }) => {
  await page.getByRole('button', { name: /open details for FEAT-001/i }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('switches between every view', async ({ page }) => {
  for (const view of ['table', 'roadmap', 'metrics', 'board']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await expect(page.getByRole('button', { name: view, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  }
});

test('filters the board and offers a way back', async ({ page }) => {
  await page.getByLabel('filter work items').fill('zzz-nothing-matches');
  await expect(page.getByText(/nothing matches this filter/i)).toBeVisible();
  await page.getByRole('button', { name: /clear it/i }).click();
  await expect(page.getByText('Add OAuth login')).toBeVisible();
});

test('reports the live connection', async ({ page }) => {
  await expect(page.getByTitle('live')).toBeVisible();
});

test('has no detectable accessibility violations on the board', async ({ page }) => {
  // axe-core finds a subset of real problems, not all of them — but the subset
  // it finds are the ones that are unambiguous and cheap to fix, and letting
  // them accumulate is how a UI becomes unusable with assistive tech.
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
});

test('has no detectable accessibility violations in the drawer', async ({ page }) => {
  await page.getByRole('button', { name: /open details for FEAT-001/i }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  expect(results.violations.map((violation) => violation.id)).toEqual([]);
});

test('looks the same as its baseline', async ({ page }) => {
  // Animations are disabled by config, not here: the live-run chip pulses and
  // Recharts animates on entry, and either would produce a diff between two
  // captures of an identical page.
  await expect(page).toHaveScreenshot('board.png', { fullPage: true });
});

test('the drawer looks the same as its baseline', async ({ page }) => {
  await page.getByRole('button', { name: /open details for FEAT-001/i }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveScreenshot('drawer.png');
});
