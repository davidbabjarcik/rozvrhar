// Reads "everything else" a student gets as PDF: the faculty's academic
// calendar (semester dates) and course documents (syllabus, conditions for
// credit) with tests and deadlines given as week numbers.
import { addDays, diffDays, isISO, mondayOf } from './dates.js';

const D = String.raw`(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})`;
const RANGE = new RegExp(`${D}\\s*(?:-|–|—|až|do)\\s*${D}`);
const DATE = new RegExp(D, 'g');

const iso = (d, m, y) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export function fold(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/* ---------------------------- academic calendar --------------------------- */

function rangeAfter(text, labelRe) {
  const m = labelRe.exec(text);
  if (!m) return null;
  const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 220);
  const r = tail.match(RANGE);
  if (!r) return null;
  const a = iso(r[1], r[2], r[3]);
  const b = iso(r[4], r[5], r[6]);
  return isISO(a) && isISO(b) && a <= b ? { from: a, to: b } : null;
}

/**
 * Semester dates from a faculty timetable of the academic year
 * ("Výučba v ZS 21.09.2026 – 18.12.2026, Skúškové obdobie v ZS …").
 */
export function parseAcademicCalendar(text) {
  const t = String(text).replace(/\s+/g, ' ');
  const f = fold(t);
  if (!/vyucba|vyuka|vyucovanie/.test(f) || !/skuskov/.test(f)) return null;
  const zs = rangeAfter(t, /V[ýy]u[čc]ba\s+v\s+(?:ZS|zimnom)\S*/i);
  const zsEx = rangeAfter(t, /Sk[úu][šs]kov[ée]\s+obdobie\s+v\s+(?:ZS|zimnom)\S*/i);
  const ls = rangeAfter(t, /V[ýy]u[čc]ba\s+v\s+(?:LS|letnom)\S*/i);
  const lsEx = rangeAfter(t, /Sk[úu][šs]kov[ée]\s+obdobie\s+v\s+(?:LS|letnom)\S*/i);
  if (!zs && !ls) return null;

  // Days off: "Dni pracovného pokoja: 26.03.2027 …", "rektorské/dekanské voľno …"
  const holidays = [];
  const offRe = /(Dni\s+pracovn[ée]ho\s+pokoja|[Rr]ektorsk\S*\s+vo[ľl]n\S*|[Dd]ekansk\S*\s+vo[ľl]n\S*|[Šš]portov\S*\s+de[ňn])/g;
  for (const m of t.matchAll(offRe)) {
    const tail = t.slice(m.index + m[0].length, m.index + m[0].length + 160);
    const stop = tail.search(/\d\s+[A-ZÁ-Ž][a-zá-ž]{3,}\s+[a-zá-ž]/); // next sentence / footnote
    const chunk = stop > 0 ? tail.slice(0, stop + 1) : tail;
    const name = /pokoja/i.test(m[0]) ? 'Deň pracovného pokoja' : m[0].trim();
    const r = chunk.match(RANGE);
    if (r) {
      let d = iso(r[1], r[2], r[3]);
      const end = iso(r[4], r[5], r[6]);
      for (let k = 0; d <= end && k < 21; k++, d = addDays(d, 1)) holidays.push({ date: d, name });
      continue;
    }
    for (const x of chunk.matchAll(DATE)) {
      const d = iso(x[1], x[2], x[3]);
      if (isISO(d)) holidays.push({ date: d, name });
    }
  }
  const sem = (teach, exams, label) => teach && {
    label,
    start: mondayOf(teach.from),
    weeks: Math.max(1, Math.round((diffDays(mondayOf(teach.from), teach.to) + 3) / 7)),
    examStart: exams?.from || '',
    examEnd: exams?.to || '',
    teachEnd: teach.to,
  };
  const year = (zs || ls).from.slice(0, 4);
  const y0 = zs ? Number(year) : Number(year) - 1;
  return {
    zs: sem(zs, zsEx, `ZS ${y0}/${String(y0 + 1).slice(2)}`),
    ls: sem(ls, lsEx, `LS ${y0}/${String(y0 + 1).slice(2)}`),
    holidays: dedupeBy(holidays, (h) => h.date),
  };
}

