import {
  type AcceptDecision,
  type Bytes,
  createLoopbackPair,
  deriveLinkKeys,
  type FileSink,
  generateSecret,
  type LoopbackOptions,
  type Manifest,
  Receiver,
  Sender,
  type SourceFile,
  type TransferConfig,
} from '../src/index.ts';

/** Deterministic pseudo-random bytes (fast, no crypto needed). */
export function patternBytes(size: number, seed = 1): Bytes {
  const out = new Uint8Array(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

export interface Setup {
  files: SourceFile[];
  decide?: (m: Manifest) => AcceptDecision | Promise<AcceptDecision>;
  sink?: FileSink;
  loopback?: LoopbackOptions;
  config?: Partial<TransferConfig>;
  /** Give the receiver a different secret (wrong link). */
  mismatchedSecret?: boolean;
}

export async function setup(opts: Setup) {
  const [a, b] = createLoopbackPair(opts.loopback);
  const senderKeys = await deriveLinkKeys(generateSecret());
  const receiverKeys = opts.mismatchedSecret ? await deriveLinkKeys(generateSecret()) : senderKeys;
  const cfg = opts.config ? { config: opts.config } : {};

  const sender = new Sender(a, { sessionIkm: senderKeys.sessionIkm, files: opts.files, ...cfg });
  const manifests: Manifest[] = [];
  const receiver = new Receiver(b, {
    sessionIkm: receiverKeys.sessionIkm,
    ...cfg,
    onManifest: (m) => {
      manifests.push(m);
      if (opts.decide) return opts.decide(m);
      if (!opts.sink) throw new Error('setup: provide sink or decide');
      return { sink: opts.sink };
    },
  });
  return { a, b, sender, receiver, manifests };
}

/** Run both sides; never rejects — returns each side's outcome or error. */
export async function run(sender: Sender, receiver: Receiver) {
  const [s, r] = await Promise.allSettled([sender.start(), receiver.start()]);
  return { sender: s, receiver: r };
}

export function codeOf(result: PromiseSettledResult<unknown>): string {
  if (result.status === 'fulfilled') return 'OK';
  return (result.reason as { code?: string }).code ?? String(result.reason);
}
