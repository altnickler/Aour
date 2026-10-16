import { expect, test } from '@playwright/test'
import { rate, signIn, start } from './helpers'

test.describe('Discover without an account', () => {
  test('first launch shows a light welcome, then listings', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL('/welcome')
    await page.getByRole('button', { name: 'Jensen Beach' }).click()
    await page.getByRole('button', { name: 'Show me happy hours' }).click()
    await expect(page).toHaveURL('/')
    await expect(page.getByRole('button', { name: /Location: Jensen Beach/ })).toBeVisible()
    await expect(page.getByRole('link', { name: /The Pelican Pour/ }).first()).toBeVisible()
  })

  test('browse a place page with happy hour, freshness and community scores', async ({ page }) => {
    await start(page, '/place/copper-heron-cocktail-club')
    await expect(page.getByRole('heading', { level: 1, name: 'Copper Heron Cocktail Club' })).toBeVisible()
    await expect(page.getByText('Demo listing', { exact: false }).first()).toBeVisible()
    const hh = page.locator('section', { has: page.getByRole('heading', { name: 'Happy hour' }) })
    await expect(hh.getByText(/Verified/)).toBeVisible()
    await expect(hh.getByText('Old fashioned')).toBeVisible()
    await expect(page.getByRole('img', { name: /Community score \d/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Ratings breakdown' })).toBeVisible()
    await expect(page.locator('article').first()).toBeVisible() // public reviews
  })

  test('unverified and outdated listings are clearly flagged', async ({ page }) => {
    await start(page, '/place/seagrape-supper-club')
    await expect(page.getByText('Needs verification').first()).toBeVisible()
    await expect(page.getByText(/not been able to confirm them yet/)).toBeVisible()
    await page.goto('/place/hobe-harbor-taproom')
    await expect(page.getByText('Outdated', { exact: true }).first()).toBeVisible()
    await expect(page.getByText(/may no longer be accurate/)).toBeVisible()
  })

  test('search and filters', async ({ page }) => {
    await start(page, '/search')
    await page.getByRole('searchbox').fill('jensen')
    await expect(page.getByText(/^\d+ places?$/)).toBeVisible()
    await expect(page.getByRole('link', { name: /Little Lagoon Wine Bar/ })).toBeVisible()
    await expect(page.getByRole('link', { name: /Copper Heron/ })).toHaveCount(0)
    await page.getByRole('searchbox').fill('')
    await page.getByRole('button', { name: /^Filters/ }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Wine bar' }).click()
    await page.getByRole('button', { name: 'Show results' }).click()
    await expect(page.getByText('1 place')).toBeVisible()
  })

  test('saving requires an account', async ({ page }) => {
    await start(page, '/place/driftwood-social')
    await page.getByRole('button', { name: 'Save to Want to Try' }).first().click()
    await expect(page).toHaveURL(/\/signin\?next=/)
    await expect(page.getByText('Sign in to save places to your lists.')).toBeVisible()
  })
})

test.describe('Signed-in core loop', () => {
  test('save to wishlist, detailed rating, rankings update, data persists', async ({ page }) => {
    await start(page)
    await signIn(page)

    // Wishlist
    await page.goto('/place/little-lagoon-wine-bar')
    await page.getByRole('button', { name: 'Save to Want to Try' }).first().click()
    await expect(page.getByText('Saved to Want to Try')).toBeVisible()
    await page.goto('/rankings?tab=want')
    await expect(page.getByRole('link', { name: /Little Lagoon Wine Bar/ })).toBeVisible()

    // Detailed rating with N/A, extra metrics, tags and review
    await page.goto('/rate/little-lagoon-wine-bar')
    await page.getByRole('tab', { name: 'Detailed' }).click()
    await page.getByLabel('Ambience', { exact: true }).fill('9')
    await page.getByLabel('Drinks', { exact: true }).fill('8.5')
    await page.getByRole('button', { name: "Didn't have it · N/A" }).nth(2).click() // Food
    await page.getByLabel('Value', { exact: true }).fill('8')
    await page.getByLabel('Service', { exact: true }).fill('9.5')
    await page.getByLabel('Overall Experience', { exact: true }).fill('9')
    await page.getByRole('button', { name: /^Drinks/, expanded: false }).click()
    await page.getByLabel('Wine selection', { exact: true }).fill('10')
    await page.getByRole('button', { name: /Great wine/ }).click()
    await page.getByLabel('Review').fill('The patio at sunset is unbeatable.')
    await page.getByLabel(/Private note/).fill('Ask for the Sancerre')
    // (20·9 + 20·8.5 + 20·8 + 15·9.5 + 10·9) / 85 = 742.5/85 = 8.735… → 8.74
    await expect(page.getByRole('img', { name: 'Your score 8.7' })).toBeVisible()
    await expect(page.getByText('#1 of 1 in your rankings')).toBeVisible()
    await page.getByRole('button', { name: 'Save rating' }).click()
    await expect(page.getByRole('heading', { name: 'Rating saved!' })).toBeVisible()

    await page.getByRole('button', { name: 'See my rankings' }).click()
    const list = page.getByRole('list', { name: 'Your ranked happy hours' })
    await expect(list.getByRole('link', { name: /Little Lagoon Wine Bar/ })).toBeVisible()
    await expect(list.getByRole('img', { name: 'My score 8.7 out of 10' })).toBeVisible()

    // Data survives a full reload
    await page.reload()
    await expect(page.getByRole('list', { name: 'Your ranked happy hours' }).getByRole('link', { name: /Little Lagoon/ })).toBeVisible()

    // Review appears publicly on the place page; private note does not
    await page.goto('/place/little-lagoon-wine-bar')
    await expect(page.getByText('The patio at sunset is unbeatable.')).toBeVisible()
    await expect(page.getByText('Ask for the Sancerre')).toHaveCount(0)
    await expect(page.getByRole('img', { name: /^My score 8\.7/ })).toBeVisible()
  })

  test('custom weights recalculate rankings', async ({ page }) => {
    await start(page)
    await signIn(page, 'weights@example.com')
    await rate(page, 'saltline-sports-grill', { Ambience: 4, Drinks: 7, Food: 7, Value: 10, Service: 6, 'Overall Experience': 7 })
    await rate(page, 'golden-hour-rooftop', { Ambience: 10, Drinks: 8, Food: 8, Value: 5, Service: 8, 'Overall Experience': 8 })
    await page.goto('/rankings')
    const first = () => page.getByRole('list', { name: 'Your ranked happy hours' }).getByRole('listitem').first()
    await expect(first()).toContainText('Golden Hour Rooftop')

    await page.goto('/settings#weights')
    await page.getByLabel('Ambience', { exact: true }).fill('0')
    await page.getByLabel('Value', { exact: true }).fill('50')
    await page.getByRole('button', { name: 'Save weights' }).click()
    await expect(page.getByText('Rankings recalculated')).toBeVisible()
    await page.goto('/rankings')
    await expect(first()).toContainText('Saltline Sports Grill')
  })

  test('edit and delete a rating', async ({ page }) => {
    await start(page)
    await signIn(page, 'editor@example.com')
    await rate(page, 'driftwood-social', { Drinks: 6 })
    await page.goto('/me/history')
    await page.getByRole('link', { name: /Driftwood Social/ }).click()
    await expect(page.getByText('Edit rating')).toBeVisible()
    await page.getByLabel('Drinks', { exact: true }).fill('9')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Rating updated' })).toBeVisible()
    await page.goto('/me/history')
    await expect(page.getByRole('img', { name: 'My score 9.0 out of 10' })).toBeVisible()
    await page.getByRole('link', { name: /Driftwood Social/ }).click()
    page.once('dialog', (d) => d.accept())
    await page.getByRole('button', { name: /Delete this rating/ }).click()
    await expect(page).toHaveURL('/rankings')
    await expect(page.getByText('Nothing ranked yet')).toBeVisible()
  })

  test('follow someone and see their public ratings and feed', async ({ page }) => {
    await start(page)
    await signIn(page, 'follower@example.com')
    await page.goto('/search')
    await page.getByRole('tab', { name: 'People' }).click()
    await page.getByRole('searchbox').fill('jen')
    await page.getByRole('link', { name: /@jen_beachlife/ }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'Jen' })).toBeVisible()
    await page.getByRole('button', { name: 'Follow' }).click()
    await expect(page.getByRole('button', { name: 'Following' })).toBeVisible()
    await expect(page.getByRole('img', { name: /Jen's score/ }).first()).toBeVisible()
    await page.goto('/activity')
    await expect(page.getByRole('link', { name: 'Jen' }).first()).toBeVisible()
    await expect(page.locator('article').first()).toBeVisible()
  })

  test('collections: create, add a place, share publicly', async ({ page }) => {
    await start(page)
    await signIn(page, 'lists@example.com')
    await page.goto('/place/sandbar-social-club')
    await page.getByRole('button', { name: 'Add to collection' }).click()
    await page.getByLabel('New collection name').fill('Best Waterfront Spots')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByText('Created Best Waterfront Spots')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.goto('/rankings?tab=collections')
    await page.getByRole('link', { name: /Best Waterfront Spots/ }).click()
    await expect(page.getByRole('link', { name: /Sandbar Social Club/ })).toBeVisible()
    await page.getByRole('button', { name: 'Edit collection' }).click()
    await page.getByRole('tab', { name: /Public/ }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Public', { exact: true })).toBeVisible()
  })

  test('account deletion removes the account', async ({ page }) => {
    await start(page)
    await signIn(page, 'leaving@example.com')
    await rate(page, 'tidewater-tap-house', { Value: 9 })
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Delete account' }).click()
    await page.getByLabel('Type DELETE to confirm').fill('DELETE')
    await page.getByRole('button', { name: 'Permanently delete my account' }).click()
    await expect(page).toHaveURL('/')
    await page.goto('/me')
    await expect(page.getByRole('heading', { name: 'Make Aour yours' })).toBeVisible()
  })
})

test.describe('Administration', () => {
  test('admin adds a listing with a schedule, publishes and verifies it', async ({ page }) => {
    await start(page)
    await signIn(page, 'ops@example.com') // first account on a device is admin in demo mode
    await page.goto('/admin/listings/new')
    await page.getByLabel('Name').fill('Test Oyster Shack')
    await page.getByLabel('Street address').fill('1 Example Way')
    await page.getByLabel('City').fill('Stuart')
    await page.getByRole('button', { name: 'Add time window' }).click()
    await page.getByRole('button', { name: 'Add special' }).click()
    await page.getByLabel('Special', { exact: true }).fill('$1 oysters')
    await page.getByRole('button', { name: 'published' }).click()
    await page.getByRole('button', { name: 'Create listing' }).click()
    await expect(page.getByText('Listing saved')).toBeVisible()
    await expect(page.getByText('Not yet verified')).toBeVisible()

    await page.getByLabel('Verification note').fill('Called and spoke to the manager')
    await page.getByRole('button', { name: 'Mark verified today' }).click()
    await expect(page.getByText('Marked verified today')).toBeVisible()

    await page.goto('/place/test-oyster-shack')
    await expect(page.getByRole('heading', { level: 1, name: 'Test Oyster Shack' })).toBeVisible()
    await expect(page.getByText('$1 oysters')).toBeVisible()
    await expect(page.getByText(/Verified today/)).toBeVisible()
  })

  test('admin data pipeline area is reachable and honest about demo mode', async ({ page }) => {
    await start(page)
    await signIn(page, 'ops@example.com')
    await page.goto('/admin/data')
    await expect(page.getByText(/Demo mode: the automated pipeline only runs/)).toBeVisible()
    const tabs = page.getByRole('navigation', { name: 'Data pipeline' })
    await tabs.getByRole('link', { name: 'Findings', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Nothing to review' })).toBeVisible()
    await tabs.getByRole('link', { name: 'Duplicates', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Merge two listings' })).toBeVisible()
  })

  test('non-admins cannot open the dashboard', async ({ page }) => {
    await start(page)
    await signIn(page, 'first@example.com')
    await page.getByRole('button', { name: /Close|Back/ }).first().isVisible()
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Sign out' }).click()
    await signIn(page, 'second@example.com')
    await page.goto('/admin')
    await expect(page.getByRole('heading', { name: 'Administrators only' })).toBeVisible()
  })
})
