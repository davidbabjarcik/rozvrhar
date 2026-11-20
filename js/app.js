import {
  DAY_NAMES, DAY_SHORT, addDays, diffDays, fmtDate, fmtDay, isISO, mondayOf, parseTime, parseUserDate,
  skHolidays, timeToMin, todayISO,
} from './dates.js';
import { describeWhen, parseWhen, teachingWeeks, weekByNumber, weekOf, weekStatus, holidayName } from './weeks.js';
import { CLASS_TYPES, ITEM_KINDS, examPrepDays, planExams, resolveItem, rowVerdict } from './planner.js';
import { buildOutputs } from './outputs.js';
import { buildICS } from './ics.js';
import { normalizeName, pageToText, parseListText, parseTimetable } from './timetable-parse.js';
import {
  looksLikeExamList, matchSubject, narrowTerms, parseAcademicCalendar, parseCourseDoc, parseExamList, pickSemester, subjectHints,
} from './doc-parse.js';
import { extractPdf } from './pdf-extract.js';
import * as G from './google.js';
import * as TT from './ticktick.js';

const STORE = 'rozvrhar:v1';
const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
const PALETTE = ['#4f46e5', '#0f8a5f', '#d9480f', '#c2255c', '#1971c2', '#7048e8', '#2b8a3e', '#e67700', '#0c8599', '#862e9c'];

/* --------------------------------- state --------------------------------- */

function defaultState() {
  return {
    semester: { name: '', start: '', weeks: 13, skipWeeks: [], holidays: [], examStart: '', examEnd: '' },
    classes: [],
    subjects: [],
    settings: { reminderMin: 15, examMinutes: 120, registerReminder: true, studyInCalendar: false, classReminder: false, blocked: [], listName: 'Škola' },
    sync: { calendarId: null, ttMap: {}, lastExport: null },
    savedAt: 0,
  };
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE));
    if (raw) return merge(defaultState(), raw);
  } catch (e) { /* ignore */ }
  return defaultState();
}

function merge(base, data) {
  return {
    ...base, ...data,
    semester: { ...base.semester, ...data.semester },
    settings: { ...base.settings, ...data.settings },
    sync: { ...base.sync, ...data.sync },
  };
}

let state = load();
const ui = { tab: localStorage.getItem('rozvrhar:tab') || 'home', variant: 0, weekQuery: '', busy: null, user: null, imported: null };
if (ui.tab === 'semester') ui.tab = 'home';
let driveTimer = null;

function save({ rerender = true } = {}) {
  state.savedAt = Date.now();
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { toast('Nepodarilo sa uložiť'); }
  if (G.isSignedIn()) {
    clearTimeout(driveTimer);
    driveTimer = setTimeout(() => G.saveToDrive(state).catch(() => {}), 2500);
  }
  if (rerender) render();
}

const uid = () => Math.random().toString(36).slice(2, 10);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), ms);
}

function subjectColor(s) {
  const i = state.subjects.indexOf(s);
  return s.color || PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
}

/* ------------------------------ path binding ------------------------------ */

function getPath(path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), state);
}

function setPath(path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const obj = keys.reduce((o, k) => o[k], state);
  obj[last] = value;
}

/* --------------------------------- render --------------------------------- */

const main = document.getElementById('main');

function render() {
  document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-current', b.dataset.tab === ui.tab ? 'page' : 'false'));
  const views = { home: viewHome, timetable: viewTimetable, subjects: viewSubjects, plan: viewPlan, export: viewExport };
  morph(main, (views[ui.tab] || viewHome)());
  renderHeader();
}

/* Minimal DOM morphing: keeps focused inputs and pressed buttons alive across re-renders. */
function morph(target, html) {
  const next = document.createElement(target.tagName);
  next.innerHTML = html;
  morphChildren(target, next);
}

function morphChildren(a, b) {
  const aKids = [...a.childNodes];
  const bKids = [...b.childNodes];
  bKids.forEach((bn, i) => {
    const an = aKids[i];
    if (!an) { a.appendChild(bn); return; }
    if (an.nodeType !== bn.nodeType || an.nodeName !== bn.nodeName || (an.nodeType === 1 && (an.id !== bn.id || an.type !== bn.type))) {
      a.replaceChild(bn, an);
      return;
    }
    if (an.nodeType !== 1) {
      if (an.nodeValue !== bn.nodeValue) an.nodeValue = bn.nodeValue;
      return;
    }
    morphEl(an, bn);
  });
  for (let i = bKids.length; i < aKids.length; i++) aKids[i].remove();
}

function morphEl(a, b) {
  for (const { name } of [...a.attributes]) if (!b.hasAttribute(name)) a.removeAttribute(name);
  for (const { name, value } of [...b.attributes]) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  const focused = document.activeElement === a;
  if (a.tagName === 'TEXTAREA') {
    if (a.dataset.bind && !focused) a.value = b.value;
    return;
  }
  morphChildren(a, b);
  if (a.tagName === 'INPUT' && !focused) {
    if (a.type === 'checkbox') a.checked = b.hasAttribute('checked');
    else if (a.type !== 'file') a.value = b.getAttribute('value') ?? '';
  }
  if (a.tagName === 'SELECT') {
    const sel = b.querySelector('option[selected]');
    a.value = sel ? sel.value : (a.options[0]?.value ?? '');
  }
}

function renderHeader() {
  const badge = document.getElementById('weekBadge');
  const st = weekStatus(state.semester, todayISO());
  if (st) {
    badge.hidden = false;
    badge.textContent = st.kind === 'teaching' ? `${st.n}. týždeň` : st.kind === 'exams' ? 'skúškové' :
      st.kind === 'before' ? `začiatok o ${st.days} d` : st.kind === 'after' ? 'po semestri' : 'voľno';
  } else badge.hidden = true;

  const acc = document.getElementById('account');
  if (ui.user) {
    morph(acc, `${ui.user.picture ? `<img src="${esc(ui.user.picture)}" alt="" referrerpolicy="no-referrer">` : ''}
      <span class="muted hide-sm">${esc(ui.user.email || '')}</span>
      <button class="btn small" data-action="signout">Odhlásiť</button>`);
  } else {
    morph(acc, `<button class="btn small" data-action="signin">Prihlásiť cez Google</button>`);
  }
}

function field(label, path, { type = 'text', placeholder = '', attrs = '', value } = {}) {
  const v = value !== undefined ? value : getPath(path);
  return `<label class="f"><span>${label}</span><input type="${type}" data-bind="${path}" ${type === 'number' ? 'data-type="number"' : ''}
    value="${esc(v ?? '')}" placeholder="${esc(placeholder)}" ${attrs}></label>`;
}

/* -------------------------------- Semester -------------------------------- */

function viewHome() {
  const empty = !state.classes.length && !state.subjects.length;
  return `
  <div class="card hero">
    <h2>${empty ? 'Hoď sem svoje PDF 👇' : 'Pridať ďalšie PDF'}</h2>
    ${empty ? `<p class="muted">Rozvrh z MAIS-u, harmonogram fakulty, podmienky zápočtu, sylaby… aj viac naraz.
      Rozvrhár sám zistí, čo je čo, a „6. týždeň“ prepočíta na tvoj deň a hodinu.</p>` : ''}
    <label class="dropzone" id="drop">
      <input type="file" id="anyInput" accept="application/pdf,.pdf,.txt,text/plain" multiple>
      <div class="big">📥</div>
      <div><b>Klikni alebo sem pretiahni súbory</b></div>
      <small>Spracuje sa priamo v prehliadači – nikam sa neposiela.</small>
    </label>
    ${ui.busy === 'import' ? `<p>⏳ ${esc(ui.busyText || 'Čítam…')}</p>` : ''}
    <details>
      <summary>Alebo vlož text (napr. skopírovaný zo stránky predmetu)</summary>
      <textarea id="anyText" placeholder="Zápočtový test I. – 6. týždeň&#10;Odovzdanie projektu – 12. týždeň"></textarea>
      <label class="f" style="margin-top:6px"><span>Predmet (ak to nie je rozvrh)</span>
        <select id="anyTextSubj"><option value="">zistiť automaticky</option>${state.subjects.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></label>
      <div class="row end" style="margin-top:8px"><button class="btn" data-action="import-text">Spracovať</button></div>
    </details>
  </div>
  ${importReport()}
  ${upcoming()}
  ${viewSemester()}`;
}

