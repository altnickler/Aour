import { defineConfig, devices } from '@playwright/test'
import { existsSync } from 'node:fs'

// Use a preinstalled Chromium when present (cloud dev boxes); CI installs its own.
const localChromium = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync)

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    timezoneId: 'America/New_York',
    locale: 'en-US',
  },
  projects: [
    {
      name: 'iphone',
      use: {
        ...devices['iPhone 13'],
        // WebKit isn't available everywhere; Chromium with iPhone metrics + touch is a good proxy.
        browserName: 'chromium',
        defaultBrowserType: 'chromium',
        launchOptions: localChromium ? { executablePath: localChromium } : {},
      },
    },
  ],
  webServer: {
    // Production build in on-device demo mode (no Supabase env) so tests are hermetic.
    command: 'npx vite build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
  },
})
