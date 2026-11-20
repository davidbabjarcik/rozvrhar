// Heuristic timetable reader. Works on positioned text items (and optionally
// the rectangles of table cells) extracted from a PDF. Handles grid layouts
// (days as rows or columns, times in the header) and list layouts
// ("Pondelok 7:30-9:00 Matematika …"). The result is always shown to the user
// for review, so this aims to be good, not perfect.
import { minToTime, timeToMin } from './dates.js';

const DAY_PATTERNS = [
  [0, /^(po|pon|pondelok|pondělí|pondeli|mon|monday)\.?:?$/i],
  [1, /^(ut|út|uto|utorok|úterý|utery|tue|tuesday)\.?:?$/i],
  [2, /^(st|str|streda|středa|wed|wednesday)\.?:?$/i],
  [3, /^(št|šť|stv|štv|štvrtok|stvrtok|čt|čtvrtek|thu|thursday)\.?:?$/i],
  [4, /^(pi|pia|piatok|pá|pátek|fri|friday)\.?:?$/i],
  [5, /^(so|sob|sobota|sat|saturday)\.?:?$/i],
  [6, /^(ne|ned|nedeľa|neděle|sun|sunday)\.?:?$/i],
];

export function dayIndex(text) {
  const t = String(text).trim();
  for (const [i, re] of DAY_PATTERNS) if (re.test(t)) return i;
  return null;
}

const TIME_RE = /(\d{1,2})[:.](\d{2})/g;
const RANGE_RE = /(\d{1,2})[:.](\d{2})\s*(?:-|–|—|do|\s)\s*(\d{1,2})[:.](\d{2})/;

function times(text) {
  const out = [];
  for (const m of String(text).matchAll(TIME_RE)) {
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h <= 23 && mi <= 59) out.push(h * 60 + mi);
  }
  return out;
}

