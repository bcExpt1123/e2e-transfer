/**
 * Save into the Origin Private File System, then let the user download each file.
 * Disk-backed, so memory stays constant even for very large files.
 */
import { DirectorySink, type DirHandleLike } from './shared/directory.ts';

const FOLDER = 'incoming';

export function opfsAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    'createWritable' in FileSystemFileHandle.prototype
  );
}

async function opfsRoot(): Promise<DirHandleLike> {
  return (await navigator.storage.getDirectory()) as unknown as DirHandleLike;
}

/** A fresh sink; files from earlier sessions are removed first. */
export async function openOpfsSink(root?: DirHandleLike): Promise<DirectorySink> {
  const base = root ?? (await opfsRoot());
  await base.removeEntry(FOLDER, { recursive: true }).catch(() => {});
  const dir = await base.getDirectoryHandle(FOLDER, { create: true });
  return new DirectorySink('opfs', dir, { collisions: 'overwrite' });
}

/** Free the space used by received files (after they were downloaded). */
export async function clearOpfs(root?: DirHandleLike): Promise<void> {
  const base = root ?? (await opfsRoot());
  await base.removeEntry(FOLDER, { recursive: true }).catch(() => {});
}
