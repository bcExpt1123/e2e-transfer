import { expect, test } from '@playwright/test';

/** Installable PWA: manifest, offline shell and the Share Target (production build). */
test.describe('progressive web app', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'Share Target and install are Chromium features',
  );

  test('manifest is installable and declares the share target', async ({ page }) => {
    await page.goto('./');
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    const manifest = await (await page.request.get(href ?? '')).json();
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(
      expect.arrayContaining(['192x192', '512x512']),
    );
    expect(manifest.share_target).toMatchObject({ method: 'POST', enctype: 'multipart/form-data' });
    for (const icon of manifest.icons) expect((await page.request.get(icon.src)).ok()).toBe(true);
  });

  test('files shared from another app land on the pick screen; the shell works offline', async ({
    page,
    context,
  }) => {
    await page.goto('./');
    // Wait until the service worker controls the page (it claims clients on first install).
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15_000 });

    // What the OS share sheet does: POST the files as multipart form data.
    const status = await page.evaluate(async () => {
      const form = new FormData();
      form.append('files', new File(['hello'], 'note.txt', { type: 'text/plain' }));
      form.append('files', new File([new Uint8Array(2048)], 'photo.jpg', { type: 'image/jpeg' }));
      const res = await fetch('share-target', { method: 'POST', body: form, redirect: 'manual' });
      return res.type === 'opaqueredirect' ? 303 : res.status;
    });
    expect(status).toBe(303);

    await context.setOffline(true);
    await page.goto('./?shared');
    const list = page.getByRole('list', { name: 'Selected files' });
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await expect(list.getByRole('listitem')).toContainText(['note.txt', 'photo.jpg']);
    await expect(page).toHaveURL(/\/$/); // the marker is removed from the address bar

    // Taken once: a reload starts empty.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Choose files' })).toBeVisible();
    await expect(list).toHaveCount(0);
    await context.setOffline(false);
  });
});
