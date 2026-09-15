/**
 * Light / dark theme control.
 *
 * Three states, not two. "System" is a real choice and it is the default: it
 * stores nothing, leaves `<html>` un-stamped, and lets the
 * `prefers-color-scheme` block in tokens.css follow the OS — including when the
 * OS changes while the tab is open. A two-state toggle cannot express that, and
 * silently pinning someone to a theme the first time they touch the button is a
 * worse default than honouring their machine.
 *
 * The control is a segmented three-way rather than a single icon that cycles,
 * because a cycling button cannot show you what the options are or which one is
 * active without being pressed.
 *
 * First paint is handled by the inline script in index.html, not here — see the
 * comment there. This component's `useEffect` only reflects *changes*.
 */
import { useCallback, useEffect, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'velozity-theme';

/** Reading storage throws in a private window with site data blocked. */
const readStored = (): ThemeChoice => {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
};

const apply = (choice: ThemeChoice): void => {
  const root = document.documentElement;
  if (choice === 'system') {
    // Removing the attribute — rather than setting it to the OS's current
    // value — is what keeps the OS in charge after this point.
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', choice);
  }

  try {
    if (choice === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // The choice still applies for this page; it just will not survive a
    // reload. Better than refusing to switch.
  }
};

const OPTIONS: Array<{ value: ThemeChoice; glyph: string; label: string }> = [
  { value: 'light', glyph: '☀', label: 'Light' },
  { value: 'dark', glyph: '☾', label: 'Dark' },
  { value: 'system', glyph: '⌂', label: 'Match system' },
];

export const ThemeToggle = (): React.JSX.Element => {
  const [choice, setChoice] = useState<ThemeChoice>(readStored);

  useEffect(() => {
    apply(choice);
  }, [choice]);

  const select = useCallback((next: ThemeChoice) => setChoice(next), []);

  return (
    <div className="theme-toggle" role="group" aria-label="Colour theme">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className="theme-toggle-btn"
          aria-pressed={choice === option.value}
          title={option.label}
          onClick={() => select(option.value)}
        >
          <span aria-hidden="true">{option.glyph}</span>
          <span className="sr-only">{option.label}</span>
        </button>
      ))}
    </div>
  );
};
