import { afterEach, describe, expect, it, vi } from 'vitest';
import { fsAccessAvailable, pickDirectorySink } from '../src/index.ts';
import { FakeDir } from './fake-fs.ts';

describe('fs-access sink', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is unavailable without showDirectoryPicker', () => {
    expect(fsAccessAvailable()).toBe(false);
    vi.stubGlobal('window', {});
    expect(fsAccessAvailable()).toBe(false);
  });

  it('asks for a writable folder and never overwrites existing files', async () => {
    const root = new FakeDir('Downloads');
    await root.getFileHandle('a.txt', { create: true });
    const showDirectoryPicker = vi.fn().mockResolvedValue(root);
    vi.stubGlobal('window', { showDirectoryPicker });
    expect(fsAccessAvailable()).toBe(true);

    const sink = await pickDirectorySink();
    expect(showDirectoryPicker).toHaveBeenCalledWith({ mode: 'readwrite', id: 'e2e-transfer' });
    expect([sink.id, sink.rootName]).toEqual(['fs-access', 'Downloads']);
    const w = await sink.open({ path: 'a.txt', size: 1, mime: '' });
    await w.write(Uint8Array.of(1), 0);
    await w.close();
    expect(sink.saved[0]?.name).toBe('a (1).txt');
  });
});