export function normalizeName(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

/* ----------------------------- classification ----------------------------- */

const TYPE_WORDS = [
  ['P', /(?:^|[\s(])(predn[aá][šs]k[ay]|přednášk[ay]|lecture|predn\.)/i],
  ['C', /(?:^|[\s(])(cvi[čc]eni[eaí]|cvi[čc]\.|exercise|tutorial)/i],
  ['L', /(?:^|[\s(])(laborat[oó]ri(?:um|a)|laborat[oó]rne|laboratoř\S*|lab\.|labs?(?=\s|$|\)))/i],
  ['S', /(?:^|[\s(])(semin[aá]r\S*)/i],
];
const TYPE_TOKENS = {
  p: 'P', pr: 'P', '(p)': 'P', '[p]': 'P', pred: 'P',
  c: 'C', cv: 'C', 'cv.': 'C', '(c)': 'C', '[c]': 'C', cvi: 'C', 'c.': 'C',
  l: 'L', lab: 'L', '(l)': 'L', '[l]': 'L',
  s: 'S', sem: 'S', '(s)': 'S', '[s]': 'S',
};
const TEACHER_RE = /\b(Ing|Mgr|doc|prof|RNDr|PhDr|PaedDr|MUDr|JUDr|Dr|Bc)\.|PhD\.?|CSc\.?|ArtD\.?/;
const TEACHER_START = /(?:^|\s)(?:prof|doc|Ing|Mgr|RNDr|PhDr|PaedDr|MUDr|JUDr|Dr|Bc)\.\s?/;
const PARITY_ODD = /\b(nep[aá]rn[ýye]\s+t[ýy]ž\S*|nep[aá]rn[ýye]|odd(?:\s+weeks?)?)(?=\s|$|[,;)])|\bNP\b/i;
const PARITY_EVEN = /(?:^|\s|\()(p[aá]rn[ýye]\s+t[ýy]ž\S*|p[aá]rn[ýye]|even(?:\s+weeks?)?)(?=\s|$|[,;)])|\bPT\b/i;
const WEEKS_RE = /(\d{1,2}(?:\s*[-–]\s*\d{1,2})?(?:\s*,\s*\d{1,2}(?:\s*[-–]\s*\d{1,2})?)*)\s*\.?\s*(?:t[ýy]ž\w*|t\.|tyz\w*|week)/i;

function isRoomToken(tok) {
  const t = tok.replace(/[(),]/g, '');
  if (/^aula/i.test(t)) return true;
  const digits = (t.match(/\d/g) || []).length;
  if (t.length > 10 || !/^[A-Za-zÁ-ž]{0,4}[- ]?\d[\dA-Za-z./-]*$/.test(t)) return false;
  return digits >= 2 || /[-.]/.test(t);
}

export function classify(lines) {
  const res = { subject: '', type: '?', room: '', teacher: '', parity: 'all', weeks: '', start: null, end: null };
  const rest = [];
  for (let raw of lines) {
    let l = String(raw).replace(/\s+/g, ' ').trim();
    if (!l) continue;
    const r = l.match(RANGE_RE);
    if (r) {
      res.start = minToTime(Number(r[1]) * 60 + Number(r[2]));
      res.end = minToTime(Number(r[3]) * 60 + Number(r[4]));
      l = l.replace(r[0], ' ').trim();
    }
    const w = l.match(WEEKS_RE);
    if (w) { res.weeks = w[1].replace(/\s+/g, ''); l = l.replace(w[0], ' ').trim(); }
    if (PARITY_ODD.test(l)) { res.parity = 'odd'; l = l.replace(PARITY_ODD, ' ').trim(); }
    else if (PARITY_EVEN.test(l)) { res.parity = 'even'; l = l.replace(PARITY_EVEN, ' ').trim(); }
    for (const [t, re] of TYPE_WORDS) {
      if (re.test(l)) { if (res.type === '?') res.type = t; l = l.replace(re, ' ').replace(/\s+/g, ' ').trim(); }
    }
    if (!l) continue;
    const tm = l.match(TEACHER_START);
    if (tm) {
      // Teacher names run to the end of the line; keep whatever precedes them.
      if (!res.teacher) res.teacher = l.slice(tm.index).trim();
      l = l.slice(0, tm.index).trim();
      if (!l) continue;
    } else if (TEACHER_RE.test(l)) { if (!res.teacher) res.teacher = l; continue; }
    const aula = l.match(/(?:^|\s)(aula(?:\s+\S+)?)$/i);
    if (aula && aula.index > 0 && !res.room) {
      res.room = aula[1];
      l = l.slice(0, aula.index).trim();
    }
    rest.push(l);
  }
  // Peel type / room tokens off the ends of each remaining line.
  const cleaned = [];
  rest.forEach((l, idx) => {
    const toks = l.split(' ').filter(Boolean);
    const peelType = (tok) => {
      const t = TYPE_TOKENS[tok.toLowerCase()];
      if (t && toks.length > 1) { if (res.type === '?') res.type = t; return true; }
      return false;
    };
    while (toks.length > 1 && (peelType(toks[toks.length - 1]) || (isRoomToken(toks[toks.length - 1]) && setRoom(toks[toks.length - 1])))) toks.pop();
    while (toks.length > 1 && peelType(toks[0])) toks.shift();
    const line = toks.join(' ');
    if (toks.length === 1) {
      const t = TYPE_TOKENS[line.toLowerCase()];
      if (t) { if (res.type === '?') res.type = t; return; }
      if (idx > 0 && isRoomToken(line) && !res.room) { res.room = line; return; }
    }
    cleaned.push(line);
  });
  function setRoom(tok) {
    if (res.room) return false;
    res.room = tok.replace(/[(),]/g, '');
    return true;
  }
  res.subject = cleaned[0] || '';
  if (!res.room && cleaned.length > 1 && isRoomToken(cleaned[cleaned.length - 1])) {
    res.room = cleaned.pop();
  }
  if (cleaned.length > 1) res.extra = cleaned.slice(1).join(' · ');
  return res;
}

/* ------------------------------- geometry -------------------------------- */

const cx = (b) => (b.x0 + b.x1) / 2;
const cy = (b) => (b.y0 + b.y1) / 2;
const contains = (r, x, y) => x >= r.x0 - 0.5 && x <= r.x1 + 0.5 && y >= r.y0 - 0.5 && y <= r.y1 + 0.5;
const area = (r) => (r.x1 - r.x0) * (r.y1 - r.y0);

function smallestRect(rects, x, y, filter) {
  let best = null;
  for (const r of rects) {
    if (!contains(r, x, y)) continue;
    if (filter && !filter(r)) continue;
    if (!best || area(r) < area(best)) best = r;
  }
  return best;
}

function swapXY(b) {
  return { ...b, x0: b.y0, x1: b.y1, y0: b.x0, y1: b.x1 };
}

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/* ------------------------------ grid layout ------------------------------ */

export function parseGrid(page) {
  let items = page.items.filter((i) => i.s && i.s.trim());
  let rects = (page.rects || []).filter((r) => r.x1 - r.x0 > 4 && r.y1 - r.y0 > 4);
  const labels = items.filter((i) => dayIndex(i.s) !== null);
  if (labels.length < 2) return null;

  const spreadX = Math.max(...labels.map(cx)) - Math.min(...labels.map(cx));
  const spreadY = Math.max(...labels.map(cy)) - Math.min(...labels.map(cy));
  const transposed = spreadX > spreadY;
  if (transposed) {
    items = items.map(swapXY);
    rects = rects.map(swapXY);
  }
  const W = transposed ? page.height : page.width;

  // Day anchors in the leading column.
  let anchors = items.filter((i) => dayIndex(i.s) !== null);
  const minX = Math.min(...anchors.map((a) => a.x0));
  anchors = anchors.filter((a) => a.x0 < minX + W * 0.15).sort((a, b) => cy(a) - cy(b));
  if (anchors.length < 2) return null;
  const labelRight = Math.max(...anchors.map((a) => a.x1));
  const firstTop = Math.min(...anchors.map((a) => a.y0));

  // Header with times above the first day.
  const headerItems = items.filter((i) => cy(i) < firstTop && i.x0 >= labelRight - 2 && times(i.s).length);
  let columns = clusterColumns(headerItems);
  let headerBottom;
  if (columns.length >= 2) {
    headerBottom = Math.max(...headerItems.map((i) => i.y1));
  } else {
    // Fallback: bare hours "7 8 9 …" in one header row.
    const hourItems = items.filter((i) => cy(i) < firstTop && i.x0 >= labelRight - 2 && /^\d{1,2}$/.test(i.s.trim()) &&
      Number(i.s) >= 6 && Number(i.s) <= 21);
    if (hourItems.length < 3) return { error: 'V hlavičke rozvrhu som nenašiel časy.' };
    columns = hourItems.sort((a, b) => cx(a) - cx(b)).map((i) => ({ cx: cx(i), start: Number(i.s) * 60, end: Number(i.s) * 60 + 60, items: [i] }));
    headerBottom = Math.max(...hourItems.map((i) => i.y1));
  }
  // Column extents: from enclosing header cells if we have them, else midpoints.
  const spacing = median(columns.slice(1).map((c, i) => c.cx - columns[i].cx)) || 40;
  columns.forEach((c, i) => {
    const r = rects.length ? smallestRect(rects, c.cx, cy(c.items[0]), (q) => q.x1 - q.x0 < spacing * 2.5) : null;
    if (r) { c.left = r.x0; c.right = r.x1; }
    else {
      c.left = i === 0 ? c.cx - spacing / 2 : (columns[i - 1].cx + c.cx) / 2;
      c.right = i === columns.length - 1 ? c.cx + spacing / 2 : (c.cx + columns[i + 1].cx) / 2;
    }
    if (c.end == null || c.end <= c.start) c.end = i < columns.length - 1 ? columns[i + 1].start : c.start + 60;
  });
  const colMinutes = median(columns.map((c) => c.end - c.start));

  // Day bands.
  const bands = [];
  anchors.forEach((a, i) => {
    const day = dayIndex(a.s);
    const r = rects.length ? smallestRect(rects, cx(a), cy(a), (q) => q.x0 <= a.x0 + 1 && q.x1 < columns[0].left + spacing) : null;
    let top;
    let bottom;
    if (r && r.y1 - r.y0 > (a.y1 - a.y0) * 1.2) { top = r.y0; bottom = r.y1; }
    else {
      top = i === 0 ? headerBottom : (cy(anchors[i - 1]) + cy(a)) / 2;
      bottom = i === anchors.length - 1 ? cy(a) + (cy(a) - top) : (cy(a) + cy(anchors[i + 1])) / 2;
    }
    const prev = bands[bands.length - 1];
    if (prev && prev.day === day) prev.bottom = Math.max(prev.bottom, bottom);
    else bands.push({ day, top, bottom });
  });
  const tableBottom = Math.max(...bands.map((b) => b.bottom));
  const bandOf = (y) => bands.find((b) => y >= b.top - 0.5 && y <= b.bottom + 0.5) || null;

  const headerSet = new Set(columns.flatMap((c) => c.items));
  const content = items.filter((i) => !headerSet.has(i) && dayIndex(i.s) === null &&
    cy(i) > headerBottom && cy(i) <= tableBottom && i.x0 >= labelRight - 1 && cx(i) >= columns[0].left - 2);

  // Group text into cells.
  const groups = new Map();
  const loose = [];
  const tableW = columns[columns.length - 1].right - columns[0].left;
  for (const it of content) {
    const band = bandOf(cy(it));
    const okCell = (q) => q.x1 - q.x0 < tableW * 0.8 && q.x0 >= labelRight - 2 &&
      (!band || q.y1 - q.y0 <= band.bottom - band.top + 2);
    // Class boxes are usually filled; the empty grid is usually just stroked.
    const r = rects.length ? (smallestRect(rects, cx(it), cy(it), (q) => q.filled && okCell(q)) ||
      smallestRect(rects, cx(it), cy(it), okCell)) : null;
    if (r && r.x1 - r.x0 >= (it.x1 - it.x0) * 0.8) {
      const key = `${r.x0},${r.y0},${r.x1},${r.y1}`;
      if (!groups.has(key)) groups.set(key, { rect: r, items: [] });
      groups.get(key).items.push(it);
    } else loose.push(it);
  }
  for (const g of clusterLoose(loose, spacing)) groups.set(`loose${groups.size}`, { rect: null, items: g });

  const xToMin = (x) => {
    const c = columns.find((q) => x >= q.left && x < q.right) ||
      columns.find((q) => x >= q.left - 0.5 && x <= q.right + 0.5) ||
      (x < columns[0].left ? columns[0] : columns[columns.length - 1]);
    const f = Math.max(0, Math.min(1, (x - c.left) / Math.max(1, c.right - c.left)));
    return c.start + f * (c.end - c.start);
  };
  const boundaries = [...new Set(columns.flatMap((c) => [c.start, c.end]))].sort((a, b) => a - b);
  const snap = (m) => boundaries.reduce((best, b) => (Math.abs(b - m) < Math.abs(best - m) ? b : best), boundaries[0]);
  const colAt = (x) => columns.find((q) => x >= q.left && x <= q.right);

  const classes = [];
  for (const g of groups.values()) {
    const its = g.items.slice().sort((a, b) => cy(a) - cy(b) || a.x0 - b.x0);
    const box = g.rect || {
      x0: Math.min(...its.map((i) => i.x0)), x1: Math.max(...its.map((i) => i.x1)),
      y0: Math.min(...its.map((i) => i.y0)), y1: Math.max(...its.map((i) => i.y1)),
    };
    const band = bandOf(cy(box));
    if (!band) continue;
    const lines = toLines(its);
    const info = classify(lines);
    if (!info.subject) continue;
    let start;
    let end;
    if (info.start && info.end) { start = timeToMin(info.start); end = timeToMin(info.end); }
    else if (g.rect) { start = snap(xToMin(box.x0 + 0.5)); end = snap(xToMin(box.x1 - 0.5)); }
    else {
      const c0 = colAt(box.x0 + 1) || columns[0];
      const c1 = colAt(box.x1 - 1) || c0;
      start = c0.start;
      end = c1.end;
      const cols = columns.indexOf(c1) - columns.indexOf(c0) + 1;
      if (cols < 2 && colMinutes <= 60) {
        const nxt = columns[columns.indexOf(c0) + 1];
        if (nxt) end = nxt.end;
      }
    }
    if (end <= start) end = start + (colMinutes || 45) * 2;
    classes.push({ ...info, day: band.day, start: minToTime(start), end: minToTime(end), raw: lines.join(' | ') });
  }
  return { classes, layout: transposed ? 'grid-columns' : 'grid-rows' };
}

function clusterColumns(headerItems) {
  if (!headerItems.length) return [];
  const sorted = headerItems.slice().sort((a, b) => cx(a) - cx(b));
  const widths = median(sorted.map((i) => i.x1 - i.x0)) || 20;
  // Start/end times may sit on two lines of one header cell. In a rotated
  // table those lines end up side by side, so detect pairs from the gaps.
  const gaps = sorted.slice(1).map((it, i) => cx(it) - cx(sorted[i]));
  const gMin = Math.min(...gaps);
  const gMax = Math.max(...gaps);
  const pairGap = gaps.length >= 3 && gMax > gMin * 2.2 ? (gMin + gMax) / 2 : widths * 0.6;
  const cols = [];
  for (const it of sorted) {
    const last = cols[cols.length - 1];
    if (last && cx(it) - cx(last.items[last.items.length - 1]) < pairGap && last.items.length < 2) {
      last.items.push(it);
      last.cx = last.items.reduce((s, i) => s + cx(i), 0) / last.items.length;
    } else cols.push({ cx: cx(it), items: [it] });
  }
  for (const c of cols) {
    const ts = c.items.flatMap((i) => times(i.s)).sort((a, b) => a - b);
    c.start = ts[0];
    c.end = ts.length > 1 ? ts[ts.length - 1] : null;
  }
  return cols.filter((c) => c.start != null);
}

function clusterLoose(items, spacing) {
  const lh = median(items.map((i) => i.y1 - i.y0)) || 8;
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      const vGap = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1);
      const hOverlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const sameLineGap = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
      const close = (vGap < lh * 0.9 && (hOverlap > -2 || Math.abs(cx(a) - cx(b)) < spacing * 0.6)) ||
        (vGap < 0 && sameLineGap < lh * 0.8);
      if (close) parent[find(i)] = find(j);
    }
  }
  const map = new Map();
  items.forEach((it, i) => {
    const r = find(i);
    if (!map.has(r)) map.set(r, []);
    map.get(r).push(it);
  });
  return [...map.values()];
}

