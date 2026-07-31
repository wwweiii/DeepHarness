import { expect, test } from '@playwright/test'

test('phase 9 desktop and mobile health, capability, and layout smoke', async ({ page, request }) => {
  const health = await request.get('/health/ready')
  expect(health.ok()).toBe(true)
  const metrics = await request.get('/metrics')
  expect(metrics.ok()).toBe(true)
  expect(await metrics.text()).toContain('deepharness_gateway_requests_total')
  const capabilities = await request.get('/api/capabilities')
  expect(capabilities.ok()).toBe(true)
  const manifest = await capabilities.json() as { summary?: { unclassified?: number; ownerless?: number } }
  expect(manifest.summary?.unclassified).toBe(0)
  expect(manifest.summary?.ownerless ?? 0).toBe(0)

  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await page.goto('/')
    await expect(page.getByRole('main')).toBeVisible({ timeout: 30_000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({
      path: `output/playwright/phase-9-${viewport.width < 500 ? 'mobile' : 'desktop'}.png`,
      fullPage: true,
    })
  }
  expect(pageErrors).toEqual([])
})
