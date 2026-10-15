import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { signIn, start } from './helpers'

const PUBLIC_PAGES = ['/', '/search', '/place/copper-heron-cocktail-club', '/signin', '/welcome', '/privacy']
const PRIVATE_PAGES = ['/rankings', '/me', '/settings', '/rate/driftwood-social', '/me/history']

async function audit(page: import('@playwright/test').Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([])
}

test.describe('Accessibility (axe, WCAG 2.1 AA)', () => {
  for (const path of PUBLIC_PAGES) {
    test(`public ${path}`, async ({ page }) => {
      await start(page, path)
      await page.waitForLoadState('networkidle')
      await audit(page)
    })
  }
  test('signed-in screens', async ({ page }) => {
    await start(page)
    await signIn(page)
    for (const path of PRIVATE_PAGES) {
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      await audit(page)
    }
  })
})

test.describe('Mobile layout', () => {
  test('no horizontal overflow and tap targets are comfortable', async ({ page }) => {
    await start(page)
    for (const path of ['/', '/search', '/place/copper-heron-cocktail-club', '/rankings', '/me']) {
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0)
    }
    const tabs = page.getByRole('navigation', { name: 'Main' }).getByRole('link')
    for (const tab of await tabs.all()) {
      const box = (await tab.boundingBox())!
      expect(box.height).toBeGreaterThanOrEqual(44)
    }
  })
})

test.describe('PWA', () => {
  test('serves a valid web app manifest and registers a service worker', async ({ page, request }) => {
    const res = await request.get('/manifest.webmanifest')
    expect(res.ok()).toBe(true)
    const manifest = await res.json()
    expect(manifest.short_name).toBe('Aour')
    expect(manifest.display).toBe('standalone')
    expect(manifest.icons.some((i: { sizes: string }) => i.sizes === '512x512')).toBe(true)
    await start(page)
    await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())), { timeout: 15_000 }).toBe(true)
    const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')
    expect((await request.get(apple!)).ok()).toBe(true)
  })
})
