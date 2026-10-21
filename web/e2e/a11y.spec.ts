import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { loginAsAdmin } from './admin'

// Runs axe (WCAG 2.1 A/AA) over every screen, in light and dark colour schemes. This spec depends on the
// "chromium" project (see playwright.config.ts) because the first-start spec enrols the organizer.
test.use({ baseURL: process.env.E2E_BASE_URL })

const SCHEMES = ['light', 'dark'] as const
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

interface Seed {
  adminState: Awaited<ReturnType<BrowserContext['storageState']>>
  team: { event: string; link: string }
  criterion: { event: string; link: string }
  pairwise: { event: string; link: string }
  published: { event: string; link: string }
  draft: string
}
let seed: Seed

async function scan(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  const report = violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n${v.nodes.map((n) => `    ${n.target.join(' ')} ${n.html.slice(0, 160)}\n      ${n.failureSummary?.replace(/\n/g, '\n      ')}`).join('\n')}`)
  expect.soft(report, `${label}: axe violations`).toEqual([])
}

/** Opens `url` in a fresh context with the colour scheme and viewport, waits for `ready`, and scans it. */
async function check(
  browser: Browser,
  label: string,
  url: string,
  ready: (page: Page) => Promise<unknown>,
  opts: { admin?: boolean; width?: number; height?: number; after?: (page: Page) => Promise<void> } = {},
) {
  for (const colorScheme of SCHEMES) {
    const context = await browser.newContext({
      baseURL: process.env.E2E_BASE_URL,
      colorScheme,
      locale: 'ru-RU',
      viewport: { width: opts.width ?? 1280, height: opts.height ?? 900 },
      storageState: opts.admin ? seed.adminState : undefined,
    })
    const page = await context.newPage()
    await page.emulateMedia({ colorScheme })
    await page.goto(url)
    await ready(page)
    if (opts.after) await opts.after(page)
    // Let entrance transitions finish so contrast is measured on the settled colours.
    await page.waitForTimeout(400)
    await scan(page, `${label} [${colorScheme}]`)
    await context.close()
  }
}

async function api<T>(request: APIRequestContext, method: 'post' | 'patch' | 'put', url: string, data?: unknown, token?: string): Promise<T> {
  const res = await request[method](url, { data, headers: token ? { Authorization: `Bearer ${token}` } : undefined })
  if (!res.ok()) throw new Error(`${method} ${url}: ${res.status()} ${await res.text()}`)
  return res.status() === 204 ? (undefined as T) : ((await res.json()) as T)
}

interface EventFullDto {
  event: { id: string }
  teams: { id: string }[]
  criteria: { id: string }[]
}

async function createEvent(request: APIRequestContext, title: string, mode: 'team' | 'criterion' | 'pairwise') {
  const { event } = await api<EventFullDto>(request, 'post', '/api/events', { title, description: 'Проверка доступности' })
  await api(request, 'patch', `/api/events/${event.id}`, { scoring_mode: mode })
  await api(request, 'post', `/api/events/${event.id}/teams/bulk`, {
    teams: [{ name: 'Альфа', description: 'Робот-помощник' }, { name: 'Бета' }, { name: 'Гамма' }, { name: 'Дельта' }],
  })
  if (mode !== 'pairwise') {
    // 0..10 step 1 renders the segmented control, 0..100 step 0.5 the numeric stepper.
    await api(request, 'post', `/api/events/${event.id}/criteria/bulk`, {
      criteria: [
        { name: 'Идея', description: 'Насколько идея свежая', max_x100: 1000, step_x100: 100, weight: 1 },
        { name: 'Реализация', max_x100: 10000, step_x100: 50, weight: 2 },
      ],
    })
  }
  const judges = await api<{ link: string }[]>(request, 'post', `/api/events/${event.id}/judges`, { names: ['Судья Первый'] })
  const link = judges[0]!.link
  await api(request, 'post', `/api/events/${event.id}/transition`, { to: 'judging' })
  return { event: event.id, link }
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000)
  const context = await browser.newContext({ baseURL: process.env.E2E_BASE_URL })
  const page = await context.newPage()
  await loginAsAdmin(page)
  const request = page.request
  seed = {
    team: await createEvent(request, 'Командный режим', 'team'),
    criterion: await createEvent(request, 'Режим по критериям', 'criterion'),
    pairwise: await createEvent(request, 'Попарное сравнение', 'pairwise'),
    published: await createEvent(request, 'Опубликованный итог', 'team'),
    draft: (await api<EventFullDto>(request, 'post', '/api/events', { title: 'Черновик' })).event.id,
    adminState: await context.storageState(),
  } as Seed

  // The published event: one submitted sheet, then locked -> finalized -> published.
  const { event, link } = seed.published
  const token = link.split('/').pop()!
  const full = await (await request.get(`/api/events/${event}`)).json() as EventFullDto
  const items = full.teams.flatMap((t, i) => full.criteria.map((c, j) => ({ team_id: t.id, criterion_id: c.id, value_x100: j === 0 ? 300 + i * 200 : 2000 + i * 1500, note: null, edited_at: Date.now() })))
  await api(request, 'put', '/api/judge/scores', { items }, token)
  await api(request, 'post', '/api/judge/submit', undefined, token)
  for (const to of ['locked', 'finalized', 'published']) await api(request, 'post', `/api/events/${event}/transition`, { to })
  await context.close()
})

test('login and first-start (404 once set up)', async ({ browser }) => {
  await check(browser, '/login', '/login', (p) => expect(p.getByLabel('Цифра 1 из 6')).toBeVisible())
  await check(browser, '/firststart', '/firststart', (p) => expect(p.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible())
})

test('events list', async ({ browser }) => {
  await check(browser, 'events', '/', (p) => expect(p.getByRole('heading', { name: 'Мероприятия' })).toBeVisible(), { admin: true })
})

test('control room tabs', async ({ browser }) => {
  const id = seed.team.event
  const tabs = ['', '/setup', '/judges', '/stage']
  for (const tab of tabs) {
    await check(browser, `control room ${tab || 'overview'}`, `/events/${id}${tab}`, (p) => expect(p.getByRole('heading', { name: 'Командный режим' })).toBeVisible(), { admin: true })
  }
  const done = seed.published.event
  for (const tab of ['', '/results', '/stage']) {
    await check(browser, `published control room ${tab || 'overview'}`, `/events/${done}${tab}`, (p) => expect(p.getByRole('heading', { name: 'Опубликованный итог' })).toBeVisible(), { admin: true })
  }
  await check(browser, 'pairwise control room judges', `/events/${seed.pairwise.event}/judges`, (p) => expect(p.getByRole('heading', { name: 'Попарное сравнение' })).toBeVisible(), { admin: true })
})

for (const [name, key] of [['team', 'team'], ['criterion', 'criterion']] as const) {
  test(`judge desk, ${name} mode`, async ({ browser }) => {
    const ready = (p: Page) => expect(p.getByRole('radiogroup').first()).toBeVisible()
    await check(browser, `judge ${name} desktop`, seed[key].link, ready)
    await check(browser, `judge ${name} 390px`, seed[key].link, ready, { width: 390, height: 800 })
  })
}

test('judge desk, pairwise mode', async ({ browser }) => {
  const ready = (p: Page) => expect(p.getByRole('heading', { name: 'Кто сильнее?' })).toBeVisible()
  await check(browser, 'judge pairwise desktop', seed.pairwise.link, ready)
  await check(browser, 'judge pairwise 390px', seed.pairwise.link, ready, { width: 390, height: 800 })
})

test('live page and stage page', async ({ browser }) => {
  const id = seed.published.event
  await check(browser, 'live', `/live/${id}`, (p) => expect(p.getByText('Альфа').first()).toBeVisible())
  await check(browser, 'live (hidden results)', `/live/${seed.team.event}`, (p) => expect(p.getByText('Результаты скрыты до публикации')).toBeVisible())
  await check(browser, 'stage', `/stage/${id}`, (p) => expect(p.locator('main, body')).toBeVisible())
})

test('open dialogs and selected states', async ({ browser }) => {
  await check(browser, 'add criterion dialog', `/events/${seed.draft}/setup`, (p) => expect(p.getByRole('heading', { name: 'Черновик' })).toBeVisible(), {
    admin: true,
    after: async (p) => {
      await p.getByRole('button', { name: 'Добавить критерий' }).click()
      await expect(p.getByRole('dialog')).toBeVisible()
    },
  })
  await check(browser, 'judge selected score and submit dialog', seed.team.link, (p) => expect(p.getByRole('radiogroup').first()).toBeVisible(), {
    after: async (p) => {
      await p.getByRole('radiogroup').first().getByRole('radio', { name: '7', exact: true }).click()
      await p.getByRole('button', { name: 'Сдать лист' }).first().click()
      await expect(p.getByRole('dialog')).toBeVisible()
    },
  })
  await check(browser, 'judge pairwise chosen', seed.pairwise.link, (p) => expect(p.getByRole('heading', { name: 'Кто сильнее?' })).toBeVisible(), {
    after: async (p) => {
      await p.keyboard.press('ArrowLeft')
      await expect(p.getByText('Решено пар: 1')).toBeVisible()
    },
  })
})

test('judge desk: keyboard-only flow reaches scores and submit', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: process.env.E2E_BASE_URL, viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  await page.goto(seed.team.link)
  const firstGroup = page.getByRole('radiogroup').first()
  await expect(firstGroup).toBeVisible()

  const focusedRadio = page.locator('[role="radio"]:focus')
  const submit = page.getByRole('button', { name: 'Сдать лист' }).first()
  let reachedScore = false
  let reachedSubmit = false
  for (let i = 0; i < 60 && !(reachedScore && reachedSubmit); i++) {
    await page.keyboard.press('Tab')
    if (await focusedRadio.count()) reachedScore = true
    if (await submit.evaluate((el) => el === document.activeElement)) reachedSubmit = true
  }
  expect(reachedScore, 'Tab reaches the segmented score input').toBe(true)
  expect(reachedSubmit, 'Tab reaches the submit button').toBe(true)

  // Pick a value with the keyboard only (Space on a focused radio) and open the submit dialog with Enter.
  await page.locator('[role="radio"]').first().focus()
  await page.keyboard.press('Space')
  await expect(page.getByRole('radiogroup').first().getByRole('radio', { checked: true })).toHaveCount(1)
  await submit.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Tab')
  expect(await dialog.evaluate((d) => d.contains(document.activeElement)), 'focus stays in the dialog').toBe(true)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(submit).toBeFocused()
  await context.close()
})
