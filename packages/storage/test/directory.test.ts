import { describe, expect, it } from 'vitest';
import { clearOpfs, DirectorySink, openOpfsSink, opfsAvailable } from '../src/index.ts';
import { fileSinkContract } from './contract.ts';
import { FakeDir } from './fake-fs.ts';

for (const collisions of ['rename', 'overwrite'] as const) {
  fileSinkContract(`directory (${collisions})`, () => {
    const root = new FakeDir('root');
    const sink = new DirectorySink('test', root, { collisions, batchBytes: 4 });
    return { sink, readBack: async (path) => root.read(path) };
  });
}

describe('DirectorySink', () => {
  it('creates nested folders and batches small chunks into fewer disk writes', async () => {
    const root = new FakeDir('root');
    const sink = new DirectorySink('test', root, { collisions: 'rename', batchBytes: 1000 });
    const w = await sink.open({ path: 'a/b/c.bin', size: 2500, mime: '' });
    for (let i = 0; i < 25; i++) await w.write(new Uint8Array(100).fill(i), i * 100);
    await w.close();
    expect(root.read('a/b/c.bin')?.byteLength).toBe(2500);
    expect(root.read('a/b/c.bin')?.[2499]).toBe(24);
    expect(root.dirs.get('a')?.dirs.get('b')?.writes).toBe(3); // 1000 + 1000 + 500
    expect(sink.saved).toEqual([expect.objectContaining({ path: 'a/b/c.bin', name: 'c.bin' })]);
    expect(sink.rootName).toBe('root');
  });

  it('never overwrites the user’s files in rename mode', async () => {
    const root = new FakeDir('root');
    await (await (await root.getFileHandle('report.pdf', { create: true })).createWritable()).close();
    await root.getDirectoryHandle('notes', { create: true });
    await root.getFileHandle('report (1).pdf', { create: true });
    const sink = new DirectorySink('test', root, { collisions: 'rename' });
    for (const path of ['report.pdf', 'notes', 'README']) {
      const w = await sink.open({ path, size: 1, mime: '' });
      await w.write(Uint8Array.of(7), 0);
      await w.close();
    }
    expect(sink.saved.map((s) => s.name)).toEqual(['report (2).pdf', 'notes (1)', 'README']);
    expect(root.read('report.pdf')?.byteLength).toBe(0);
  });

  it('removes the partial file on abort and ignores a second abort', async () => {
    const root = new FakeDir('root');
    const sink = new DirectorySink('test', root, { collisions: 'rename' });
    const w = await sink.open({ path: 'x.bin', size: 10, mime: '' });
    await w.write(new Uint8Array(3), 0);
    await w.abort();
    await w.abort();
    expect(root.files.has('x.bin')).toBe(false);
    expect(sink.saved).toEqual([]);
  });
});

describe('OPFS sink', () => {
  it('starts from an empty folder each time and can be cleared', async () => {
    const root = new FakeDir('opfs');
    const first = await openOpfsSink(root);
    const w = await first.open({ path: 'old.txt', size: 1, mime: '' });
    await w.write(Uint8Array.of(1), 0);
    await w.close();
    expect(root.read('incoming/old.txt')).toEqual(Uint8Array.of(1));

    const second = await openOpfsSink(root);
    expect(root.read('incoming/old.txt')).toBeUndefined();
    expect(second.id).toBe('opfs');
    await clearOpfs(root);
    expect(root.dirs.has('incoming')).toBe(false);
    await clearOpfs(root); // nothing to clear: no error
  });

  it('is reported unavailable outside browsers', () => {
    expect(opfsAvailable()).toBe(false);
  });
});
