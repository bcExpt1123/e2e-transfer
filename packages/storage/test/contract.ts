import type { FileSink } from '@e2e-transfer/core';
import { describe, expect, it } from 'vitest';

/**
 * Contract every FileSink adapter must pass (docs/MAINTAINABILITY.md).
 * `readBack` returns the stored bytes for a path, or undefined.
 */
export function fileSinkContract(
  name: string,
  make: () => { sink: FileSink; readBack(path: string): Promise<Uint8Array | undefined> },
): void {
  describe(`FileSink contract: ${name}`, () => {
    it('stores sequential chunks', async () => {
      const { sink, readBack } = make();
      const w = await sink.open({ path: 'dir/a.bin', size: 5, mime: 'application/octet-stream' });
      await w.write(new Uint8Array([1, 2]), 0);
      await w.write(new Uint8Array([3, 4, 5]), 2);
      await w.close();
      expect([...((await readBack('dir/a.bin')) ?? [])]).toEqual([1, 2, 3, 4, 5]);
    });

    it('handles empty files', async () => {
      const { sink, readBack } = make();
      const w = await sink.open({ path: 'empty', size: 0, mime: '' });
      await w.close();
      expect((await readBack('empty'))?.byteLength).toBe(0);
    });

    it('rejects out-of-order writes', async () => {
      const { sink } = make();
      const w = await sink.open({ path: 'x', size: 4, mime: '' });
      await expect(w.write(new Uint8Array([1]), 2)).rejects.toThrow();
    });

    it('rejects writes beyond the declared size', async () => {
      const { sink } = make();
      const w = await sink.open({ path: 'x', size: 1, mime: '' });
      await expect(w.write(new Uint8Array([1, 2]), 0)).rejects.toThrow();
    });

    it('rejects close() before all bytes arrived', async () => {
      const { sink } = make();
      const w = await sink.open({ path: 'x', size: 2, mime: '' });
      await w.write(new Uint8Array([1]), 0);
      await expect(w.close()).rejects.toThrow();
    });

    it('does not persist aborted files', async () => {
      const { sink, readBack } = make();
      const w = await sink.open({ path: 'gone', size: 2, mime: '' });
      await w.write(new Uint8Array([1]), 0);
      await w.abort();
      expect(await readBack('gone')).toBeUndefined();
      await expect(w.write(new Uint8Array([2]), 1)).rejects.toThrow();
    });
  });
}
