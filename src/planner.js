// Cut planner: packs rectangular parts onto sheets/boards using guillotine cuts
// (every cut runs edge to edge through the piece being cut, like a table saw or
// track saw). Pure functions with no DOM access, so it can be reused anywhere.
//
// Coordinates: x runs along a sheet's length (the grain), y along its width.
// A part with `grain: true` keeps its length parallel to the sheet's length.

const EPS = 1e-6;
export const MAX_INSTANCES = 1500;

const SORTS = {
  area: (a, b) => b.l * b.w - a.l * a.w || Math.max(b.l, b.w) - Math.max(a.l, a.w),
  longest: (a, b) => Math.max(b.l, b.w) - Math.max(a.l, a.w) || b.l * b.w - a.l * a.w,
  perimeter: (a, b) => b.l + b.w - (a.l + a.w),
  length: (a, b) => b.l - a.l || b.w - a.w,
  width: (a, b) => b.w - a.w || b.l - a.l,
};

// Lower score is a better fit. dl/dw are the leftovers along length/width.
const FITS = {
  shortSide: (f, pl, pw) => { const dl = f.l - pl, dw = f.w - pw; return [Math.min(dl, dw), Math.max(dl, dw)]; },
  longSide: (f, pl, pw) => { const dl = f.l - pl, dw = f.w - pw; return [Math.max(dl, dw), Math.min(dl, dw)]; },
  area: (f, pl, pw) => [f.l * f.w - pl * pw, Math.min(f.l - pl, f.w - pw)],
};

// Returns true when the first cut should be a rip (along the length), leaving
// a full-length strip below the part.
const SPLITS = {
  shorterLeftover: (dl, dw) => dl <= dw,
  longerLeftover: (dl, dw) => dl > dw,
  minArea: (dl, dw, pl, pw) => pl * dw > dl * pw,
  maxArea: (dl, dw, pl, pw) => pl * dw <= dl * pw,
  ripFirst: () => true,
  crosscutFirst: () => false,
};

function heuristics(itemCount) {
  const sorts = itemCount > 80 ? ['area', 'longest', 'width'] : Object.keys(SORTS);
  const fits = itemCount > 80 ? ['shortSide', 'area'] : Object.keys(FITS);
  const splits = itemCount > 80 ? ['shorterLeftover', 'ripFirst', 'crosscutFirst'] : Object.keys(SPLITS);
  const out = [];
  for (const sort of sorts) for (const fit of fits) for (const split of splits) out.push({ sort, fit, split });
  return out;
}

const node = (x, y, l, w) => ({ x, y, l, w, cut: null, children: [], part: null });

function lessScore(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i] - EPS) return true;
    if (a[i] > b[i] + EPS) return false;
  }
  return false;
}

function orientations(it) {
  const out = [[it.l, it.w, false]];
  if (!it.grain && Math.abs(it.l - it.w) > EPS) out.push([it.w, it.l, true]);
  return out;
}

// Cuts `n` so that the first child is `size` along `axis`. The kerf is lost
// between the two children. Returns the offcut child (or null if nothing is left).
function split(n, axis, size, kerf) {
  n.cut = { axis, at: size };
  const first = axis === 'x' ? node(n.x, n.y, size, n.w) : node(n.x, n.y, n.l, size);
  const restL = axis === 'x' ? n.l - size - kerf : n.l;
  const restW = axis === 'x' ? n.w : n.w - size - kerf;
  let rest = null;
  if (restL > EPS && restW > EPS) {
    rest = axis === 'x' ? node(n.x + size + kerf, n.y, restL, restW) : node(n.x, n.y + size + kerf, restL, restW);
  }
  n.children = rest ? [first, rest] : [first];
  return [first, rest];
}

