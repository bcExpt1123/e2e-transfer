/** Small browser integrations used during a transfer (docs/UX.md § Principles: never lose work). */

/** Keeps the screen on while held; silently does nothing where unsupported or denied. */
export class ScreenWakeLock {
  #sentinel: WakeLockSentinel | undefined;
  #wanted = false;

  constructor() {
    // The lock is released when the tab is hidden; take it again on return.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (this.#wanted && document.visibilityState === 'visible') void this.#acquire();
      });
    }
  }

  set held(value: boolean) {
    if (value === this.#wanted) return;
    this.#wanted = value;
    if (value) void this.#acquire();
    else {
      void this.#sentinel?.release().catch(() => {});
      this.#sentinel = undefined;
    }
  }

  async #acquire() {
    try {
      if (!('wakeLock' in navigator) || this.#sentinel) return;
      this.#sentinel = await navigator.wakeLock.request('screen');
      this.#sentinel.addEventListener('release', () => {
        this.#sentinel = undefined;
      });
    } catch {
      // not allowed (e.g. battery saver): fine
    }
  }
}

/** Trigger a browser download of `blob` as `name`. */
export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  // Give the download a moment to start before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Last path segment: what a downloaded file is called. */
export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