function toLines(items) {
  const lh = median(items.map((i) => i.y1 - i.y0)) || 8;
  const lines = [];
  for (const it of items.slice().sort((a, b) => cy(a) - cy(b))) {
    const line = lines.find((l) => Math.abs(l.y - cy(it)) < lh * 0.5);
    if (line) line.items.push(it);
    else lines.push({ y: cy(it), items: [it] });
  }
  return lines.sort((a, b) => a.y - b.y)
    .map((l) => l.items.sort((a, b) => a.x0 - b.x0).map((i) => i.s.trim()).join(' ').replace(/\s+/g, ' ').trim());
}

/* ------------------------------ list layout ------------------------------ */

export function parseListText(text) {
  const classes = [];
  let day = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    let line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const first = line.split(/[ ,;:|\t]/)[0];
    const d = dayIndex(first);
    if (d !== null) {
      day = d;
      line = line.slice(first.length).replace(/^[\s,;:|]+/, '');
    }
    const r = line.match(RANGE_RE);
    if (!r || day === null) continue;
    const parts = line.split(/\s*[|;\t]\s*|\s{2,}/);
    const info = classify(parts.length > 1 ? parts : [line]);
    if (!info.subject) continue;
    classes.push({ ...info, day, raw: rawLine.trim() });
  }
  return { classes, layout: 'list' };
}

