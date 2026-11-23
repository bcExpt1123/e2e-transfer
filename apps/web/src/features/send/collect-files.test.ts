import { describe, expect, it } from 'vitest';
import { collectFromDataTransfer, fromFileList, mergePicked } from './collect-files.ts';

const file = (name: string, size = 1) => new File([new Uint8Array(size)], name);

function fileEntry(f: File): FileSystemFileEntry {
  return { isFile: true, isDirectory: false, name: f.name, file: (ok: (f: File) => void) => ok(f) } as never;
}

function dirEntry(name: string, children: FileSystemEntry[]): FileSystemDirectoryEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      // emulate batching: first call returns all, second returns []
      let done = false;
      return {
        readEntries: (ok: (e: FileSystemEntry[]) => void) => {
          ok(done ? [] : children);
          done = true;
        },
      };
    },
  } as never;
}

function dataTransfer(entries: (FileSystemEntry | null)[], files: File[] = []): DataTransfer {
  return {
    items: entries.map((e) => ({ kind: 'file', webkitGetAsEntry: () => e })),
    files,
  } as never;
}

describe('collect-files', () => {
  it('uses webkitRelativePath when present', () => {
    const f = file('a.txt');
    Object.defineProperty(f, 'webkitRelativePath', { value: 'dir/a.txt' });
    expect(fromFileList([f, file('b.txt')]).map((p) => p.path)).toEqual(['dir/a.txt', 'b.txt']);
  });

  it('walks dropped folders recursively', async () => {
    const tree = dirEntry('photos', [fileEntry(file('1.jpg')), dirEntry('raw', [fileEntry(file('2.raw'))])]);
    const picked = await collectFromDataTransfer(dataTransfer([tree, fileEntry(file('note.md'))]));
    expect(picked.map((p) => p.path)).toEqual(['photos/1.jpg', 'photos/raw/2.raw', 'note.md']);
  });

  it('falls back to dt.files when entries are unavailable', async () => {
    const f = file('x.bin');
    const picked = await collectFromDataTransfer(dataTransfer([null], [f]));
    expect(picked).toEqual([{ file: f, path: 'x.bin' }]);
  });

  it('merges by path, newest wins', () => {
    const a1 = { file: file('a', 1), path: 'a' };
    const a2 = { file: file('a', 2), path: 'a' };
    const b = { file: file('b'), path: 'b' };
    expect(mergePicked([a1, b], [a2])).toEqual([a2, b]);
  });
});
