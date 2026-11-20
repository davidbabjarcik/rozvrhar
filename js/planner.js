// Planning logic: resolve "week 12" items to real slots, pick the best
// combination of exam terms, and lay out study days.
import { addDays, diffDays, isISO, parseTime, timeToMin, minToTime, weekday } from './dates.js';
import { classOccurrences, parseWhen, weekByNumber } from './weeks.js';

export const ITEM_KINDS = {
  test: { label: 'Test / písomka', icon: '📝', prep: 3, slot: ['C', 'L', 'S', 'P'] },
  zadanie: { label: 'Zadanie / projekt', icon: '💻', prep: 5, slot: ['C', 'L', 'S', 'P'] },
  prezentacia: { label: 'Prezentácia', icon: '🎤', prep: 2, slot: ['C', 'S', 'L', 'P'] },
  zapocet: { label: 'Zápočet', icon: '✅', prep: 2, slot: ['C', 'L', 'S', 'P'] },
  ine: { label: 'Iné', icon: '📌', prep: 0, slot: ['C', 'L', 'S', 'P'] },
};

export const CLASS_TYPES = {
  P: 'Prednáška', C: 'Cvičenie', L: 'Laboratórium', S: 'Seminár', '?': 'Iné',
};

/** Days of preparation needed for an exam (user value or derived from difficulty). */
export function examPrepDays(subject) {
  const v = Number(subject.prepDays);
  if (v > 0) return v;
  const d = Number(subject.difficulty) || 3;
  return [2, 3, 4, 6, 8][Math.max(1, Math.min(5, d)) - 1];
}

/**
 * Turn an item's "when" into a concrete slot.
 * Returns { ok, date, endDate?, start?, end?, allDay, approx, via, week?, reason? }
 */
export function resolveItem(item, subject, classes, sem) {
  const when = parseWhen(item.when, sem);
  if (!when) return { ok: false, reason: item.when ? 'Neviem prečítať termín' : 'Chýba termín' };
  const kind = ITEM_KINDS[item.kind] || ITEM_KINDS.ine;
  const ownTime = parseTime(item.time);
  const subjClasses = classes.filter((c) => c.subjectId === subject.id);
  const order = item.slot && item.slot !== 'auto' ? [item.slot] : kind.slot;
  const rank = (c) => {
    const i = order.indexOf(c.type);
    return i === -1 ? 99 : i;
  };

  if (when.kind === 'date') {
    if (ownTime) return slotResult(when.date, ownTime, addMinutes(ownTime, item.duration || 90), 'manual');
    // No time given: use the subject's class on that weekday if there is one.
    const wd = weekday(when.date);
    const same = subjClasses.filter((c) => Number(c.day) === wd).sort((a, b) => rank(a) - rank(b));
    if (same.length && rank(same[0]) < 99) return slotResult(when.date, same[0].start, same[0].end, 'class', same[0]);
    return { ok: true, date: when.date, allDay: true, approx: false, via: 'date' };
  }

  const candidates = [];
  for (const c of subjClasses) {
    if (rank(c) === 99) continue;
    for (const occ of classOccurrences(sem, c)) {
      if (occ.n >= when.from && occ.n <= when.to) candidates.push({ c, occ });
    }
  }
  candidates.sort((a, b) => rank(a.c) - rank(b.c) || a.occ.date.localeCompare(b.occ.date));
  // Prefer the best class type, but within that type the earliest date.
  if (candidates.length) {
    const bestRank = rank(candidates[0].c);
    const pick = candidates.filter((x) => rank(x.c) === bestRank)
      .sort((a, b) => a.occ.date.localeCompare(b.occ.date) || a.c.start.localeCompare(b.c.start))[0];
    const start = ownTime || pick.c.start;
    const end = ownTime ? addMinutes(ownTime, item.duration || 90) : pick.c.end;
    const r = slotResult(pick.occ.date, start, end, 'class', pick.c);
    r.week = pick.occ.n;
    r.approx = when.from !== when.to;
    return r;
  }
  const wFrom = weekByNumber(sem, when.from);
  const wTo = weekByNumber(sem, when.to);
  if (!wFrom || !wTo) return { ok: false, reason: `Semester nemá ${when.to}. týždeň` };
  return {
    ok: true, date: wFrom.monday, endDate: addDays(wTo.monday, 4), allDay: true, approx: true,
    via: 'week', week: when.from, reason: 'V tom týždni nemáš hodinu tohto predmetu – berie sa celý týždeň',
  };
}