/** Which semester of the calendar is the one to plan now. */
export function pickSemester(cal, today) {
  if (cal.zs && (!cal.ls || today <= (cal.zs.examEnd || cal.zs.teachEnd))) return cal.zs;
  return cal.ls || cal.zs;
}

/* ------------------------- course docs / syllabus ------------------------- */

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5 };

const KINDS = [
  // [kind, regex on folded text]
  ['test', /zapoctov(?:ka|y\s+test|a\s+pisomka|a\s+praca)|priebezn\S*\s+test|(?:^|[\s(])(?:\d\.\s*)?test(?:y|u)?(?=[\s.,;:)]|$)|pisomk|pisomn\S*\s+(?:test|praca|previerk)|previerk|midterm|kviz|quiz|kontroln\S*\s+(?:praca|test)/],
  ['prezentacia', /prezentaci|obhajob/],
  ['zadanie', /odovzd|deadline|(?:^|\s)zadani[ea]\s+\S|projekt|semestraln\S*\s+prac|referat/],
  ['zapocet', /(?:^|[\s,;])zapocet(?=[\s.,;:]|$)|udelenie\s+zapoctu/],
];
const SKIP = /oprav|nahradn|bleskov|pretest|formativ|konzultac|zverejnen|preberan|priebezn\S*\s+kontrol|hodnoten|bodov|max\.?\s*\d|bonus/;

function weekSpec(seg) {
  const f = fold(seg);
  let m = f.match(/(\d{1,2})\s*\.?\s*(?:alebo|resp\.?|ci|\/|-|–|az|a)\s*(\d{1,2})\s*\.?\s*(?:tyzd|tyz\b|tyzn|t\.)/);
  if (m) return { from: +m[1], to: +m[2], text: m[0] };
  m = f.match(/(\d{1,2})\s*\.\s*(?:tyzd|tyzn|vyucbov\S*\s+tyzd|tyz\b|t\.)/);
  if (m) return { from: +m[1], to: +m[1], text: m[0] };
  m = f.match(/(?:tyzden|tyzdni|tyzdna|tyzd\.|week)\s*(?:c\.)?\s*(\d{1,2})(?:\s*(?:-|–|alebo|resp\.?)\s*(\d{1,2}))?/);
  if (m) return { from: +m[1], to: +(m[2] || m[1]), text: m[0] };
  return null;
}

function dateSpec(seg) {
  const m = seg.match(/(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})?/);
  if (!m) return null;
  return `${+m[1]}.${+m[2]}.${m[3] || ''}`;
}

const WORD_ORD = { prv: 1, druh: 2, tret: 3, stvrt: 4, piat: 5 };

function ordinal(f) {
  const r = f.match(/(?:test|zapoctovka|pisomka|previerka|praca)\s*(i{1,3}|iv)\b/);
  if (r && ROMAN[r[1]]) return ROMAN[r[1]];
  const w = f.match(/(?:^|[\s•*-])(prv|druh|tret|stvrt|piat)[aiyeu]\S*\s+(?:\S+\s+)?(?:zapoct|test|pisom|previer|kontrol)/);
  if (w) return WORD_ORD[w[1]];
  const a = f.match(/(?:^|\s)(\d)\.\s*(?:zapoct|test|pisom|previer|kontrol)|(?:test|zapoctovka|pisomka|previerka)\s*(?:c\.)?\s*(\d)\b/);
  return a ? Number(a[1] || a[2]) : 0;
}

