// Расписание работы сервера: в какие дни и часы он должен быть включён.
// Окно может переходить через полночь (например, 20:00–02:00).

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULTS = { enabled: false, from: '18:00', to: '23:00', days: [true, true, true, true, true, true, true] };

const minutes = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

/** Проверить и привести настройки расписания к виду { enabled, from, to, days[7] } (дни — с понедельника). */
function clean(input, cur = DEFAULTS) {
  const p = { ...cur, ...(input || {}) };
  const from = String(p.from);
  const to = String(p.to);
  if (!TIME_RE.test(from) || !TIME_RE.test(to)) throw new Error('Время расписания — в формате ЧЧ:ММ');
  if (from === to) throw new Error('Время включения и выключения совпадает');
  const days = Array.isArray(p.days) && p.days.length === 7 ? p.days.map(Boolean) : DEFAULTS.days.slice();
  if (p.enabled && !days.some(Boolean)) throw new Error('Отметьте хотя бы один день');
  return { enabled: !!p.enabled, from, to, days };
}

/** Должен ли сервер работать в момент d. */
function inWindow(p, d = new Date()) {
  if (!p || !p.enabled) return false;
  const now = d.getHours() * 60 + d.getMinutes();
  const f = minutes(p.from);
  const t = minutes(p.to);
  const dow = (d.getDay() + 6) % 7; // 0 — понедельник
  const prev = (dow + 6) % 7;
  if (f < t) return !!p.days[dow] && now >= f && now < t;
  // Через полночь: вечер «сегодняшнего» окна или ночное продолжение вчерашнего.
  return (!!p.days[dow] && now >= f) || (!!p.days[prev] && now < t);
}

const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/** Коротко для подсказки: «Пн–Пт, 18:00–23:00». */
function describe(p) {
  if (!p.enabled) return 'выключено';
  const on = p.days.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  let days;
  if (on.length === 7) days = 'каждый день';
  else if (on.length > 2 && on[on.length - 1] - on[0] === on.length - 1) days = `${DAY_NAMES[on[0]]}–${DAY_NAMES[on[on.length - 1]]}`;
  else days = on.map((i) => DAY_NAMES[i]).join(', ');
  return `${days}, ${p.from}–${p.to}`;
}

module.exports = { DEFAULTS, clean, inWindow, describe };
