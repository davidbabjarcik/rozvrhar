// Date helpers. Calendar dates are kept as 'YYYY-MM-DD' strings and all
// arithmetic is done in UTC so daylight-saving changes never shift a day.

export const TZ = 'Europe/Bratislava';

export const DAY_NAMES = ['Pondelok', 'Utorok', 'Streda', 'Štvrtok', 'Piatok', 'Sobota', 'Nedeľa'];
export const DAY_SHORT = ['Po', 'Ut', 'St', 'Št', 'Pi', 'So', 'Ne'];

const pad = (n) => String(n).padStart(2, '0');

export function toDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function fromDate(dt) {
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function isISO(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(toDate(s).getTime());
}

export function addDays(iso, n) {
  const dt = toDate(iso);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fromDate(dt);
}

/** Whole days from a to b (b - a). */
export function diffDays(a, b) {
  return Math.round((toDate(b) - toDate(a)) / 86400000);
}

/** 0 = Monday … 6 = Sunday */
export function weekday(iso) {
  return (toDate(iso).getUTCDay() + 6) % 7;
}

export function mondayOf(iso) {
  return addDays(iso, -weekday(iso));
}

export function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function fmtDate(iso, withYear = true) {
  if (!isISO(iso)) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return withYear ? `${d}.${m}.${y}` : `${d}.${m}.`;
}

export function fmtDay(iso) {
  return `${DAY_SHORT[weekday(iso)]} ${fmtDate(iso)}`;
}

/**
 * Parse a user-typed date: '12.12.2026', '12. 12. 2026', '12.12.' (year guessed
 * from refISO so the date lands on or after it), or '2026-12-12'.
 */
export function parseUserDate(input, refISO) {
  if (!input) return null;
  const s = String(input).trim();
  if (isISO(s)) return s;
  const m = s.match(/^(\d{1,2})\s*\.\s*(\d{1,2})\s*\.?\s*(\d{4})?$/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  let y = m[3] ? Number(m[3]) : null;
  if (!y) {
    const ref = refISO && isISO(refISO) ? refISO : todayISO();
    y = Number(ref.slice(0, 4));
    const cand = `${y}-${pad(mo)}-${pad(d)}`;
    if (diffDays(ref, cand) < -60) y += 1;
  }
  const iso = `${y}-${pad(mo)}-${pad(d)}`;
  return fromDate(toDate(iso)) === iso ? iso : null;
}

/** 'H:MM' / 'HH.MM' / 'HHMM' → 'HH:MM' or null */
export function parseTime(input) {
  if (!input) return null;
  const m = String(input).trim().match(/^(\d{1,2})(?:[:.h]?(\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = m[2] ? Number(m[2]) : 0;
  if (h > 23 || mi > 59) return null;
  return `${pad(h)}:${pad(mi)}`;
}

export function timeToMin(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export function minToTime(min) {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)));
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

export function addMinutes(t, n) {
  return minToTime(timeToMin(t) + n);
}

/** UTC offset (minutes) of the given time zone at a local wall-clock moment. */
export function tzOffsetMinutes(iso, time = '12:00', tz = TZ) {
  const [y, mo, d] = iso.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(guess));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
  return Math.round((asUTC - guess) / 60000);
}

/** '2026-12-10', '10:00' → '2026-12-10T10:00:00+0100' (wall clock in TZ) */
export function toOffsetString(iso, time = '00:00', tz = TZ) {
  const off = tzOffsetMinutes(iso, time, tz);
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${iso}T${time}:00${sign}${pad(Math.floor(a / 60))}${pad(a % 60)}`;
}

/** Easter Sunday (Gregorian, anonymous algorithm). */
export function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Slovak public holidays (days off) for a year. The list can change by law, so the UI lets the user edit it. */
export function skHolidays(year) {
  const easter = easterSunday(year);
  const fixed = [
    ['01-01', 'Deň vzniku SR'], ['01-06', 'Zjavenie Pána'], ['05-01', 'Sviatok práce'],
    ['05-08', 'Deň víťazstva nad fašizmom'], ['07-05', 'Sv. Cyril a Metod'], ['08-29', 'Výročie SNP'],
    ['09-15', 'Sedembolestná Panna Mária'], ['11-01', 'Sviatok všetkých svätých'],
    ['11-17', 'Deň boja za slobodu a demokraciu'], ['12-24', 'Štedrý deň'], ['12-25', 'Prvý sviatok vianočný'],
    ['12-26', 'Druhý sviatok vianočný'],
  ].map(([md, name]) => ({ date: `${year}-${md}`, name }));
  return [
    ...fixed,
    { date: addDays(easter, -2), name: 'Veľký piatok' },
    { date: addDays(easter, 1), name: 'Veľkonočný pondelok' },
  ].sort((a, b) => a.date.localeCompare(b.date));
}
