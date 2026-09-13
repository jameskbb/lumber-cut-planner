// Draws one sheet of a cut plan as SVG: birch-coloured stock, parts, hatched
// offcuts, numbered saw cuts and a tape-measure ruler along two edges.

import { lengthParts, formatLength } from './units.js';

const NS = 'http://www.w3.org/2000/svg';

export function svgEl(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v);
  for (const kid of kids) if (kid !== null && kid !== undefined) el.append(kid);
  return el;
}

/** Appends a length to an SVG <text>, setting fractions as small raised numerators. */
export function appendLength(textEl, value, units) {
  const { whole, frac } = lengthParts(value, units);
  if (whole) textEl.append(svgEl('tspan', {}, whole));
  if (frac) {
    const [n, d] = frac.split('/');
    textEl.append(svgEl('tspan', { 'font-size': '64%', dy: '-0.5em', dx: whole ? '1.5' : null }, n));
    textEl.append(svgEl('tspan', { 'font-size': '64%', dy: '0.5em' }, '/' + d));
  }
}

function appendDims(textEl, l, w, units) {
  appendLength(textEl, l, units);
  textEl.append(svgEl('tspan', {}, ' × '));
  appendLength(textEl, w, units);
}

export function nounFor(sheet, units) {
  return sheet.width <= (units === 'mm' ? 305 : 12) ? 'Board' : 'Sheet';
}

// Rough width of condensed Archivo text, used to decide what fits in a part.
const textWidth = (s, size) => s.length * size * 0.5;

function tickPlan(units, scale) {
  if (units === 'mm') {
    const major = scale * 100 >= 34 ? 100 : 500;
    return { minor: scale * 10 >= 4 ? 10 : scale * 50 >= 4 ? 50 : 100, mid: major === 100 ? 50 : 100, major };
  }
  const major = scale * 12 >= 26 ? 12 : 24;
  return { minor: scale >= 4 ? 1 : scale * 3 >= 4 ? 3 : 6, mid: 6, major };
}

function ruler(length, scale, units, vertical, band) {
  const g = svgEl('g', { class: 'sv-ruler', 'aria-hidden': 'true' });
  const px = length * scale;
  g.append(svgEl('rect', vertical
    ? { x: 0, y: 0, width: band, height: px, class: 'sv-tape' }
    : { x: 0, y: 0, width: px, height: band, class: 'sv-tape' }));
  const { minor, mid, major } = tickPlan(units, scale);
  // Skip labels that would sit closer than ~30px apart.
  const labelStep = major * Math.max(1, Math.ceil(30 / (major * scale)));
  const multipleOf = (v, step) => Math.abs(v / step - Math.round(v / step)) < 1e-9;
  for (let i = 1; i * minor < length - 1e-9; i++) {
    const v = i * minor;
    const isMajor = multipleOf(v, major);
    const isMid = !isMajor && multipleOf(v, mid);
    const t = isMajor ? band * 0.55 : isMid ? band * 0.36 : band * 0.2;
    const p = v * scale;
    g.append(svgEl('line', vertical
      ? { x1: band - t, x2: band, y1: p, y2: p, class: isMajor ? 'sv-tick is-major' : 'sv-tick' }
      : { x1: p, x2: p, y1: band - t, y2: band, class: isMajor ? 'sv-tick is-major' : 'sv-tick' }));
    if (multipleOf(v, labelStep)) {
      const label = svgEl('text', vertical
        ? { x: band * 0.42, y: p - 3, class: 'sv-tape-label', transform: `rotate(-90 ${band * 0.42} ${p - 3})` }
        : { x: p + 3, y: band * 0.58, class: 'sv-tape-label' }, formatLength(v, units));
      g.append(label);
    }
  }
  return g;
}

