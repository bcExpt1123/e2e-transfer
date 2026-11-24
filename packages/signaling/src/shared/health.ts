/**
 * Per-relay health (docs/ARCHITECTURE.md § Why this scales). Adapters report how each
 * connection attempt went; the next session connects to healthy relays first and skips
 * ones that keep failing, for a while. Persistence is up to the app (e.g. localStorage).
 */

export type RelayStatus = { url: string; ok: true; ms: number } | { url: string; ok: false };
export type RelayStatusListener = (status: RelayStatus) => void;

export interface RelayRecord {
  /** Failures in a row (reset by a success). */
  fails: number;
  lastFail?: number;
  /** Smoothed time to connect, ms. */
  ms?: number;
}

export interface HealthStore {
  load(): Record<string, RelayRecord>;
  save(records: Record<string, RelayRecord>): void;
}

/** Failing this many times in a row… */
const FAILS_TO_SKIP = 2;
/** …takes a relay out of rotation for this long. */
const COOLDOWN_MS = 30 * 60_000;
const MAX_RECORDS = 50;

export class RelayHealth {
  readonly #store: HealthStore | undefined;
  readonly #now: () => number;
  #records: Record<string, RelayRecord>;

  constructor(store?: HealthStore, now: () => number = Date.now) {
    this.#store = store;
    this.#now = now;
    let loaded: Record<string, RelayRecord> = {};
    try {
      loaded = store?.load() ?? {};
    } catch {
      // corrupt or unavailable: start fresh
    }
    this.#records = loaded;
  }

  record(status: RelayStatus): void {
    const prev = this.#records[status.url] ?? { fails: 0 };
    const next: RelayRecord = status.ok
      ? { fails: 0, ms: prev.ms === undefined ? status.ms : Math.round(prev.ms * 0.7 + status.ms * 0.3) }
      : { ...prev, fails: prev.fails + 1, lastFail: this.#now() };
    delete this.#records[status.url]; // re-insert: most recently seen last
    this.#records[status.url] = next;
    const urls = Object.keys(this.#records);
    for (const old of urls.slice(0, Math.max(0, urls.length - MAX_RECORDS))) delete this.#records[old];
    try {
      this.#store?.save(this.#records);
    } catch {
      // not persisted: fine
    }
  }

  /**
   * Healthy relays first, fastest first (untried ones keep their configured order, after the
   * known-fast ones). Relays in their cooldown are dropped, but never below `min` relays.
   */
  rank(urls: readonly string[], min = 2): string[] {
    const now = this.#now();
    const unique = [...new Set(urls)];
    const resting = (url: string) => {
      const r = this.#records[url];
      return !!r && r.fails >= FAILS_TO_SKIP && now - (r.lastFail ?? 0) < COOLDOWN_MS;
    };
    const speed = (url: string) => this.#records[url]?.ms ?? Number.POSITIVE_INFINITY;
    const healthy = unique.filter((u) => !resting(u)).sort((a, b) => speed(a) - speed(b));
    const fallback = unique
      .filter(resting)
      .sort((a, b) => (this.#records[a]?.lastFail ?? 0) - (this.#records[b]?.lastFail ?? 0));
    return [...healthy, ...fallback.slice(0, Math.max(0, min - healthy.length))];
  }
}

/** Time a connection attempt and report it (an attempt abandoned because we left doesn't count). */
export function reportAttempt<T>(
  url: string,
  attempt: Promise<T>,
  listener: RelayStatusListener | undefined,
  abandoned: () => boolean,
): Promise<T> {
  if (!listener) return attempt;
  const started = performance.now();
  attempt.then(
    () => listener({ url, ok: true, ms: Math.round(performance.now() - started) }),
    () => abandoned() || listener({ url, ok: false }),
  );
  return attempt;
}
