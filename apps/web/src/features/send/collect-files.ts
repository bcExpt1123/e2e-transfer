/** A file picked for sending, with its path relative to what the user dropped. */
export interface PickedFile {
  file: File;
  path: string;
}

/** From <input type=file> (with or without `webkitdirectory`) or clipboard. */
export function fromFileList(list: ArrayLike<File>): PickedFile[] {
  return Array.from(list, (file) => ({ file, path: file.webkitRelativePath || file.name }));
}

/**
 * From a drop event, walking dropped folders recursively.
 * Must be called synchronously inside the drop handler: DataTransfer items
 * become unusable once the event returns, so entries are captured before any await.
 */
export function collectFromDataTransfer(dt: DataTransfer): Promise<PickedFile[]> {
  const entries = Array.from(dt.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry?.() ?? null);

  if (entries.length === 0 || entries.some((e) => e === null)) {
    return Promise.resolve(fromFileList(dt.files));
  }
  return walkAll(entries as FileSystemEntry[]);
}

async function walkAll(entries: FileSystemEntry[]): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  for (const entry of entries) await walk(entry, '', out);
  return out;
}

async function walk(entry: FileSystemEntry, prefix: string, out: PickedFile[]): Promise<void> {
  const path = `${prefix}${entry.name}`;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    out.push({ file, path });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns batches (≈100 in Chromium) until an empty batch
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, `${path}/`, out);
    }
  }
}

/** Append `incoming` to `current`, newer picks replacing older ones with the same path. */
export function mergePicked(current: readonly PickedFile[], incoming: readonly PickedFile[]): PickedFile[] {
  const byPath = new Map(current.map((p) => [p.path, p]));
  for (const p of incoming) byPath.set(p.path, p);
  return [...byPath.values()];
}