function packSheet(stock, items, kerf, h) {
  const root = node(0, 0, stock.length, stock.width);
  let free = [root];
  const placed = [];
  const left = [];
  let area = 0;
  const sorted = [...items].sort((a, b) => SORTS[h.sort](a, b) || a.order - b.order);

  for (const it of sorted) {
    let best = null;
    for (const f of free) {
      for (const [pl, pw, rotated] of orientations(it)) {
        if (pl > f.l + EPS || pw > f.w + EPS) continue;
        const score = FITS[h.fit](f, pl, pw);
        if (!best || lessScore(score, best.score)) best = { f, pl, pw, rotated, score };
      }
    }
    if (!best) { left.push(it); continue; }

    const { f, pl, pw, rotated } = best;
    free = free.filter((n) => n !== f);
    const ripFirst = SPLITS[h.split](f.l - pl, f.w - pw, pl, pw);
    let holder = f;
    for (const axis of ripFirst ? ['y', 'x'] : ['x', 'y']) {
      const size = axis === 'x' ? pl : pw;
      const extent = axis === 'x' ? holder.l : holder.w;
      if (extent - size > EPS) {
        const [first, rest] = split(holder, axis, size, kerf);
        if (rest) free.push(rest);
        holder = first;
      }
    }
    holder.part = { ...it, rotated };
    placed.push(holder);
    area += pl * pw;
  }

  const biggestOffcut = free.reduce((m, n) => Math.max(m, n.l * n.w), 0);
  return { root, placed, left, free, area, biggestOffcut };
}

function bestPack(stock, items, kerf) {
  let best = null;
  for (const h of heuristics(items.length)) {
    const p = packSheet(stock, items, kerf, h);
    if (!best || p.area > best.area + EPS ||
        (Math.abs(p.area - best.area) <= EPS && p.biggestOffcut > best.biggestOffcut + EPS)) {
      best = p;
    }
  }
  return best;
}

function allowedOn(it, s) {
  return !it.from || it.from === s.id;
}

function fitsStock(it, s) {
  return allowedOn(it, s) && orientations(it).some(([pl, pw]) => pl <= s.length + EPS && pw <= s.width + EPS);
}

function runStrategy(stock, items, kerf, strategy) {
  const avail = stock.map((s) => s.qty);
  const copies = stock.map(() => 0);
  let remaining = items;
  const sheets = [];

  while (remaining.length) {
    let pick = null;
    stock.forEach((s, i) => {
      if (avail[i] <= 0 || !remaining.some((it) => fitsStock(it, s))) return;
      const eligible = remaining.filter((it) => allowedOn(it, s));
      const p = bestPack(s, eligible, kerf);
      if (!p.placed.length) return;
      p.left = p.left.concat(remaining.filter((it) => !allowedOn(it, s)));
      const sheetArea = s.length * s.width;
      const key = strategy === 'yield' ? [p.area / sheetArea, p.area] : [p.area, p.area / sheetArea];
      if (!pick || key[0] > pick.key[0] + EPS || (Math.abs(key[0] - pick.key[0]) <= EPS && key[1] > pick.key[1] + EPS)) {
        pick = { i, p, key };
      }
    });
    if (!pick) break;
    avail[pick.i] -= 1;
    copies[pick.i] += 1;
    sheets.push({ stock: stock[pick.i], copy: copies[pick.i], pack: pick.p });
    remaining = pick.p.left;
  }
  const unplacedArea = remaining.reduce((a, it) => a + it.l * it.w, 0);
  const stockArea = sheets.reduce((a, s) => a + s.stock.length * s.stock.width, 0);
  return { sheets, remaining, unplacedArea, stockArea };
}

function betterRun(a, b) {
  if (Math.abs(a.unplacedArea - b.unplacedArea) > EPS) return a.unplacedArea < b.unplacedArea;
  if (Math.abs(a.stockArea - b.stockArea) > EPS) return a.stockArea < b.stockArea;
  return a.sheets.length < b.sheets.length;
}

function describeSheet({ stock, copy, pack }, index, kerf) {
  const cuts = [];
  (function walk(n) {
    if (!n.cut) return;
    const { axis, at } = n.cut;
    const pos = (axis === 'x' ? n.x : n.y) + at;
    cuts.push({
      n: cuts.length + 1,
      type: axis === 'x' ? 'crosscut' : 'rip',
      axis,
      pos,
      offset: at,
      piece: { x: n.x, y: n.y, l: n.l, w: n.w },
    });
    n.children.forEach(walk);
  })(pack.root);

  const placements = pack.placed
    .map((n) => ({
      partId: n.part.partId,
      name: n.part.name,
      n: n.part.n,
      x: n.x, y: n.y, l: n.l, w: n.w,
      rotated: n.part.rotated,
    }))
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const offcuts = pack.free
    .map((n) => ({ x: n.x, y: n.y, l: n.l, w: n.w }))
    .sort((a, b) => b.l * b.w - a.l * a.w);

  const area = stock.length * stock.width;
  return {
    index,
    stockId: stock.id,
    stockName: stock.name,
    copy,
    length: stock.length,
    width: stock.width,
    kerf,
    placements,
    cuts,
    offcuts,
    usedArea: pack.area,
    area,
    yield: pack.area / area,
  };
}

