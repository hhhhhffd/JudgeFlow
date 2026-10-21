import { expect, test, type Page } from '@playwright/test'
import { totp } from './totp'

test.use({ baseURL: process.env.E2E_BASE_URL })

const SHOTS = process.env.E2E_SHOTS_DIR

async function shot(page: Page, name: string, fullPage = true) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage })
}

test('organizer runs an event from first start to a published result', async ({ browser, page }) => {
  // ---- first start ----
  await page.goto('/')
  await expect(page).toHaveURL(/\/(firststart|login)/)
  await page.goto('/firststart')
  await page.getByLabel('Пароль установки').fill(process.env.E2E_SETUP_PASSWORD!)
  await page.getByLabel('Ваше имя').fill('Анна')
  await page.getByRole('button', { name: 'Продолжить' }).click()
  const secret = await page.getByLabel('Ключ', { exact: true }).inputValue()
  await shot(page, '01-enroll')
  const enrollCode = totp(secret)
  await page.getByLabel('Цифра 1 из 6').fill(enrollCode)
  await expect(page.getByRole('heading', { name: 'Мероприятия' })).toBeVisible()

  // ---- create the event ----
  await page.getByRole('button', { name: 'Новое мероприятие' }).first().click()
  await page.getByLabel('Название').fill('Хакатон E2E')
  await page.getByRole('button', { name: /Создать/ }).click()
  await expect(page.getByRole('heading', { name: 'Хакатон E2E' })).toBeVisible()
  const eventId = page.url().match(/\/events\/([^/?#]+)/)![1]!
  await shot(page, '02-event-created')

  // ---- teams (paste), criteria, judges ----
  await page.getByRole('link', { name: 'Настройка' }).click()
  await page.getByRole('button', { name: 'Вставить список' }).click()
  await page.getByLabel('Команды', { exact: true }).last().fill('Альфа\tРобот-помощник\nБета\nГамма')
  await page.getByRole('button', { name: 'Добавить 3' }).click()
  await expect(page.getByText('Альфа', { exact: true })).toBeVisible()

  for (const name of ['Идея', 'Реализация']) {
    await page.getByRole('button', { name: 'Добавить критерий' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Название').fill(name)
    await dialog.getByLabel('Максимум').fill('10')
    await dialog.getByLabel('Шаг').fill('1')
    await dialog.getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByText(name, { exact: true })).toBeVisible()
  }
  await shot(page, '03-setup')

  await page.getByRole('link', { name: 'Судьи' }).click()
  await page.getByLabel(/По одному имени в строке/).fill('Судья Первый\nСудья Второй')
  await page.getByRole('button', { name: /Создать ссылки/ }).click()
  const first = page.getByLabel('Ссылка для Судья Первый')
  await expect(first).toBeVisible()
  const links = [await first.inputValue(), await page.getByLabel('Ссылка для Судья Второй').inputValue()]
  await shot(page, '04-judge-links')
  await page.getByRole('button', { name: 'Готово' }).click()

  // ---- start judging ----
  await page.getByRole('button', { name: 'Запустить оценивание' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Запустить оценивание' }).click()
  await expect(page.getByText('Идёт оценивание', { exact: false }).first()).toBeVisible()
  await shot(page, '05-judging')

  // ---- judge scores, with the network dropping mid-way ----
  const judgeContext = await browser.newContext({ baseURL: process.env.E2E_BASE_URL, viewport: { width: 390, height: 800 } })
  const judge = await judgeContext.newPage()
  await judge.goto(links[0]!)
  await expect(judge.getByRole('radiogroup', { name: /Идея/ })).toBeVisible()
  await shot(judge, '06-judge-desk', false)
  const pick = (name: RegExp, value: string) => judge.getByRole('radiogroup', { name }).getByRole('radio', { name: value, exact: true }).click()
  const syncStatus = judge.getByText('Синхронизировано')

  await pick(/Идея/, '7')
  await pick(/Реализация/, '8')
  await expect(syncStatus).toBeVisible()

  await judgeContext.setOffline(true)
  await judge.getByRole('button', { name: 'Далее' }).click()
  await expect(judge.getByRole('heading', { name: 'Бета' })).toBeVisible()
  await pick(/Идея/, '5')
  await pick(/Реализация/, '6')
  await judge.getByRole('button', { name: 'Далее' }).click()
  await expect(judge.getByRole('heading', { name: 'Гамма' })).toBeVisible()
  await pick(/Идея/, '3')
  await pick(/Реализация/, '4')
  await expect(judge.getByText('Нет сети').first()).toBeVisible()
  await shot(judge, '07-judge-offline', false)

  // The Service Worker keeps the shell available: a reload while offline still shows the desk.
  await judge.waitForFunction(() => navigator.serviceWorker.controller !== null)
  await judge.reload()
  await expect(judge.getByRole('heading', { name: 'Альфа' }).or(judge.getByRole('heading', { name: 'Бета' })).or(judge.getByRole('heading', { name: 'Гамма' }))).toBeVisible()

  await judgeContext.setOffline(false)
  await expect(judge.getByText('Синхронизировано')).toBeVisible({ timeout: 30_000 })
  await expect(judge.getByText(/не отправлено/)).toHaveCount(0)

  // ---- submit the sheet ----
  await judge.getByRole('button', { name: 'Сдать лист' }).first().click()
  await judge.getByRole('dialog').getByRole('button', { name: 'Сдать', exact: true }).click()
  await expect(judge.getByText('Лист сдан').first()).toBeVisible()
  await shot(judge, '08-judge-submitted', false)

  // ---- monitoring matrix and the public board while judging ----
  await page.getByRole('link', { name: 'Обзор' }).click()
  await expect(page.getByText('Судья Первый')).toBeVisible()
  await expect(page.getByText('Судьи сдали листы').locator('xpath=following-sibling::*').first()).toHaveText('1/2')
  await shot(page, '09-matrix')

  const publicContext = await browser.newContext({ baseURL: process.env.E2E_BASE_URL })
  const board = await publicContext.newPage()
  await board.goto(`/live/${eventId}`)
  await expect(board.getByText('Результаты скрыты до публикации')).toBeVisible()
  await shot(board, '10-live-hidden', false)

  // ---- lock, finalize (the second judge never submitted, so force), publish ----
  await page.getByRole('button', { name: 'Закрыть оценивание' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Закрыть оценивание' }).click()
  await expect(page.getByRole('button', { name: 'Подвести итоги' })).toBeVisible()

  await page.getByRole('button', { name: 'Подвести итоги' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Подвести итоги' }).click()
  await expect(page.getByText('Не все судьи сдали листы')).toBeVisible()
  await expect(page.getByRole('dialog').getByText('Судья Второй')).toBeVisible()
  await page.getByLabel('Причина (обязательно)').fill('Судья ушёл')
  await page.getByRole('button', { name: 'Подвести итоги всё равно' }).click()
  await expect(page.getByRole('button', { name: 'Опубликовать' })).toBeVisible()

  // ---- stage: controlled reveal, 3rd place first ----
  await page.getByRole('link', { name: 'Сцена' }).click()
  await page.getByRole('button', { name: 'Пьедестал' }).click()
  await expect(page.getByRole('button', { name: 'Пьедестал' })).toHaveAttribute('aria-pressed', 'true')
  const stage = await publicContext.newPage()
  await stage.goto(`/stage/${eventId}`)
  await expect(stage.getByRole('list', { name: 'Участник' })).toBeVisible()
  await expect(stage.getByText('Гамма')).toHaveCount(0)
  await page.getByRole('button', { name: 'Показать следующее место' }).click()
  await expect(stage.getByText('Гамма')).toBeVisible()
  await expect(stage.getByText('Бета')).toHaveCount(0)
  await expect(stage.getByText('Альфа')).toHaveCount(0)
  await expect(page.getByText('Открыто 1 из 3')).toBeVisible()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Space')
  await expect(stage.getByText('Бета')).toBeVisible()
  await expect(stage.getByText('Альфа')).toHaveCount(0)
  await shot(stage, '13-stage-podium-2', false)
  await shot(page, '14-stage-control')
  await page.getByRole('button', { name: 'Показать всё' }).click()
  await expect(stage.getByText('Альфа')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Показать следующее место' })).toBeDisabled()
  await shot(stage, '15-stage-podium-all', false)
  await stage.close()
  await page.getByRole('button', { name: 'Опубликовать' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Опубликовать' }).click()
  await expect(page.getByRole('button', { name: 'Снять с публикации' })).toBeVisible()

  // ---- results + CSV ----
  await page.getByRole('link', { name: 'Результаты' }).click()
  await expect(page.getByText('Альфа', { exact: true })).toBeVisible()
  await shot(page, '11-results')
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Скачать CSV' }).or(page.getByRole('button', { name: 'Скачать CSV' })).click()])
  expect(download.suggestedFilename()).toMatch(/\.csv$/)

  // ---- public board shows the published result ----
  await board.reload()
  await expect(board.getByText('Альфа').first()).toBeVisible()
  await expect(board.getByText('Бета').first()).toBeVisible()
  await expect(board.getByText('Итоги').first()).toBeVisible()
  await shot(board, '12-live-published', false)

  await judgeContext.close()
  await publicContext.close()
})
