import { describe, expect, it } from 'vitest';
import { de } from './de.ts';
import { en } from './en.ts';
import { i18n, pickLocale } from './index.svelte.ts';

/** Same shape all the way down: every key exists, functions stay functions. */
function shape(v: unknown): unknown {
  if (typeof v === 'function') return `fn/${v.length}`;
  if (Array.isArray(v)) return v.map(shape);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]));
  return typeof v;
}

describe('i18n', () => {
  it('picks the saved language, then the browser’s, then English', () => {
    expect(pickLocale('de', ['en-US'])).toBe('de');
    expect(pickLocale(null, ['fr-FR', 'de-AT', 'en'])).toBe('de');
    expect(pickLocale('xx', ['fr'])).toBe('en');
    expect(pickLocale('constructor', [])).toBe('en');
  });

  it('German matches the English catalog key for key', () => {
    expect(shape(de)).toEqual(shape(en));
  });

  it('switches language at runtime and sets <html lang>', async () => {
    await i18n.setLocale('de', false);
    expect(i18n.m.send.createLink).toBe('Link erstellen');
    expect(document.documentElement.lang).toBe('de');
    await i18n.setLocale('en', false);
    expect(i18n.m.send.createLink).toBe('Create link');
  });
});
