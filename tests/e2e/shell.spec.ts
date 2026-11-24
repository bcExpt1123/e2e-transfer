import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

async function expectNoA11yViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`)).toEqual([]);
}

test.describe('app shell', () => {
  test('send screen renders with primary actions', async ({ page }) => {
    await page.goto('./');
    await expect(page).toHaveTitle('e2e-transfer');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('end-to-end encrypted');
    await expect(page.getByRole('button', { name: 'Choose files' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose folder' })).toBeVisible();
  });

  test('picking files lists them and allows removal', async ({ page }) => {
    await page.goto('./');
    await page.getByTestId('file-input').setInputFiles([
      { name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') },
      { name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(2_000_000) },
    ]);
    const list = page.getByRole('list', { name: 'Selected files' });
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await expect(page.getByText('2 files · 2 MB')).toBeVisible();

    await page.getByRole('button', { name: 'Remove hello.txt' }).click();
    await expect(list.getByRole('listitem')).toHaveCount(1);

    await page.getByRole('button', { name: 'Clear all' }).click();
    await expect(list).toHaveCount(0);
  });

  test('settings dialog switches theme and closes with Escape', async ({ page, browserName }) => {
    await page.goto('./');
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();

    await dialog.getByText('Dark').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // Safari doesn't focus a button on click, so there is no focus to give back there.
    if (browserName !== 'webkit') await expect(page.getByRole('button', { name: 'Settings' })).toBeFocused();

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('a damaged link explains itself and offers a way out', async ({ page }) => {
    await page.goto('./#v1.dGVzdA');
    await expect(page.getByRole('alert')).toContainText('This link is incomplete or damaged.');
    expect(new URL(page.url()).hash).toBe(''); // never left in the address bar
    await page.getByRole('button', { name: 'Send files instead' }).click();
    await expect(page.getByRole('button', { name: 'Choose files' })).toBeVisible();
  });

  test('network settings validate input and persist', async ({ page }) => {
    await page.goto('./');
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByLabel('Nostr relays').fill('http://not-secure.example');
    await dialog.getByRole('button', { name: 'Save network settings' }).click();
    await expect(dialog.getByRole('alert')).toContainText('wss://');

    await dialog.getByLabel('Nostr relays').fill('wss://relay.example.org');
    await dialog.getByLabel('TURN address').fill('turns:turn.example.org:443');
    await dialog.getByLabel('Username').fill('me');
    await dialog.getByLabel('Password').fill('secret');
    await dialog.getByRole('button', { name: 'Save network settings' }).click();
    await expect(page.getByText('Network settings saved')).toBeVisible();

    await page.reload();
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByLabel('TURN address')).toHaveValue('turns:turn.example.org:443');
    await expect(page.getByLabel('Nostr relays')).toHaveValue('wss://relay.example.org');
  });

  test('production build ships a CSP', async ({ page }) => {
    await page.goto('./');
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`no axe violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('./');
      await page
        .getByTestId('file-input')
        .setInputFiles([{ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('a') }]);
      await expectNoA11yViolations(page);

      await page.getByRole('button', { name: 'Settings' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectNoA11yViolations(page);
    });
  }

  test('works by keyboard alone: pick files and create the link', async ({ page, browserName, isMobile }) => {
    test.skip(browserName === 'webkit', 'WebKit skips buttons when tabbing unless the OS setting is on');
    test.skip(isMobile, 'touch devices have no Tab key');
    await page.goto('./');
    // Tab until "Choose files" has focus, then open the picker with Enter.
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      if (
        await page
          .getByRole('button', { name: 'Choose files' })
          .evaluate((el) => el === document.activeElement)
      )
        break;
    }
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Enter');
    await (await chooser).setFiles([{ name: 'k.txt', mimeType: 'text/plain', buffer: Buffer.from('k') }]);

    const create = page.getByRole('button', { name: 'Create link' });
    for (let i = 0; i < 15 && !(await create.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(create).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Secret link' })).toBeVisible();
    // Focus is never lost to <body> after the screen changes.
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
  });
});

test.describe('languages', () => {
  test.use({ locale: 'de-DE' });

  test('follows the browser language, can be switched, and remembers the choice', async ({ page }) => {
    await page.goto('./');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect(page.getByRole('button', { name: 'Dateien wählen' })).toBeVisible();
    await expectNoA11yViolations(page);

    await page.getByRole('button', { name: 'Einstellungen' }).click();
    await page.getByRole('combobox', { name: 'Sprache' }).selectOption('en');
    await expect(page.getByRole('button', { name: 'Choose files' })).toBeVisible();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('button', { name: 'Choose files' })).toBeVisible();
  });
});
