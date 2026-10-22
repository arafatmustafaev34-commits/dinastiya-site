// Быстрый посредник между Telegram и Google Apps Script.
// Мгновенно гасит «часики» на кнопке, а остальную работу отдаёт скрипту.
// Переменные в Vercel: BOT_TOKEN, SECRET, APPS_SCRIPT_URL

module.exports = async (req, res) => {
  const { BOT_TOKEN, SECRET, APPS_SCRIPT_URL } = process.env;
  if (req.method !== 'POST' || !SECRET || !APPS_SCRIPT_URL || req.query.key !== SECRET) {
    return res.status(403).json({ ok: false });
  }
  const update = req.body || {};

  // 1. Сразу отвечаем на нажатие кнопки: кружок исчезает за долю секунды
  if (update.callback_query && BOT_TOKEN) {
    try {
      await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/answerCallbackQuery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: update.callback_query.id, text: 'Принято' })
      });
    } catch (e) {}
  }

  // 2. Передаём то же сообщение в Apps Script (он меняет статус и шлёт уведомление)
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    await fetch(APPS_SCRIPT_URL + '?key=' + encodeURIComponent(SECRET), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
      signal: ctl.signal
    });
    return res.status(200).json({ ok: true });
  } catch (e) {
    // таймаут: скрипт запрос уже получил и продолжает работу, повтор от Telegram не нужен
    return res.status(e.name === 'AbortError' ? 200 : 500).json({ ok: e.name === 'AbortError' });
  } finally {
    clearTimeout(timer);
  }
};