export function pageToText(page) {
  return toLines(page.items).join('\n');
}

/* --------------------------------- main ---------------------------------- */

export function parseTimetable(pages) {
  const all = [];
  const notes = [];
  let layout = null;
  for (const page of pages) {
    const grid = parseGrid(page);
    const linesText = pageLines(page);
    const list = parseListText(linesText);
    let pick = null;
    if (grid && grid.classes && grid.classes.length) pick = grid;
    if (list.classes.length >= 3 && (!pick || list.classes.length >= pick.classes.length)) pick = list;
    if (!pick && grid && grid.error) notes.push(grid.error);
    if (pick) { all.push(...pick.classes); layout = layout || pick.layout; }
  }
  return { classes: dedupe(all), layout, notes };
}

function pageLines(page) {
  const items = page.items.filter((i) => i.s && i.s.trim());
  const lh = median(items.map((i) => i.y1 - i.y0)) || 8;
  const lines = [];
  for (const it of items.slice().sort((a, b) => cy(a) - cy(b))) {
    const line = lines.find((l) => Math.abs(l.y - cy(it)) < lh * 0.45);
    if (line) line.items.push(it);
    else lines.push({ y: cy(it), items: [it] });
  }
  return lines.sort((a, b) => a.y - b.y).map((l) => {
    const sorted = l.items.sort((a, b) => a.x0 - b.x0);
    let out = '';
    let prevX = null;
    for (const i of sorted) {
      if (prevX !== null) out += i.x0 - prevX > lh * 1.5 ? ' | ' : ' ';
      out += i.s.trim();
      prevX = i.x1;
    }
    return out;
  }).join('\n');
}

function dedupe(classes) {
  const seen = new Set();
  return classes.filter((c) => {
    const k = `${c.day}|${c.start}|${c.end}|${normalizeName(c.subject)}|${c.type}|${c.parity}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
