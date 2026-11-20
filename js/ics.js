// iCalendar (.ics) export — works with Google Calendar import, Apple, Outlook,
// and TickTick calendar subscription.
import { addDays, TZ } from './dates.js';

const VTIMEZONE = [
  'BEGIN:VTIMEZONE', `TZID:${TZ}`,
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST',
  'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET',
  'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

const d8 = (iso) => iso.replace(/-/g, '');
const t6 = (t) => `${t.replace(':', '')}00`;

export function escapeText(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

/** Fold to 75 octets per RFC 5545 (UTF-8 aware). */
export function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '';
  let len = 0;
  for (const ch of line) {
    const l = enc.encode(ch).length;
    if (len + l > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      len = 0;
    }
    cur += ch;
    len += l;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/** RRULE + EXDATE lines for a weekly recurring timed event. */
export function recurrenceLines(ev) {
  if (!ev.recurrence) return [];
  const lines = [`RRULE:FREQ=WEEKLY;UNTIL=${d8(ev.recurrence.until)}T225959Z`];
  if (ev.recurrence.exdates.length) {
    lines.push(`EXDATE;TZID=${TZ}:${ev.recurrence.exdates.map((d) => `${d8(d)}T${t6(ev.start)}`).join(',')}`);
  }
  return lines;
}

export function buildICS(events, calName = 'Rozvrh') {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Rozvrhar//SK', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calName)}`, `X-WR-TIMEZONE:${TZ}`, ...VTIMEZONE,
  ];
  for (const ev of events) {
    lines.push('BEGIN:VEVENT', `UID:${ev.key.replace(/[^\w:-]/g, '_')}@rozvrhar`, `DTSTAMP:${stamp}`);
    if (ev.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${d8(ev.date)}`, `DTEND;VALUE=DATE:${d8(addDays(ev.endDate || ev.date, 1))}`);
    } else {
      lines.push(`DTSTART;TZID=${TZ}:${d8(ev.date)}T${t6(ev.start)}`, `DTEND;TZID=${TZ}:${d8(ev.date)}T${t6(ev.end)}`);
      lines.push(...recurrenceLines(ev));
    }
    lines.push(`SUMMARY:${escapeText(ev.title)}`);
    if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
    if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);
    for (const m of ev.reminders || []) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(ev.title)}`, `TRIGGER:-PT${m}M`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
