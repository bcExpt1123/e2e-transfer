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

  test('settings dialog switches theme and closes with Escape', async ({ page }) => {
    await page.goto('./');
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();

    await dialog.getByText('Dark').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Settings' })).toBeFocused();

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('a #v1. link opens the receive view', async ({ page }) => {
    await page.goto('./#v1.dGVzdA');
    await expect(page.getByRole('heading', { name: 'Incoming transfer' })).toBeVisible();
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
});