function addMinutes(t, n) {
  return minToTime(timeToMin(t) + n);
}

function slotResult(date, start, end, via, cls) {
  return { ok: true, date, start, end, allDay: false, approx: false, via, classId: cls ? cls.id : null };
}

/* ------------------------------------------------------------------ */
/* Exam term optimisation                                              */
/* ------------------------------------------------------------------ */

const DEFAULTS = { retakeGap: 5, maxPlans: 3, blocked: [] };

/**
 * subjects: [{ id, name, difficulty, credits, wantRetake, prepDays, exams:[{id,date,time}], lockedExamId }]
 * Returns { plans: [{ score, choice:{subjectId: examId}, rows:[…] }], skipped:[subject], warnings:[] }
 */
export function planExams(subjects, sem, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const blocked = new Set(opts.blocked || []);
  const warnings = [];
  const active = [];
  const skipped = [];

  for (const s of subjects) {
    const terms = (s.exams || []).filter((e) => isISO(e.date) && !blocked.has(e.date));
    if (!terms.length) {
      if ((s.exams || []).length) warnings.push(`${s.name}: všetky termíny sú v dňoch, keď nemôžeš.`);
      skipped.push(s);
      continue;
    }
    let options2 = terms.slice().sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
    // Retake-only terms ("1. opravný termín") count as a safety net, not as a first attempt.
    const regular = options2.filter((e) => !e.retakeOnly);
    if (regular.length) options2 = regular;
    if (s.lockedExamId) {
      const locked = options2.find((e) => e.id === s.lockedExamId);
      if (locked) options2 = [locked];
    }
    active.push({ s, terms: options2, all: terms });
  }
  if (!active.length) return { plans: [], skipped, warnings };

  const allDates = active.flatMap((a) => a.terms.map((t) => t.date)).sort();
  const baseline = isISO(sem.examStart) ? addDays(sem.examStart, -3) : addDays(allDates[0], -7);
  const periodEnd = isISO(sem.examEnd) ? sem.examEnd : allDates[allDates.length - 1];
  const periodLen = Math.max(7, diffDays(baseline, periodEnd));

  // Search order: most constrained subject first.
  active.sort((a, b) => a.terms.length - b.terms.length);
  const combos = active.reduce((p, a) => p * a.terms.length, 1);

  const scored = [];
  const keep = (choiceArr) => {
    const res = scoreChoice(active, choiceArr, baseline, periodLen, opts);
    if (!res) return;
    scored.push(res);
    if (scored.length > 400) {
      scored.sort((a, b) => b.score - a.score);
      scored.length = 60;
    }
  };

  if (combos <= 250000) {
    const pick = new Array(active.length);
    const used = new Set();
    const rec = (i) => {
      if (i === active.length) { keep(pick.slice()); return; }
      for (const t of active[i].terms) {
        if (used.has(t.date)) continue; // never two exams on the same day
        used.add(t.date);
        pick[i] = t;
        rec(i + 1);
        used.delete(t.date);
      }
    };
    rec(0);
  } else {
    // Too many combinations: beam search over subjects.
    let beam = [[]];
    for (let i = 0; i < active.length; i++) {
      const next = [];
      for (const partial of beam) {
        const used = new Set(partial.map((t) => t.date));
        for (const t of active[i].terms) if (!used.has(t.date)) next.push([...partial, t]);
      }
      next.sort((a, b) => partialScore(active, b, baseline) - partialScore(active, a, baseline));
      beam = next.slice(0, 300);
    }
    beam.forEach(keep);
  }

  if (!scored.length) {
    warnings.push('Nedá sa nájsť kombinácia bez dvoch skúšok v ten istý deň – pridaj viac termínov.');
    return { plans: [], skipped, warnings };
  }
  scored.sort((a, b) => b.score - a.score);
  const plans = [];
  const seen = new Set();
  for (const p of scored) {
    const key = Object.values(p.choice).sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    plans.push(p);
    if (plans.length >= opts.maxPlans) break;
  }
  return { plans, skipped, warnings };
}

function weightOf(s) {
  const d = Number(s.difficulty) || 3;
  const c = Number(s.credits) || 5;
  return d / 3 + c / 6;
}

