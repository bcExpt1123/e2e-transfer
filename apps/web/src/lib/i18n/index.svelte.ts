import { en, type Messages } from './en.ts';

/**
 * Typed, dependency-free i18n (ADR 0005). To add a language:
 * create `<lang>.ts` exporting `const xx: Messages = { … }` and register it below.
 */
const catalogs = {
  en: { label: 'English', messages: en },
} satisfies Record<string, { label: string; messages: Messages }>;

export type Locale = keyof typeof catalogs;
export const locales = Object.entries(catalogs).map(([id, c]) => ({ id: id as Locale, label: c.label }));

class I18n {
  #locale = $state<Locale>('en');

  get locale(): Locale {
    return this.#locale;
  }

  set locale(value: Locale) {
    this.#locale = value;
    document.documentElement.lang = value;
  }

  /** Current messages; reactive in components. */
  get m(): Messages {
    return catalogs[this.#locale].messages;
  }
}

export const i18n = new I18n();
export type { Messages };