function cleanTitle(seg, spec) {
  let s = seg;
  if (spec) {
    // Drop the "(6. alebo 7. týždni semestra)" part.
    const f = fold(s);
    const i = f.indexOf(spec.text.trim().split(' ')[0]);
    if (i > 0) s = s.slice(0, i);
  }
  s = s.replace(/^.*?\)\s*\d*\s+(?=[A-ZÁ-Ž])/, '').replace(/^[\s•●▪◦\-–—*·]+/, '').replace(/^\d{1,2}\.\s+(?=\D)/, '')
    .replace(/[\s(–—:-]+$/, '').replace(/\s+v$/i, '').replace(/\s+/g, ' ').trim();
  if (s.length > 48) s = s.slice(0, 46).replace(/\s\S*$/, '') + '…';
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

function itemKey(kind, f, title) {
  if (kind === 'zadanie') {
    const caps = title.match(/\b([A-Z][A-Z0-9_-]{2,})\b/);
    return `zadanie:${caps ? caps[1].toLowerCase() : fold(title).replace(/odovzdan\S*|zadani\S*|ukoncen\S*|[^a-z0-9]/g, '')}`;
  }
  if (kind === 'zapocet') return 'zapocet';
  return `${kind}:${ordinal(f) || fold(title).replace(/[^a-z0-9]/g, '')}`;
}

/**
 * Finds tests, deadlines and the credit date in a course document.
 * `lines` are the document's text lines in reading order.
 */
export function parseCourseDoc(lines) {
  const found = new Map();
  const add = (kind, seg, spec, source) => {
    const f = fold(seg);
    const title = cleanTitle(seg, spec) || { test: 'Test', zadanie: 'Odovzdanie zadania', zapocet: 'Zápočet', prezentacia: 'Prezentácia' }[kind];
    const when = spec.from === spec.to ? String(spec.from) : `${spec.from}-${spec.to}`;
    const key = itemKey(kind, f, title);
    const prev = found.get(key);
    if (!prev) { found.set(key, { kind, title, when, source, from: spec.from, to: spec.to, ord: kind === 'test' ? ordinal(f) : 0 }); return; }
    // A schedule table names one exact week inside an earlier "6. or 7. week".
    if (prev.from !== prev.to && spec.from === spec.to && spec.from >= prev.from && spec.from <= prev.to) {
      prev.note = `podľa podmienok ${prev.when.replace('-', '. alebo ')}. týždeň`;
      prev.when = when; prev.from = spec.from; prev.to = spec.to;
    }
  };
  // Retake chances: "oprava Zápočtovka I." (week 11), "1. opravná písomka 13. týždeň",
  // "2. opravná písomka 1. týždeň skúškového obdobia".
  const retakes = [];
  const noteRetake = (seg, spec) => {
    const f = fold(seg);
    if (!/oprav|nahradn/.test(f) || !/zapoctov|test|pisom|previer|kontroln/.test(f)) return;
    const m = f.match(/oprav\S*\s+(?:zapoctov\S*\s+)?(?:test|zapoctovk\S*|pisomk\S*|previerk\S*)\s+(?:c\.\s*)?(i{1,3}|iv|\d)\b(?!\s*\.?\s*tyz)/);
    retakes.push({ ord: m ? (ROMAN[m[1]] || Number(m[1])) : 0, week: spec.from, examPeriod: /skuskov/.test(f) });
  };
  const classify = (seg) => {
    const f = fold(seg);
    if (SKIP.test(f)) return null;
    for (const [kind, re] of KINDS) if (re.test(f)) return kind;
    return null;
  };

  // 1) Sentences that carry their own week ("Zápočtový test I. (6. alebo 7. týždni)").
  for (const line of lines) {
    for (const seg of line.split(/;|,(?![^(]*\))/)) {
      const spec = weekSpec(seg);
      if (!spec || spec.from < 1 || spec.to > 16) continue;
      noteRetake(seg, spec);
      const kind = classify(seg);
      if (kind) add(kind, seg, spec, 'text');
    }
  }

  // 2) A week-by-week schedule: lines starting "1.", "2.", … in order.
  const starts = lines.map((l, i) => ({ i, n: (l.match(/^\s*(\d{1,2})\s*\.(?:\s|$)/) || [])[1] })).filter((x) => x.n);
  let best = [];
  for (let a = 0; a < starts.length; a++) {
    const run = [starts[a]];
    for (let b = a + 1; b < starts.length; b++) if (+starts[b].n === +run[run.length - 1].n + 1) run.push(starts[b]);
    if (run.length > best.length) best = run;
  }
  if (best.length >= 5) {
    best.forEach((s, k) => {
      const endLine = k + 1 < best.length ? best[k + 1].i : Math.min(lines.length, s.i + 3);
      const block = lines.slice(s.i, endLine).join('\n').replace(/^\s*\d{1,2}\s*\.\s*/, '');
      for (const seg of block.split(/[,;•●▪\n]|\s[–-]\s/)) {
        noteRetake(seg, { from: +s.n, to: +s.n });
        const kind = classify(seg);
        if (!kind || seg.trim().length < 4) continue;
        if (kind === 'zadanie' && !(/ukoncen|deadline|termin/.test(fold(seg)) || /\b[A-Z][A-Z0-9_-]{2,}\b/.test(seg))) continue;
        add(kind, seg, { from: +s.n, to: +s.n, text: '' }, 'table');
      }
    });
  }

  // 3) Exam dates: "Skúška: 12.1.2027 9:00 …" lines.
  // Also "Riadny hromadný termín – 12. 01. 2027" under a "Podmienky skúšky" heading.
  const exams = [];
  const docTalksExam = lines.some((l) => /skusk|exam/.test(fold(l)));
  for (const line of lines) {
    const f = fold(line);
    const examLine = /skusk|exam/.test(f) || (docTalksExam && /termin/.test(f) && /riadn|opravn|hromadn|nahradn/.test(f));
    if (!examLine || /zapoct|pisomk/.test(f) || (/opravn/.test(f) && !/termin/.test(f))) continue;
    for (const m of line.matchAll(/(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})(?:\s*(?:o|,)?\s*(\d{1,2})[:.](\d{2}))?/g)) {
      const d = iso(m[1], m[2], m[3]);
      if (isISO(d)) exams.push({ date: d, time: m[4] ? `${m[4].padStart(2, '0')}:${m[5]}` : '', retakeOnly: /opravn|nahradn/.test(f) });
    }
  }

  const items = [...found.values()].sort((a, b) => a.from - b.from);
  const seenR = new Set();
  const uniq = retakes.filter((r) => { const k = `${r.ord}|${r.week}|${r.examPeriod}`; return seenR.has(k) ? false : (seenR.add(k), true); });
  for (const it of items) {
    if (it.kind !== 'test') continue;
    const mine = uniq.filter((r) => (r.ord === 0 || r.ord === it.ord) && (r.examPeriod || r.week > it.to))
      .sort((a, b) => Number(a.examPeriod) - Number(b.examPeriod) || a.week - b.week);
    if (mine.length) it.retakes = mine.map(({ week, examPeriod }) => ({ week, examPeriod }));
  }
  return { items, exams: dedupeBy(exams, (e) => e.date + e.time) };
}

