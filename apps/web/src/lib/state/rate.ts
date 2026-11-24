/**
 * Smoothed transfer speed and time left (docs/UX.md § Transfer). An exponential
 * moving average over byte deltas keeps the numbers calm instead of jumpy.
 */
export interface RateSnapshot {
  /** Bytes per second, smoothed; 0 until there is enough data. */
  bytesPerSecond: number;
  /** Seconds left, or null when unknown. */
  secondsLeft: number | null;
}

export class RateMeter {
  readonly #tauMs: number;
  #lastBytes = 0;
  #lastAt: number | undefined;
  #bps = 0;
  #elapsedMs = 0;

  /** `tauMs`: smoothing time constant. */
  constructor(tauMs = 3000) {
    this.#tauMs = tauMs;
  }

  reset(): void {
    this.#lastBytes = 0;
    this.#lastAt = undefined;
    this.#bps = 0;
    this.#elapsedMs = 0;
  }

  /** Record that `done` of `total` bytes are complete at time `now` (ms). */
  sample(done: number, total: number, now: number): RateSnapshot {
    if (this.#lastAt === undefined) {
      this.#lastAt = now;
      this.#lastBytes = done;
      return { bytesPerSecond: 0, secondsLeft: null };
    }
    const dt = now - this.#lastAt;
    if (dt > 0) {
      const instant = ((done - this.#lastBytes) / dt) * 1000;
      // Weight grows with dt so irregular sampling still converges correctly.
      const alpha = 1 - Math.exp(-dt / this.#tauMs);
      this.#bps = this.#elapsedMs === 0 ? instant : this.#bps + alpha * (instant - this.#bps);
      this.#elapsedMs += dt;
      this.#lastAt = now;
      this.#lastBytes = done;
    }
    const left = total - done;
    // Wait for ~1 s of data before promising anything.
    const secondsLeft = this.#elapsedMs >= 1000 && this.#bps > 0 ? Math.ceil(left / this.#bps) : null;
    return { bytesPerSecond: this.#elapsedMs >= 1000 ? this.#bps : 0, secondsLeft };
  }
}
