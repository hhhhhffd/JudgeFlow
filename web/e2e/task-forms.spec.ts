import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { loginAsAdmin } from './admin'

test.use({ baseURL: process.env.E2E_BASE_URL })

test('team forms: custom deletion confirmation, all question types and live collaboration', async ({ browser, page }) => {
  await loginAsAdmin(page)
  const errors: string[] = []
  const watch = (target: Page) => {
    target.on('pageerror', (error) => errors.push(error.message))
    target.on('dialog', (dialog) => { errors.push(`Unexpected browser dialog: ${dialog.message()}`); void dialog.dismiss() })
  }
  watch(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Новое мероприятие' }).first().click()
  await page.getByLabel('Название').fill('Командные формы E2E')
  await page.getByRole('button', { name: /Создать/ }).click()
  await expect(page.getByRole('heading', { name: 'Командные формы E2E' })).toBeVisible()
  await page.getByRole('link', { name: 'Настройка', exact: true }).click()
  await page.getByRole('button', { name: 'Добавить команду', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Название', { exact: true }).fill('Альфа')
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await page.getByRole('link', { name: 'Участники', exact: true }).click()
  await expect(page.getByLabel('Имя', { exact: true })).toBeVisible()
  await expect(page.getByPlaceholder('Новая команда')).toHaveCount(0)

  const addUser = async (name: string, role: string) => {
    await page.getByLabel('Имя', { exact: true }).fill(name)
    await page.getByRole('combobox').nth(0).click()
    await page.getByRole('option', { name: role, exact: true }).click()
    if (role !== 'Жюри') {
      await page.getByRole('combobox').nth(1).click()
      await page.getByRole('option', { name: 'Альфа', exact: true }).click()
    }
    await page.getByRole('button', { name: 'Создать и показать доступ' }).click()
    await expect(page.getByText(`Сохраните доступ для ${name}`, { exact: true })).toBeVisible()
    const link = await page.locator('code').nth(1).textContent()
    await page.getByRole('button', { name: 'Готово', exact: true }).click()
    return link!
  }
  await addUser('Проверка отмены', 'Жюри')
  await addUser('Проверка памяти', 'Жюри')
  await page.getByRole('button', { name: 'Удалить Проверка отмены', exact: true }).click()
  await expect(dialog).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('delete-confirmation.png') })
  await dialog.getByLabel('Больше не спрашивать').check()
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Удалить Проверка отмены', exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('jf.access.skip-delete-confirmation'))).toBeNull()
  await page.getByRole('button', { name: 'Удалить Проверка отмены', exact: true }).click()
  await expect(dialog.getByLabel('Больше не спрашивать')).not.toBeChecked()
  await dialog.getByLabel('Больше не спрашивать').check()
  await dialog.getByRole('button', { name: 'Удалить', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('jf.access.skip-delete-confirmation'))).toBe('true')
  await page.reload()
  await page.getByRole('button', { name: 'Удалить Проверка памяти', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Удалить Проверка памяти', exact: true })).toHaveCount(0)
  await expect(dialog).not.toBeVisible()

  const links = {
    teacher: await addUser('Педагог первый', 'Педагог'),
    colleague: await addUser('Педагог второй', 'Педагог'),
    student: await addUser('Студент первый', 'Студент'),
    studentColleague: await addUser('Студент второй', 'Студент'),
    jury: await addUser('Жюри форм', 'Жюри'),
  }
  await addUser('Временный участник', 'Жюри')
  await page.getByRole('button', { name: 'Удалить Временный участник', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Удалить Временный участник', exact: true })).toHaveCount(0)
  await expect(dialog).not.toBeVisible()

  await page.getByRole('link', { name: 'Вопросы', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Вопросы', exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Назад', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Добавить команду', exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Вопросы', exact: true }).click()
  await expect(page.getByLabel('Имя', { exact: true })).toHaveCount(0)
  await expect(page.getByPlaceholder('Новая команда')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /02 Педагоги/ })).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('question-editor-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: test.info().outputPath('question-editor-mobile.png'), fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.setViewportSize({ width: 1280, height: 720 })

  const addQuestion = async (audience: string, kind: string, prompt: string, required = true) => {
    await page.getByLabel('Для кого', { exact: true }).click()
    await page.getByRole('option', { name: audience, exact: true }).click()
    await page.getByLabel('Тип вопроса', { exact: true }).click()
    await page.getByRole('option', { name: kind, exact: true }).click()
    await page.getByLabel('Вопрос', { exact: true }).fill(prompt)
    await page.getByRole('checkbox', { name: 'Обязательный вопрос', exact: true }).setChecked(required)
    if (kind !== 'Развёрнутый ответ') {
      await page.getByLabel('Вариант 1', { exact: true }).fill('Первый')
      await page.getByLabel('Вариант 2', { exact: true }).fill('Второй')
    } else {
      await expect(page.getByLabel('Вариант 1', { exact: true })).toHaveCount(0)
    }
    await page.getByRole('button', { name: 'Добавить вопрос', exact: true }).click()
    await expect(page.getByRole('button', { name: `Удалить вопрос ${prompt}`, exact: true })).toBeVisible()
  }
  for (const audience of ['Педагоги', 'Студенты']) {
    await addQuestion(audience, 'Один вариант', `${audience}: один`)
    await addQuestion(audience, 'Несколько вариантов', `${audience}: несколько`)
    await addQuestion(audience, 'Развёрнутый ответ', `${audience}: сочинение`)
  }
  await addQuestion('Педагоги', 'Развёрнутый ответ', 'Необязательный комментарий', false)
  await addQuestion('Педагоги', 'Развёрнутый ответ', 'Временный вопрос', false)
  await page.getByRole('button', { name: 'Удалить вопрос Временный вопрос', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Удалить вопрос Временный вопрос', exact: true })).toHaveCount(0)
  await expect(dialog).not.toBeVisible()
  expect((await page.context().cookies()).some((cookie) => cookie.name === 'jf_event_session')).toBe(false)

  const contexts: BrowserContext[] = []
  const open = async (link: string) => {
    const context = await browser.newContext({ baseURL: process.env.E2E_BASE_URL })
    contexts.push(context)
    const target = await context.newPage()
    watch(target)
    await target.goto(link)
    await expect(target).toHaveURL(/\/event$/)
    return target
  }
  try {
    const student = await open(links.student)
    const studentColleague = await open(links.studentColleague)
    const teacher = await open(links.teacher)
    const colleague = await open(links.colleague)
    const jury = await open(links.jury)
    for (const target of [student, studentColleague, teacher, colleague]) {
      await expect(target.getByRole('heading', { name: 'Задание пока закрыто' })).toBeVisible()
      await target.evaluate(() => { document.documentElement.dataset.noReload = 'preserved' })
    }
    await page.getByRole('link', { name: 'Этапы заданий', exact: true }).click()
    await page.getByRole('button', { name: /02 Педагоги/ }).click()
    await expect(teacher.getByRole('heading', { name: 'Ответьте на вопросы' })).toBeVisible()
    const fillAndSubmit = async (first: Page, second: Page, audience: string) => {
      await expect(first.getByRole('button', { name: 'Сдать работу' })).toBeDisabled()
      await first.getByRole('radiogroup', { name: `${audience}: один`, exact: false }).getByLabel('Первый', { exact: true }).check()
      const choices = first.getByRole('group', { name: `${audience}: несколько`, exact: false })
      await choices.getByLabel('Первый', { exact: true }).check()
      await choices.getByLabel('Второй', { exact: true }).check()
      await expect(second.getByRole('group', { name: `${audience}: несколько`, exact: false }).getByLabel('Второй', { exact: true })).toBeChecked()
      const essay = first.getByRole('textbox', { name: `${audience}: сочинение`, exact: false })
      await essay.fill('Первый абзац\nВторой абзац')
      await expect(second.getByRole('textbox', { name: `${audience}: сочинение`, exact: false })).toHaveValue('Первый абзац\nВторой абзац')
      await expect(essay).toBeFocused()
      await essay.pressSequentially(' — продолжение', { delay: 70 })
      await expect(second.getByRole('textbox', { name: `${audience}: сочинение`, exact: false })).toHaveValue('Первый абзац\nВторой абзац — продолжение')
      await expect(essay).toBeFocused()
      await expect(first.getByRole('button', { name: 'Сдать работу' })).toBeEnabled()
      expect(await first.evaluate(() => document.documentElement.dataset.noReload)).toBe('preserved')
      expect(await second.evaluate(() => document.documentElement.dataset.noReload)).toBe('preserved')
      await second.getByRole('button', { name: 'Сдать работу' }).click()
      await expect(first.getByRole('heading', { name: 'Ответы приняты' })).toBeVisible()
      await expect(second.getByRole('heading', { name: 'Ответы приняты' })).toBeVisible()
    }
    await fillAndSubmit(teacher, colleague, 'Педагоги')
    await page.getByRole('button', { name: /03 Студенты/ }).click()
    await expect(student.getByRole('heading', { name: 'Ответьте на вопросы' })).toBeVisible()
    await fillAndSubmit(student, studentColleague, 'Студенты')
    await expect(jury.getByRole('heading', { name: '2 / 2 командных работ отправлено' })).toBeVisible()
    await jury.locator('summary').first().click()
    await expect(jury.locator('details[open]').getByText('Первый, Второй', { exact: true })).toBeVisible()
    await expect(jury.locator('details[open]').getByText('Первый абзац\nВторой абзац — продолжение', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Вернуть в настройку' })).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})
