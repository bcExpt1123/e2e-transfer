import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const isCI = Boolean(process.env.CI);
/** Firefox/WebKit always run in CI; locally opt in with E2E_ALL_BROWSERS=1 (after `playwright install`). */
const allBrowsers = isCI || Boolean(process.env.E2E_ALL_BROWSERS);

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}/`,
    trace: 'on-first-retry',
  },
  // Runs against the production build so CSP, PWA and minification are exercised.
  webServer: {
    command: `pnpm --filter @e2e-transfer/web exec vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !isCI,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
    ...(allBrowsers
      ? [
          {
            name: 'firefox',
            use: {
              ...devices['Desktop Firefox'],
              // CI runners can't resolve the mDNS (.local) names Firefox puts in host candidates,
              // so two pages on one machine would never connect. Use plain host addresses there.
              launchOptions: {
                firefoxUserPrefs: {
                  'media.peerconnection.ice.obfuscate_host_addresses': false,
                  'media.peerconnection.ice.loopback': true,
                },
              },
            },
          },
          { name: 'webkit', use: { ...devices['Desktop Safari'] } },
        ]
      : []),
  ],
});
