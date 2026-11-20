import test from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeExamList, matchSubject, narrowTerms, parseAcademicCalendar, parseCourseDoc, parseExamList, pickSemester,
} from '../js/doc-parse.js';
import { classify } from '../js/timetable-parse.js';

const CAL = `2026/2027
ČASOVÝ ROZVRH ŠTÚDIA
Výučba v ZS1
21.09.2026 – 18.12.2026
Zimné prázdniny
21.12.2026 – 03.01.2027
Skúškové obdobie v ZS
04.01.2027 – 12.02.2027
Výučba v LS2
15.02.2027 – 14.05.2027
Skúškové obdobie v LS
17.05.2027 – 30.06.2027
Dni pracovného pokoja:
letný semester:
26.03.2027 - piatok
29.03.2027 - pondelok
1 ZS – zimný semester`;

test('faculty calendar gives semester dates and days off', () => {
  const cal = parseAcademicCalendar(CAL);
  assert.equal(cal.zs.start, '2026-09-21');
  assert.equal(cal.zs.weeks, 13);
  assert.equal(cal.zs.examStart, '2027-01-04');
  assert.equal(cal.zs.examEnd, '2027-02-12');
  assert.equal(cal.ls.start, '2027-02-15');
  assert.deepEqual(cal.holidays.map((h) => h.date), ['2027-03-26', '2027-03-29']);
  assert.equal(pickSemester(cal, '2026-11-20').label, 'ZS 2026/27');
  assert.equal(pickSemester(cal, '2027-03-01').label, 'LS 2026/27');
});

const COURSE = `Podmienky pre udelenie zápočtu
v rámci predmetu Operačné systémy a kyberbezpečnosť
Povinné aktivity sú:
• Zápočtový test I. (6. alebo 7. týždni semestra)
• Zápočtový test II. 11. resp. 12. týždni semestra)
• Bleskovky na cvičeniach – 2. týždeň
Termíny odovzdania zadaní:
• zadanie COPYMASTER – 6. týždeň
• zadanie IPC – 12. týždeň
1.
Úvod, organizačné pokyny
2.
Práca so súbormi I.
3.
Práca so súbormi II.
4.
Ovládanie zariadení
5.
Procesy
6.
Zápočtovka I.
Konzultácie zadaní
7. Pipe a signály
Ukončenie odovzdávania Zadanie COPYMASTER
8. Zdieľaná pamäť
9. Semafóry
10. Sockety
11.
Zápočtovka II., oprava Zápočtovka I., preberanie zadaní
12.
Oprava Zápočtovka II., oprava Zápočtovka I.
13.
Zápočet; oprava Zápočtovka II.`;

test('course document: tests, deadlines and credit by week', () => {
  const { items } = parseCourseDoc(COURSE.split('\n'));
  const got = items.map((i) => `${i.kind}|${i.title}|${i.when}`);
  assert.deepEqual(got, [
    'test|Zápočtový test I.|6',
    'zadanie|Zadanie COPYMASTER|6',
    'test|Zápočtový test II.|11',
    'zadanie|Zadanie IPC|12',
    'zapocet|Zápočet|13',
  ]);
  assert.match(items[0].note, /6\. alebo 7\./);
});

test('course document is matched to the right subject', () => {
  const subjects = [{ name: 'Operačné systémy a kyberbezpečnosť' }, { name: 'Diskrétna matematika' }];
  assert.equal(matchSubject(subjects, COURSE).name, 'Operačné systémy a kyberbezpečnosť');
});

test('timetable cell with wrapped name, codes and groups', () => {
  const r = classify(['Objektovo orientované', 'programovanie', 'PK6_S02(PC1)', 'Ing. Marek Ružička, PhD.', 'CL', '', 'A1'],
    [false, true, false, false, false, false, false]);
  assert.equal(r.subject, 'Objektovo orientované programovanie');
  assert.equal(r.room, 'PK6_S02(PC1)');
  assert.equal(r.type, 'L');
  assert.equal(r.groups, 'A1');
  assert.equal(r.teacher, 'Ing. Marek Ružička, PhD.');
});

test('retake chances are attached to the right test', () => {
  const dm = ['* Prvá zápočtová písomka: 7. týždeň semestra.', '* Druhá zápočtová písomka: 11. týždeň semestra.',
    '* 1. opravná zápočtové písomka  13. týždeň semestra.', '* 2. opravná zápočtové písomka  1. týždeň skúškového obdobia.',
    'Podmienky skúšky:', '* Riadny hromadný termín - 12. 01. 2027.', '* Opravný hromadný termín - 26. 01. 2027.'];
  const r = parseCourseDoc(dm);
  assert.deepEqual(r.items.map((i) => [i.title, i.when, (i.retakes || []).map((x) => (x.examPeriod ? 'S' : '') + x.week).join(',')]), [
    ['Prvá zápočtová písomka', '7', '13,S1'],
    ['Druhá zápočtová písomka', '11', '13,S1'],
  ]);
  assert.deepEqual(r.exams, [
    { date: '2027-01-12', time: '', retakeOnly: false },
    { date: '2027-01-26', time: '', retakeOnly: true },
  ]);
});

test('MAIS exam list: subjects, retake terms and my examiner', () => {
  const text = `Riadny hromadný termín DM- skúšajúci Myšková
12. 1. 2027 8:00
Diskrétna matematika\tBN5-ZP1\t0/0\tSkúška\tObsadený
Riadny hromadný termín DM- skúšajúci Berežný
12. 1. 2027 8:00
Diskrétna matematika\tPK4_AVWS\t0/0\tSkúška\tObsadený
1. opravný hromadný termín DM- skúšajúci Myšková
26. 1. 2027 8:00
Diskrétna matematika\tBN5-ZP1\t0/0\tSkúška\tObsadený
Skúška z OOP
5. 1. 2027 8:00
17. 11. 2026 12:00 - 4. 1. 2027 12:00\t\tObjektovo orientované programovanie\tL9-A536\t105/0\tSkúška`;
  assert.ok(looksLikeExamList(text));
  const subjects = [{ id: 'dm', name: 'Diskrétna matematika' }, { id: 'oop', name: 'Objektovo orientované programovanie' }];
  const terms = parseExamList(text, subjects);
  assert.equal(terms.length, 4);
  const oop = terms.find((t) => t.subjectId === 'oop');
  assert.equal(oop.room, 'L9-A536');
  assert.equal(oop.regUntil, '2027-01-04');
  const dm = narrowTerms(terms.filter((t) => t.subjectId === 'dm'), 'doc. RNDr. Helena Myšková, PhD.');
  assert.equal(dm.examiner, 'Myšková');
  assert.deepEqual(dm.terms.map((t) => [t.date, t.time, t.retakeOnly]), [['2027-01-12', '08:00', false], ['2027-01-26', '08:00', true]]);
});
