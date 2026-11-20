// Turns the app state + chosen exam plan into calendar events and tasks.
import { addDays, diffDays, fmtDate, todayISO, addMinutes } from './dates.js';
import { classOccurrences } from './weeks.js';
import { CLASS_TYPES, ITEM_KINDS, resolveItem, studyPlan } from './planner.js';

// Google Calendar colorIds
const COLORS = { P: '9', C: '10', L: '6', S: '5', '?': '8', item: '11', exam: '11', study: '7' };

export function buildOutputs(state, planRows) {
  const { semester: sem, classes, subjects, settings } = state;
  const byId = Object.fromEntries(subjects.map((s) => [s.id, s]));
  const events = [];
  const tasks = [];
  const today = todayISO();
  const remind = Number(settings.reminderMin) || 0;

  // Weekly classes
  for (const c of classes) {
    const s = byId[c.subjectId];
    if (!s || !c.start || !c.end) continue;
    const occ = classOccurrences(sem, c);
    if (!occ.length) continue;
    const dates = new Set(occ.map((o) => o.date));
    const first = occ[0].date;
    const last = occ[occ.length - 1].date;
    const exdates = [];
    for (let d = first; diffDays(d, last) >= 0; d = addDays(d, 7)) if (!dates.has(d)) exdates.push(d);
    events.push({
      key: `class:${c.id}`,
      category: 'class',
      title: `${s.short || s.name} – ${CLASS_TYPES[c.type] || c.type}`,
      description: [s.name, c.teacher, c.parity !== 'all' ? (c.parity === 'odd' ? 'nepárne týždne' : 'párne týždne') : '', c.weeks ? `týždne ${c.weeks}` : '']
        .filter(Boolean).join('\n'),
      location: c.room || '',
      date: first, start: c.start, end: c.end, allDay: false,
      recurrence: { until: last, exdates },
      reminders: settings.classReminder ? [10] : [],
      colorId: COLORS[c.type] || COLORS['?'],
    });
  }

  // Tests, assignments, …
  const testGroups = {};
  for (const s of subjects) {
    for (const it of s.items || []) {
      const r = resolveItem(it, s, classes, sem);
      if (!r.ok) continue;
      const kind = ITEM_KINDS[it.kind] || ITEM_KINDS.ine;
      const title = `${kind.icon} ${it.title || kind.label} – ${s.short || s.name}`;
      const note = [
        `${kind.label}, ${s.name}`,
        it.when ? `Zadané ako: ${it.when}` : '',
        r.approx && r.via === 'week' ? 'Presný deň nie je známy – blokovaný je celý týždeň.' : '',
        r.approx && r.via === 'class' ? 'Zadané rozpätie týždňov – vybraná prvá hodina v ňom.' : '',
        it.note || '',
      ].filter(Boolean).join('\n');
      events.push({
        key: `item:${it.id}`, category: 'item', title, description: note, location: '',
        date: r.date, endDate: r.endDate || r.date, start: r.start, end: r.end, allDay: r.allDay,
        reminders: [24 * 60, ...(remind ? [remind] : [])].filter((m) => r.allDay ? true : m > 0),
        colorId: COLORS.item,
      });
      tasks.push({
        key: `item:${it.id}`, kind: 'item', title, content: note,
        date: r.date, time: r.allDay ? null : r.start, priority: 5,
      });
      // Study days before credit tests ("zápočtovka"), like before exams.
      const testDays = Number(settings.testStudyDays) || 0;
      if (testDays > 0 && (it.kind === 'test' || it.kind === 'zapocet')) {
        // Two tests of one subject on the same day share their study days.
        const group = `${s.id}:${r.date}`;
        const names = (testGroups[group] = testGroups[group] || []);
        names.push(it.title || kind.label);
        if (names.length > 1) continue;
        for (let k = testDays; k >= 1; k--) {
          const d = addDays(r.date, -k);
          if (diffDays(today, d) < 0) continue;
          tasks.push({
            key: `tstudy:${it.id}:${d}`, kind: 'study', group, step: k,
            title: '', content: `${kind.label} je ${fmtDate(r.date)}${r.start ? ' o ' + r.start : ''}.`, date: d, time: null, priority: 1,
            subjectLabel: s.short || s.name,
          });
        }
        continue;
      }
      const prep = it.prepDays === '' || it.prepDays == null ? kind.prep : Number(it.prepDays);
      if (prep > 0) {
        const pd = addDays(r.date, -prep);
        if (diffDays(today, pd) >= 0 || diffDays(today, r.date) > 0) {
          tasks.push({
            key: `prep:${it.id}`, kind: 'prep',
            title: `Začni sa pripravovať: ${it.title || kind.label} – ${s.short || s.name}`,
            content: `${kind.label} je ${fmtDate(r.date)}${r.start ? ' o ' + r.start : ''}.`,
            date: diffDays(today, pd) >= 0 ? pd : today, time: null, priority: 3,
          });
        }
      }
    }
  }

  // Exams + study plan
  if (planRows && planRows.length) {
    for (const r of planRows) {
      const s = r.subject;
      const e = r.exam;
      const start = e.time || null;
      const desc = [`Skúška: ${s.name}`, e.note || '', r.retake ? `Opravný termín najskôr: ${fmtDate(r.retake.date)}` : 'Po tomto termíne už nie je opravný.']
        .filter(Boolean).join('\n');
      events.push({
        key: `exam:${s.id}`, category: 'exam', title: `🎓 Skúška – ${s.short || s.name}`,
        description: desc, location: e.room || '',
        date: e.date, start, end: start ? addMinutes(start, Number(settings.examMinutes) || 120) : null,
        allDay: !start, reminders: [24 * 60, 120], colorId: COLORS.exam,
      });
      tasks.push({
        key: `exam:${s.id}`, kind: 'exam', title: `🎓 Skúška – ${s.name}`, content: desc,
        date: e.date, time: start, priority: 5,
      });
      if (settings.registerReminder !== false) {
        let due = addDays(e.date, -10);
        if (diffDays(today, due) < 0) due = today;
        if (diffDays(today, e.date) >= 0) {
          tasks.push({
            key: `reg:${s.id}`, kind: 'register', title: `Prihlásiť sa na skúšku: ${s.name} (${fmtDate(e.date)})`,
            content: 'Prihlás sa na termín v AIS/MAIS, kým je voľné miesto.', date: due, time: null, priority: 3,
          });
        }
      }
    }
    for (const t of studyPlan(planRows, sem)) {
      const s = byId[t.subjectId];
      const key = `study:${t.subjectId}:${t.date}`;
      tasks.push({ key, kind: 'study', title: `📚 ${t.title}`, content: '', date: t.date, time: null, priority: 1 });
      if (settings.studyInCalendar) {
        events.push({
          key, category: 'study', title: `📚 ${t.title}`, description: s ? s.name : '', location: '',
          date: t.date, allDay: true, reminders: [], colorId: COLORS.study,
        });
      }
    }
  }

  // Name the shared study days now that every test of the day is known.
  for (const t of tasks) {
    if (!t.group) continue;
    const testDays = Number(settings.testStudyDays) || 0;
    const label = `${testGroups[t.group].join(' + ')} – ${t.subjectLabel}`;
    t.title = t.step === 1 ? `📚 Opakovanie: ${label}` : `📚 Učenie: ${label} (${testDays - t.step + 1}/${testDays - 1})`;
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || (a.start || '').localeCompare(b.start || ''));
  tasks.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
  return { events, tasks };
}