/** Subject names a document talks about ("…v rámci predmetu Operačné systémy…"). */
export function subjectHints(text) {
  const t = String(text).replace(/\s+/g, ' ');
  const out = [];
  for (const m of t.matchAll(/predmet(?:u|e|om)?\s*:?\s*[„"“]?([A-ZÁ-Ž][^„"“”()\n,.;:]{2,70})/g)) out.push(m[1].trim());
  const head = t.slice(0, 300);
  return [...new Set(out)].concat(head ? [head] : []);
}

/** Best matching subject for a document, by its name appearing in the text. */
export function matchSubject(subjects, text) {
  const ft = fold(text).replace(/[^a-z0-9]+/g, ' ');
  let best = null;
  for (const s of subjects) {
    const n = fold(s.name).replace(/[^a-z0-9]+/g, ' ').trim();
    if (!n) continue;
    const idx = ft.indexOf(n);
    const score = idx >= 0 ? n.length * 10 - idx / 100 : 0;
    let alt = 0;
    if (!score && s.short && s.short.length >= 2) {
      const re = new RegExp(`(?:^|\\s)${fold(s.short)}(?:\\s|$)`);
      if (re.test(ft)) alt = s.short.length;
    }
    const sc = score || alt;
    if (sc && (!best || sc > best.score)) best = { s, score: sc };
  }
  return best ? best.s : null;
}

