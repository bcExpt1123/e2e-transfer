/**
 * In-memory MessageChannelLike pair that behaves like an RTCDataChannel:
 * asynchronous, ordered delivery and a `bufferedAmount` that drains at a
 * configurable rate, so backpressure logic is exercised in unit tests.
 */
import type { Bytes } from '../bytes.ts';
import type { MessageChannelLike } from './channel.ts';

export interface LoopbackOptions {
  /** Bytes delivered per tick, per direction (default 1 MiB). */
  bytesPerTick?: number;
  /**
   * Intercept every message in flight from A to B (or B to A). Return the
   * messages to deliver instead: [] drops, [m, m] duplicates, a modified copy tampers.
   */
  intercept?: (data: Bytes, index: number, direction: 'a→b' | 'b→a') => Bytes[];
}

export interface LoopbackStats {
  /** Highest bufferedAmount observed on this end. */
  maxBufferedAmount: number;
  messagesSent: number;
}

type Listener<T extends unknown[] = []> = (...args: T) => void;

class LoopbackEnd implements MessageChannelLike {
  bufferedAmountLowThreshold = 0;
  readonly stats: LoopbackStats = { maxBufferedAmount: 0, messagesSent: 0 };
  peer!: LoopbackEnd;

  #buffered = 0;
  #queue: Bytes[] = [];
  #pumping = false;
  #closed = false;
  #messageListeners = new Set<Listener<[Bytes]>>();
  #lowListeners = new Set<Listener>();
  #closeListeners = new Set<Listener>();

  constructor(
    private readonly direction: 'a→b' | 'b→a',
    private readonly opts: Required<Pick<LoopbackOptions, 'bytesPerTick'>> & LoopbackOptions,
  ) {}

  get bufferedAmount() {
    return this.#buffered;
  }

  #closing = false;

  get closed() {
    return this.#closed || this.#closing;
  }

  send(data: Bytes): void {
    if (this.closed) throw new DOMException('channel is closed', 'InvalidStateError');
    this.#queue.push(data.slice());
    this.#buffered += data.byteLength;
    this.stats.messagesSent++;
    this.stats.maxBufferedAmount = Math.max(this.stats.maxBufferedAmount, this.#buffered);
    this.#schedulePump();
  }

  #schedulePump() {
    if (this.#pumping) return;
    this.#pumping = true;
    setTimeout(() => this.#pump(), 0);
  }

  #pump() {
    this.#pumping = false;
    let budget = this.opts.bytesPerTick;
    while (this.#queue.length > 0 && budget > 0 && !this.#closed) {
      const msg = this.#queue.shift() as Bytes;
      const before = this.#buffered;
      this.#buffered -= msg.byteLength;
      budget -= msg.byteLength;
      const index = this.stats.messagesSent - this.#queue.length - 1;
      const out = this.opts.intercept ? this.opts.intercept(msg, index, this.direction) : [msg];
      for (const m of out) this.peer.#deliver(m);
      if (before > this.bufferedAmountLowThreshold && this.#buffered <= this.bufferedAmountLowThreshold) {
        for (const cb of [...this.#lowListeners]) cb();
      }
    }
    if (this.#queue.length > 0 && !this.#closed) this.#schedulePump();
    else if (this.#closing) this.#closeBoth();
  }

  #deliver(data: Bytes) {
    if (this.#closed) return;
    for (const cb of [...this.#messageListeners]) cb(data);
  }

  onMessage(cb: Listener<[Bytes]>) {
    this.#messageListeners.add(cb);
    return () => this.#messageListeners.delete(cb);
  }

  onBufferedAmountLow(cb: Listener) {
    this.#lowListeners.add(cb);
    return () => this.#lowListeners.delete(cb);
  }

  onClose(cb: Listener) {
    this.#closeListeners.add(cb);
    return () => this.#closeListeners.delete(cb);
  }

  /** Like RTCDataChannel: already-queued messages are still delivered, then both ends close. */
  close(): void {
    if (this.#closed || this.#closing) return;
    this.#closing = true;
    if (this.#queue.length === 0) this.#closeBoth();
  }

  #closeBoth() {
    this.#closeLocal();
    this.peer.#closeLocal();
  }

  #closeLocal() {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue = [];
    this.#buffered = 0;
    setTimeout(() => {
      for (const cb of [...this.#closeListeners]) cb();
    }, 0);
  }
}

export type LoopbackChannel = LoopbackEnd;

export function createLoopbackPair(options: LoopbackOptions = {}): [LoopbackChannel, LoopbackChannel] {
  const opts = { bytesPerTick: 1024 * 1024, ...options };
  const a = new LoopbackEnd('a→b', opts);
  const b = new LoopbackEnd('b→a', opts);
  a.peer = b;
  b.peer = a;
  return [a, b];
}
