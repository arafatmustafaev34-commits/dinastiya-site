// =====================================================================
// api/gas.js — защитный шлюз между сайтом и Google Apps Script.
//
// Зачем: Apps Script не видит IP посетителя, поэтому сам ограничить флуд не может.
// Теперь сайт ходит сюда (/api/gas), а этот шлюз:
//   1) считает запросы с каждого IP и отвечает 429, если их слишком много (rate limit);
//   2) отсекает слишком большие и кривые запросы, чужие сайты (Origin);
//   3) кэширует меню на CDN Vercel, чтобы тысячи открытий сайта не будили Google;
//   4) подписывает настоящие заказы ключом PROXY_KEY — без него Google заказ не примет.
//
// Переменные окружения в Vercel (Settings → Environment Variables):
//   APPS_SCRIPT_URL  — ссылка /exec (уже есть для api/tg.js)
//   PROXY_KEY        — НОВАЯ: длинная случайная строка, та же, что PROXY_KEY в Google-скрипте
//   (необязательно) UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN — общий счётчик на всех серверах.
//       Без них счётчик живёт в памяти каждого сервера Vercel: от одного флудера защищает,
//       но если Vercel запустит несколько копий функции, лимит у каждой свой.
// =====================================================================

// ---------- НАСТРОЙКИ ЛИМИТОВ (меняйте числа здесь) ----------
const LIMITS = {
  // ВАЖНО: гости в зале сидят на одном Wi-Fi кофейни, а у мобильных операторов один IP бывает у многих абонентов.
  // Поэтому лимиты по IP щедрые, а главный фильтр заказов — лимит на номер телефона в Google-скрипте (ORDER_LIMITS)
  order:    { max: 15,  window: 600 },  // заказов с одного IP за 10 минут
  feedback: { max: 30,  window: 600 },  // оценок с одного IP за 10 минут
  status:   { max: 300, window: 60 },   // опросов «готов ли заказ» в минуту: один гость спрашивает ~8 раз в минуту, 20 гостей на Wi-Fi ≈ 160
  menu:     { max: 120, window: 60 }    // загрузок меню в минуту (обычно отдаётся из кэша CDN и сюда даже не доходит)
};
const MAX_BODY = 8 * 1024;             // заказ весит ~1 КБ; всё, что больше 8 КБ, — мусор
const UPSTREAM_TIMEOUT = 9000;         // сколько ждём Google (мс). Повтор заказа после таймаута не задублирует его (см. rid)
const MENU_CACHE = 'public, s-maxage=20, stale-while-revalidate=60';   // меню кэшируется на CDN 20 сек
const STATUS_CACHE = 'public, s-maxage=4';

// ---------- Счётчик запросов ----------
const mem = new Map();                 // запасной счётчик в памяти: ключ → { n, reset }
function memHit(key, w) {
  const now = Date.now();
  let r = mem.get(key);
  if (!r || r.reset <= now) { r = { n: 0, reset: now + w * 1000 }; mem.set(key, r); }
  r.n++;
  if (mem.size > 5000) for (const [k, v] of mem) if (v.reset <= now) mem.delete(k);   // чистим просроченные
  return { n: r.n, ttl: Math.ceil((r.reset - now) / 1000) };
}
async function redisHit(key, w) {      // общий счётчик в Upstash Redis (если подключён)
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 1500);
  try {
    const r = await fetch(url.replace(/\/$/, '') + '/pipeline', {
      method: 'POST', signal: ctl.signal,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', key, '0', 'EX', String(w), 'NX'], ['INCR', key], ['TTL', key]])
    });
    const j = await r.json();
    return { n: Number(j[1].result), ttl: Math.max(1, Number(j[2].result)) };
  } catch (e) { return null; } finally { clearTimeout(t); }
}
async function limit(kind, ip) {
  const L = LIMITS[kind], key = 'rl:' + kind + ':' + ip;
  const hit = (await redisHit(key, L.window)) || memHit(key, L.window);   // Redis недоступен → память
  return { ok: hit.n <= L.max, left: Math.max(0, L.max - hit.n), ttl: hit.ttl, max: L.max };
}

// ---------- Вспомогательное ----------
const clientIp = req =>
  String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || (req.socket && req.socket.remoteAddress) || 'unknown').trim();

function send(res, code, obj, cache) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache || 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(code).send(JSON.stringify(obj));
}

async function readBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return JSON.stringify(req.body);
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > MAX_BODY) return null; chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}

async function upstream(url, init) {   // запрос в Google с таймаутом. Google отвечает редиректом — fetch проходит его сам
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal, redirect: 'follow' });
    const text = await r.text();
    return JSON.parse(text);
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : 'upstream' };
  } finally { clearTimeout(t); }
}

// ---------- Обработчик ----------
module.exports = async (req, res) => {
  const GAS = process.env.APPS_SCRIPT_URL, KEY = process.env.PROXY_KEY || '';
  if (!GAS) return send(res, 500, { ok: false, error: 'config' });
  const ip = clientIp(req);

  // Запросы с чужих сайтов отсекаем (браузер всегда шлёт Origin при POST)
  const origin = req.headers.origin;
  if (req.method === 'POST' && origin) {
    let host = ''; try { host = new URL(origin).host; } catch (e) {}
    if (host !== req.headers.host) return send(res, 403, { ok: false, error: 'origin' });
  }

  // ----- GET: меню или статус заказа -----
  if (req.method === 'GET') {
    const q = req.query || {};
    if (q.menu) {
      const rl = await limit('menu', ip);
      if (!rl.ok) { res.setHeader('Retry-After', rl.ttl); return send(res, 429, { ok: false, error: 'rate' }); }
      const j = await upstream(GAS + '?menu=1', { method: 'GET' });
      return send(res, 200, j, j.ok ? MENU_CACHE : 'no-store');
    }
    if (q.n) {
      if (!/^\d{1,7}$/.test(String(q.n))) return send(res, 400, { ok: false, error: 'bad' });
      const rl = await limit('status', ip);
      if (!rl.ok) { res.setHeader('Retry-After', rl.ttl); return send(res, 429, { ok: false, error: 'rate' }); }
      const j = await upstream(GAS + '?n=' + q.n, { method: 'GET' });
      return send(res, 200, j, j.ok ? STATUS_CACHE : 'no-store');
    }
    return send(res, 400, { ok: false, error: 'bad' });
  }

  // ----- POST: заказ или оценка -----
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return send(res, 405, { ok: false, error: 'method' }); }
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) return send(res, 413, { ok: false, error: 'big' });
  const raw = await readBody(req);
  if (raw === null || raw.length > MAX_BODY) return send(res, 413, { ok: false, error: 'big' });
  let d; try { d = JSON.parse(raw); } catch (e) { return send(res, 400, { ok: false, error: 'bad' }); }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return send(res, 400, { ok: false, error: 'bad' });

  const kind = d.type === 'feedback' ? 'feedback' : d.type === 'order' ? 'order' : null;
  if (!kind) return send(res, 400, { ok: false, error: 'bad' });     // сюда нельзя подсунуть «сообщение от Telegram»

  const rl = await limit(kind, ip);
  res.setHeader('X-RateLimit-Limit', rl.max); res.setHeader('X-RateLimit-Remaining', rl.left);
  if (!rl.ok) { res.setHeader('Retry-After', rl.ttl); return send(res, 429, { ok: false, error: 'rate', retry: rl.ttl }); }

  delete d.update_id;
  d.key = KEY;                          // подпись: Google поверит, что заказ прошёл через шлюз
  const j = await upstream(GAS, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(d) });
  return send(res, 200, j);
};
