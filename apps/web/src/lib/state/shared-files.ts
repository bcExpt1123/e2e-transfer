/**
 * Files shared to the installed app from the OS share sheet (PWA Share Target).
 * public/sw-extras.js parks them in a cache and opens `./?shared`; this takes them once.
 */
export const SHARE_CACHE = 'e2e-transfer-share';
const PARAM = 'shared';

export async function takeSharedFiles(
  loc: Pick<Location, 'href'> = location,
  store: CacheStorage | undefined = globalThis.caches,
): Promise<File[]> {
  const url = new URL(loc.href);
  if (!url.searchParams.has(PARAM)) return [];
  url.searchParams.delete(PARAM);
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  if (!store) return [];
  try {
    const cache = await store.open(SHARE_CACHE);
    const keys: readonly Request[] = await cache.keys();
    const index = (r: Request) => Number(new URL(r.url).pathname.split('/').pop());
    const files: File[] = [];
    for (const request of [...keys].sort((a, b) => index(a) - index(b))) {
      const res = await cache.match(request);
      if (!res) continue;
      const name = decodeURIComponent(res.headers.get('x-file-name') ?? '') || 'shared-file';
      files.push(new File([await res.blob()], name, { type: res.headers.get('content-type') ?? '' }));
    }
    return files;
  } catch {
    return [];
  } finally {
    await store.delete(SHARE_CACHE).catch(() => false);
  }
}
