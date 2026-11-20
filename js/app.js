import {
  DAY_NAMES, DAY_SHORT, addDays, diffDays, fmtDate, fmtDay, isISO, mondayOf, parseTime, parseUserDate,
  skHolidays, timeToMin, todayISO,
} from './dates.js';
import { describeWhen, parseWhen, teachingWeeks, weekByNumber, weekOf, weekStatus, holidayName } from './weeks.js';
import { CLASS_TYPES, ITEM_KINDS, examPrepDays, planExams, resolveItem, rowVerdict } from './planner.js';
import { buildOutputs } from './outputs.js';
import { buildICS } from './ics.js';
import { normalizeName, parseListText, parseTimetable } from './timetable-parse.js';
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
const ui = { tab: localStorage.getItem('rozvrhar:tab') || 'semester', variant: 0, weekQuery: '', busy: null, user: null };
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
  const views = { semester: viewSemester, timetable: viewTimetable, subjects: viewSubjects, plan: viewPlan, export: viewExport };
  morph(main, (views[ui.tab] || viewSemester)());
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

  return `
  ${!s.start ? `<div class="card"><h2>Ahoj 👋</h2>
    <ol class="steps">
      <li>Nastav <b>začiatok semestra</b> – od neho sa počítajú týždne.</li>
      <li>V záložke <b>Rozvrh</b> nahraj PDF rozvrhu (alebo ho vlož ako text).</li>
      <li>V <b>Predmetoch</b> zadaj testy a zadania tak, ako sú v sylabe („12. týždeň“), a termíny skúšok.</li>
      <li><b>Plán</b> ti ukáže dátumy a odporučí, na ktoré termíny skúšok sa prihlásiť.</li>
      <li><b>Export</b> pošle všetko do Google Kalendára a TickTicku.</li>
    </ol></div>` : ''}
  <div class="card">
    <h2>Semester</h2>
    <div class="grid">
      ${field('Názov', 'semester.name', { placeholder: 'ZS 2026/27' })}
      ${field('Začiatok (1. týždeň)', 'semester.start', { type: 'date' })}
      ${field('Počet týždňov výučby', 'semester.weeks', { type: 'number', attrs: 'min="1" max="30"' })}
      ${field('Skúškové od', 'semester.examStart', { type: 'date' })}
      ${field('Skúškové do', 'semester.examEnd', { type: 'date' })}
    </div>
  </div>

  <div class="card">
    <h2>Kalkulačka týždňov</h2>
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
    <h2>Voľné dni a prerušenia</h2>
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
      <input type="file" id="pdfInput" accept="application/pdf,.pdf">
      <div class="big">📄</div>
      <div><b>Klikni alebo sem pretiahni PDF rozvrhu</b></div>
      <small>PDF sa spracuje priamo v prehliadači – nikam sa neposiela.</small>
    </label>
    ${ui.busy === 'pdf' ? '<p>Čítam PDF…</p>' : ''}
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
        <div class="res">${res}</div>
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

async function importPdf(file) {
  ui.busy = 'pdf';
  ui.parseNote = null;
  render();
  try {
    const pdfjs = await getPdfjs();
    const pages = await extractPdf(pdfjs, new Uint8Array(await file.arrayBuffer()));
    const res = parseTimetable(pages);
    if (!res.classes.length) {
      const anyText = pages.some((p) => p.items.length);
      ui.parseNote = {
        ok: false,
        text: anyText ? `Z PDF som nevedel vyčítať hodiny${res.notes[0] ? ' (' + res.notes[0] + ')' : ''}. Skús ho vložiť ako text alebo pridaj hodiny ručne.`
          : 'PDF neobsahuje text (asi je to obrázok/sken). Vlož rozvrh ako text alebo pridaj hodiny ručne.',
      };
    } else {
      applyParsed(res.classes);
      ui.parseNote = { ok: true, text: `Načítaných ${res.classes.length} hodín z ${new Set(res.classes.map((c) => normalizeName(c.subject))).size} predmetov. Skontroluj ich nižšie.` };
    }
  } catch (e) {
    console.error(e);
    ui.parseNote = { ok: false, text: `Chyba pri čítaní PDF: ${e.message}` };
  }
  ui.busy = null;
  save();
}

function applyParsed(parsed) {
  const replace = !state.classes.length ||
    confirm('Nahradiť doterajšie hodiny tými z nového rozvrhu?\n\nOK = nahradiť, Zrušiť = pridať k existujúcim.\n(Predmety, testy a skúšky ostanú.)');
  if (replace) state.classes = [];
  for (const p of parsed) {
    const key = normalizeName(p.subject);
    let s = state.subjects.find((x) => normalizeName(x.name) === key || (x.short && normalizeName(x.short) === key));
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

function newSubject(name) {
  const short = name.length > 14
    ? name.split(/\s+/).filter((w) => w.length > 2 || /^\d+$/.test(w)).map((w) => (/^\d+$/.test(w) ? w : w[0].toUpperCase())).join('')
    : '';
  return { id: uid(), name, short, credits: 5, difficulty: 3, prepDays: '', wantRetake: true, items: [], exams: [] };
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
  if (el.id === 'pdfInput' && el.files[0]) { importPdf(el.files[0]); return; }
  if (el.id === 'restore' && el.files[0]) { restoreBackup(el.files[0]); return; }
  const path = el.dataset?.bind;
  if (!path) return;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (el.dataset.type === 'number') v = v === '' ? '' : Number(v);
  if (path.endsWith('.time') && v && el.type !== 'time') v = parseTime(v) || v;
  setPath(path, v);
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
  const f = e.dataTransfer.files[0];
  if (f) importPdf(f);
});

/* ---------------------------------- boot ---------------------------------- */

const tt = TT.captureTokenFromHash();
if (tt) {
  ui.tab = 'export';
  setTimeout(() => toast(tt.ok ? '✅ TickTick pripojený' : `TickTick: ${tt.error}`, 4000), 300);
}
render();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