function partLabel(g, p, px, units, letter) {
  const [x, y, w, h] = px;
  const name = p.name;
  const dimsText = `${formatLength(p.l, units)} x ${formatLength(p.w, units)}`;
  const rotate = h > w * 1.4 && w < 90;
  const [boxW, boxH] = rotate ? [h, w] : [w, h];
  const size = Math.max(10, Math.min(14, boxH * 0.3));
  const cx = x + w / 2, cy = y + h / 2;
  const transform = rotate ? `rotate(-90 ${cx} ${cy})` : null;

  if (boxH >= size * 2.5 && boxW >= textWidth(dimsText, size * 0.9) + 8) {
    const maxChars = Math.floor((boxW - 8) / (size * 0.5));
    const shown = name.length > maxChars ? name.slice(0, Math.max(1, maxChars - 1)) + '…' : name;
    g.append(svgEl('text', { x: cx, y: cy - size * 0.2, 'font-size': size, class: 'sv-name', transform }, shown));
    const dims = svgEl('text', { x: cx, y: cy + size * 0.95, 'font-size': size * 0.9, class: 'sv-dims', transform });
    appendDims(dims, p.l, p.w, units);
    g.append(dims);
  } else if (Math.min(w, h) >= 13) {
    const s = Math.min(12, Math.min(w, h) * 0.7);
    g.append(svgEl('text', { x: cx, y: cy + s * 0.36, 'font-size': s, class: 'sv-name' }, letter));
  }
}

/**
 * @param sheet one entry of planCuts().sheets
 * @param opt {width, maxHeight, units, colorOf(partId), letterOf(partId), done:Set, showCuts, key, label}
 *   Optional: `view` {x, y, l, w} shows only that part of the sheet, scaled to
 *   fit width × maxHeight (a view touching the top or left edge keeps its
 *   ruler); `focus` [{x, y, l, w}] fades everything outside those pieces;
 *   `id` names the SVG patterns when the same sheet is drawn twice.
 */