function partialScore(active, picks, baseline) {
  const items = picks.map((t, i) => ({ t, s: active[i].s })).sort((a, b) => a.t.date.localeCompare(b.t.date));
  let prev = baseline;
  let sum = 0;
  for (const it of items) {
    sum += Math.min(diffDays(prev, it.t.date) / examPrepDays(it.s), 1.5) * weightOf(it.s);
    prev = it.t.date;
  }
  return sum;
}

function scoreChoice(active, picks, baseline, periodLen, opts) {
  const rows = picks.map((t, i) => ({ subject: active[i].s, exam: t, all: active[i].all }))
    .sort((a, b) => a.exam.date.localeCompare(b.exam.date) || (a.exam.time || '').localeCompare(b.exam.time || ''));
  let prev = baseline;
  let minRatio = Infinity;
  let wSum = 0;
  let ratioSum = 0;
  let retakeSum = 0;
  let lateSum = 0;
  for (const r of rows) {
    const need = examPrepDays(r.subject);
    const gap = Math.max(0, diffDays(prev, r.exam.date) - (prev === baseline ? 0 : 1));
    const ratio = Math.min(gap / need, 1.5);
    const w = weightOf(r.subject);
    const retake = r.all
      .filter((e) => diffDays(r.exam.date, e.date) >= opts.retakeGap)
      .sort((a, b) => a.date.localeCompare(b.date))[0] || null;
    r.gapDays = gap;
    r.needDays = need;
    r.ratio = ratio;
    r.retake = retake;
    minRatio = Math.min(minRatio, ratio);
    ratioSum += ratio * w;
    wSum += w;
    if (r.subject.wantRetake !== false) retakeSum += (retake ? 1 : 0) * w;
    else retakeSum += w;
    lateSum += diffDays(baseline, r.exam.date) / periodLen;
    prev = r.exam.date;
  }
  const score =
    2.0 * Math.min(minRatio, 1.2) +
    1.0 * (ratioSum / wSum) +
    0.8 * (retakeSum / wSum) -
    0.15 * (lateSum / rows.length);
  const choice = {};
  rows.forEach((r) => { choice[r.subject.id] = r.exam.id; });
  return { score: Math.round(score * 1000) / 1000, choice, rows };
}

/** Plain-language verdict for one exam row. */
export function rowVerdict(r) {
  const parts = [];
  if (r.ratio >= 1) parts.push(`✅ ${r.gapDays} dní na prípravu (potrebuješ ~${r.needDays})`);
  else if (r.ratio >= 0.6) parts.push(`⚠️ len ${r.gapDays} dní na prípravu (ideál ~${r.needDays})`);
  else parts.push(`🔥 iba ${r.gapDays} dní na prípravu (ideál ~${r.needDays})`);
  if (r.retake) parts.push(`opravný termín: ${r.retake.date}`);
  else if (r.subject.wantRetake !== false) parts.push('bez opravného termínu po ňom');
  return parts;
}

/* ------------------------------------------------------------------ */
/* Study plan                                                          */
/* ------------------------------------------------------------------ */

/**
 * Lay out study days before each chosen exam, never on another exam day,
 * and never before the previous exam (you study for one thing at a time).
 */
export function studyPlan(rows, sem) {
  const examDays = new Set(rows.map((r) => r.exam.date));
  const sorted = rows.slice().sort((a, b) => a.exam.date.localeCompare(b.exam.date));
  const tasks = [];
  let floor = isISO(sem.examStart) ? addDays(sem.examStart, -7) : addDays(sorted[0]?.exam.date || '2000-01-01', -10);
  for (const r of sorted) {
    const need = r.needDays || examPrepDays(r.subject);
    const days = [];
    let d = addDays(r.exam.date, -1);
    while (days.length < need && diffDays(floor, d) >= 0) {
      if (!examDays.has(d)) days.unshift(d);
      d = addDays(d, -1);
    }
    days.forEach((date, i) => {
      const last = i === days.length - 1;
      tasks.push({
        subjectId: r.subject.id,
        date,
        title: last ? `Opakovanie: ${r.subject.name}` : `Učenie: ${r.subject.name} (${i + 1}/${days.length - 1})`,
        kind: 'study',
      });
    });
    floor = addDays(r.exam.date, 1);
  }
  return tasks;
}
