/**
 * Short codes `N-word-word` (docs/PROTOCOL.md §6). N (1–999) picks the public
 * nameplate topic; the two words (2 × 11 bits) are the password for CPace.
 */
import { type Bytes, randomBytes, toHex, utf8 } from '../bytes.ts';
import { hkdf } from '../keys.ts';
import { CODE_WORDS } from './wordlist.ts';

export interface ShortCode {
  nameplate: number;
  words: [string, string];
}

const BY_PREFIX = new Map(CODE_WORDS.map((w) => [w.slice(0, 4), w]));
const WORD_SET = new Set(CODE_WORDS);

function randomBelow(n: number): number {
  // rejection sampling: no modulo bias
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  for (;;) {
    const b = randomBytes(4);
    const v = (((b[0] ?? 0) << 24) | ((b[1] ?? 0) << 16) | ((b[2] ?? 0) << 8) | (b[3] ?? 0)) >>> 0;
    if (v < limit) return v % n;
  }
}

export function generateCode(): ShortCode {
  const word = () => CODE_WORDS[randomBelow(CODE_WORDS.length)] ?? 'abandon';
  return { nameplate: 1 + randomBelow(999), words: [word(), word()] };
}

export const formatCode = (c: ShortCode): string => `${c.nameplate}-${c.words[0]}-${c.words[1]}`;

/** Full word for an exact word or a unique ≥4-letter prefix; null otherwise. */
export function resolveWord(input: string): string | null {
  const w = input.toLowerCase();
  if (WORD_SET.has(w)) return w;
  if (w.length < 4) return null;
  const full = BY_PREFIX.get(w.slice(0, 4));
  return full?.startsWith(w) ? full : null;
}

/** Words starting with `prefix`, for autocomplete. */
export function completeWord(prefix: string, limit = 6): string[] {
  const p = prefix.toLowerCase();
  if (!p) return [];
  const out: string[] = [];
  for (const w of CODE_WORDS) {
    if (w.startsWith(p)) out.push(w);
    if (out.length >= limit) break;
  }
  return out;
}

/** Lenient parsing: case, spaces, extra dashes and 4-letter prefixes are all fine. Null if invalid. */
export function parseCode(input: string): ShortCode | null {
  const parts = input
    .trim()
    .toLowerCase()
    .split(/[\s\-_.,]+/)
    .filter(Boolean);
  if (parts.length !== 3) return null;
  const [n, a, b] = parts as [string, string, string];
  if (!/^\d{1,3}$/.test(n)) return null;
  const nameplate = Number(n);
  if (nameplate < 1 || nameplate > 999) return null;
  const w1 = resolveWord(a);
  const w2 = resolveWord(b);
  return w1 && w2 ? { nameplate, words: [w1, w2] } : null;
}

const NAMEPLATE_SALT = utf8('e2e-transfer/v1/nameplate');

/** Public signaling topic and envelope key for a nameplate. The key only obfuscates: N is public. */
export async function nameplateKeys(nameplate: number): Promise<{ topic: string; envelopeKey: CryptoKey }> {
  const ikm = utf8(String(nameplate));
  const [room, key] = await Promise.all([
    hkdf(ikm, NAMEPLATE_SALT, 'room', 16),
    hkdf(ikm, NAMEPLATE_SALT, 'signal', 32),
  ]);
  const envelopeKey = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { topic: toHex(room), envelopeKey };
}

/** The CPace password: the canonical code text. */
export const codePassword = (c: ShortCode): Bytes => utf8(formatCode(c));