function dedupeBy(arr, key) {
  const seen = new Set();
  return arr.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
}

/* ------------------------- exam terms list (MAIS) ------------------------- */

const TERM_LINE = /^\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\s+(\d{1,2})[:.](\d{2})\s*$/;

/** Looks like a list of exam terms copied from the student system. */
export function looksLikeExamList(text) {
  const lines = String(text).split(/\r?\n/);
  const terms = lines.filter((l) => TERM_LINE.test(l)).length;
  return terms >= 2 && /sk[úu][šs]k|term[íi]n|exam/i.test(text);
}

/**
 * Exam terms grouped by subject. Each term: { date, time, room, title,
 * retakeOnly, examiner, regUntil, full }.
 * `subjects` are matched by name; unknown names are returned as new.
 */
export function parseExamList(text, subjects) {
  const lines = String(text).split(/\r?\n/).map((l) => l.replace(/ /g, ' '));
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TERM_LINE);
    if (!m) continue;
    const date = iso(m[1], m[2], m[3]);
    if (!isISO(date)) continue;
    const time = `${m[4].padStart(2, '0')}:${m[5]}`;
    let title = '';
    for (let k = i - 1; k >= 0 && k >= i - 2; k--) {
      if (lines[k].trim() && !TERM_LINE.test(lines[k])) { title = lines[k].trim(); break; }
    }
    // The details row: [registration window] subject  room  capacity  type  note
    const row = (lines[i + 1] || '').trim();
    const cols = row.split(/\t+|\s{3,}/).map((c) => c.trim()).filter(Boolean);
    const reg = row.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\s+\d{1,2}:\d{2}\s*[-–]\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\s+(\d{1,2}:\d{2})/);
    const subj = matchSubject(subjects, row) || matchSubject(subjects, title);
    let name = subj ? subj.name : '';
    if (!name) {
      name = cols.find((c) => /[a-zá-ž]{3}/i.test(c) && !RANGE.test(c) && !/\d{1,2}\.\s*\d{1,2}\./.test(c)) || title;
    }
    const nameIdx = cols.findIndex((c) => fold(c).includes(fold(name).slice(0, 12)));
    const room = nameIdx >= 0 && cols[nameIdx + 1] && !/^\d+\/\d+$/.test(cols[nameIdx + 1]) ? cols[nameIdx + 1] : '';
    const ex = `${title} ${row}`.match(/sk[úu][šs]aj[úu]c[ia]\S*\s+([A-ZÁ-Ž][a-zá-ž]+)/);
    out.push({
      subjectId: subj?.id || null,
      subjectName: name,
      date, time, room, title,
      retakeOnly: /opravn|n[áa]hradn/i.test(title),
      examiner: ex ? ex[1] : '',
      regUntil: reg ? iso(reg[4], reg[5], reg[6]) : '',
      full: /obsaden/i.test(row),
    });
  }
  return out;
}

/**
 * Keep only terms that make sense for this student: if terms are split by
 * examiner and one of them teaches the student's classes, keep that one.
 * Same date + time in several rooms becomes one term.
 */
export function narrowTerms(terms, teacherText) {
  const t = fold(teacherText || '');
  const examiners = [...new Set(terms.map((x) => x.examiner).filter(Boolean))];
  let kept = terms;
  let mine = null;
  if (examiners.length > 1) {
    mine = examiners.find((e) => t.includes(fold(e))) || null;
    if (mine) kept = terms.filter((x) => !x.examiner || x.examiner === mine);
  }
  const merged = new Map();
  for (const x of kept) {
    const k = `${x.date} ${x.time}`;
    const prev = merged.get(k);
    if (!prev) merged.set(k, { ...x });
    else if (x.room && !prev.room.split(' / ').includes(x.room)) prev.room = `${prev.room} / ${x.room}`;
  }
  return { terms: [...merged.values()].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)), examiner: mine };
}
