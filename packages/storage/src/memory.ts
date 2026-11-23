import type { FileMeta, FileSink, SinkWriter } from '@e2e-transfer/core';

/**
 * Collects files in RAM as Blobs. Used by tests and as the last-resort sink
 * for small files (docs/ARCHITECTURE.md § Adapter interfaces).
 */
export class MemorySink implements FileSink {
  readonly id = 'memory';
  /** Completed files, keyed by path. */
  readonly files = new Map<string, Blob>();

  async open(meta: FileMeta): Promise<SinkWriter> {
    const parts: Uint8Array[] = [];
    let written = 0;
    let state: 'open' | 'closed' | 'aborted' = 'open';
    const ensureOpen = () => {
      if (state !== 'open') throw new Error(`writer is ${state}`);
    };

    return {
      write: async (chunk, offset) => {
        ensureOpen();
        if (offset !== written) throw new RangeError(`expected offset ${written}, got ${offset}`);
        if (written + chunk.byteLength > meta.size) throw new RangeError('write exceeds declared size');
        parts.push(chunk.slice());
        written += chunk.byteLength;
      },
      close: async () => {
        ensureOpen();
        if (written !== meta.size) throw new RangeError(`size mismatch: ${written} != ${meta.size}`);
        state = 'closed';
        this.files.set(meta.path, new Blob(parts as BlobPart[], { type: meta.mime }));
      },
      abort: async () => {
        state = 'aborted';
        parts.length = 0;
      },
    };
  }
}
