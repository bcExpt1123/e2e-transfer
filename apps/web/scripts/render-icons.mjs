/**
 * Renders the PNG app icons from the SVG sources (some platforms ignore SVG manifest icons).
 * Run after changing public/icon*.svg:  node apps/web/scripts/render-icons.mjs
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const pub = join(import.meta.dirname, '..', 'public');
const jobs = [
  { src: 'icon.svg', out: 'icon-192.png', size: 192 },
  { src: 'icon.svg', out: 'icon-512.png', size: 512 },
  { src: 'icon-maskable.svg', out: 'icon-maskable-512.png', size: 512 },
  { src: 'icon-maskable.svg', out: 'apple-touch-icon.png', size: 180 },
];

const browser = await chromium.launch();
try {
  for (const { src, out, size } of jobs) {
    const svg = await readFile(join(pub, src), 'utf8');
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}</style><img src="${url}" width="${size}" height="${size}">`,
    );
    await page.screenshot({ path: join(pub, out), omitBackground: true });
    await page.close();
    console.log(`${out} (${size}×${size})`);
  }
} finally {
  await browser.close();
}
