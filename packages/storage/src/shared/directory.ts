/**
 * Writes received files into a File System Access directory handle — either one
 * the user picked (fs-access) or the Origin Private File System (opfs).
 * Memory use is constant: chunks are batched up to `batchBytes`, then written to disk.
 */
import type { FileMeta, FileSink, SinkWriter } from '@e2e-transfer/core';

/** The parts of FileSystem*Handle we use; the browser's handles satisfy these. */
export interface WritableLike {
  write(data: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
export interface FileHandleLike {
  readonly name: string;
  createWritable(): Promise<WritableLike>;
  getFile(): Promise<File>;
}
export interface DirHandleLike {
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

export interface SavedFile {
  /** Path from the manifest. */
  path: string;
  /** Name actually used on disk (may differ after collision renaming). */
  name: string;
  handle: FileHandleLike;
}

export interface DirectorySinkOptions {
  /** `rename` keeps existing files ("a (1).txt"); `overwrite` replaces them. */
  collisions: 'rename' | 'overwrite';
  /** Bytes buffered before each disk write. */
  batchBytes?: number;
}

export class DirectorySink implements FileSink {
  readonly saved: SavedFile[] = [];
  readonly #root: DirHandleLike;
  readonly #opts: DirectorySinkOptions;

  constructor(
    readonly id: string,
    root: DirHandleLike,
    opts: DirectorySinkOptions,
  ) {
    this.#root = root;
    this.#opts = opts;
  }

  get rootName(): string {
    return this.#root.name;
  }

  async open(meta: FileMeta): Promise<SinkWriter> {
    const segments = meta.path.split('/');
    const fileName = segments.pop() ?? meta.path;
    let dir = this.#root;
    for (const s of segments) dir = await dir.getDirectoryHandle(s, { create: true });
    const name = this.#opts.collisions === 'rename' ? await freeName(dir, fileName) : fileName;
    const handle = await dir.getFileHandle(name, { create: true });
    const out = await handle.createWritable();

    const batchBytes = this.#opts.batchBytes ?? 1024 * 1024;
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let written = 0;
    let state: 'open' | 'closed' | 'aborted' = 'open';
    const ensureOpen = () => {
      if (state !== 'open') throw new Error(`writer is ${state}`);
    };
    const flush = async () => {
      if (pendingBytes === 0) return;
      const batch = new Uint8Array(pendingBytes);
      let at = 0;
      for (const p of pending) {
        batch.set(p, at);
        at += p.byteLength;
      }
      pending = [];
      pendingBytes = 0;
      await out.write(batch);
    };

    return {
      write: async (chunk, offset) => {
        ensureOpen();
        if (offset !== written) throw new RangeError(`expected offset ${written}, got ${offset}`);
        if (written + chunk.byteLength > meta.size) throw new RangeError('write exceeds declared size');
        pending.push(chunk);
        pendingBytes += chunk.byteLength;
        written += chunk.byteLength;
        if (pendingBytes >= batchBytes) await flush();
      },
      close: async () => {
        ensureOpen();
        if (written !== meta.size) throw new RangeError(`size mismatch: ${written} != ${meta.size}`);
        await flush();
        await out.close();
        state = 'closed';
        this.saved.push({ path: meta.path, name, handle });
      },
      abort: async (reason) => {
        if (state !== 'open') return;
        state = 'aborted';
        pending = [];
        await out.abort(reason).catch(() => {});
        // getFileHandle({create}) already made an empty file; don't leave it behind.
        await dir.removeEntry(name).catch(() => {});
      },
    };
  }
}

/** "a.txt" → "a (1).txt" → "a (2).txt" … until the name is unused. */
async function freeName(dir: DirHandleLike, name: string): Promise<string> {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? name : `${stem} (${i})${ext}`;
    if (!(await exists(dir, candidate))) return candidate;
  }
}

async function exists(dir: DirHandleLike, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TypeMismatchError') return true; // a folder
    return false;
  }
}
