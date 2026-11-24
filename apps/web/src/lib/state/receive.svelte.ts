/**
 * Receive flow state (docs/UX.md: Connect → Review → Transfer → Done).
 * Picks the best storage: a folder the user chooses (fs-access), else OPFS, else memory.
 */
import {
  type Bytes,
  browserRtc,
  type Emitter,
  ErrorCode,
  type FileSink,
  isTransferError,
  type LinkEvents,
  type LinkPhase,
  LinkReceiver,
  type Manifest,
  type ReceiverProgress,
  type RtcFactory,
  TransferError,
} from '@e2e-transfer/core';
import type { CodeReceiver } from '@e2e-transfer/core/code';
import {
  clearOpfs,
  type DirectorySink,
  fsAccessAvailable,
  MemorySink,
  openOpfsSink,
  opfsAvailable,
  pickDirectorySink,
} from '@e2e-transfer/storage';
import { baseName, download } from './browser.ts';
import { describeDevice } from './device.ts';
import { incoming } from './link.svelte.ts';
import { createSignaling, iceServers } from './network.ts';
import { RateMeter, type RateSnapshot } from './rate.ts';

export type ReceivePhase = 'idle' | LinkPhase;
export type SaveTarget = 'folder' | 'download';

/** A received file the user can download (OPFS or memory). */
export interface ReceivedFile {
  path: string;
  size: number;
  get(): Promise<Blob>;
}

export interface ReceiveDeps {
  createSignaling: typeof createSignaling;
  rtc: RtcFactory;
  now: () => number;
  /** Sink for "download" mode; default OPFS where supported, else memory. */
  downloadSink: () => Promise<FileSink>;
  pickFolder: () => Promise<DirectorySink>;
  canPickFolder: () => boolean;
  /** True when "download" mode has to buffer files in RAM. */
  inMemory: () => boolean;
}

const defaultDeps: ReceiveDeps = {
  createSignaling,
  rtc: browserRtc,
  now: () => performance.now(),
  downloadSink: async () => (opfsAvailable() ? openOpfsSink() : new MemorySink()),
  pickFolder: pickDirectorySink,
  canPickFolder: fsAccessAvailable,
  inMemory: () => !opfsAvailable(),
};

export class ReceiveController {
  phase = $state<ReceivePhase>('idle');
  manifest = $state<Manifest | null>(null);
  /** Verification words to read out to the sender. */
  words = $state<readonly string[]>([]);
  /** Manual mode: the reply code to hand back to the sender. */
  replyCode = $state<string | null>(null);
  done = $state(0);
  total = $state(0);
  rate = $state<RateSnapshot>({ bytesPerSecond: 0, secondsLeft: null });
  error = $state<ErrorCode | null>(null);
  /** Where files went: a folder name, or downloadable files. */
  savedTo = $state<{ kind: 'folder'; name: string } | { kind: 'download'; files: ReceivedFile[] } | null>(
    null,
  );

  readonly #deps: ReceiveDeps;
  #session: LinkReceiver | CodeReceiver | undefined;
  #decide: ((sink: FileSink | null) => void) | undefined;
  #sink: FileSink | undefined;
  readonly #meter = new RateMeter();

  constructor(deps: Partial<ReceiveDeps> = {}) {
    this.#deps = { ...defaultDeps, ...deps };
  }

  get canPickFolder(): boolean {
    return this.#deps.canPickFolder();
  }

  get inMemory(): boolean {
    return this.#deps.inMemory();
  }

  get byCode(): boolean {
    return incoming.code !== null;
  }

  get manual(): boolean {
    return incoming.offer !== undefined;
  }

  get busy(): boolean {
    return !['idle', 'reviewing', 'done', 'failed', 'cancelled', 'declined'].includes(this.phase);
  }

  get percent(): number {
    return this.total > 0 ? Math.floor((this.done / this.total) * 100) : 0;
  }

