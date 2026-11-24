import type { FileMeta, FileSink, SinkWriter } from '../src/index.ts';

/** Minimal in-RAM sink for core tests (the real one lives in packages/storage). */
export class MemorySink implements FileSink {
  readonly id = 'memory';
  readonly files = new Map<string, Blob>();

  async open(meta: FileMeta): Promise<SinkWriter> {
    const parts: Uint8Array[] = [];
    return {
      write: async (chunk) => {
        parts.push(chunk.slice());
      },
      close: async () => {
        this.files.set(meta.path, new Blob(parts as BlobPart[]));
      },
      abort: async () => {
        parts.length = 0;
      },
    };
  }
}
