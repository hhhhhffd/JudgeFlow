// Strings of the projector screen (/stage/:eventId).
export const stageText = {
  title: 'Сцена',
  loading: 'Загружаем сцену…',
  eyebrow: 'Итоги',
  notFound: {
    title: 'Сцена недоступна',
    text: 'Такого мероприятия нет, либо оно ещё не открыто. Страница обновится сама.',
  },
  error: { title: 'Не удалось загрузить сцену' },
  soon: { title: 'Итоги скоро', text: 'Результаты будут объявлены после завершения оценивания.' },
  waiting: { title: 'Церемония начинается', text: 'Оставайтесь с нами: скоро объявим результаты.' },
  offline: 'Нет связи — показаны последние данные',
  place: (n: number) => `${n} место`,
  tie: 'Делят место',
  noScore: 'Нет оценок',
  score: 'Балл',
  team: 'Участник',
  rank: 'Место',
  hiddenPlace: (n: number) => `${n} место пока скрыто`,
}
