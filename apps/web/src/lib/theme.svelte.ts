export type ThemePref = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'e2e-transfer:theme';

function load(): ThemePref {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    // storage blocked (private mode, sandbox) — fall back to system
  }
  return 'system';
}

class Theme {
  #pref = $state<ThemePref>(load());

  get pref(): ThemePref {
    return this.#pref;
  }

  set pref(value: ThemePref) {
    this.#pref = value;
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // non-persistent is fine
    }
    this.apply();
  }

  /** Reflect the preference on <html data-theme>; tokens.css does the rest. */
  apply(): void {
    const root = document.documentElement;
    if (this.#pref === 'system') delete root.dataset.theme;
    else root.dataset.theme = this.#pref;
  }
}

export const theme = new Theme();
