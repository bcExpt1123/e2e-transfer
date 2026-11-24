/**
 * MANIFEST / ACCEPT payloads and their validation (docs/PROTOCOL.md §4.3).
 * Everything from the peer is untrusted: validate before it reaches a sink or the UI.
 */
import type { TransferConfig } from '../config.ts';
import { protocolError } from './frames.ts';

export interface ManifestFile {
  path: string;
  size: number;
  mime: string;
}

export interface Manifest {
  files: ManifestFile[];
  chunkSize: number;
  total: number;
}

export interface Accept {
  /** Indices into Manifest.files, in the order they will be sent. */
  files: number[];
  /** Resume (PROTOCOL §4.6): byte offset to continue each listed file from (default 0). */
  resume?: Record<number, number>;
}

const MAX_PATH_LENGTH = 4096;
const MAX_SEGMENT_LENGTH = 255;
const MAX_MIME_LENGTH = 255;
// C0 controls, DEL, C1 controls, and bidi overrides (which can disguise "exe.txt" as "txt.exe" in the UI)
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/** Returns a reason string if `path` is unsafe, otherwise null. */
export function pathProblem(path: string): string | null {
  if (path.length === 0) return 'empty path';
  if (path.length > MAX_PATH_LENGTH) return 'path too long';
  if (CONTROL_CHARS.test(path)) return 'control character in path';
  if (path.includes('\\')) return 'backslash in path';
  if (path.startsWith('/')) return 'absolute path';
  if (/^[a-zA-Z]:/.test(path)) return 'drive-letter path';
  for (const segment of path.split('/')) {
    if (segment === '') return 'empty path segment';
    if (segment === '.' || segment === '..') return 'relative path segment';
    if (segment.length > MAX_SEGMENT_LENGTH) return 'path segment too long';
  }
  return null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isSize = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export function validateManifest(value: unknown, cfg: TransferConfig): Manifest {
  if (!isRecord(value) || !Array.isArray(value.files)) throw protocolError('malformed manifest');
  const { chunkSize, total } = value;
  if (!isSize(chunkSize) || chunkSize === 0 || chunkSize > cfg.chunkSize) {
    throw protocolError('manifest chunkSize out of range');
  }
  if (value.files.length === 0) throw protocolError('manifest has no files');
  if (value.files.length > cfg.maxFiles) throw protocolError('manifest has too many files');

  const seen = new Set<string>();
  let sum = 0;
  const files = value.files.map((f): ManifestFile => {
    if (!isRecord(f) || typeof f.path !== 'string' || !isSize(f.size) || typeof f.mime !== 'string') {
      throw protocolError('malformed manifest entry');
    }
    const problem = pathProblem(f.path);
    if (problem) throw protocolError(`unsafe path rejected: ${problem}`);
    if (seen.has(f.path)) throw protocolError('duplicate path in manifest');
    if (f.mime.length > MAX_MIME_LENGTH || CONTROL_CHARS.test(f.mime))
      throw protocolError('invalid mime type');
    seen.add(f.path);
    sum += f.size;
    return { path: f.path, size: f.size, mime: f.mime };
  });

  if (!Number.isSafeInteger(sum) || total !== sum)
    throw protocolError('manifest total does not match file sizes');
  return { files, chunkSize, total: sum };
}

export function validateAccept(value: unknown, manifest: Manifest): Accept {
  if (!isRecord(value) || !Array.isArray(value.files)) throw protocolError('malformed ACCEPT');
  const seen = new Set<number>();
  for (const i of value.files) {
    if (!Number.isInteger(i) || i < 0 || i >= manifest.files.length || seen.has(i)) {
      throw protocolError('invalid file index in ACCEPT');
    }
    seen.add(i);
  }
  const files = value.files as number[];
  // Unknown fields are ignored for forward compatibility.
  if (value.resume === undefined) return { files };
  if (!isRecord(value.resume)) throw protocolError('malformed ACCEPT resume');
  const resume: Record<number, number> = {};
  for (const [key, offset] of Object.entries(value.resume)) {
    const index = Number(key);
    const size = manifest.files[index]?.size;
    if (!seen.has(index) || size === undefined || !isSize(offset) || offset > size) {
      throw protocolError('invalid resume offset in ACCEPT');
    }
    resume[index] = offset;
  }
  return { files, resume };
}

/** Byte-exact comparison of two validated manifests (a resumed session must offer the same files). */
export function sameManifest(a: Manifest, b: Manifest): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
