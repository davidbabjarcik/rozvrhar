// Semester week arithmetic: "12. týždeň" → real dates.
import { addDays, diffDays, isISO, mondayOf, parseUserDate, weekday } from './dates.js';

/**
 * sem = { start, weeks, skipWeeks: [mondayISO], holidays: [{date,name}], examStart, examEnd }
 * Returns teaching weeks [{ n, monday, sunday }]. Calendar weeks listed in
 * skipWeeks (e.g. a dean's break) are not counted.
 */
export function teachingWeeks(sem) {
  if (!sem || !isISO(sem.start)) return [];
  const total = Math.max(1, Math.min(30, Number(sem.weeks) || 13));
  const skip = new Set((sem.skipWeeks || []).map(mondayOf));
  const out = [];
  let monday = mondayOf(sem.start);
  let guard = 0;
  while (out.length < total && guard++ < 80) {
    if (!skip.has(monday)) out.push({ n: out.length + 1, monday, sunday: addDays(monday, 6) });
    monday = addDays(monday, 7);
  }
  return out;
}

export function weekByNumber(sem, n) {
  return teachingWeeks(sem).find((w) => w.n === n) || null;
}

/** Teaching week number of a date, or null (before/after semester, or a skipped week). */
export function weekOf(sem, iso) {
  const m = mondayOf(iso);
  const w = teachingWeeks(sem).find((x) => x.monday === m);
  return w ? w.n : null;
}

export function dateInWeek(sem, n, day) {
  const w = weekByNumber(sem, n);
  return w ? addDays(w.monday, day) : null;
}

export function holidaySet(sem) {
  return new Set((sem.holidays || []).map((h) => (typeof h === 'string' ? h : h.date)));
}

export function holidayName(sem, iso) {
  const h = (sem.holidays || []).find((x) => (typeof x === 'string' ? x : x.date) === iso);
  return h ? (typeof h === 'string' ? 'voľno' : h.name || 'voľno') : null;
}

/**
 * Parse when something happens, as typed by the user or copied from a syllabus:
 *   '12', '12.', '12. týždeň', 'T12', 'týž. 12'      → week 12
 *   '12-13', '12./13.', '12. – 13. týždeň'          → weeks 12…13
 *   '12.12.2026', '12.12.', '2026-12-12'             → date
 */
export function parseWhen(input, sem) {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;

  const ref = sem && isISO(sem.start) ? sem.start : undefined;
  const date = parseUserDate(s, ref);
  if (date) return { kind: 'date', date };

  const cleaned = s
    .replace(/t[ýy]ž(deň|den|dni|dne)?\.?/g, ' ')
    .replace(/week|wk|týd(en|ne)?\.?|tyz\.?/g, ' ')
    .replace(/^t\s*(?=\d)/, ' ')
    .trim();
  const range = cleaned.match(/^(\d{1,2})\s*\.?\s*(?:-|–|—|\/|až|az)\s*(\d{1,2})\s*\.?$/);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (a >= 1 && b >= a && b <= 30) return { kind: 'week', from: a, to: b };
  }
  const single = cleaned.match(/^(\d{1,2})\s*\.?$/);
  if (single) {
    const n = Number(single[1]);
    if (n >= 1 && n <= 30) return { kind: 'week', from: n, to: n };
  }
  return null;
}

/** Human description of a parsed "when". */
export function describeWhen(when) {
  if (!when) return '';
  if (when.kind === 'date') return when.date;
  return when.from === when.to ? `${when.from}. týždeň` : `${when.from}.–${when.to}. týždeň`;
}

/**
 * All teaching-day dates of a weekly class, honoring parity / explicit week
 * lists and skipping holidays.
 * cls = { day: 0-6, parity: 'all'|'odd'|'even', weeks: '1-6,8' }
 */
export function classOccurrences(sem, cls) {
  const hol = holidaySet(sem);
  const allowed = parseWeekList(cls.weeks);
  const out = [];
  for (const w of teachingWeeks(sem)) {
    if (cls.parity === 'odd' && w.n % 2 === 0) continue;
    if (cls.parity === 'even' && w.n % 2 === 1) continue;
    if (allowed && !allowed.has(w.n)) continue;
    const date = addDays(w.monday, Number(cls.day) || 0);
    if (hol.has(date)) continue;
    out.push({ n: w.n, date });
  }
  return out;
}

/** '1-6, 8, 10-12' → Set of week numbers; empty → null (all weeks). */
export function parseWeekList(spec) {
  if (!spec || !String(spec).trim()) return null;
  const set = new Set();
  for (const part of String(spec).split(/[,;\s]+/)) {
    const m = part.match(/^(\d{1,2})\.?(?:[-–](\d{1,2})\.?)?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let i = a; i <= b && i <= 30; i++) set.add(i);
  }
  return set.size ? set : null;
}

/** Current teaching week info for a date (default today). */
export function weekStatus(sem, iso) {
  const weeks = teachingWeeks(sem);
  if (!weeks.length) return null;
  const n = weekOf(sem, iso);
  if (n) return { kind: 'teaching', n };
  if (diffDays(iso, weeks[0].monday) > 0) return { kind: 'before', days: diffDays(iso, weeks[0].monday) };
  if (sem.examStart && isISO(sem.examStart) && diffDays(sem.examStart, iso) >= 0 &&
      (!sem.examEnd || diffDays(iso, sem.examEnd) >= 0)) return { kind: 'exams' };
  if (diffDays(weeks[weeks.length - 1].sunday, iso) > 0) return { kind: 'after' };
  return { kind: 'break' };
}

export { weekday };
