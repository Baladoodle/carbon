import { tokensToCss, type ThemeTokens } from '@core/theme/theme';
import { invoke, on } from '../bridge';
import { createStore, useStore } from '../state/store';

/** The active theme tokens; also applied as CSS variables (`var(--bg)` …) on :root. */
export const themeStore = createStore<ThemeTokens | null>(null);

function apply(t: ThemeTokens): void {
  let el = document.getElementById('carbon-theme');
  if (!el) {
    el = document.createElement('style');
    el.id = 'carbon-theme';
    document.head.appendChild(el);
  }
  el.textContent = tokensToCss(t);
  document.documentElement.dataset.theme = t.name;
  themeStore.set(t);
}

/** Loads the Omarchy theme and follows changes. Called once by the shell. */
export function startTheme(): void {
  on('theme:changed', apply);
  void invoke('theme:get', null).then(apply);
}

export const useTheme = (): ThemeTokens | null => useStore(themeStore, (t) => t);
