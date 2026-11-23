import type { Bytes } from '../bytes.ts';

/** Something the sender can read in ranges: a File in browsers, anything in tests. */
export interface SourceFile {
  /** Relative `/`-separated path shown to and used by the receiver. */
  path: string;
  size: number;
  mime: string;
  read(start: number, end: number): Promise<Bytes>;
}

export function blobSource(blob: Blob, path: string): SourceFile {
  return {
    path,
    size: blob.size,
    mime: blob.type,
    read: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()),
  };
}

export function bytesSource(bytes: Uint8Array, path: string, mime = 'application/octet-stream'): SourceFile {
  return {
    path,
    size: bytes.byteLength,
    mime,
    read: async (start, end) => bytes.slice(start, end) as Bytes,
  };
}
