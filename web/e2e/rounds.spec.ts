import { expect, test, type Page } from '@playwright/test'
import { loginAsAdmin } from './admin'

test.use({ baseURL: process.env.E2E_BASE_URL })

const SHOTS = process.env.E2E_SHOTS_DIR

async function shot(page: Page, name: string, fullPage = true) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage })
}

test('rounds: rubric event -> next pairwise round with top 3 -> pairs (one offline) -> ranking', async ({ browser, page }) => {
  await loginAsAdmin(page)

  // ---- round 1: a rubric event with centering switched on ----
  await page.goto('/')
  await page.getByRole('button', { name: 'Новое мероприятие' }).first().click()
  await page.getByLabel('Название').fill('Раунды E2E')
  await page.getByRole('button', { name: /Создать/ }).click()
  await expect(page.getByRole('heading', { name: 'Раунды E2E' })).toBeVisible()

  await page.getByRole('link', { name: 'Настройка' }).click()
  const rules = page.getByRole('region', { name: 'Правила оценивания' })
  await rules.getByLabel('Центрировать оценки судей').click()
  await expect(rules.getByText(/центрирование может исказить итог/)).toBeVisible()
  await rules.getByRole('button', { name: 'Сохранить' }).click()
  await expect(rules.getByLabel('Центрировать оценки судей')).toBeChecked()
  await shot(page, 'r1-normalization')

  await page.getByRole('button', { name: 'Вставить список' }).click()
  await page.locator('#paste-text').fill('Альфа\nБета\nГамма\nДельта')
  await page.getByRole('button', { name: 'Добавить 4' }).click()
  await expect(page.getByText('Дельта', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Добавить критерий' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Название').fill('Идея')
  await dialog.getByLabel('Максимум').fill('10')
  await dialog.getByLabel('Шаг').fill('1')
  await dialog.getByRole('button', { name: 'Сохранить' }).click()

  await page.getByRole('link', { name: 'Судьи' }).click()
  await page.getByLabel(/По одному имени в строке/).fill('Судья Раундов')
  await page.getByRole('button', { name: /Создать ссылки/ }).click()
  const firstLink = await page.getByLabel('Ссылка для Судья Раундов').inputValue()
  await page.getByRole('button', { name: 'Готово' }).click()

  await page.getByRole('button', { name: 'Запустить оценивание' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Запустить оценивание' }).click()
  await expect(page.getByText('Идёт оценивание').first()).toBeVisible()

  // ---- the judge gives 9, 7, 5, 3 with hotkeys and submits ----
  const judgeContext = await browser.newContext({ baseURL: process.env.E2E_BASE_URL, viewport: { width: 1280, height: 900 } })
  const judge = await judgeContext.newPage()
  await judge.goto(firstLink)
  await expect(judge.getByRole('heading', { name: 'Альфа' })).toBeVisible()
  for (const [i, value] of ['9', '7', '5', '3'].entries()) {
    await judge.keyboard.press(value)
    await expect(judge.getByText('Синхронизировано')).toBeVisible()
    if (i < 3) await judge.keyboard.press('ArrowRight')
  }
  await judge.keyboard.press('Control+Enter')
  await judge.getByRole('dialog').getByRole('button', { name: 'Сдать', exact: true }).click()
  await expect(judge.getByText('Лист сдан').first()).toBeVisible()
  await judgeContext.close()

  // ---- finalize; both the centered and the raw score are shown ----
  await page.getByRole('button', { name: 'Закрыть оценивание' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Закрыть оценивание' }).click()
  await page.getByRole('button', { name: 'Подвести итоги' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Подвести итоги' }).click()
  await expect(page.getByText('Итоги подведены').first()).toBeVisible()
  await page.getByRole('link', { name: 'Результаты' }).click()
  await expect(page.getByText(/Без нормализации: 9/)).toBeVisible()
  await shot(page, 'r2-results-normalized')

  // ---- next round: pairwise, top 3 preselected, judges copied ----
  await page.getByRole('button', { name: 'Следующий раунд' }).click()
  const next = page.getByRole('dialog')
  await expect(next.getByText('Выбрано 3 из 4')).toBeVisible()
  await expect(next.getByRole('checkbox', { name: /Дельта/ })).not.toBeChecked()
  await next.getByLabel('Название раунда').fill('Финал E2E')
  await next.getByText('Попарное сравнение').click()
  await shot(page, 'r3-next-round-dialog', false)
  await next.getByRole('button', { name: 'Создать раунд' }).click()

  // The new event opens with the judge links dialog on top (it hides the page from the accessibility tree).
  const roundLink = await page.getByLabel('Ссылка для Судья Раундов').inputValue()
  await expect(page.getByText('Финал E2E').first()).toBeVisible()
  await expect(page.getByText('Раунд 2').first()).toBeVisible()
  await expect(page.getByText('Из раунда: Раунды E2E')).toBeVisible()
  expect(roundLink).not.toBe(firstLink)
  await shot(page, 'r4-new-round-links')
  await page.getByRole('button', { name: 'Готово' }).click()

  await page.getByRole('button', { name: 'Запустить оценивание' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Запустить оценивание' }).click()
  await expect(page.getByText('Идёт оценивание').first()).toBeVisible()

  // ---- the judge compares pairs; the second decision happens offline ----
  const pairContext = await browser.newContext({ baseURL: process.env.E2E_BASE_URL, viewport: { width: 1280, height: 900 } })
  const pairs = await pairContext.newPage()
  await pairs.goto(roundLink)
  await expect(pairs.getByRole('heading', { name: 'Кто сильнее?' })).toBeVisible()
  await expect(pairs.getByText('Решено пар: 0')).toBeVisible()
  await shot(pairs, 'r5-judge-pairs', false)

  await pairs.keyboard.press('ArrowLeft')
  await expect(pairs.getByText('Решено пар: 1')).toBeVisible()
  await expect(pairs.getByText('Синхронизировано')).toBeVisible()

  await pairContext.setOffline(true)
  await pairs.keyboard.press('ArrowRight')
  await expect(pairs.getByText('Решено пар: 2')).toBeVisible()
  await expect(pairs.getByText('Нет сети')).toBeVisible()
  await pairContext.setOffline(false)
  await expect(pairs.getByText('Синхронизировано')).toBeVisible()

  await pairs.keyboard.press('ArrowDown')
  await expect(pairs.getByText('Решено пар: 3')).toBeVisible()
  await expect(pairs.getByText('Синхронизировано')).toBeVisible()

  await pairs.keyboard.press('Control+Enter')
  await pairs.getByRole('dialog').getByRole('button', { name: /^Сдать(,|$)/ }).click()
  await expect(pairs.getByText('Лист сдан').first()).toBeVisible()
  await pairContext.close()

  // ---- finalize and read the ranking ----
  await page.getByRole('button', { name: 'Закрыть оценивание' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Закрыть оценивание' }).click()
  await page.getByRole('button', { name: 'Подвести итоги' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Подвести итоги' }).click()
  await expect(page.getByText('Итоги подведены').first()).toBeVisible()
  await page.getByRole('link', { name: 'Результаты' }).click()
  await expect(page.getByRole('columnheader', { name: 'Победы', exact: true })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Поражения', exact: true })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: 'Альфа' })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: 'Дельта' })).toHaveCount(0)
  await shot(page, 'r6-pairwise-results')

  // ---- the events list groups the round under the first event ----
  await page.goto('/')
  await expect(page.getByRole('button', { name: /Скрыть следующие раунды/ })).toBeVisible()
  await shot(page, 'r7-events-list')
})
