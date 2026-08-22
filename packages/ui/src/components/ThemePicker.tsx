import { useEffect, type ReactElement } from 'react';
import { THEMES, useUiStore, type Theme } from '../state/ui.js';

/**
 * Choosing a theme (P3-UI-04).
 *
 * The theme is written to `data-theme` on the document element and mirrored
 * into the URL, so a choice can be pasted to somebody else — "look at it in
 * contrast" is a sentence people actually say, and a preference that lives only
 * in one browser cannot be discussed.
 *
 * Read from the URL on load rather than from storage: a shared link should show
 * the sender's theme, and a stored preference silently overriding a link is the
 * behaviour that makes people think the link is broken.
 */
export function ThemePicker(): ReactElement {
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('theme');
    if (fromUrl !== null && (THEMES as readonly string[]).includes(fromUrl)) {
      setTheme(fromUrl as Theme);
    }
  }, [setTheme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    const url = new URL(window.location.href);
    url.searchParams.set('theme', theme);
    window.history.replaceState(null, '', url);
  }, [theme]);

  return (
    <label className="app__group">
      theme
      <select
        value={theme}
        onChange={(event) => setTheme(event.target.value as Theme)}
        aria-label="colour theme"
      >
        {THEMES.map((candidate) => (
          <option key={candidate} value={candidate}>
            {candidate}
          </option>
        ))}
      </select>
    </label>
  );
}
