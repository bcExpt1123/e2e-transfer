import { en, type Messages } from './en.ts';

/**
 * Typed, dependency-free i18n (ADR 0005). English is built in; other languages are
 * loaded on demand so they don't weigh on the first load. To add a language: create
 * `<lang>.ts` exporting `const xx: Messages = { … }` and register it below.
 */
const catalogs = {
  en: { label: 'English', load: async () => en },
  de: { label: 'Deutsch', load: async () => (await import('./de.ts')).de },
} satisfies Record<string, { label: string; load: () => Promise<Messages> }>;

export type Locale = keyof typeof catalogs;
export const locales = Object.entries(catalogs).map(([id, c]) => ({ id: id as Locale, label: c.label }));

const STORAGE_KEY = 'e2e-transfer:locale';
const isLocale = (v: string | null | undefined): v is Locale => !!v && Object.hasOwn(catalogs, v);

/** The user's saved choice, else the first browser language we have, else English. */
export function pickLocale(saved: string | null, preferred: readonly string[]): Locale {
  if (isLocale(saved)) return saved;
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0];
    if (isLocale(base)) return base;
  }
  return 'en';
}

class I18n {
  #locale = $state<Locale>('en');
  #messages = $state.raw<Messages>(en);

  get locale(): Locale {
    return this.#locale;
  }

  /** Current messages; reactive in components. */
  get m(): Messages {
    return this.#messages;
  }

  /** Switch language (after its messages have loaded) and remember the choice. */
  async setLocale(value: Locale, remember = true): Promise<void> {
    const messages = await catalogs[value].load();
    this.#messages = messages;
    this.#locale = value;
    document.documentElement.lang = value;
    if (!remember) return;
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // not persisted: fine
    }
  }

  /** At startup: the saved choice, else the browser's languages. Never rejects. */
  async init(): Promise<void> {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch {
      // storage blocked
    }
    const preferred = navigator.languages?.length ? navigator.languages : [navigator.language];
    await this.setLocale(pickLocale(saved, preferred), false).catch(() => {});
  }
}

export const i18n = new I18n();
export type { Messages };
