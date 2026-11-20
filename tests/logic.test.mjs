import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUserDate, skHolidays, toOffsetString, weekday } from '../js/dates.js';
import { classOccurrences, parseWhen, teachingWeeks, weekOf } from '../js/weeks.js';
import { planExams, resolveItem, studyPlan } from '../js/planner.js';
import { buildICS } from '../js/ics.js';
import { buildOutputs } from '../js/outputs.js';
import { classify, parseListText } from '../js/timetable-parse.js';

const sem = { start: '2026-09-21', weeks: 13, skipWeeks: [], holidays: [{ date: '2026-11-17', name: 'Sviatok' }], examStart: '2026-12-21', examEnd: '2027-02-12' };

test('teaching weeks and week lookup', () => {
  const w = teachingWeeks(sem);
  assert.equal(w.length, 13);
  assert.equal(w[11].monday, '2026-12-07'); // week 12
  assert.equal(weekOf(sem, '2026-12-10'), 12);
  const skipped = teachingWeeks({ ...sem, skipWeeks: ['2026-11-02'] });
  assert.equal(skipped[6].monday, '2026-11-09'); // week 7 moves past the break
});

test('parseWhen understands weeks, ranges and dates', () => {
  assert.deepEqual(parseWhen('12. týždeň', sem), { kind: 'week', from: 12, to: 12 });
  assert.deepEqual(parseWhen('12-13', sem), { kind: 'week', from: 12, to: 13 });
  assert.deepEqual(parseWhen('12./13.', sem), { kind: 'week', from: 12, to: 13 });
  assert.deepEqual(parseWhen('T7', sem), { kind: 'week', from: 7, to: 7 });
  assert.deepEqual(parseWhen('10.12.', sem), { kind: 'date', date: '2026-12-10' });
  assert.deepEqual(parseWhen('15.1.', sem), { kind: 'date', date: '2027-01-15' });
  assert.equal(parseWhen('hocico', sem), null);
  assert.equal(parseUserDate('31.2.2026'), null);
});

test('class occurrences honor parity and holidays', () => {
  const tue = classOccurrences(sem, { day: 1, parity: 'all' });
  assert.ok(!tue.some((o) => o.date === '2026-11-17'));
  assert.equal(tue.length, 12);
  const odd = classOccurrences(sem, { day: 0, parity: 'odd' });
  assert.deepEqual(odd.map((o) => o.n), [1, 3, 5, 7, 9, 11, 13]);
  assert.equal(weekday(odd[0].date), 0);
});

test('item in week 12 lands on the seminar slot', () => {
  const subject = { id: 's1', name: 'OOP' };
  const classes = [
    { id: 'c1', subjectId: 's1', type: 'P', day: 0, start: '07:30', end: '09:00', parity: 'all' },
    { id: 'c2', subjectId: 's1', type: 'C', day: 2, start: '10:50', end: '12:20', parity: 'all' },
  ];
  const r = resolveItem({ kind: 'test', when: '12' }, subject, classes, sem);
  assert.equal(r.date, '2026-12-09');
  assert.equal(r.start, '10:50');
  const none = resolveItem({ kind: 'test', when: '12' }, { id: 'x', name: 'X' }, classes, sem);
  assert.equal(none.allDay, true);
  assert.equal(none.endDate, '2026-12-11');
});

test('exam planner spreads exams and keeps retakes', () => {
  const subjects = [
    { id: 'a', name: 'Matematika', difficulty: 5, credits: 6, exams: [
      { id: 'a1', date: '2027-01-05' }, { id: 'a2', date: '2027-01-15' }, { id: 'a3', date: '2027-02-02' }] },
    { id: 'b', name: 'OOP', difficulty: 3, credits: 6, exams: [
      { id: 'b1', date: '2027-01-05' }, { id: 'b2', date: '2027-01-08' }, { id: 'b3', date: '2027-01-26' }] },
    { id: 'c', name: 'Angličtina', difficulty: 1, credits: 2, exams: [{ id: 'c1', date: '2027-01-07' }, { id: 'c2', date: '2027-01-20' }] },
  ];
  const { plans } = planExams(subjects, sem);
  assert.ok(plans.length >= 1);
  const best = plans[0];
  const dates = best.rows.map((r) => r.exam.date);
  assert.equal(new Set(dates).size, dates.length, 'no two exams on the same day');
  // Hard subject should not be on the first day with nothing before it.
  assert.notEqual(best.choice.a, 'a1');
  const study = studyPlan(best.rows, sem);
  assert.ok(study.length > 0);
  assert.ok(!study.some((t) => dates.includes(t.date)), 'no studying on exam days');
});

test('locked exam term is respected', () => {
  const subjects = [
    { id: 'a', name: 'A', exams: [{ id: 'a1', date: '2027-01-05' }, { id: 'a2', date: '2027-01-20' }], lockedExamId: 'a1' },
  ];
  assert.equal(planExams(subjects, sem).plans[0].choice.a, 'a1');
});

test('outputs + ICS build', () => {
  const state = {
    semester: sem,
    classes: [{ id: 'c1', subjectId: 's1', type: 'C', day: 1, start: '09:10', end: '10:40', parity: 'all', room: 'A-120' }],
    subjects: [{ id: 's1', name: 'Matematika', short: 'MAT', items: [{ id: 'i1', kind: 'test', title: 'Písomka', when: '12' }], exams: [] }],
    settings: { reminderMin: 30 },
  };
  const { events, tasks } = buildOutputs(state, []);
  const cls = events.find((e) => e.category === 'class');
  assert.deepEqual(cls.recurrence.exdates, ['2026-11-17']);
  assert.ok(tasks.some((t) => t.key === 'item:i1' && t.date === '2026-12-08' && t.time === '09:10'));
  const ics = buildICS(events);
  assert.match(ics, /RRULE:FREQ=WEEKLY;UNTIL=20261215T225959Z/);
  assert.match(ics, /EXDATE;TZID=Europe\/Bratislava:20261117T091000/);
});

test('timezone offsets', () => {
  assert.equal(toOffsetString('2027-01-10', '09:00'), '2027-01-10T09:00:00+0100');
  assert.equal(toOffsetString('2026-10-01', '09:00'), '2026-10-01T09:00:00+0200');
  assert.ok(skHolidays(2027).some((h) => h.name === 'Veľkonočný pondelok' && h.date === '2027-03-29'));
});

test('classifier and list parser', () => {
  const c = classify(['Počítačové siete', 'Laboratórium', 'L9-0.12', 'nepárny týždeň', 'Ing. J. Novák, PhD.']);
  assert.equal(c.subject, 'Počítačové siete');
  assert.equal(c.type, 'L');
  assert.equal(c.room, 'L9-0.12');
  assert.equal(c.parity, 'odd');
  assert.match(c.teacher, /Novák/);
  const l = parseListText('Pondelok\n07:30 - 09:00 OOP Prednáška BC300\nUtorok\n9:10-10:40 Matematika 2 Cvičenie A-120 párny');
  assert.equal(l.classes.length, 2);
  assert.equal(l.classes[1].day, 1);
  assert.equal(l.classes[1].parity, 'even');
  assert.equal(l.classes[1].subject, 'Matematika 2');
});
