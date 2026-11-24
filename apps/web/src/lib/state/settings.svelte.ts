/**
 * Network settings (docs/ROADMAP.md phase 4): relays, brokers, STUN and TURN.
 * Stored on this device only. Empty lists mean "use the defaults".
 */
const KEY = 'e2e-transfer.network';

export interface TurnServer {
  urls: string;
  username: string;
  credential: string;
}

export interface NetworkSettings {
  nostrRelays: string[];
  mqttBrokers: string[];
  stunUrls: string[];
  turn: TurnServer | null;
}

export const EMPTY_SETTINGS: NetworkSettings = { nostrRelays: [], mqttBrokers: [], stunUrls: [], turn: null };

export type SettingsProblem = 'relay' | 'broker' | 'stun' | 'turn';

/** Splits a textarea into trimmed, non-empty, de-duplicated lines. */
export const parseList = (text: string): string[] => [
  ...new Set(
    text
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];

const isUrl = (s: string, schemes: string[]) => {
  try {
    return schemes.includes(new URL(s).protocol);
  } catch {
    return false;
  }
};
// STUN/TURN URIs aren't hierarchical URLs (stun:host:port), so check the scheme and that a host follows.
const isIceUri = (s: string, schemes: string[]) =>
  schemes.some((p) => s.startsWith(p) && s.length > p.length + 1);

/** Returns the first problem, or null when the settings can be saved. */
export function validate(s: NetworkSettings): SettingsProblem | null {
  if (!s.nostrRelays.every((u) => isUrl(u, ['wss:']))) return 'relay';
  if (!s.mqttBrokers.every((u) => isUrl(u, ['wss:']))) return 'broker';
  if (!s.stunUrls.every((u) => isIceUri(u, ['stun:', 'stuns:']))) return 'stun';
  if (s.turn && (!isIceUri(s.turn.urls, ['turn:', 'turns:']) || !s.turn.username || !s.turn.credential)) {
    return 'turn';
  }
  return null;
}

function load(): NetworkSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY_SETTINGS;
    const parsed = { ...EMPTY_SETTINGS, ...(JSON.parse(raw) as Partial<NetworkSettings>) };
    return validate(parsed) === null ? parsed : EMPTY_SETTINGS;
  } catch {
    return EMPTY_SETTINGS;
  }
}

class Settings {
  #value = $state<NetworkSettings>(load());

  get network(): NetworkSettings {
    return this.#value;
  }

  get hasTurn(): boolean {
    return this.#value.turn !== null;
  }

  /** Validates, stores and applies to the next connection. Returns the problem if any. */
  save(next: NetworkSettings): SettingsProblem | null {
    const problem = validate(next);
    if (problem) return problem;
    this.#value = next;
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // private mode: keep for this session only
    }
    return null;
  }

  reset(): void {
    this.#value = EMPTY_SETTINGS;
    try {
      localStorage.removeItem(KEY);
    } catch {
      // ignore
    }
  }
}

export const settings = new Settings();

/** UI state shared across features (features can't import each other). */
export const appUi = $state({ settingsOpen: false, aboutOpen: false });