function importReport() {
  const rep = ui.imported;
  if (!rep) return '';
  const byId = Object.fromEntries(state.subjects.map((x) => [x.id, x]));
  const rows = rep.entries.map((e, ei) => {
    if (e.kind === 'calendar') return `<div class="found"><span class="fi">📆</span><div><b>Harmonogram fakulty</b> · <span class="muted">${esc(e.file)}</span>
      <div>${esc(e.text)}</div></div></div>`;
    if (e.kind === 'timetable') return `<div class="found"><span class="fi">📅</span><div><b>Rozvrh</b> · <span class="muted">${esc(e.file)}</span>
      <div>${esc(e.text)}</div></div></div>`;
    if (e.kind === 'exams') {
      const subj = byId[e.subjectId];
      if (!subj) return '';
      const list = subj.exams.filter((x) => e.examIds.includes(x.id))
        .map((x) => `<li>${x.retakeOnly ? '🔁' : '🎓'} ${fmtDay(x.date)} ${esc(x.time || '')}${x.retakeOnly ? ' <span class="muted">(opravný)</span>' : ''}${x.note ? ` <span class="muted">· ${esc(x.note)}</span>` : ''}</li>`).join('');
      return `<div class="found"><span class="fi">🎓</span><div><b>${esc(subj.name)}</b> – termíny skúšky
        ${e.examiner ? `<div class="muted">Nechal som termíny skúšajúcej/-ceho ${esc(e.examiner)} (učí ťa podľa rozvrhu).</div>` : ''}
        <ul>${list}</ul></div></div>`;
    }
    if (e.kind === 'course') {
      const subj = byId[e.subjectId];
      if (!subj) return '';
      const items = (subj.items || []).filter((it) => e.itemIds.includes(it.id)).map((it) => {
        const r = resolveItem(it, subj, state.classes, state.semester);
        const k = ITEM_KINDS[it.kind] || ITEM_KINDS.ine;
        const when = r.ok ? `${fmtDay(r.date)}${r.allDay ? '' : ' ' + r.start}${r.via === 'class' ? ' <span class="muted">(tvoja hodina)</span>' : ''}` : `<span class="warn">${esc(r.reason)}</span>`;
        return `<li>${k.icon} ${esc(it.title)} – <b>${when}</b> <span class="muted">· ${/^\d+(-\d+)?$/.test(it.when) ? esc(it.when) + '. týždeň' : esc(it.when)}${it.note ? ', ' + esc(it.note) : ''}</span> ${retakeControls(subj, it)}</li>`;
      }).join('');
      const exams = (subj.exams || []).filter((x) => (e.examIds || []).includes(x.id))
        .map((x) => `<li>${x.retakeOnly ? '🔁 Opravný termín' : '🎓 Skúška'} – <b>${fmtDay(x.date)}${x.time ? ' ' + esc(x.time) : ''}</b></li>`).join('');
      return `<div class="found"><span class="fi">📘</span><div>
        <div class="row"><select data-import-move="${ei}" aria-label="Predmet" style="max-width:340px;font-weight:600">${state.subjects.map((x) => `<option value="${x.id}" ${x.id === subj.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <span class="muted">${esc(e.file)}</span></div>
        <ul>${items}${exams}</ul></div></div>`;
    }
    return `<div class="found"><span class="fi">❓</span><div><b>${esc(e.file)}</b><div class="warn">${esc(e.text)}</div></div></div>`;
  }).join('');
  return `<div class="card">
    <h2>✨ Čo som našiel <button class="btn small ghost" data-action="undo-import">↶ Vrátiť</button></h2>
    ${rows}
    ${rep.notes.map((n) => `<p class="warn">${esc(n)}</p>`).join('')}
    <div class="row" style="margin-top:10px">
      <button class="btn primary" data-goto="plan">🎯 Pozrieť plán</button>
      <button class="btn" data-goto="export">📤 Poslať do kalendára</button>
    </div>
  </div>`;
}

function upcoming() {
  if (!state.semester.start) return '';
  const { events } = buildOutputs(state, currentPlanRows());
  const today = todayISO();
  const next = events.filter((e) => (e.category === 'item' || e.category === 'exam') && (e.endDate || e.date) >= today)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.start || '').localeCompare(b.start || '')).slice(0, 6);
  if (!next.length) return '';
  return `<div class="card agenda"><h2>⏭️ Najbližšie</h2>${next.map((e) => {
    const d = diffDays(today, e.date);
    const rel = d <= 0 ? 'dnes' : d === 1 ? 'zajtra' : `o ${d} dní`;
    return `<div class="ev"><span class="d">${fmtDay(e.date)}${e.allDay ? '' : `<br>${e.start}`}</span><span>${esc(e.title)} <small class="muted">· ${rel}</small></span></div>`;
  }).join('')}</div>`;
}

function viewSemester() {
  const s = state.semester;
  const weeks = teachingWeeks(s);
  const today = todayISO();
  const curWeek = weekOf(s, today);
  const q = ui.weekQuery.trim();
  let answer = '';
  if (q) {
    const w = parseWhen(q, s);
    if (!weeks.length) answer = '<span class="warn">Najprv nastav začiatok semestra.</span>';
    else if (!w) answer = '<span class="warn">Zadaj číslo týždňa (napr. 12 alebo 12-13) alebo dátum (napr. 10.12.).</span>';
    else if (w.kind === 'date') {
      const n = weekOf(s, w.date);
      answer = n ? `<b>${fmtDay(w.date)}</b> je v <b>${n}. týždni</b> semestra.` : `${fmtDay(w.date)} nie je v žiadnom výučbovom týždni.`;
    } else {
      const a = weekByNumber(s, w.from);
      const b = weekByNumber(s, w.to);
      answer = a && b
        ? `<b>${describeWhen(w)}</b>: ${fmtDay(a.monday)} – ${fmtDay(addDays(b.monday, 4))} <span class="muted">(do nedele ${fmtDate(b.sunday)})</span>`
        : `<span class="warn">Semester má iba ${weeks.length} týždňov.</span>`;
    }
  }
  const holChips = (s.holidays || []).map((h, i) => `<span class="chip" title="${esc(h.name || '')}">${fmtDay(h.date)}${h.name ? ' · ' + esc(h.name) : ''}
    <button data-action="del-holiday" data-i="${i}" aria-label="Odstrániť">✕</button></span>`).join('');
  const skipChips = (s.skipWeeks || []).map((d, i) => `<span class="chip">týždeň od ${fmtDate(d)}
    <button data-action="del-skip" data-i="${i}" aria-label="Odstrániť">✕</button></span>`).join('');

  const summary = s.start && weeks.length
    ? `<b>${esc(s.name || 'Semester')}</b> · výučba ${fmtDate(weeks[0].monday)} – ${fmtDate(addDays(weeks[weeks.length - 1].monday, 4))} (${weeks.length} týž.)${s.examStart ? ` · skúškové od ${fmtDate(s.examStart)}` : ''}${curWeek ? ` · <b>teraz ${curWeek}. týždeň</b>` : ''}`
    : 'Semester ešte nie je nastavený – nahraj harmonogram fakulty alebo ho zadaj ručne.';
  return `
  <div class="card">
    <h2>🗓️ Semester</h2>
    <p>${summary}${s.guessed ? ' <span class="warn">(odhad – nahraj harmonogram fakulty, nech je to presne)</span>' : ''}</p>
    <details ${s.start ? '' : 'open'}>
    <summary>Upraviť</summary>
    <div class="grid">
      ${field('Názov', 'semester.name', { placeholder: 'ZS 2026/27' })}
      ${field('Začiatok (1. týždeň)', 'semester.start', { type: 'date' })}
      ${field('Počet týždňov výučby', 'semester.weeks', { type: 'number', attrs: 'min="1" max="30"' })}
      ${field('Skúškové od', 'semester.examStart', { type: 'date' })}
      ${field('Skúškové do', 'semester.examEnd', { type: 'date' })}
    </div>
    </details>
  </div>

  <div class="card">
    <h2>🔢 Kalkulačka týždňov</h2>
    <p class="muted">Napíš „12“, „12-13“ alebo dátum a hneď uvidíš, kedy to je.</p>
    <input id="weekQuery" value="${esc(ui.weekQuery)}" placeholder="napr. 12 alebo 10.12." autocomplete="off">
    <p id="weekAnswer">${answer}</p>
    ${weeks.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Týždeň</th><th>Od</th><th>Do</th><th>Poznámka</th></tr></thead>
      <tbody>${weeks.map((w) => {
        const hol = [0, 1, 2, 3, 4].map((d) => addDays(w.monday, d)).map((d) => holidayName(s, d) ? `${DAY_SHORT[(diffDays(w.monday, d))]}: ${holidayName(s, d)}` : '').filter(Boolean).join(', ');
        return `<tr class="${w.n === curWeek ? 'now' : ''}"><td><b>${w.n}.</b>${w.n === curWeek ? ' ← teraz' : ''}</td>
          <td>${fmtDate(w.monday)}</td><td>${fmtDate(addDays(w.monday, 4))}</td><td class="muted">${esc(hol)}</td></tr>`;
      }).join('')}</tbody></table></div>` : ''}
  </div>

  <div class="card">
    <details><summary style="margin:0">Voľné dni a prerušenia</summary>
    <p class="muted">V sviatok sa hodiny do kalendára nedajú. Týždeň prerušenia (napr. dekanské voľno) sa do číslovania nepočíta.</p>
    <h3>Sviatky / voľné dni</h3>
    <div class="chips">${holChips || '<span class="muted">žiadne</span>'}</div>
    <div class="row">
      <input type="date" id="newHoliday" style="max-width:180px">
      <button class="btn small" data-action="add-holiday">Pridať deň</button>
      <button class="btn small" data-action="add-sk-holidays" ${s.start ? '' : 'disabled'}>Pridať štátne sviatky SR</button>
    </div>
    <h3 style="margin-top:14px">Týždne, ktoré sa nepočítajú</h3>
    <div class="chips">${skipChips || '<span class="muted">žiadne</span>'}</div>
    <div class="row">
      <input type="date" id="newSkip" style="max-width:180px">
      <button class="btn small" data-action="add-skip">Pridať týždeň</button>
    </div>
    </details>
  </div>`;
}

/* -------------------------------- Timetable -------------------------------- */

function viewTimetable() {
  const opts = (list, cur) => list.map(([v, l]) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${l}</option>`).join('');
  const subjOpts = (cur) => state.subjects.map((s) => `<option value="${s.id}" ${s.id === cur ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  const sorted = state.classes.map((c, i) => ({ c, i })).sort((a, b) => a.c.day - b.c.day || (a.c.start || '').localeCompare(b.c.start || ''));
  const rows = sorted.map(({ c, i }) => `
    <div class="cls">
      <select class="subj" data-bind="classes.${i}.subjectId">${subjOpts(c.subjectId)}</select>
      <select data-bind="classes.${i}.type">${opts(Object.entries(CLASS_TYPES), c.type)}</select>
      <select data-bind="classes.${i}.day" data-type="number">${opts(DAY_NAMES.slice(0, 6).map((d, k) => [k, d]), c.day)}</select>
      <input type="time" data-bind="classes.${i}.start" value="${esc(c.start)}">
      <input type="time" data-bind="classes.${i}.end" value="${esc(c.end)}">
      <input data-bind="classes.${i}.room" value="${esc(c.room)}" placeholder="miestnosť">
      <select data-bind="classes.${i}.parity" title="Týždne">${opts([['all', 'každý týž.'], ['odd', 'nepárne'], ['even', 'párne']], c.parity)}</select>
      <button class="icon" data-action="del-class" data-i="${i}" title="Odstrániť">🗑️</button>
    </div>`).join('');

  return `
  <div class="card">
    <h2>Nahraj rozvrh</h2>
    <label class="dropzone" id="drop">
      <input type="file" id="anyInput" accept="application/pdf,.pdf" multiple>
      <div class="big">📄</div>
      <div><b>Klikni alebo sem pretiahni PDF rozvrhu</b></div>
      <small>PDF sa spracuje priamo v prehliadači – nikam sa neposiela.</small>
    </label>
    ${ui.busy === 'import' ? `<p>⏳ ${esc(ui.busyText || 'Čítam…')}</p>` : ''}
    ${ui.parseNote ? `<p class="${ui.parseNote.ok ? 'ok' : 'warn'}">${esc(ui.parseNote.text)}</p>` : ''}
    <details>
      <summary>Alebo vlož rozvrh ako text</summary>
      <p class="muted">Jeden riadok = jedna hodina. Deň stačí napísať raz, pod neho riadky s časom.</p>
      <textarea id="ttText" placeholder="Pondelok&#10;07:30-09:00 OOP prednáška BC300&#10;10:50-12:20 Matematika 2 cvičenie A-120 nepárny&#10;Utorok&#10;09:10-10:40 Matematika 2 prednáška Aula"></textarea>
      <div class="row end" style="margin-top:8px"><button class="btn" data-action="parse-text">Načítať text</button></div>
    </details>
  </div>

  <div class="card">
    <h2>Hodiny <span class="row">
      <button class="btn small" data-action="add-class" ${state.subjects.length ? '' : 'disabled'}>+ Hodina</button>
      ${state.classes.length ? '<button class="btn small ghost" data-action="clear-classes">Vymazať všetko</button>' : ''}</span></h2>
    ${state.classes.length ? `<p class="muted">Skontroluj, či sedí, čo sa prečítalo z PDF. Zmeny sa ukladajú automaticky.</p>
      <div class="cls head"><span>Predmet</span><span>Typ</span><span>Deň</span><span>Od</span><span>Do</span><span>Miestnosť</span><span>Týždne</span><span></span></div>
      ${rows}` : `<div class="empty">Zatiaľ žiadne hodiny. Nahraj PDF${state.subjects.length ? ' alebo pridaj hodinu ručne' : ''}.</div>`}
    ${!state.subjects.length ? `<div class="row"><button class="btn small" data-action="add-subject">+ Pridať predmet ručne</button></div>` : ''}
    ${state.classes.length ? weekPreview() : ''}
  </div>`;
}

function weekPreview() {
  const cls = state.classes.filter((c) => c.start && c.end && c.day <= 4);
  if (!cls.length) return '';
  const minT = Math.floor(Math.min(...cls.map((c) => timeToMin(c.start))) / 60) * 60;
  const maxT = Math.ceil(Math.max(...cls.map((c) => timeToMin(c.end))) / 60) * 60;
  const pxPerMin = 0.8;
  const H = (maxT - minT) * pxPerMin;
  const hours = [];
  for (let t = minT; t <= maxT; t += 60) hours.push(t);
  const byId = Object.fromEntries(state.subjects.map((s) => [s.id, s]));
  const col = (d) => {
    // Side-by-side layout for overlapping blocks.
    const list = cls.filter((c) => Number(c.day) === d).sort((a, b) => a.start.localeCompare(b.start));
    const lanes = [];
    const placed = list.map((c) => {
      let lane = lanes.findIndex((end) => end <= c.start);
      if (lane === -1) { lane = lanes.length; lanes.push(c.end); } else lanes[lane] = c.end;
      return { c, lane };
    });
    const n = Math.max(1, lanes.length);
    return placed.map(({ c, lane }) => {
      const s = byId[c.subjectId];
      const top = (timeToMin(c.start) - minT) * pxPerMin;
      const h = (timeToMin(c.end) - timeToMin(c.start)) * pxPerMin;
      return `<div class="blk" style="top:${top}px;height:${h - 2}px;left:calc(${(lane / n) * 100}% + 2px);right:auto;width:calc(${100 / n}% - 4px);background:${s ? subjectColor(s) : '#888'}">
        <b>${esc(s ? s.short || s.name : '?')}</b>${esc(c.type)} ${esc(c.room || '')}${c.parity !== 'all' ? (c.parity === 'odd' ? ' · NP' : ' · P') : ''}</div>`;
    }).join('');
  };
  return `<h3 style="margin-top:16px">Náhľad týždňa</h3>
  <div class="week">
    <div></div>${DAY_SHORT.slice(0, 5).map((d) => `<div class="hd">${d}</div>`).join('')}
    <div class="col" style="height:${H}px;border-left:0">${hours.map((t) => `<div class="lbl" style="top:${(t - minT) * pxPerMin}px">${t / 60}:00</div>`).join('')}</div>
    ${[0, 1, 2, 3, 4].map((d) => `<div class="col" style="height:${H}px">${hours.map((t) => `<div class="hr" style="top:${(t - minT) * pxPerMin}px"></div>`).join('')}${col(d)}</div>`).join('')}
  </div>`;
}

/* -------------------------------- Subjects -------------------------------- */

function viewSubjects() {
  if (!state.subjects.length) {
    return `<div class="card"><div class="empty">Predmety sa vytvoria z rozvrhu. Môžeš ich pridať aj ručne.<br><br>
      <button class="btn primary" data-action="add-subject">+ Pridať predmet</button></div></div>`;
  }
  const kindOpts = (cur) => Object.entries(ITEM_KINDS).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${v.icon} ${v.label}</option>`).join('');
  return `
  <div class="hint">💡 Do poľa <b>Kedy</b> píš rovno zo sylabu: <code>12</code>, <code>12. týždeň</code>, <code>12-13</code> alebo dátum <code>10.12.</code>.
    Ak je to v týždni, keď máš z predmetu cvičenie, test sa automaticky dá na tú hodinu.</div>
  ${state.subjects.map((s, si) => {
    const items = (s.items || []).map((it, ii) => {
      const r = resolveItem(it, s, state.classes, state.semester);
      const res = !it.when ? '' : r.ok
        ? `<span class="ok">→ ${fmtDay(r.date)}${r.allDay ? (r.endDate && r.endDate !== r.date ? ` – ${fmtDay(r.endDate)}` : '') : ` ${r.start}–${r.end}`}</span>
           ${r.via === 'class' ? '<span class="muted">(na tvojej hodine)</span>' : ''}${r.reason ? ` <span class="warn">${esc(r.reason)}</span>` : ''}`
        : `<span class="bad">${esc(r.reason)}</span>`;
      return `<div class="item">
        <select data-bind="subjects.${si}.items.${ii}.kind">${kindOpts(it.kind)}</select>
        <input data-bind="subjects.${si}.items.${ii}.title" value="${esc(it.title)}" placeholder="Názov (napr. 1. test)">
        <input class="when" data-bind="subjects.${si}.items.${ii}.when" value="${esc(it.when)}" placeholder="Kedy: 12 / 12-13 / 10.12.">
        <input data-bind="subjects.${si}.items.${ii}.time" value="${esc(it.time || '')}" placeholder="čas (voliteľný)">
        <button class="icon" data-action="del-item" data-si="${si}" data-ii="${ii}" title="Odstrániť">🗑️</button>
        <div class="res">${res} ${retakeControls(s, it)}</div>
      </div>`;
    }).join('');
    const exams = (s.exams || []).map((e, ei) => `<div class="exam">
        <input type="date" data-bind="subjects.${si}.exams.${ei}.date" value="${esc(e.date)}">
        <input type="time" data-bind="subjects.${si}.exams.${ei}.time" value="${esc(e.time || '')}">
        <input data-bind="subjects.${si}.exams.${ei}.note" value="${esc(e.note || '')}" placeholder="poznámka (miestnosť, písomná…)">
        <button class="icon" data-action="del-exam" data-si="${si}" data-ei="${ei}" title="Odstrániť">🗑️</button>
      </div>`).join('');
    return `<div class="card subject" style="--sc:${subjectColor(s)}">
      <div class="title">
        <input data-bind="subjects.${si}.name" value="${esc(s.name)}" aria-label="Názov predmetu">
        <input data-bind="subjects.${si}.short" value="${esc(s.short || '')}" placeholder="skratka" style="max-width:110px" aria-label="Skratka">
        <button class="icon" data-action="del-subject" data-si="${si}" title="Odstrániť predmet">🗑️</button>
      </div>
      <div class="grid" style="margin-top:10px">
        <label class="f"><span>Náročnosť: ${['', 'pohoda', 'ľahký', 'stredný', 'ťažký', 'peklo'][s.difficulty || 3]}</span>
          <input type="range" min="1" max="5" data-type="number" data-bind="subjects.${si}.difficulty" value="${s.difficulty || 3}"></label>
        ${field('Kredity', `subjects.${si}.credits`, { type: 'number', attrs: 'min="0" max="30"' })}
        ${field('Dni učenia na skúšku', `subjects.${si}.prepDays`, { type: 'number', placeholder: `auto (${examPrepDays(s)})`, attrs: 'min="0" max="30"' })}
        <label class="check"><input type="checkbox" data-bind="subjects.${si}.wantRetake" ${s.wantRetake !== false ? 'checked' : ''}> Nechať si opravný termín</label>
      </div>
      <div class="items">
        <h3>Počas semestra</h3>
        ${items || '<p class="muted">Žiadne testy ani zadania.</p>'}
        <button class="btn small" data-action="add-item" data-si="${si}">+ Test / zadanie</button>
      </div>
      <div class="items">
        <h3>Termíny skúšky</h3>
        ${exams || '<p class="muted">Termíny ešte nie sú? Pridaj ich, keď ich vypíšu.</p>'}
        <div class="row">
          <button class="btn small" data-action="add-exam" data-si="${si}">+ Termín</button>
          <button class="btn small ghost" data-action="bulk-exams" data-si="${si}">Vložiť viac naraz</button>
          <span class="spacer"></span>
          <label class="check"><input type="checkbox" data-bind="subjects.${si}.noExam" ${s.noExam ? 'checked' : ''}> Bez skúšky (len zápočet)</label>
        </div>
      </div>
    </div>`;
  }).join('')}
  <div class="row"><button class="btn" data-action="add-subject">+ Pridať predmet</button></div>`;
}

/* ---------------------------------- Plan ---------------------------------- */

function computePlan() {
  const subjects = state.subjects.filter((s) => !s.noExam);
  return planExams(subjects, state.semester, { blocked: state.settings.blocked || [] });
}

function currentPlanRows() {
  const p = computePlan();
  const plan = p.plans[Math.min(ui.variant, p.plans.length - 1)];
  return plan ? plan.rows : [];
}

function viewPlan() {
  const res = computePlan();
  const withExams = state.subjects.filter((s) => !s.noExam && (s.exams || []).length);
  const plan = res.plans[Math.min(ui.variant, Math.max(0, res.plans.length - 1))];
  const blockedChips = (state.settings.blocked || []).map((d, i) => `<span class="chip">${fmtDay(d)}
    <button data-action="del-blocked" data-i="${i}" aria-label="Odstrániť">✕</button></span>`).join('');

  let examHtml;
  if (!withExams.length) {
    examHtml = '<div class="empty">Pridaj termíny skúšok v záložke Predmety a tu uvidíš, na ktoré sa oplatí prihlásiť.</div>';
  } else if (!plan) {
    examHtml = `<p class="bad">${res.warnings.map(esc).join('<br>') || 'Nenašiel sa plán.'}</p>`;
  } else {
    examHtml = `
    ${res.plans.length > 1 ? `<div class="variant">${res.plans.map((p, i) => `<button class="btn small" data-action="variant" data-i="${i}" aria-pressed="${i === ui.variant}">
      ${i === 0 ? '⭐ Najlepší' : `Variant ${i + 1}`}</button>`).join('')}</div>` : ''}
    ${plan.rows.map((r) => {
      const locked = r.subject.lockedExamId === r.exam.id;
      return `<div class="plan-row">
        <div><div class="date">${fmtDay(r.exam.date)}</div><small>${esc(r.exam.time || '')}</small></div>
        <div><b><span class="dot" style="background:${subjectColor(r.subject)}"></span> ${esc(r.subject.name)}</b>
          <div class="why">${rowVerdict(r).map((x) => esc(x).replace(/(\d{4}-\d{2}-\d{2})/g, (d) => fmtDate(d))).join(' · ')}</div></div>
        <button class="btn small ${locked ? 'primary' : ''}" data-action="lock" data-sid="${r.subject.id}" data-eid="${r.exam.id}"
          title="${locked ? 'Odomknúť' : 'Už som prihlásený – nechaj tento termín'}">${locked ? '🔒 Prihlásený' : '🔓 Zamknúť'}</button>
      </div>`;
    }).join('')}
    ${res.skipped.filter((s) => !s.noExam).length ? `<p class="muted">Bez termínov: ${res.skipped.filter((s) => !s.noExam).map((s) => esc(s.name)).join(', ')}</p>` : ''}
    ${res.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join('')}
    <details><summary>Ako sa vyberá?</summary>
      <p class="muted">Skúšam všetky kombinácie termínov (nikdy dve skúšky v jeden deň). Každá skúška dostane čas na učenie od predošlej skúšky –
      ťažšie a viackreditové predmety potrebujú viac dní. Najviac sa hodnotí, aby ani jedna skúška nebola „na poslednú chvíľu“,
      potom celkový čas na prípravu a či ti po termíne ostane opravný. Ak si už prihlásený, termín zamkni a zvyšok sa prepočíta.</p>
    </details>`;
  }

  // Agenda: everything except weekly classes and study days.
  const { events, tasks } = buildOutputs(state, plan ? plan.rows : []);
  const agendaItems = events.filter((e) => e.category === 'item' || e.category === 'exam');
  const studyCount = tasks.filter((t) => t.kind === 'study').length;
  const groups = new Map();
  for (const e of agendaItems) {
    const n = weekOf(state.semester, e.date);
    const key = n ? `${n}. týždeň · ${fmtDate(mondayOf(e.date))} – ${fmtDate(addDays(mondayOf(e.date), 6))}` :
      `Týždeň ${fmtDate(mondayOf(e.date))} – ${fmtDate(addDays(mondayOf(e.date), 6))}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const today = todayISO();
  const agenda = [...groups.entries()].map(([k, list]) => `<h3>${k}</h3>${list.map((e) => `
    <div class="ev" style="${diffDays(today, e.date) < 0 ? 'opacity:.5' : ''}"><span class="d">${fmtDay(e.date)}${e.allDay ? '' : `<br>${e.start}`}</span>
    <span>${esc(e.title)}${e.allDay && e.endDate && e.endDate !== e.date ? ` <small class="warn">(niekedy v týždni)</small>` : ''}</span></div>`).join('')}`).join('');

  return `
  <div class="card">
    <h2>🎯 Odporúčané termíny skúšok</h2>
    ${examHtml}
    <h3 style="margin-top:14px">Dni, keď nemôžem mať skúšku</h3>
    <div class="chips">${blockedChips || '<span class="muted">žiadne</span>'}</div>
    <div class="row"><input type="date" id="newBlocked" style="max-width:180px"><button class="btn small" data-action="add-blocked">Pridať</button></div>
  </div>
  <div class="card agenda">
    <h2>📌 Prehľad semestra</h2>
    ${agenda || '<div class="empty">Zatiaľ tu nič nie je. Pridaj testy a zadania v Predmetoch.</div>'}
    ${studyCount ? `<p class="muted" style="margin-top:12px">+ ${studyCount} dní učenia pred skúškami (pôjdu do TickTicku).</p>` : ''}
  </div>`;
}

/* --------------------------------- Export --------------------------------- */

function viewExport() {
  const rows = currentPlanRows();
  const { events, tasks } = buildOutputs(state, rows);
  const nClass = events.filter((e) => e.category === 'class').length;
  const nOther = events.length - nClass;
  const gOk = G.googleConfigured();
  const ttOk = Boolean(TT.proxyUrl());
  const ttOn = TT.ticktickConnected();
  const set = state.settings;
  const last = state.sync.lastExport;
  return `
  <div class="card">
    <h2>📅 Google Kalendár</h2>
    <p>Vytvorí sa samostatný kalendár <b>„${esc(calName())}“</b> s ${nClass} opakujúcimi sa hodinami a ${nOther} udalosťami (testy, zadania, skúšky).
      Pri ďalšom exporte sa celý tento kalendár nahradí – tvoje ostatné kalendáre sa nemenia.</p>
    ${gOk ? '' : '<p class="warn">Najprv doplň Google Client ID v nastaveniach nižšie.</p>'}
    <label class="check"><input type="checkbox" data-bind="settings.studyInCalendar" ${set.studyInCalendar ? 'checked' : ''}> Dni učenia aj do kalendára</label>
    <label class="check"><input type="checkbox" data-bind="settings.classReminder" ${set.classReminder ? 'checked' : ''}> Pripomienka 10 min pred každou hodinou</label>
    <div class="row" style="margin-top:8px">
      <button class="btn primary" data-action="export-google" ${gOk && events.length && !ui.busy ? '' : 'disabled'}>Exportovať do Google Kalendára</button>
      <button class="btn" data-action="download-ics" ${events.length ? '' : 'disabled'}>Stiahnuť .ics</button>
    </div>
    ${ui.busy === 'google' ? `<div class="progress"><div id="prog" style="width:0%"></div></div>` : ''}
    ${last?.google ? `<p class="muted">Naposledy: ${new Date(last.google).toLocaleString('sk')}</p>` : ''}
  </div>

  <div class="card">
    <h2>✅ TickTick</h2>
    <p>${tasks.length} úloh: testy a zadania, „začni sa pripravovať“, prihlásenie na skúšky, skúšky a dni učenia. Opakovaný export úlohy aktualizuje, neduplikuje.</p>
    ${ttOk ? '' : '<p class="warn">TickTick potrebuje malý proxy server (návod v README). Bez neho použi .ics alebo skopíruj úlohy.</p>'}
    <div class="grid">${field('Zoznam v TickTicku', 'settings.listName', { placeholder: 'Škola' })}</div>
    <div class="row" style="margin-top:8px">
      ${ttOn ? `<button class="btn primary" data-action="export-tt" ${tasks.length && !ui.busy ? '' : 'disabled'}>Poslať do TickTicku</button>
        <button class="btn ghost" data-action="tt-disconnect">Odpojiť</button>`
        : `<button class="btn primary" data-action="tt-connect" ${ttOk ? '' : 'disabled'}>Pripojiť TickTick</button>`}
      <button class="btn" data-action="copy-tasks" ${tasks.length ? '' : 'disabled'}>Kopírovať ako text</button>
    </div>
    ${ui.busy === 'tt' ? `<div class="progress"><div id="prog" style="width:0%"></div></div>` : ''}
    ${last?.tt ? `<p class="muted">Naposledy: ${new Date(last.tt).toLocaleString('sk')}</p>` : ''}
  </div>

  <div class="card">
    <h2>⚙️ Nastavenia</h2>
    <div class="grid">
      ${field('Pripomienka pred testom (min)', 'settings.reminderMin', { type: 'number', attrs: 'min="0"' })}
      ${field('Dĺžka skúšky (min)', 'settings.examMinutes', { type: 'number', attrs: 'min="15"' })}
    </div>
    <label class="check"><input type="checkbox" data-bind="settings.registerReminder" ${set.registerReminder !== false ? 'checked' : ''}> Pripomenúť prihlásenie na skúšku (10 dní vopred)</label>
    <details>
      <summary>Prepojenia (pre vlastné nasadenie)</summary>
      <div class="grid">
        <label class="f"><span>Google OAuth Client ID</span><input id="gcid" value="${esc(localStorage.getItem('rozvrhar:gcid') || '')}" placeholder="…apps.googleusercontent.com"></label>
        <label class="f"><span>TickTick proxy URL</span><input id="ttproxy" value="${esc(localStorage.getItem('rozvrhar:ttProxy') || '')}" placeholder="https://….workers.dev"></label>
      </div>
      <div class="row" style="margin-top:8px"><button class="btn small" data-action="save-conn">Uložiť</button></div>
    </details>
    <details>
      <summary>Záloha</summary>
      <div class="row">
        <button class="btn small" data-action="backup">Stiahnuť zálohu (.json)</button>
        <label class="btn small" style="cursor:pointer">Obnoviť zo zálohy<input type="file" id="restore" accept=".json,application/json" hidden></label>
        <button class="btn small ghost bad" data-action="reset">Vymazať všetky dáta</button>
      </div>
    </details>
  </div>`;
}

function calName() {
  return `Škola${state.semester.name ? ' – ' + state.semester.name : ''}`;
}

/* ------------------------------- PDF import ------------------------------- */

let pdfjsPromise = null;
async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS).then((m) => {
      m.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return m;
    });
  }
  return pdfjsPromise;
}

const KIND_ORDER = { calendar: 0, timetable: 1, exams: 2, course: 3, unknown: 4 };

async function readSource(src) {
  if (src.text != null) return { name: src.name, text: src.text, pages: null, subjectId: src.subjectId, subjectName: src.subjectName };
  const isPdf = /pdf$/i.test(src.file.type) || /\.pdf$/i.test(src.file.name);
  if (!isPdf) return { name: src.file.name, text: await src.file.text(), pages: null };
  const pdfjs = await getPdfjs();
  const pages = await extractPdf(pdfjs, new Uint8Array(await src.file.arrayBuffer()));
  return { name: src.file.name, text: pages.map(pageToText).join('\n'), pages };
}

function sniff(doc) {
  const cal = parseAcademicCalendar(doc.text);
  if (cal) return { kind: 'calendar', cal };
  if (looksLikeExamList(doc.text)) return { kind: 'exams' };
  const tt = doc.pages ? parseTimetable(doc.pages) : parseListText(doc.text);
  const course = parseCourseDoc(doc.text.split('\n'));
  const nSubj = new Set(tt.classes.map((c) => normalizeName(c.subject))).size;
  if (tt.classes.length >= 3 && nSubj >= 2 && tt.classes.length > course.items.length) return { kind: 'timetable', tt };
  if (course.items.length || course.exams.length) return { kind: 'course', course };
  if (tt.classes.length) return { kind: 'timetable', tt };
  return { kind: 'unknown' };
}

/** One entry point for every file: timetable, faculty calendar, course docs. */
async function importFiles(sources) {
  if (!sources.length) return;
  const snapshot = JSON.stringify(state);
  ui.busy = 'import';
  const report = { entries: [], notes: [], snapshot };
  const docs = [];
  for (const [i, src] of sources.entries()) {
    const name = src.name || src.file.name;
    ui.busyText = `Čítam ${name} (${i + 1}/${sources.length})…`;
    render();
    try {
      const doc = await readSource(src);
      docs.push({ ...doc, ...sniff(doc) });
    } catch (e) {
      console.error(e);
      report.entries.push({ kind: 'unknown', file: name, text: `Nepodarilo sa prečítať: ${e.message}` });
    }
  }
  // Calendar first (weeks → dates), then the timetable (subjects), then course docs.
  docs.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  for (const d of docs) {
    if (d.kind === 'calendar') report.entries.push(applyCalendar(d));
    else if (d.kind === 'timetable') {
      applyParsed(d.tt.classes, { ask: false });
      const names = [...new Set(d.tt.classes.map((c) => c.subject))];
      report.entries.push({ kind: 'timetable', file: d.name, text: `${d.tt.classes.length} hodín z ${names.length} predmetov: ${names.join(', ')}` });
    } else if (d.kind === 'course') report.entries.push(applyCourse(d));
    else if (d.kind === 'exams') report.entries.push(...applyExamList(d));
    else {
      report.entries.push({
        kind: 'unknown', file: d.name,
        text: d.text.trim() ? 'Nenašiel som tu rozvrh, termíny ani týždne s testami.' : 'PDF neobsahuje text (asi je to sken/obrázok).',
      });
    }
  }
  if (!state.semester.start) {
    Object.assign(state.semester, guessSemester(todayISO()));
    report.notes.push(`Začiatok semestra som odhadol na ${fmtDate(state.semester.start)}. Ak nesedí, nahraj harmonogram fakulty alebo ho uprav nižšie.`);
  }
  ui.imported = report;
  ui.busy = null;
  ui.tab = 'home';
  ui.variant = 0;
  save();
}

function applyCalendar(d) {
  const sem = pickSemester(d.cal, todayISO());
  const s = state.semester;
  Object.assign(s, { name: sem.label, start: sem.start, weeks: sem.weeks, examStart: sem.examStart, examEnd: sem.examEnd, guessed: false });
  const end = sem.examEnd || addDays(sem.start, 7 * 22);
  const have = new Set(s.holidays.map((h) => h.date));
  const add = d.cal.holidays.filter((h) => h.date >= sem.start && h.date <= end && !have.has(h.date));
  s.holidays.push(...add);
  s.holidays.sort((a, b) => a.date.localeCompare(b.date));
  const wk = teachingWeeks(s);
  return {
    kind: 'calendar', file: d.name,
    text: `${sem.label}: výučba ${fmtDate(sem.start)} – ${fmtDate(sem.teachEnd)} (${wk.length} týždňov)` +
      `${sem.examStart ? `, skúškové ${fmtDate(sem.examStart)} – ${fmtDate(sem.examEnd)}` : ''}` +
      `${add.length ? `, voľné dni: ${add.map((h) => fmtDate(h.date)).join(', ')}` : ''}`,
  };
}

function applyCourse(d) {
  let subj = d.subjectId ? state.subjects.find((x) => x.id === d.subjectId) : ((d.subjectName && findSubject(d.subjectName)) || matchSubject(state.subjects, d.text));
  if (!subj) {
    const hint = d.subjectName || subjectHints(d.text).find((h) => h.length <= 50) || d.name.replace(/\.(pdf|txt)$/i, '');
    subj = newSubject(hint.trim());
    subj.fromDoc = true;
    state.subjects.push(subj);
  }
  const itemIds = [];
  for (const it of d.course.items) {
    // Re-importing the same document updates instead of duplicating.
    const same = subj.items.find((x) => x.kind === it.kind && normalizeName(x.title) === normalizeName(it.title));
    const retakes = retakeOptions(it.retakes);
    if (same) { Object.assign(same, { when: it.when, note: it.note || '', retakes }); itemIds.push(same.id); continue; }
    const item = { id: uid(), kind: it.kind, title: it.title, when: it.when, time: '', note: it.note || '', retakes, auto: true };
    subj.items.push(item);
    itemIds.push(item.id);
  }
  const examIds = d.course.exams.map((e) => addExam(subj, e));
  // "…predmetu Operačné systémy…" for "Operačné systémy a kyberbezpečnosť" → OS
  if (subj.shortAuto !== false) {
    const key = normalizeName(subj.name);
    const shorter = subjectHints(d.text).filter((h) => h.length < subj.name.length && key.startsWith(normalizeName(h)) && normalizeName(h).length >= 6);
    if (shorter.length) subj.short = initials(shorter[0]);
  }
  return { kind: 'course', file: d.name, subjectId: subj.id, itemIds, examIds };
}

/** Retake chances as values for the "Kedy" field. */
function retakeOptions(list) {
  if (!list || !list.length) return undefined;
  const out = [];
  for (const r of list) {
    if (!r.examPeriod) { out.push({ when: String(r.week), label: `${r.week}. týždeň` }); continue; }
    if (!isISO(state.semester.examStart)) continue;
    const mon = addDays(mondayOf(state.semester.examStart), 7 * (r.week - 1));
    out.push({ when: fmtDate(mon), label: `${r.week}. týždeň skúškového (od ${fmtDate(mon)})` });
  }
  return out.length ? out : undefined;
}

function retakeOf(subj, it) {
  return subj.items.find((x) => x.retakeOf === it.id);
}

/** "Idem na opravu" next to a test; on a retake: switch between its possible weeks. */
function retakeControls(subj, it) {
  if (it.kind !== 'test') return '';
  if (it.retakeOf) {
    const opts = it.retakes || [];
    if (opts.length < 2) return '';
    return `<span class="chips" style="display:inline-flex;margin:0">${opts.map((o) => `<button class="btn small ${o.when === it.when ? 'primary' : 'ghost'}"
      data-action="retake-when" data-sid="${subj.id}" data-iid="${it.id}" data-when="${esc(o.when)}">${esc(o.label)}</button>`).join('')}</span>`;
  }
  const r = retakeOf(subj, it);
  return r
    ? `<button class="btn small primary" data-action="retake" data-sid="${subj.id}" data-iid="${it.id}" title="Zrušiť opravu">🔁 Ideš na opravu ✕</button>`
    : `<button class="btn small" data-action="retake" data-sid="${subj.id}" data-iid="${it.id}">🔁 Idem na opravu</button>`;
}

/** Adds (or removes) the retake of a test. Picks the first retake chance that is still ahead. */
function toggleRetake(subj, it, { when, options, force } = {}) {
  const existing = retakeOf(subj, it);
  if (existing && !force) { subj.items = subj.items.filter((x) => x !== existing); return null; }
  const opts = options || it.retakes || [];
  const today = todayISO();
  const ahead = opts.find((o) => {
    const r = resolveItem({ ...it, when: o.when, retakeOf: it.id }, subj, state.classes, state.semester);
    return r.ok && (r.endDate || r.date) >= today;
  });
  const pick = when || (ahead || opts[opts.length - 1] || {}).when || '';
  if (existing) { existing.when = pick; existing.retakes = opts.length ? opts : existing.retakes; return existing; }
  const item = {
    id: uid(), kind: 'test', title: `Oprava: ${it.title}`, when: pick, time: '', note: '',
    retakeOf: it.id, retakes: opts.length ? opts : undefined, auto: true,
  };
  subj.items.splice(subj.items.indexOf(it) + 1, 0, item);
  return item;
}

/* ---- "#do=…" links: a prepared set of changes the student opens in their own app ---- */

function findSubject(hint) {
  if (!hint) return null;
  const h = fold(hint).replace(/[^a-z0-9]+/g, ' ').trim();
  return state.subjects.find((x) => fold(x.short || '') === h) ||
    state.subjects.find((x) => fold(x.name).replace(/[^a-z0-9]+/g, ' ').includes(h)) ||
    state.subjects.find((x) => h.includes(fold(x.name).replace(/[^a-z0-9]+/g, ' '))) || null;
}

function findItem(subj, hint) {
  const h = normalizeName(hint);
  return subj.items.find((x) => !x.retakeOf && normalizeName(x.title) === h) ||
    subj.items.find((x) => !x.retakeOf && (normalizeName(x.title).includes(h) || h.includes(normalizeName(x.title))));
}

async function runLinkActions(actions) {
  const snapshot = JSON.stringify(state);
  const texts = actions.filter((a) => a.t === 'text');
  if (texts.length) {
    await importFiles(texts.map((a) => ({ name: a.name || 'z odkazu', text: a.text, subjectId: findSubject(a.subject)?.id, subjectName: a.subject })));
  }
  const report = ui.imported || { entries: [], notes: [], snapshot };
  report.snapshot = snapshot;
  const touched = new Map();
  const mark = (subj, item) => { if (!touched.has(subj)) touched.set(subj, []); touched.get(subj).push(item.id); };
  for (const a of actions) {
    if (a.t === 'text') continue;
    const subj = findSubject(a.subject) || (a.alias && findSubject(a.alias));
    if (!subj) {
      if (a.t !== 'short') report.notes.push(`Nenašiel som predmet „${a.subject}“ – najprv nahraj rozvrh.`);
      continue;
    }
    if (a.t === 'short') { subj.short = a.short; subj.shortAuto = false; continue; }
    if (a.t === 'item') {
      const same = findItem(subj, a.title);
      if (same) { Object.assign(same, { when: a.when, ...(a.slot ? { slot: a.slot } : {}) }); mark(subj, same); continue; }
      const it = { id: uid(), kind: a.kind || 'test', title: a.title, when: a.when, time: a.time || '', note: a.note || '', slot: a.slot, auto: true };
      subj.items.push(it);
      mark(subj, it);
    } else if (a.t === 'retake') {
      let orig = findItem(subj, a.of);
      if (!orig) {
        orig = { id: uid(), kind: 'test', title: a.of, when: a.ofWhen || '', time: '', note: '', auto: true };
        subj.items.push(orig);
      }
      const opts = (a.options || []).map((w) => ({ when: String(w), label: /^\d+$/.test(String(w)) ? `${w}. týždeň` : String(w) }));
      const known = orig.retakes && orig.retakes.length ? orig.retakes : null;
      const r = toggleRetake(subj, orig, { when: a.when, options: known || (opts.length ? opts : undefined), force: true });
      mark(subj, orig);
      mark(subj, r);
    }
  }
  for (const [subj, ids] of touched) report.entries.push({ kind: 'course', file: 'odkaz', subjectId: subj.id, itemIds: ids, examIds: [] });
  ui.imported = report;
  ui.tab = 'home';
  save();
}

function readLinkActions() {
  const m = location.hash.match(/(?:^#|&)do=([^&]+)/);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const b64 = decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(bytes));
    return Array.isArray(data) ? data : null;
  } catch (e) {
    console.error(e);
    return null;
  }
}

/** Add or update one exam term; returns its id. */
function addExam(subj, e) {
  const same = subj.exams.find((x) => x.date === e.date && (!x.time || !e.time || x.time === e.time || (x.timeAuto && e.time)));
  if (same) {
    if (e.time) { same.time = e.time; same.timeAuto = false; }
    if (e.retakeOnly != null) same.retakeOnly = Boolean(e.retakeOnly);
    if (e.note && !same.note) same.note = e.note;
    return same.id;
  }
  const x = { id: uid(), date: e.date, time: e.time || '09:00', timeAuto: !e.time, note: e.note || '', retakeOnly: Boolean(e.retakeOnly) };
  subj.exams.push(x);
  subj.exams.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return x.id;
}

/** Terms copied from the student system (MAIS): several subjects at once. */
function applyExamList(d) {
  const terms = parseExamList(d.text, state.subjects);
  const groups = new Map();
  for (const t of terms) {
    let subj = t.subjectId && state.subjects.find((x) => x.id === t.subjectId);
    if (!subj) {
      subj = state.subjects.find((x) => normalizeName(x.name) === normalizeName(t.subjectName));
      if (!subj) { subj = newSubject(t.subjectName); state.subjects.push(subj); }
    }
    if (!groups.has(subj)) groups.set(subj, []);
    groups.get(subj).push(t);
    // "Skúška z OOP", "DM- skúšajúci …", "ÚŠaAvBS - skúška": the system's own abbreviation.
    if (subj.shortAuto !== false) {
      const ab = (t.title.match(/(?:^|\s|z\s)([A-ZÁ-Ž][A-Za-zÁ-ž]{1,7})(?=\s*[-–]|\s*$)/) || [])[1];
      if (ab && /[A-ZÁ-Ž].*[A-ZÁ-Ž]/.test(ab) && fold(initials(subj.name, true)).startsWith(fold(ab[0]))) subj.short = ab;
    }
  }
  const out = [];
  for (const [subj, list] of groups) {
    const teachers = state.classes.filter((c) => c.subjectId === subj.id).map((c) => c.teacher || '').join(' ');
    const { terms: kept, examiner } = narrowTerms(list, teachers);
    const examIds = kept.map((t) => addExam(subj, {
      date: t.date, time: t.time, retakeOnly: t.retakeOnly,
      note: [t.room, t.regUntil ? `prihlásiť do ${fmtDate(t.regUntil)}` : ''].filter(Boolean).join(' · '),
    }));
    out.push({ kind: 'exams', file: d.name, subjectId: subj.id, examIds: [...new Set(examIds)], examiner });
  }
  if (!out.length) out.push({ kind: 'unknown', file: d.name, text: 'Nenašiel som termíny skúšok.' });
  return out;
}

/** Typical Slovak semester when no faculty calendar was given. */
function guessSemester(today) {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const firstMonday = (d) => { let x = d; while (new Date(`${x}T12:00:00Z`).getUTCDay() !== 1) x = addDays(x, 1); return x; };
  if (m >= 7 || m === 1) {
    const yy = m === 1 ? y - 1 : y;
    const examStart = firstMonday(`${yy + 1}-01-02`);
    return { name: `ZS ${yy}/${String(yy + 1).slice(2)}`, start: firstMonday(`${yy}-09-20`), weeks: 13, examStart, examEnd: addDays(examStart, 39), guessed: true };
  }
  const start = firstMonday(`${y}-02-09`);
  const examStart = addDays(start, 13 * 7);
  return { name: `LS ${y - 1}/${String(y).slice(2)}`, start, weeks: 13, examStart, examEnd: addDays(examStart, 39), guessed: true };
}

function applyParsed(parsed, { ask = true } = {}) {
  const replace = !state.classes.length || !ask ||
    confirm('Nahradiť doterajšie hodiny tými z nového rozvrhu?\n\nOK = nahradiť, Zrušiť = pridať k existujúcim.\n(Predmety, testy a skúšky ostanú.)');
  if (replace) state.classes = [];
  for (const p of parsed) {
    const key = normalizeName(p.subject);
    let s = state.subjects.find((x) => normalizeName(x.name) === key || (x.short && normalizeName(x.short) === key));
    if (!s) {
      // A subject first created from a course document under a shorter name.
      s = state.subjects.find((x) => x.fromDoc && (key.startsWith(normalizeName(x.name)) || normalizeName(x.name).startsWith(key)));
      if (s) { s.name = p.subject; s.fromDoc = false; }
    }
    if (!s) {
      s = newSubject(p.subject);
      state.subjects.push(s);
    }
    state.classes.push({
      id: uid(), subjectId: s.id, type: p.type || '?', day: p.day, start: p.start, end: p.end,
      room: p.room || '', teacher: p.teacher || '', parity: p.parity || 'all', weeks: p.weeks || '',
    });
  }
}

function initials(name, all = false) {
  return name.split(/\s+/).filter((w) => all || w.length > 2 || /^\d+$/.test(w)).map((w) => (/^\d+$/.test(w) ? w : w[0].toUpperCase())).join('');
}

function fold(t) {
  return String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function newSubject(name) {
  const short = name.length > 14 ? initials(name) : '';
  return { id: uid(), name, short, shortAuto: true, credits: 5, difficulty: 3, prepDays: '', wantRetake: true, items: [], exams: [] };
}

/* --------------------------------- events --------------------------------- */

document.getElementById('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  ui.tab = b.dataset.tab;
  localStorage.setItem('rozvrhar:tab', ui.tab);
  render();
  window.scrollTo({ top: 0 });
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.id === 'anyInput' && el.files.length) { importFiles([...el.files].map((file) => ({ file }))); el.value = ''; return; }
  if (el.dataset?.importMove != null) { moveImported(Number(el.dataset.importMove), el.value); return; }
  if (el.id === 'restore' && el.files[0]) { restoreBackup(el.files[0]); return; }
  const path = el.dataset?.bind;
  if (!path) return;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (el.dataset.type === 'number') v = v === '' ? '' : Number(v);
  if (path.endsWith('.time') && v && el.type !== 'time') v = parseTime(v) || v;
  setPath(path, v);
  if (/^subjects\.\d+\.short$/.test(path)) getPath(path.replace(/\.short$/, '')).shortAuto = false;
  if (path === 'semester.start' && isISO(v) && !state.semester.examStart) {
    const wk = teachingWeeks(state.semester);
    if (wk.length) state.semester.examStart = addDays(wk[wk.length - 1].monday, 7);
  }
  if (path.includes('.exams.') && path.endsWith('.date')) ui.variant = 0;
  save();
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'weekQuery') {
    ui.weekQuery = e.target.value;
    render();
  }
});

document.addEventListener('click', async (e) => {
  const go = e.target.closest('[data-goto]');
  if (go) {
    ui.tab = go.dataset.goto;
    localStorage.setItem('rozvrhar:tab', ui.tab);
    render();
    window.scrollTo({ top: 0 });
    return;
  }
  const b = e.target.closest('[data-action]');
  if (!b) return;
  const a = b.dataset.action;
  const si = Number(b.dataset.si);
  const i = Number(b.dataset.i);
  const s = state.subjects[si];
  try {
    switch (a) {
      case 'signin': return await doSignIn();
      case 'signout': G.signOut(); ui.user = null; toast('Odhlásený'); return render();
      case 'add-holiday': {
        const v = document.getElementById('newHoliday').value;
        if (!isISO(v)) return toast('Vyber dátum');
        state.semester.holidays.push({ date: v, name: '' });
        state.semester.holidays.sort((x, y) => x.date.localeCompare(y.date));
        return save();
      }
      case 'add-sk-holidays': {
        const start = state.semester.start;
        const end = state.semester.examEnd && isISO(state.semester.examEnd) ? state.semester.examEnd : addDays(start, 7 * 22);
        const years = [...new Set([start.slice(0, 4), end.slice(0, 4)])].map(Number);
        const have = new Set(state.semester.holidays.map((h) => h.date));
        const add = years.flatMap(skHolidays).filter((h) => h.date >= start && h.date <= end && !have.has(h.date));
        state.semester.holidays.push(...add);
        state.semester.holidays.sort((x, y) => x.date.localeCompare(y.date));
        toast(add.length ? `Pridaných ${add.length} sviatkov – skontroluj, či sedia s harmonogramom školy.` : 'Žiadne nové sviatky');
        return save();
      }
      case 'del-holiday': state.semester.holidays.splice(i, 1); return save();
      case 'add-skip': {
        const v = document.getElementById('newSkip').value;
        if (!isISO(v)) return toast('Vyber ľubovoľný deň v tom týždni');
        state.semester.skipWeeks.push(mondayOf(v));
        state.semester.skipWeeks = [...new Set(state.semester.skipWeeks)].sort();
        return save();
      }
      case 'del-skip': state.semester.skipWeeks.splice(i, 1); return save();
      case 'add-class': {
        state.classes.push({ id: uid(), subjectId: state.subjects[0].id, type: 'C', day: 0, start: '08:00', end: '09:40', room: '', parity: 'all', weeks: '' });
        return save();
      }
      case 'del-class': state.classes.splice(i, 1); return save();
      case 'clear-classes': if (confirm('Vymazať všetky hodiny?')) { state.classes = []; save(); } return;
      case 'parse-text': {
        const txt = document.getElementById('ttText').value;
        const res = parseListText(txt);
        if (!res.classes.length) return toast('Nenašiel som žiadne riadky s dňom a časom (napr. „Pondelok“ a „7:30-9:00 …“)', 4000);
        applyParsed(res.classes);
        ui.parseNote = { ok: true, text: `Načítaných ${res.classes.length} hodín.` };
        return save();
      }
      case 'add-subject': {
        const name = prompt('Názov predmetu');
        if (!name) return;
        state.subjects.push(newSubject(name.trim()));
        return save();
      }
      case 'del-subject': {
        if (!confirm(`Odstrániť predmet ${s.name} aj s jeho hodinami, testami a termínmi?`)) return;
        state.classes = state.classes.filter((c) => c.subjectId !== s.id);
        state.subjects.splice(si, 1);
        return save();
      }
      case 'add-item': s.items.push({ id: uid(), kind: 'test', title: '', when: '', time: '' }); return save();
      case 'del-item': s.items.splice(Number(b.dataset.ii), 1); return save();
      case 'add-exam': {
        const lastE = s.exams[s.exams.length - 1];
        s.exams.push({ id: uid(), date: lastE ? addDays(lastE.date, 7) : (state.semester.examStart || ''), time: lastE?.time || '09:00', note: '' });
        return save();
      }
      case 'del-exam': {
        const [removed] = s.exams.splice(Number(b.dataset.ei), 1);
        if (removed && s.lockedExamId === removed.id) s.lockedExamId = null;
        return save();
      }
      case 'bulk-exams': {
        const txt = prompt('Vlož termíny, každý na nový riadok, napr.:\n12.1.2027 9:00 D-201\n19.1. 13:00\n2.2. 9:00');
        if (!txt) return;
        let n = 0;
        for (const line of txt.split(/\n|;/)) {
          const m = line.trim().match(/^(\d{1,2}\s*\.\s*\d{1,2}\s*\.?\s*(?:\d{4})?|\d{4}-\d{2}-\d{2})\s*(?:o\s*)?(\d{1,2}[:.]\d{2})?\s*(.*)$/i);
          if (!m) continue;
          const date = parseUserDate(m[1].replace(/\s+/g, ''), state.semester.examStart || state.semester.start);
          if (!date) continue;
          s.exams.push({ id: uid(), date, time: parseTime(m[2]) || '', note: (m[3] || '').trim() });
          n++;
        }
        s.exams.sort((x, y) => x.date.localeCompare(y.date));
        toast(`Pridaných ${n} termínov`);
        return save();
      }
      case 'variant': ui.variant = i; return render();
      case 'import-text': {
        const text = document.getElementById('anyText').value;
        if (!text.trim()) return toast('Najprv vlož text');
        const subjectId = document.getElementById('anyTextSubj').value || undefined;
        return await importFiles([{ name: 'vložený text', text, subjectId }]);
      }
      case 'retake': {
        const subj = state.subjects.find((x) => x.id === b.dataset.sid);
        const it = subj?.items.find((x) => x.id === b.dataset.iid);
        if (!it) return;
        const r = toggleRetake(subj, it);
        if (r) {
          const res = resolveItem(r, subj, state.classes, state.semester);
          toast(res.ok ? `🔁 Oprava: ${fmtDay(res.date)}${res.allDay ? '' : ' ' + res.start}` : '🔁 Oprava pridaná – doplň, kedy je', 3500);
          if (ui.imported) ui.imported.entries.forEach((e) => { if (e.subjectId === subj.id && e.itemIds?.includes(it.id)) e.itemIds.push(r.id); });
        }
        return save();
      }
      case 'retake-when': {
        const subj = state.subjects.find((x) => x.id === b.dataset.sid);
        const it = subj?.items.find((x) => x.id === b.dataset.iid);
        if (it) it.when = b.dataset.when;
        return save();
      }
      case 'undo-import': {
        if (!ui.imported) return;
        state = merge(defaultState(), JSON.parse(ui.imported.snapshot));
        ui.imported = null;
        toast('Vrátené');
        return save();
      }
      case 'lock': {
        const subj = state.subjects.find((x) => x.id === b.dataset.sid);
        subj.lockedExamId = subj.lockedExamId === b.dataset.eid ? null : b.dataset.eid;
        ui.variant = 0;
        return save();
      }
      case 'add-blocked': {
        const v = document.getElementById('newBlocked').value;
        if (!isISO(v)) return toast('Vyber dátum');
        state.settings.blocked = [...new Set([...(state.settings.blocked || []), v])].sort();
        ui.variant = 0;
        return save();
      }
      case 'del-blocked': state.settings.blocked.splice(i, 1); return save();
      case 'download-ics': {
        const { events } = buildOutputs(state, currentPlanRows());
        download(`${calName().replace(/[^\w\-–ľščťžýáíéúäôňďĺŕó ]/gi, '')}.ics`, buildICS(events, calName()), 'text/calendar');
        return;
      }
      case 'export-google': return await exportGoogle();
      case 'tt-connect': return TT.connectTickTick();
      case 'tt-disconnect': TT.disconnectTickTick(); return render();
      case 'export-tt': return await exportTickTick();
      case 'copy-tasks': {
        const { tasks } = buildOutputs(state, currentPlanRows());
        const text = tasks.map((t) => `${t.title} – ${fmtDate(t.date)}${t.time ? ' ' + t.time : ''}`).join('\n');
        await navigator.clipboard.writeText(text);
        return toast('Skopírované – v TickTicku vlož do poľa novej úlohy');
      }
      case 'save-conn': {
        localStorage.setItem('rozvrhar:gcid', document.getElementById('gcid').value.trim());
        localStorage.setItem('rozvrhar:ttProxy', document.getElementById('ttproxy').value.trim());
        toast('Uložené');
        return render();
      }
      case 'backup': return download(`rozvrhar-zaloha-${todayISO()}.json`, JSON.stringify(state, null, 2), 'application/json');
      case 'reset': {
        if (!confirm('Naozaj vymazať všetky dáta v tomto prehliadači?')) return;
        state = defaultState();
        return save();
      }
      default:
    }
  } catch (err) {
    console.error(err);
    ui.busy = null;
    render();
    toast(err.message || String(err), 5000);
  }
});

function moveImported(ei, subjectId) {
  const e = ui.imported?.entries[ei];
  if (!e || e.subjectId === subjectId) return;
  const from = state.subjects.find((x) => x.id === e.subjectId);
  const to = state.subjects.find((x) => x.id === subjectId);
  if (!from || !to) return;
  const moving = from.items.filter((it) => e.itemIds.includes(it.id));
  from.items = from.items.filter((it) => !e.itemIds.includes(it.id));
  to.items.push(...moving);
  // Drop a subject that only existed because of this document.
  if (from.fromDoc && !from.items.length && !from.exams.length && !state.classes.some((c) => c.subjectId === from.id)) {
    state.subjects = state.subjects.filter((x) => x !== from);
  }
  e.subjectId = to.id;
  save();
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function restoreBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data.semester || !Array.isArray(data.subjects)) throw new Error('Toto nie je záloha Rozvrhára');
    state = merge(defaultState(), data);
    save();
    toast('Obnovené');
  } catch (e) {
    toast(e.message, 4000);
  }
}

function setProgress(done, total) {
  const p = document.getElementById('prog');
  if (p) p.style.width = `${Math.round((done / total) * 100)}%`;
}

async function doSignIn() {
  await G.signIn();
  ui.user = await G.userInfo();
  toast(`Prihlásený: ${ui.user.email}`);
  try {
    const remote = await G.loadFromDrive();
    if (remote?.data && remote.data.savedAt > (state.savedAt || 0) &&
        (state.savedAt === 0 || confirm('Na Google Drive sú novšie dáta (z iného zariadenia). Načítať ich?'))) {
      state = merge(defaultState(), remote.data);
      localStorage.setItem(STORE, JSON.stringify(state));
      toast('Dáta načítané z Google Drive');
    } else {
      await G.saveToDrive(state);
    }
  } catch (e) {
    toast(`Synchronizácia zlyhala: ${e.message}`, 4000);
  }
  render();
}

async function exportGoogle() {
  const { events } = buildOutputs(state, currentPlanRows());
  ui.busy = 'google';
  render();
  if (!G.isSignedIn()) {
    await G.signIn();
    ui.user = await G.userInfo();
  }
  const res = await G.exportToCalendar(events, { name: calName(), previousId: state.sync.calendarId, onProgress: setProgress });
  state.sync.calendarId = res.calendarId;
  state.sync.lastExport = { ...(state.sync.lastExport || {}), google: Date.now() };
  ui.busy = null;
  save();
  toast(res.failures.length ? `Hotovo, ale ${res.failures.length} udalostí zlyhalo: ${res.failures[0]}` : `✅ V Google Kalendári je ${events.length} udalostí`, 5000);
}

async function exportTickTick() {
  const { tasks } = buildOutputs(state, currentPlanRows());
  const upcoming = tasks.filter((t) => diffDays(todayISO(), t.date) >= -1);
  ui.busy = 'tt';
  render();
  const res = await TT.exportToTickTick(upcoming, { listName: state.settings.listName || 'Škola', map: state.sync.ttMap, onProgress: setProgress });
  state.sync.ttMap = res.map;
  state.sync.lastExport = { ...(state.sync.lastExport || {}), tt: Date.now() };
  ui.busy = null;
  save();
  toast(res.failures.length ? `Hotovo, ${res.failures.length} úloh zlyhalo: ${res.failures[0]}` : `✅ ${upcoming.length} úloh v TickTicku`, 5000);
}

document.addEventListener('dragover', (e) => {
  const drop = e.target.closest?.('#drop');
  if (!drop) return;
  e.preventDefault();
  drop.classList.add('over');
});
document.addEventListener('dragleave', (e) => e.target.closest?.('#drop')?.classList.remove('over'));
document.addEventListener('drop', (e) => {
  const drop = e.target.closest?.('#drop');
  if (!drop) return;
  e.preventDefault();
  drop.classList.remove('over');
  const files = [...e.dataTransfer.files];
  if (files.length) importFiles(files.map((file) => ({ file })));
});

/* ---------------------------------- boot ---------------------------------- */

const tt = TT.captureTokenFromHash();
if (tt) {
  ui.tab = 'export';
  setTimeout(() => toast(tt.ok ? '✅ TickTick pripojený' : `TickTick: ${tt.error}`, 4000), 300);
}
render();

function handleLink() {
  const actions = readLinkActions();
  if (!actions) return;
  runLinkActions(actions).then(() => toast('✅ Zmeny z odkazu sú pridané – skontroluj ich', 4000))
    .catch((e) => { console.error(e); toast(`Odkaz sa nepodarilo použiť: ${e.message}`, 5000); });
}
handleLink();
// The app may already be open in this tab when the link is opened.
window.addEventListener('hashchange', handleLink);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
