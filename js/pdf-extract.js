// Pulls positioned text and cell rectangles out of a PDF with pdf.js.
// `pdfjs` is the loaded pdf.js module (passed in so this also runs in Node tests).

function mul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function bbox(m, x0, y0, x1, y1) {
  const pts = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

export async function extractPdf(pdfjs, data) {
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const pages = [];
  for (let p = 1; p <= Math.min(doc.numPages, 10); p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const t = it.transform;
      const h = Math.hypot(t[2], t[3]) || it.height || 8;
      // Text space box: from baseline up by font height (slightly below for descenders).
      const m = mul(vp.transform, [t[0] / (Math.hypot(t[0], t[1]) || 1), t[1] / (Math.hypot(t[0], t[1]) || 1),
        t[2] / h, t[3] / h, t[4], t[5]]);
      const b = bbox(m, 0, -h * 0.2, it.width, h * 0.85);
      items.push({ s: it.str, ...b });
    }
    let rects = [];
    try {
      rects = await extractRects(pdfjs, page, vp);
    } catch (e) {
      rects = [];
    }
    pages.push({ width: vp.width, height: vp.height, items, rects });
  }
  return pages;
}

async function extractRects(pdfjs, page, vp) {
  const { OPS } = pdfjs;
  const FILL_OPS = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const ops = await page.getOperatorList();
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const rects = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.constructPath) {
      const mm = args && args[args.length - 1];
      if (!mm || mm.length !== 4 || !Number.isFinite(mm[0])) continue;
      const b = bbox(mul(vp.transform, ctm), mm[0], mm[1], mm[2], mm[3]);
      b.filled = false;
      // The paint op may come after colour/state ops: look a few ops ahead.
      for (let j = i + 1; j < Math.min(i + 8, ops.fnArray.length); j++) {
        const f = ops.fnArray[j];
        if (FILL_OPS.has(f)) { b.filled = true; break; }
        if (f === OPS.stroke || f === OPS.closeStroke || f === OPS.endPath || f === OPS.constructPath) break;
      }
      if (b.x1 - b.x0 > 4 && b.y1 - b.y0 > 4 && (b.x1 - b.x0) < vp.width * 0.98) rects.push(b);
    }
  }
  // Drop exact duplicates (fill + stroke of the same cell).
  const seen = new Map();
  return rects.filter((r) => {
    const k = [r.x0, r.y0, r.x1, r.y1].map((v) => Math.round(v)).join(',');
    if (seen.has(k)) {
      if (r.filled) seen.get(k).filled = true;
      return false;
    }
    seen.set(k, r);
    return true;
  });
}