  /** Connect using the link that opened this page. */
  async start(): Promise<void> {
    const secret = incoming.secret;
    const typed = incoming.code;
    if (!secret && !typed) {
      this.error = 'LINK_INVALID';
      this.phase = 'failed';
      return;
    }
    this.#session?.cancel();
    this.error = null;
    this.manifest = null;
    this.words = [];
    this.replyCode = null;
    this.savedTo = null;
    this.done = 0;
    this.#meter.reset();
    this.phase = 'joining';

    let session: LinkReceiver | CodeReceiver;
    try {
      const signaling = await this.#deps.createSignaling();
      const onManifest = (manifest: Manifest) => {
        this.manifest = manifest;
        this.total = manifest.total;
        return new Promise<{ sink: FileSink } | null>((resolve) => {
          this.#decide = (sink) => resolve(sink ? { sink } : null);
        });
      };
      if (typed) {
        const { CodeReceiver, parseCode } = await import('@e2e-transfer/core/code');
        const code = parseCode(typed);
        if (!code) throw new TransferError(ErrorCode.CodeInvalid, 'unparsable code');
        session = new CodeReceiver({
          code,
          signaling,
          rtc: this.#deps.rtc,
          iceServers: iceServers(),
          onManifest,
        });
      } else
        session = new LinkReceiver({
          secret: secret as Bytes,
          signaling,
          rtc: this.#deps.rtc,
          iceServers: iceServers(),
          hint: describeDevice(navigator.userAgent),
          ...(incoming.offer && { offer: incoming.offer }),
          onManifest,
        });
    } catch (err) {
      this.#fail(err);
      return;
    }
    this.#session = session;
    // Both session kinds emit the link events; CodeSender adds `wrongCode`.
    const events: Pick<Emitter<LinkEvents<ReceiverProgress>>, 'on'> = session;
    events.on('phase', (p) => {
      if (this.#session === session) this.phase = p;
    });
    if (session instanceof LinkReceiver) {
      session.on('code', (c) => {
        if (this.#session === session) this.replyCode = c;
      });
    }
    events.on('words', (w) => {
      if (this.#session === session) this.words = w;
    });
    events.on('progress', ({ received, total }) => {
      if (this.#session !== session) return;
      this.done = received;
      this.total = total;
      this.rate = this.#meter.sample(received, total, this.#deps.now());
    });

    try {
      const outcome = await session.start();
      if (this.#session === session && outcome === 'completed') await this.#completed();
    } catch (err) {
      if (this.#session === session) this.#fail(err);
    }
  }

  /**
   * Accept the files. Call directly from the click handler: choosing a folder
   * needs the user gesture. Resolves false if the user dismissed the folder picker.
   */
  async accept(target: SaveTarget): Promise<boolean> {
    if (!this.#decide) return false;
    let sink: FileSink;
    try {
      sink = target === 'folder' ? await this.#deps.pickFolder() : await this.#deps.downloadSink();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return false; // picker dismissed
      throw err;
    }
    this.#sink = sink;
    const decide = this.#decide;
    this.#decide = undefined;
    decide(sink);
    return true;
  }

  decline(): void {
    const decide = this.#decide;
    this.#decide = undefined;
    decide?.(null);
  }

  cancel(): void {
    this.#decide = undefined;
    this.#session?.cancel();
  }

  /** Drop received data held by this page (OPFS space, memory). */
  async discard(): Promise<void> {
    this.savedTo = null;
    if (this.#sink?.id === 'opfs') await clearOpfs().catch(() => {});
    this.#sink = undefined;
  }

  async #completed() {
    const sink = this.#sink;
    if (!sink) return;
    if (sink.id === 'fs-access') {
      this.savedTo = { kind: 'folder', name: (sink as DirectorySink).rootName };
      return;
    }
    const files: ReceivedFile[] =
      sink instanceof MemorySink
        ? [...sink.files].map(([path, blob]) => ({ path, size: blob.size, get: async () => blob }))
        : (sink as DirectorySink).saved.map((s) => ({
            path: s.path,
            size: this.manifest?.files.find((f) => f.path === s.path)?.size ?? 0,
            get: () => s.handle.getFile(),
          }));
    this.savedTo = { kind: 'download', files };
    // One file: start the download right away (no extra click). Several: the Done screen lists them.
    const [only] = files;
    if (files.length === 1 && only) await this.save(only);
  }

  async save(file: ReceivedFile): Promise<void> {
    download(await file.get(), baseName(file.path));
  }

  #fail(err: unknown) {
    this.#decide = undefined;
    this.error = isTransferError(err) ? err.code : 'PROTOCOL_ERROR';
    if (this.phase !== 'cancelled' && this.phase !== 'declined') this.phase = 'failed';
  }
}