export function renderSheet(sheet, opt) {
  const { units, colorOf, letterOf, done, showCuts, key } = opt;
  const R = 20; // ruler band
  const GAP = 3;
  const PAD = 4;
  const off = R + GAP;
  const view = opt.view;
  let scale = (opt.width - off - PAD) / sheet.length;
  scale = Math.max(0.5, Math.min(scale, ((opt.maxHeight || 640) - off - PAD) / sheet.width));
  // No 0.5 floor here: a whole metre-sized sheet on a phone needs less than that.
  if (view) scale = Math.max(0.01, Math.min((opt.width - off - PAD) / view.l, ((opt.maxHeight || 640) - off - PAD) / view.w));
  const W = sheet.length * scale;
  const H = sheet.width * scale;
  const vbW = off + W + PAD;
  const vbH = off + H + PAD;
  let vb = [0, 0, vbW, vbH];
  if (view) {
    const x0 = view.x <= 1e-6 ? 0 : off + view.x * scale;
    const y0 = view.y <= 1e-6 ? 0 : off + view.y * scale;
    const x1 = view.x + view.l >= sheet.length - 1e-6 ? vbW : off + (view.x + view.l) * scale;
    const y1 = view.y + view.w >= sheet.width - 1e-6 ? vbH : off + (view.y + view.w) * scale;
    vb = [x0, y0, x1 - x0, y1 - y0];
  }

  const svg = svgEl('svg', {
    viewBox: vb.map((v) => v.toFixed(1)).join(' '), width: vb[2].toFixed(1), height: vb[3].toFixed(1),
    role: 'img', 'aria-label': opt.label, class: 'sheet-svg',
  });
  const id = opt.id || `sv${key}`;
  svg.append(svgEl('defs', {},
    svgEl('pattern', { id: `${id}-grain`, width: 260, height: 12, patternUnits: 'userSpaceOnUse' },
      svgEl('path', { d: 'M0 3 C70 1 150 6 260 3 M0 8.5 C90 11 170 6.5 260 9', class: 'sv-grain' })),
    svgEl('pattern', { id: `${id}-hatch`, width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
      svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 7, class: 'sv-hatch' }))));

  const top = ruler(sheet.length, scale, units, false, R);
  top.setAttribute('transform', `translate(${off} 0)`);
  const left = ruler(sheet.width, scale, units, true, R);
  left.setAttribute('transform', `translate(0 ${off})`);
  svg.append(top, left, svgEl('text', { x: R / 2, y: R * 0.66, class: 'sv-unit', 'aria-hidden': 'true' }, units));

  const g = svgEl('g', { transform: `translate(${off} ${off})` });
  g.append(svgEl('rect', { x: 0, y: 0, width: W, height: H, class: 'sv-stock' }));
  g.append(svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: `url(#${id}-grain)` }));

  for (const o of sheet.offcuts) {
    const x = o.x * scale, y = o.y * scale, w = o.l * scale, h = o.w * scale;
    const og = svgEl('g', { class: 'sv-offcut' });
    og.append(svgEl('rect', { x, y, width: w, height: h, fill: `url(#${id}-hatch)` }));
    if (w >= 64 && h >= 22) {
      const t = svgEl('text', { x: x + w / 2, y: y + h / 2 + 4, class: 'sv-offcut-label', 'font-size': 11 });
      appendDims(t, o.l, o.w, units);
      og.append(t);
    }
    g.append(og);
  }

  for (const p of sheet.placements) {
    const x = p.x * scale, y = p.y * scale, w = p.l * scale, h = p.w * scale;
    const pg = svgEl('g', { class: 'sv-part', 'data-part': p.partId, tabindex: '-1' });
    pg.append(svgEl('title', {}, `${p.name}: ${formatLength(p.l, units)} × ${formatLength(p.w, units)}${p.rotated ? ' (turned)' : ''}`));
    pg.append(svgEl('rect', { x, y, width: w, height: h, fill: colorOf(p.partId) }));
    partLabel(pg, p, [x, y, w, h], units, letterOf(p.partId));
    g.append(pg);
  }

  if (opt.focus?.length) {
    const hole = (r) => `M${r.x * scale} ${r.y * scale}h${r.l * scale}v${r.w * scale}h${-r.l * scale}z`;
    g.append(svgEl('path', { d: `M0 0H${W}V${H}H0z${opt.focus.map(hole).join('')}`, 'fill-rule': 'evenodd', class: 'sv-fade', 'aria-hidden': 'true' }));
    for (const r of opt.focus) {
      g.append(svgEl('rect', { x: r.x * scale, y: r.y * scale, width: r.l * scale, height: r.w * scale, class: 'sv-focus', 'aria-hidden': 'true' }));
    }
  }

  const band = Math.max(sheet.kerf * scale, 1.25);
  const marks = svgEl('g');
  const taken = [];
  const MARK_GAP = 18;
  for (const c of sheet.cuts) {
    const cutKey = `${key}-${c.n}`;
    const isDone = done.has(cutKey);
    const cls = `sv-cut${isDone ? ' is-done' : ''}`;
    let rect, mx, my, len;
    if (c.axis === 'x') {
      rect = { x: c.pos * scale, y: c.piece.y * scale, width: band, height: c.piece.w * scale };
      mx = rect.x + band / 2; my = rect.y + 11; len = rect.height;
    } else {
      rect = { x: c.piece.x * scale, y: c.pos * scale, width: c.piece.l * scale, height: band };
      mx = rect.x + 11; my = rect.y + band / 2; len = rect.width;
    }
    g.append(svgEl('rect', { ...rect, class: cls, 'data-cut': cutKey }));
    // Slide the marker along its cut until it clears markers already drawn.
    let slid = 0;
    while (slid + 22 < len && taken.some(([tx, ty]) => Math.hypot(tx - mx, ty - my) < MARK_GAP)) {
      if (c.axis === 'x') my += 6; else mx += 6;
      slid += 6;
    }
    if (showCuts && len >= 26) {
      taken.push([mx, my]);
      marks.append(svgEl('g', { class: `sv-mark${isDone ? ' is-done' : ''}`, 'data-cut': cutKey },
        svgEl('circle', { cx: mx, cy: my, r: 8.5 }),
        svgEl('text', { x: mx, y: my + 3.4 }, String(c.n))));
    }
  }
  g.append(marks);
  g.append(svgEl('rect', { x: 0, y: 0, width: W, height: H, class: 'sv-edge' }));
  svg.append(g);
  return svg;
}
