import { afterEach, describe, expect, it } from 'vitest';
import { SHARE_CACHE, takeSharedFiles } from './shared-files.ts';

/** Just enough CacheStorage for the share-target hand-over. */
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const open = async (name: string) => {
    const store = stores.get(name) ?? new Map<string, Response>();
    stores.set(name, store);
    return {
      keys: async () => [...store.keys()].map((url) => new Request(url)),
      match: async (r: Request) => store.get(r.url)?.clone(),
      put: async (url: string, res: Response) => void store.set(url, res),
    };
  };
  return {
    stores,
    api: { open, delete: async (name: string) => stores.delete(name) } as unknown as CacheStorage,
  };
}

describe('takeSharedFiles', () => {
  afterEach(() => history.replaceState(null, '', '/'));

  it('takes the parked files once, in order, and cleans up', async () => {
    const { api, stores } = fakeCaches();
    const cache = await api.open(SHARE_CACHE);
    for (const [i, name] of ['b.txt', 'a ü.txt'].entries()) {
      await cache.put(
        `https://app.example/__shared/${i}`,
        new Response(`#${i}`, {
          headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) },
        }),
      );
    }
    history.replaceState(null, '', '/?shared');
    const files = await takeSharedFiles(location, api);
    expect(files.map((f) => [f.name, f.type])).toEqual([
      ['b.txt', 'text/plain'],
      ['a ü.txt', 'text/plain'],
    ]);
    expect(await files[1]?.text()).toBe('#1');
    expect(location.search).toBe('');
    expect(stores.has(SHARE_CACHE)).toBe(false);
  });

  it('does nothing on a normal visit', async () => {
    const { api } = fakeCaches();
    expect(await takeSharedFiles({ href: 'https://app.example/' }, api)).toEqual([]);
  });
});
