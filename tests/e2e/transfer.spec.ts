import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';

/**
 * Real WebRTC between two pages. Signaling uses BroadcastChannel (same browser
 * context) instead of public relays, so the test is hermetic (docs/ARCHITECTURE.md § Testing strategy).
 */
test.skip(
  ({ browserName }) => browserName === 'webkit' && process.platform === 'linux',
  'Playwright WebKit on Linux has no WebRTC (CI runs WebKit on macOS)',
);

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function useBroadcastSignaling(context: BrowserContext) {
  await context.addInitScript(() => localStorage.setItem('e2e-transfer.signaling', 'broadcast'));
}

async function createLink(sender: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await sender.goto('./');
  await sender.getByTestId('file-input').setInputFiles(files);
  await sender.getByRole('button', { name: 'Create link' }).click();
  const link = await sender.getByRole('textbox', { name: 'Secret link' }).inputValue();
  expect(link).toMatch(/#v1\.[\w-]{43}$/);
  return link;
}

async function connectAndApprove(sender: Page, receiver: Page, link: string) {
  await receiver.goto(link);
  expect(new URL(receiver.url()).hash).toBe(''); // secret stripped from the address bar
  await expect(sender.getByRole('heading', { name: 'A device opened your link' })).toBeVisible();
  // Both screens show the same four verification words.
  const words = (page: Page) =>
    page.getByTestId('verification-words').getByRole('listitem').allTextContents();
  await expect(receiver.getByTestId('verification-words').getByRole('listitem')).toHaveCount(4);
  expect(await words(sender)).toEqual(await words(receiver));
  await expect(sender.getByText(/It says it’s \w+ on \w+\./)).toBeVisible();
  await sender.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(receiver.getByRole('heading', { name: 'Incoming files' })).toBeVisible();
}

test.describe('transfer between two browsers', () => {
  test.beforeEach(async ({ context }) => useBroadcastSignaling(context));

  test('sends a file end to end and saves identical bytes', async ({ context }) => {
    const sender = await context.newPage();
    const receiver = await context.newPage();
    const payload = randomBytes(3 * 1024 * 1024 + 123);
    const link = await createLink(sender, [
      { name: 'photo.bin', mimeType: 'application/octet-stream', buffer: payload },
    ]);
    await expect(sender.getByText('Waiting for the other device…')).toBeVisible();

    await connectAndApprove(sender, receiver, link);
    await expect(receiver.getByRole('listitem')).toContainText(['photo.bin']);

    const downloading = receiver.waitForEvent('download');
    await receiver.getByRole('button', { name: 'Accept & download' }).click();
    const download = await downloading;

    await expect(receiver.getByRole('heading', { name: 'Saved' })).toBeVisible();
    await expect(sender.getByRole('heading', { name: 'Delivered' })).toBeVisible();
    expect(download.suggestedFilename()).toBe('photo.bin');
    const received = await readFile((await download.path()) ?? '');
    expect(received.length).toBe(payload.length);
    expect(sha256(received)).toBe(sha256(payload));

    await sender.getByRole('button', { name: 'Send more files' }).click();
    await expect(sender.getByRole('button', { name: 'Choose files' })).toBeVisible();
  });

  test('sends several files and offers each for download', async ({ context }) => {
    const sender = await context.newPage();
    const receiver = await context.newPage();
    const files = [
      { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('first file') },
      { name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('second file') },
    ];
    const link = await createLink(sender, files);
    await connectAndApprove(sender, receiver, link);
    await receiver.getByRole('button', { name: 'Accept & download' }).click();
    await expect(receiver.getByRole('heading', { name: 'Saved' })).toBeVisible();

    const downloading = receiver.waitForEvent('download');
    await receiver.getByRole('button', { name: 'Download b.txt' }).click();
    const download = await downloading;
    expect((await readFile((await download.path()) ?? '')).toString()).toBe('second file');
    await expect(sender.getByRole('heading', { name: 'Delivered' })).toBeVisible();
  });

  test('the receiver can decline, and the sender is told', async ({ context }) => {
    const sender = await context.newPage();
    const receiver = await context.newPage();
    const link = await createLink(sender, [
      { name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('x') },
    ]);
    await connectAndApprove(sender, receiver, link);
    await receiver.getByRole('button', { name: 'Decline' }).click();
    await expect(receiver.getByText('You declined the files.')).toBeVisible();
    await expect(sender.getByRole('alert')).toContainText('The other device declined.');
  });

  test('the sender can turn away an unexpected device and keep the link open', async ({ context }) => {
    const sender = await context.newPage();
    const stranger = await context.newPage();
    const link = await createLink(sender, [
      { name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('x') },
    ]);
    await stranger.goto(link);
    await sender.getByRole('button', { name: 'Decline' }).click();
    await expect(stranger.getByRole('alert')).toContainText('The other device declined.');
    await expect(sender.getByText('Waiting for the other device…')).toBeVisible();
    await expect(sender.getByRole('textbox', { name: 'Secret link' })).toHaveValue(link);
  });

  test('share and review screens have no axe violations', async ({ context }) => {
    const sender = await context.newPage();
    const receiver = await context.newPage();
    const link = await createLink(sender, [
      { name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('x') },
    ]);
    const axe = (page: Page) =>
      new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
    expect((await axe(sender)).violations).toEqual([]);
    await connectAndApprove(sender, receiver, link);
    expect((await axe(receiver)).violations).toEqual([]);
  });

  test('connects manually: offer in the link, reply code pasted back', async ({ browser }) => {
    // Separate contexts: no BroadcastChannel, no relays — the codes are the only channel.
    const a = await browser.newContext();
    const b = await browser.newContext();
    for (const c of [a, b]) {
      await c.addInitScript(() => localStorage.setItem('e2e-transfer.signaling', 'offline-test'));
      await c.route(/^wss?:/, (route) => route.abort());
    }
    const sender = await a.newPage();
    const receiver = await b.newPage();
    const payload = randomBytes(500_000);
    await sender.goto('./');
    await sender
      .getByTestId('file-input')
      .setInputFiles([{ name: 'm.bin', mimeType: 'application/octet-stream', buffer: payload }]);
    await sender.getByRole('button', { name: 'Create link' }).click();
    await sender.getByRole('button', { name: 'No internet relay? Connect manually' }).click();
    await expect(sender.getByRole('heading', { name: 'Connect manually' })).toBeVisible();
    // gathering ICE candidates takes up to 3 s (longer when STUN is unreachable, as here)
    await expect(sender.getByRole('img', { name: 'QR code of the secret link' })).toBeVisible({
      timeout: 15_000,
    });
    const link = await sender.getByRole('textbox', { name: 'Secret link' }).inputValue();
    expect(link).toMatch(/#v1\.[\w-]{43}\.[\w-]+$/);

    await receiver.goto(link);
    const replyField = receiver.getByRole('textbox', { name: 'Reply code' });
    await expect(replyField).toBeVisible({ timeout: 15_000 });
    const reply = await replyField.inputValue();
    expect(reply.length).toBeGreaterThan(50);

    const replyBox = sender.getByRole('textbox', { name: 'Reply code from the other device' });
    await replyBox.fill('not-a-reply');
    await sender.getByRole('button', { name: 'Connect' }).click();
    await expect(sender.getByRole('alert')).toContainText('doesn’t fit this link');
    await replyBox.fill(reply);
    await sender.getByRole('button', { name: 'Connect' }).click();

    await sender.getByRole('button', { name: 'Send', exact: true }).click();
    const downloading = receiver.waitForEvent('download');
    await receiver.getByRole('button', { name: 'Accept & download' }).click();
    const download = await downloading;
    expect(sha256(await readFile((await download.path()) ?? ''))).toBe(sha256(payload));
    await expect(sender.getByRole('heading', { name: 'Delivered' })).toBeVisible();
    await a.close();
    await b.close();
  });
});
