import { expect, test } from '@playwright/test'

test('renders tools, resumes interactions, queues prompts, and inspects capabilities', async ({ page }) => {
  const runId = crypto.randomUUID()
  const send = async (text = '', action = 'Send message') => {
    const composer = page.getByRole('textbox', { name: 'Message' })
    await composer.fill(text)
    await page.getByRole('button', { name: action }).click()
  }
  const openLatestTool = async (title = '') => {
    const frame = page.locator('.tool-frame').filter({ hasText: title }).last()
    await expect(frame).toBeVisible({ timeout: 30_000 })
    if (!await frame.evaluate(element => element.hasAttribute('open'))) {
      await frame.locator('summary').click()
    }
    return frame
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  const create = page.getByRole('button', { name: 'Create session' })
  if (await create.isVisible()) await create.click()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeEnabled()

  await send('[tool:bash] browser durable approval')
  let bash = await openLatestTool('Bash')
  await expect(bash.locator('.approval-allow').first()).toBeVisible()
  await page.reload()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible({ timeout: 30_000 })
  bash = await openLatestTool('Bash')
  await expect(bash.locator('.approval-allow').first()).toBeVisible()
  await bash.locator('.approval-allow').first().click()
  await expect(page.getByText(/Tool completed through ACP:/).last()).toBeVisible({ timeout: 30_000 })

  await send('[tool:question] browser durable question')
  await openLatestTool('Questions')
  await page.reload()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible({ timeout: 30_000 })
  const question = await openLatestTool('Questions')
  await question.locator('.question-option').filter({ hasText: 'Contract tests' }).click()
  await question.getByRole('button', { name: 'Submit answers' }).click()
  await expect(page.getByText(/Contract tests/).last()).toBeVisible({ timeout: 30_000 })

  await send('[tool:unknown] browser generic renderer')
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({ timeout: 30_000 })
  const unknown = await openLatestTool('FutureHarnessTool')
  await expect(unknown.getByText('Input', { exact: true })).toBeVisible()
  await expect(unknown.locator('.tool-json').first()).toContainText('<script>')
  expect(await page.evaluate(() => Boolean(
    Reflect.get(window, '__deepharnessUnsafeToolExecuted'),
  ))).toBe(false)

  await send(`[queue] browser first queued prompt ${runId}`)
  await expect(page.getByRole('button', { name: 'Queue message' })).toBeVisible({ timeout: 15_000 })
  await send(`browser second queued prompt ${runId}`, 'Queue message')
  await expect(page.getByText(
    `DeepHarness test model received: browser second queued prompt ${runId}`,
    { exact: true },
  )).toBeVisible({ timeout: 45_000 })
  await expect(page.locator('.inspector').getByText('Latest usage', { exact: true })).toBeVisible()

  const mode = page.getByLabel('Permission mode')
  await mode.selectOption('acceptEdits')
  await expect(mode).toHaveValue('acceptEdits')
  const model = page.getByLabel('Model')
  await model.selectOption('haiku')
  await expect(model).toHaveValue('haiku')
  await page.reload()
  await expect(page.getByLabel('Permission mode')).toHaveValue('acceptEdits')
  await expect(page.getByLabel('Model')).toHaveValue('haiku')
  await page.getByLabel('Permission mode').selectOption('default')
  await expect(page.getByLabel('Permission mode')).toHaveValue('default')

  await page.getByRole('button', { name: 'Capabilities', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Capabilities' })).toBeVisible()
  await expect(page.locator('.provider')).toHaveCount(7)
  await expect(page.locator('.provider.active')).toContainText('Anthropic')
  await page.getByLabel('Search capabilities').fill('AskUserQuestion')
  const capabilityRow = page.locator('.capability-table tbody tr').filter({ hasText: 'AskUserQuestionTool' })
  await expect(capabilityRow).toHaveCount(1)
  await expect(capabilityRow).toContainText('Yes')
  await capabilityRow.locator('details summary').click()
  await expect(capabilityRow).toContainText('updatedInput.answers')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'output/playwright/phase-2-desktop.png', fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await page.locator('.mobile-view-tabs').getByRole('button', { name: 'Capabilities' }).click()
  await expect(page.getByRole('heading', { name: 'Capabilities' })).toBeVisible()
  await expect(page.locator('.provider')).toHaveCount(7)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const boxes = await page.locator('.mobile-view-tabs, .capability-header, .capability-filters')
    .evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect()
      return { left: box.left, right: box.right, width: box.width }
    }))
  for (const box of boxes) {
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.right).toBeLessThanOrEqual(390)
    expect(box.width).toBeGreaterThan(0)
  }
  await page.screenshot({ path: 'output/playwright/phase-2-mobile.png', fullPage: true })
})
