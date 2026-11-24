import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { svelteTesting } from '@testing-library/svelte/vite';
import type { Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

/** docs/SECURITY.md § Implementation rules. Injected at build time only (dev server needs inline HMR). */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // headless UI libs set positioning styles at runtime
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' wss:",
  "img-src 'self' blob: data:",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const cspPlugin = (): Plugin => ({
  name: 'e2e-transfer:csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
});

const isTest = Boolean(process.env.VITEST);

export default defineConfig({
  root: import.meta.dirname,
  // GitHub Pages serves from /<repo>/; CI sets BASE_PATH.
  base: process.env.BASE_PATH ?? '/',
  plugins: [
    tailwindcss(),
    svelte(),
    svelteTesting(),
    cspPlugin(),
    !isTest &&
      VitePWA({
        // Updates wait until every tab is closed: activating mid-transfer could delete lazy chunks
        // an open page still needs. The first install takes control at once (offline, share target).
        registerType: 'prompt',
        injectRegister: 'script',
        includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
        manifest: {
          name: 'e2e-transfer',
          short_name: 'e2e-transfer',
          description: 'Send files directly to another device, end-to-end encrypted.',
          theme_color: '#4338ca',
          background_color: '#f7f7f8',
          display: 'standalone',
          start_url: '.',
          id: '.',
          icons: [
            { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
          // "Share to e2e-transfer" from other apps (public/sw-extras.js).
          share_target: {
            action: 'share-target',
            method: 'POST',
            enctype: 'multipart/form-data',
            params: { files: [{ name: 'files', accept: ['*/*'] }] },
          },
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png}'],
          importScripts: ['sw-extras.js'],
          cleanupOutdatedCaches: true,
        },
      }),
  ],
  build: { target: 'es2022' },
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    // Svelte component libraries ship .svelte sources that must go through the compiler.
    server: { deps: { inline: ['@lucide/svelte', 'bits-ui', 'svelte-sonner'] } },
  },
});
