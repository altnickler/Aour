import { expect, test } from '@playwright/test'
import { start } from './helpers'

/** Location in the browser: real Geolocation API (mocked coordinates), denial, fallback search, radius. */
test.describe('Location', () => {
  test.describe('permission granted', () => {
    test.use({ geolocation: { latitude: 27.2001, longitude: -80.2502 }, permissions: ['geolocation'] })

    test('"Near me" appears only after the user shares location, with distances on cards', async ({ page }) => {
      await start(page)
      // Before sharing: the launch market is named honestly, never "Near me".
      const loc = page.getByRole('button', { name: /^Location:/ })
      await expect(loc).toHaveAccessibleName(/Location: Stuart & Martin County/)
      await expect(page.getByText(/Showing Stuart & Martin County/)).toBeVisible()
      await loc.click()
      await page.getByRole('button', { name: 'Share location' }).click()
      await expect(page.getByText('Using your location')).toBeVisible()
      await page.getByRole('button', { name: 'Done' }).click()
      await expect(loc).toHaveAccessibleName(/Location: Near me, within 5 miles/)
      await expect(page.getByText(/\d+(\.\d)? mi|Nearby/).first()).toBeVisible()
    })

    test('radius chips change the result set', async ({ page }) => {
      await start(page)
      const count = page.locator('section', { has: page.getByRole('heading', { name: /^Happy hours within/ }) }).locator('h2 + span, h2 ~ span').first()
      await page.getByRole('group', { name: 'Search radius' }).getByRole('button', { name: '2 miles' }).click()
      await expect(page.getByRole('heading', { name: 'Happy hours within 2 mi' })).toBeVisible()
      const small = Number(await count.textContent())
      await page.getByRole('group', { name: 'Search radius' }).getByRole('button', { name: '25 miles' }).click()
      await expect(page.getByRole('heading', { name: 'Happy hours within 25 mi' })).toBeVisible()
      await expect.poll(async () => Number(await count.textContent())).toBeGreaterThan(small)
    })
  })

  test.describe('permission denied', () => {
    test.use({ permissions: [] })

    test('explains the fallback and keeps an honest label', async ({ page }) => {
      // Headless browsers leave the permission prompt pending; answer it the way a user who taps "Don't allow" would.
      await page.addInitScript(() => {
        navigator.geolocation.getCurrentPosition = (_ok, fail) =>
          fail?.({ code: 1, message: 'User denied Geolocation', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError)
      })
      await start(page)
      await page.getByRole('button', { name: /^Location:/ }).click()
      await page.getByRole('button', { name: 'Share location' }).click()
      await expect(page.getByRole('alert')).toContainText(/Search for a city or address/)
      await page.getByRole('button', { name: 'Done' }).click()
      await expect(page.getByRole('button', { name: /^Location:/ })).not.toHaveAccessibleName(/Near me/)
    })

    test('manual search sets the search centre', async ({ page }) => {
      await start(page)
      await page.getByRole('button', { name: /^Location:/ }).click()
      await page.getByRole('searchbox', { name: 'Search a city or address' }).fill('Jensen Beach')
      await page.getByRole('list', { name: 'Search results' }).getByRole('button').first().click()
      await expect(page.getByRole('button', { name: /^Location:/ })).toHaveAccessibleName(/Location: Stuart & Martin County, Florida/)
    })
  })

  test.describe('far from any coverage', () => {
    test.use({ geolocation: { latitude: 41.8781, longitude: -87.6298 }, permissions: ['geolocation'] })

    test('shows an empty state instead of silently showing Stuart', async ({ page }) => {
      await start(page)
      await page.getByRole('button', { name: /^Location:/ }).click()
      await page.getByRole('button', { name: 'Share location' }).click()
      await page.getByRole('button', { name: 'Done' }).click()
      await expect(page.getByRole('heading', { name: /Aour isn't in your area yet/ })).toBeVisible()
      // The (anonymous, ~11 km) coverage request is sent automatically for a real location.
      await expect(page.getByRole('button', { name: 'Request sent' })).toBeDisabled()
      await expect(page.getByText(/We've noted this area/)).toBeVisible()
      await expect(page.getByRole('link', { name: /Copper Heron/ })).toHaveCount(0)
    })
  })
})
