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
  'Playwright WebKit on Linux has no WebRTC',
);
// Known issue (docs/ROADMAP.md): on the macOS CI runner two WebKit pages never get past ICE, because
// WebKit hides host candidates without camera access and Playwright can't turn that off. Run locally on a Mac.
test.skip(
  ({ browserName }) => browserName === 'webkit' && !!process.env.CI,
  'WebKit WebRTC does not connect on the CI runner',
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

  test('several devices can download from one link', async ({ context }) => {
    const sender = await context.newPage();
    const payload = randomBytes(512 * 1024);
    const link = await createLink(sender, [
      { name: 'shared.bin', mimeType: 'application/octet-stream', buffer: payload },
    ]);
    await sender.getByRole('checkbox', { name: /Let several devices download/ }).check();
    await expect(sender.getByText('Waiting for devices to open the link…')).toBeVisible();

    const receivers = [await context.newPage(), await context.newPage()];
    for (const receiver of receivers) {
      await receiver.goto(link);
      await expect(sender.getByRole('heading', { name: 'A device opened your link' })).toBeVisible();
      await sender.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(receiver.getByRole('heading', { name: 'Incoming files' })).toBeVisible();
    }
    // The link is still on screen, with both devices listed under it.
    await expect(sender.getByRole('textbox', { name: 'Secret link' })).toHaveValue(link);
    await expect(sender.getByTestId('receiver')).toHaveCount(2);

    for (const receiver of receivers) {
      const downloading = receiver.waitForEvent('download');
      await receiver.getByRole('button', { name: 'Accept & download' }).click();
      const received = await readFile((await (await downloading).path()) ?? '');
      expect(sha256(received)).toBe(sha256(payload));
    }
    await expect(sender.getByTestId('receiver').filter({ hasText: 'Delivered' })).toHaveCount(2);
    expect(await new AxeBuilder({ page: sender }).analyze().then((r) => r.violations)).toEqual([]);
  });

  test('resumes after the connection drops mid-transfer', async ({ context }) => {
    // Record every RTCPeerConnection so the test can pull the plug on one.
    await context.addInitScript(() => {
      const Native = window.RTCPeerConnection;
      const pcs: RTCPeerConnection[] = [];
      Object.assign(window, { __pcs: pcs });
      window.RTCPeerConnection = class extends Native {
        constructor(config?: RTCConfiguration) {
          super(config);
          pcs.push(this);
        }
      };
    });
    const sender = await context.newPage();
    const receiver = await context.newPage();
    const payload = randomBytes(40 * 1024 * 1024);
    const link = await createLink(sender, [
      { name: 'big.bin', mimeType: 'application/octet-stream', buffer: payload },
    ]);
    await connectAndApprove(sender, receiver, link);
    const downloading = receiver.waitForEvent('download', { timeout: 60_000 });
    await receiver.getByRole('button', { name: 'Accept & download' }).click();
    await expect(receiver.getByRole('progressbar')).toBeVisible();
    await receiver.evaluate(() => {
      for (const pc of (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs) pc.close();
    });

    const received = await readFile((await (await downloading).path()) ?? '');
    expect(received.length).toBe(payload.length);
    expect(sha256(received)).toBe(sha256(payload));
    await expect(sender.getByRole('heading', { name: 'Delivered' })).toBeVisible();
    // A second connection carried the rest; nobody was asked to approve or accept again.
    const connections = await receiver.evaluate(
      () => (window as unknown as { __pcs: unknown[] }).__pcs.length,
    );
    expect(connections).toBeGreaterThanOrEqual(2);
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

  test('sends with a short code; a wrong guess is refused and reported', async ({ context }) => {
    const sender = await context.newPage();
    const payload = randomBytes(200_000);
    await sender.goto('./');
    await sender
      .getByTestId('file-input')
      .setInputFiles([{ name: 'code.bin', mimeType: 'application/octet-stream', buffer: payload }]);
    await sender.getByRole('button', { name: 'Create link' }).click();
    await sender.getByRole('button', { name: 'Use a short code instead' }).click();
    const code = (await sender.getByTestId('short-code').textContent())?.trim() ?? '';
    expect(code).toMatch(/^\d{1,3}-[a-z]+-[a-z]+$/);
    const [n, w1, w2] = code.split('-') as [string, string, string];

    // A guesser with the right number but a wrong word
    const guesser = await context.newPage();
    await guesser.goto('./');
    const wrong = w2 === 'zoo' ? 'zone' : 'zoo';
    await guesser.getByRole('combobox', { name: 'Code from the sender' }).fill(`${n}-${w1}-${wrong}`);
    await guesser.getByRole('button', { name: 'Receive' }).click();
    await expect(guesser.getByRole('alert')).toContainText('That code didn’t work');
    await expect(sender.getByRole('alert')).toContainText('Someone entered a wrong code (1 of 3 tries)');

    // The real receiver types it loosely, with 4-letter prefixes
    const receiver = await context.newPage();
    await receiver.goto('./');
    await receiver
      .getByRole('combobox', { name: 'Code from the sender' })
      .fill(` ${n} ${w1.slice(0, 4).toUpperCase()} ${w2.slice(0, 4)} `);
    await receiver.getByRole('button', { name: 'Receive' }).click();
    await expect(receiver.getByRole('heading', { name: 'Incoming files' })).toBeVisible({ timeout: 15_000 });
    const downloading = receiver.waitForEvent('download');
    await receiver.getByRole('button', { name: 'Accept & download' }).click();
    const download = await downloading;
    expect(sha256(await readFile((await download.path()) ?? ''))).toBe(sha256(payload));
    await expect(sender.getByRole('heading', { name: 'Delivered' })).toBeVisible();
  });
});
