import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { loginAsAdmin } from './admin'

test.use({ baseURL: process.env.E2E_BASE_URL })

const SHOTS = process.env.E2E_SHOTS_DIR

async function shot(page: Page, name: string, fullPage = true) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage })
}

/** Gives every visible criterion of the open team the value 5. */
async function scoreEverything(judge: Page) {
  for (const group of await judge.getByRole('radiogroup').all()) await group.getByRole('radio', { name: '5', exact: true }).click()
}

test('tracks: auto-assignment, judge sees only own teams, backup sheet import, results per track', async ({ browser, page }) => {
  await loginAsAdmin(page)

  // ---- event from a template ----
  await page.goto('/')
  await page.getByRole('button', { name: 'Новое мероприятие' }).first().click()
  await page.getByLabel('Название').fill('Треки E2E')
  await page.getByLabel('Шаблон критериев').click()
  await page.getByRole('option', { name: 'Питч' }).click()
  await page.getByRole('button', { name: /Создать/ }).click()
  await expect(page.getByRole('heading', { name: 'Треки E2E' })).toBeVisible()

  // ---- tracks, teams with a track column, a track-specific criterion ----
  await page.getByRole('link', { name: 'Настройка' }).click()
  await expect(page.getByText('Проблема и рынок')).toBeVisible()
  for (const name of ['Веб', 'Мобайл']) {
    await page.getByRole('button', { name: 'Добавить трек' }).click()
    await page.getByRole('dialog').getByLabel('Название').fill(name)
    await page.getByRole('dialog').getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByText(name, { exact: true })).toBeVisible()
  }
  await page.getByRole('button', { name: 'Вставить список' }).click()
  await page.locator('#paste-text').fill('Альфа\t\tвеб\nБета\t\tМобайл')
  await page.getByRole('button', { name: 'Добавить 2' }).click()
  await expect(page.getByText('Трек: Мобайл')).toBeVisible()

  await page.getByRole('button', { name: 'Добавить критерий' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Название').fill('Дизайн мобилки')
  await dialog.getByLabel('Максимум').fill('10')
  await dialog.getByLabel('Шаг').fill('1')
  await dialog.getByLabel('Для какого трека').click()
  await page.getByRole('option', { name: 'Мобайл' }).click()
  await dialog.getByRole('button', { name: 'Сохранить' }).click()
  await expect(page.getByText('Дизайн мобилки')).toBeVisible()
  await shot(page, 't1-setup-tracks')

  // ---- judges and auto-assignment: one judge per team ----
  await page.getByRole('link', { name: 'Судьи' }).click()
  await page.getByLabel(/По одному имени в строке/).fill('Судья Веб\nСудья Мобайл')
  await page.getByRole('button', { name: /Создать ссылки/ }).click()
  const links = [await page.getByLabel('Ссылка для Судья Веб').inputValue(), await page.getByLabel('Ссылка для Судья Мобайл').inputValue()]
  await page.getByRole('button', { name: 'Готово' }).click()

  await page.getByLabel('Судей на команду').fill('1')
  await page.getByRole('button', { name: 'Распределить' }).click()
  await expect(page.getByRole('button', { name: 'Назначить: Судья Веб — Альфа' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Назначить: Судья Веб — Бета' })).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByRole('button', { name: 'Назначить: Судья Мобайл — Бета' })).toHaveAttribute('aria-pressed', 'true')
  await shot(page, 't2-distribution')

  // ---- start judging; the matrix shows what is outside each judge's set ----
  await page.getByRole('button', { name: 'Запустить оценивание' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Запустить оценивание' }).click()
  await expect(page.getByText('Идёт оценивание').first()).toBeVisible()
  await page.getByRole('link', { name: 'Обзор' }).click()
  await expect(page.getByLabel('Судья Веб · Бета: не назначена судье')).toBeVisible()
  await shot(page, 't3-matrix')

  // ---- the web judge sees only the web team and its 5 criteria ----
  const desktop = { baseURL: process.env.E2E_BASE_URL, viewport: { width: 1280, height: 900 }, acceptDownloads: true }
  const webContext = await browser.newContext(desktop)
  const web = await webContext.newPage()
  await web.goto(links[0]!)
  await expect(web.getByRole('heading', { name: 'Альфа' })).toBeVisible()
  await expect(web.getByText('Бета')).toHaveCount(0)
  await expect(web.getByRole('radiogroup')).toHaveCount(5)
  await scoreEverything(web)
  await expect(web.getByText('Синхронизировано')).toBeVisible()
  await web.getByRole('button', { name: 'Сдать лист' }).first().click()
  await web.getByRole('dialog').getByRole('button', { name: 'Сдать', exact: true }).click()
  await expect(web.getByText('Лист сдан').first()).toBeVisible()

  // ---- the mobile judge also gets the track-specific criterion ----
  const mobileContext = await browser.newContext(desktop)
  const mobile = await mobileContext.newPage()
  await mobile.goto(links[1]!)
  await expect(mobile.getByRole('heading', { name: 'Бета' })).toBeVisible()
  await expect(mobile.getByText('Альфа')).toHaveCount(0)
  await expect(mobile.getByRole('radiogroup')).toHaveCount(6)
  await expect(mobile.getByRole('radiogroup', { name: /Дизайн мобилки/ })).toBeVisible()
  await scoreEverything(mobile)
  await expect(mobile.getByText('Синхронизировано')).toBeVisible()
  await shot(mobile, 't4-judge-mobile-track', false)

  // ---- emergency backup: download, check the format, import it in the Control Room ----
  await mobile.getByRole('button', { name: 'Резервная копия листа' }).click()
  const [download] = await Promise.all([mobile.waitForEvent('download'), mobile.getByRole('button', { name: 'Скачать резервную копию листа' }).click()])
  const sheet = JSON.parse(readFileSync((await download.path())!, 'utf8')) as Record<string, unknown> & { items: unknown[] }
  expect(sheet).toMatchObject({ format: 'judgeflow-sheet/1', judge_name: 'Судья Мобайл' })
  expect(typeof sheet.token).toBe('string')
  expect(sheet.items).toHaveLength(6)

  await page.getByRole('link', { name: 'Судьи' }).click()
  await page.getByLabel('Файл листа судьи').setInputFiles(await download.path()!)
  await expect(page.getByText('Принято: 6')).toBeVisible()
  await expect(page.getByText('Отклонено: 0')).toBeVisible()
  await shot(page, 't5-sheet-import')

  await mobile.getByRole('button', { name: 'Сдать лист' }).first().click()
  await mobile.getByRole('dialog').getByRole('button', { name: 'Сдать', exact: true }).click()
  await expect(mobile.getByText('Лист сдан').first()).toBeVisible()

  // ---- results: one group per track, ranks restart ----
  await page.getByRole('link', { name: 'Результаты' }).click()
  await expect(page.getByRole('heading', { name: 'Веб' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Мобайл' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Веб' }).getByText('Альфа')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Мобайл' }).getByText('Бета')).toBeVisible()
  await shot(page, 't6-results-tracks')

  await webContext.close()
  await mobileContext.close()
})
