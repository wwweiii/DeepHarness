import { expect, test } from '@playwright/test'
import { closeOpenSessions } from './support.ts'

test('creates, streams, cancels, refreshes, and stays responsive', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await closeOpenSessions(request)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')

  const create = page.getByRole('button', { name: 'Create session' })
  await expect(create).toBeEnabled({ timeout: 30_000 })
  await create.click()

  await expect(page.getByText('Connected', { exact: true })).toBeVisible({ timeout: 30_000 })
  const composer = page.getByRole('textbox', { name: 'Message' })
  await expect(composer).toBeEnabled()

  const prompt = `Browser stream ${crypto.randomUUID()}`
  await composer.fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText(`DeepHarness test model received: ${prompt}`, { exact: true }))
    .toBeVisible({ timeout: 30_000 })
  expect(pageErrors).toEqual([])

  await page.reload()
  await expect(page.getByText(prompt, { exact: true })).toBeVisible()
  await expect(page.getByText(`DeepHarness test model received: ${prompt}`, { exact: true }))
    .toBeVisible()

  await composer.fill('[slow] browser cancellation')
  await page.getByRole('button', { name: 'Send message' }).click()
  const stop = page.locator('.stop-button')
  await expect(stop).toBeEnabled({ timeout: 15_000 })
  await stop.click()
  await expect(page.getByRole('definition').filter({ hasText: /^idle$/ })).toBeVisible({ timeout: 30_000 })
  await expect(composer).toBeEnabled()
  await expect(page.locator('.stop-action')).toHaveCount(0)

  await page.screenshot({
    path: 'output/playwright/phase-1-desktop.png',
    fullPage: true,
  })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expect(page.getByRole('main').getByText('DeepHarness', { exact: true })).toBeVisible()
  await expect(composer).toBeVisible()
  await expect(page.locator('.stop-action')).toHaveCount(0)
  const noHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )
  expect(noHorizontalOverflow).toBe(true)
  await page.screenshot({
    path: 'output/playwright/phase-1-mobile.png',
    fullPage: true,
  })
  expect(pageErrors).toEqual([])
})
