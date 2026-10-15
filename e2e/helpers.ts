import { expect, type Page } from '@playwright/test'

/** Skip the first-launch welcome (it is tested separately). */
export async function start(page: Page, path = '/') {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aour-place-v1')) localStorage.setItem('aour-place-v1', JSON.stringify({ onboarded: true }))
  })
  await page.goto(path)
}

/** Demo-mode sign in: any email, code 123456. */
export async function signIn(page: Page, email = 'allie@example.com') {
  await page.goto('/signin')
  await page.getByPlaceholder('you@example.com').fill(email)
  await page.getByRole('button', { name: /Continue with email/ }).click()
  await page.getByRole('button', { name: /Verify/ }).click()
  await expect(page).toHaveURL('/')
}

export async function rate(page: Page, slug: string, scores: Record<string, number | 'na'>) {
  await page.goto(`/rate/${slug}`)
  for (const [label, v] of Object.entries(scores)) {
    const card = page.locator('div').filter({ has: page.getByLabel(label, { exact: true }) }).last()
    if (v === 'na') await card.getByRole('button', { name: /N\/A/ }).click()
    else await page.getByLabel(label, { exact: true }).fill(String(v))
  }
  await page.getByRole('button', { name: 'Save rating' }).click()
  await expect(page.getByRole('heading', { name: 'Rating saved!' })).toBeVisible()
}