function validStock(s) {
  return s && s.length > EPS && s.width > EPS && Number.isInteger(s.qty) && s.qty > 0;
}
function validPart(p) {
  return p && p.length > EPS && p.width > EPS && Number.isInteger(p.qty) && p.qty > 0;
}

/**
 * @param {{stock: Array<{id,name,length,width,qty}>, parts: Array<{id,name,length,width,qty,grain,from?}>, kerf: number}} input
 *   `from` optionally limits a part to one stock id.
 */
export function planCuts({ stock = [], parts = [], kerf = 0 }) {
  kerf = Math.max(0, Number(kerf) || 0);
  const stockList = stock.filter(validStock);
  const partList = parts.filter(validPart);
  const stockIds = new Set(stockList.map((s) => s.id));

  const items = [];
  partList.forEach((p, order) => {
    // A part tied to stock that no longer exists can be cut from anything.
    const from = p.from && stockIds.has(p.from) ? p.from : null;
    for (let n = 1; n <= p.qty; n++) {
      items.push({ partId: p.id, name: p.name, l: p.length, w: p.width, grain: !!p.grain, from, n, order });
    }
  });

  const empty = { sheets: [], unplaced: [], stats: { sheets: 0, partsTotal: items.length, partsPlaced: 0, partArea: 0, stockArea: 0, yield: 0 } };
  if (items.length > MAX_INSTANCES) return { ...empty, error: 'too-many-parts' };
  if (!items.length) return empty;

  let best = null;
  for (const strategy of ['yield', 'fill']) {
    const r = runStrategy(stockList, items, kerf, strategy);
    if (!best || betterRun(r, best)) best = r;
  }

  // List sheets in the order the stock was entered, not the order they were filled.
  const order = new Map(stockList.map((s, i) => [s, i]));
  const sheets = [...best.sheets]
    .sort((a, b) => order.get(a.stock) - order.get(b.stock) || a.copy - b.copy)
    .map((s, i) => describeSheet(s, i, kerf));

  const byPart = new Map();
  for (const it of best.remaining) {
    const entry = byPart.get(it.partId) || {
      partId: it.partId, name: it.name, length: it.l, width: it.w, count: 0, order: it.order,
      reason: stockList.some((s) => fitsStock(it, s)) ? 'no-stock' : 'too-big',
    };
    entry.count += 1;
    byPart.set(it.partId, entry);
  }
  const unplaced = [...byPart.values()].sort((a, b) => a.order - b.order);

  const partArea = sheets.reduce((a, s) => a + s.usedArea, 0);
  const stockArea = sheets.reduce((a, s) => a + s.area, 0);
  return {
    sheets,
    unplaced,
    stats: {
      sheets: sheets.length,
      partsTotal: items.length,
      partsPlaced: items.length - best.remaining.length,
      partArea,
      stockArea,
      yield: stockArea ? partArea / stockArea : 0,
    },
  };
}

/**
 * When parts are left over only because stock ran out, find the cheapest
 * single stock type to buy more of. Returns {stockId, add} or null.
 */
export function suggestStock(input, result = planCuts(input)) {
  const short = result.unplaced.filter((u) => u.reason === 'no-stock');
  if (!short.length) return null;
  const goal = result.unplaced.length - short.length; // too-big parts can never fit

  let best = null;
  for (const s of input.stock.filter(validStock)) {
    const worksWith = (add) => {
      const stock = input.stock.map((x) => (x === s ? { ...x, qty: x.qty + add } : x));
      return planCuts({ ...input, stock }).unplaced.length <= goal;
    };
    const shortArea = short.reduce((a, u) => a + u.length * u.width * u.count, 0);
    let lo = Math.max(1, Math.ceil(shortArea / (s.length * s.width) - EPS));
    let hi = lo;
    while (hi <= 256 && !worksWith(hi)) { lo = hi + 1; hi *= 2; }
    if (hi > 256) continue;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (worksWith(mid)) hi = mid; else lo = mid + 1;
    }
    const area = hi * s.length * s.width;
    if (!best || area < best.area - EPS || (Math.abs(area - best.area) <= EPS && hi < best.add)) {
      best = { stockId: s.id, add: hi, area };
    }
  }
  return best && { stockId: best.stockId, add: best.add };
}
