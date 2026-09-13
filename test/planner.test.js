import test from 'node:test';
import assert from 'node:assert/strict';
import { planCuts, suggestStock, MAX_INSTANCES } from '../src/planner.js';

const EPS = 1e-6;

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const overlaps = (a1, a2, b1, b2) => Math.min(a2, b2) - Math.max(a1, b1) > EPS;

// Checks every physical rule a real cut plan must follow.
function assertBuildable(result, input) {
  const kerf = input.kerf ?? 0;
  let placedCount = 0;
  for (const sheet of result.sheets) {
    const stock = input.stock.find((s) => s.id === sheet.stockId);
    assert.ok(stock, 'sheet uses listed stock');
    const ps = sheet.placements;
    placedCount += ps.length;

    for (const p of ps) {
      const part = input.parts.find((x) => x.id === p.partId);
      assert.ok(p.x >= -EPS && p.y >= -EPS, 'inside sheet');
      assert.ok(p.x + p.l <= sheet.length + EPS && p.y + p.w <= sheet.width + EPS, 'inside sheet');
      const dims = p.rotated ? [part.width, part.length] : [part.length, part.width];
      assert.ok(Math.abs(p.l - dims[0]) < EPS && Math.abs(p.w - dims[1]) < EPS, 'correct size');
      if (part.grain) assert.equal(p.rotated, false, 'grain-locked part not rotated');
      if (part.from) assert.equal(sheet.stockId, part.from, 'part cut from its chosen stock');
    }

    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i], b = ps[j];
        const gapX = Math.max(b.x - (a.x + a.l), a.x - (b.x + b.l));
        const gapY = Math.max(b.y - (a.y + a.w), a.y - (b.y + b.w));
        assert.ok(Math.max(gapX, gapY) >= kerf - EPS, `parts ${i} and ${j} are at least a kerf apart`);
      }
    }

    // No saw cut passes through a part.
    for (const c of sheet.cuts) {
      for (const p of ps) {
        const [p1, p2, q1, q2] = c.axis === 'x' ? [p.x, p.x + p.l, p.y, p.y + p.w] : [p.y, p.y + p.w, p.x, p.x + p.l];
        const [s1, s2] = c.axis === 'x' ? [c.piece.y, c.piece.y + c.piece.w] : [c.piece.x, c.piece.x + c.piece.l];
        const hitsBand = c.pos < p2 - EPS && c.pos + kerf > p1 + EPS;
        assert.ok(!(hitsBand && overlaps(q1, q2, s1, s2)), `cut ${c.n} misses every part`);
      }
    }
  }
  const unplacedCount = result.unplaced.reduce((a, u) => a + u.count, 0);
  assert.equal(placedCount + unplacedCount, result.stats.partsTotal);
  assert.equal(placedCount, result.stats.partsPlaced);
}

test('the old demo now fits on one sheet instead of two', () => {
  const input = {
    kerf: 0.125,
    stock: [{ id: 'L', name: 'Large', length: 96, width: 48, qty: 1 }, { id: 'S', name: 'Small', length: 48, width: 24, qty: 1 }],
    parts: [
      { id: 'side', name: 'Side', length: 24, width: 12, qty: 2 },
      { id: 'back', name: 'Back', length: 24, width: 12, qty: 1 },
      { id: 'top', name: 'Top', length: 12, width: 12, qty: 1 },
      { id: 'bot', name: 'Bottom', length: 12, width: 12, qty: 1 },
    ],
  };
  const r = planCuts(input);
  assertBuildable(r, input);
  assert.equal(r.unplaced.length, 0);
  assert.equal(r.sheets.length, 1);
});

test('an exact fit needs no cuts', () => {
  const input = { kerf: 0.125, stock: [{ id: 's', name: 'S', length: 24, width: 12, qty: 1 }], parts: [{ id: 'p', name: 'P', length: 24, width: 12, qty: 1 }] };
  const r = planCuts(input);
  assert.equal(r.sheets[0].cuts.length, 0);
  assert.equal(r.sheets[0].yield, 1);
});

test('the kerf takes up material between parts', () => {
  const stock = [{ id: 's', name: 'Board', length: 49, width: 10, qty: 1 }];
  const parts = [{ id: 'p', name: 'P', length: 24, width: 10, qty: 2 }];
  assert.equal(planCuts({ stock, parts, kerf: 1 }).unplaced.length, 0);
  const tight = planCuts({ stock, parts, kerf: 1.5 });
  assert.equal(tight.stats.partsPlaced, 1);
  assert.equal(tight.unplaced[0].reason, 'no-stock');
});

test('a rip along the full length is described as a rip', () => {
  const r = planCuts({ kerf: 0.125, stock: [{ id: 's', name: 'S', length: 96, width: 48, qty: 1 }], parts: [{ id: 'p', name: 'P', length: 96, width: 24, qty: 1 }] });
  assert.equal(r.sheets[0].cuts.length, 1);
  assert.equal(r.sheets[0].cuts[0].type, 'rip');
  assert.equal(r.sheets[0].cuts[0].offset, 24);
});

test('grain-locked parts are never turned', () => {
  const stock = [{ id: 's', name: 'S', length: 96, width: 48, qty: 1 }];
  const locked = planCuts({ kerf: 0, stock, parts: [{ id: 'p', name: 'P', length: 40, width: 60, qty: 1, grain: true }] });
  assert.equal(locked.unplaced[0].reason, 'too-big');
  const free = planCuts({ kerf: 0, stock, parts: [{ id: 'p', name: 'P', length: 40, width: 60, qty: 1, grain: false }] });
  assert.equal(free.unplaced.length, 0);
  assert.equal(free.sheets[0].placements[0].rotated, true);
});

test('parts tied to a stock are only cut from it', () => {
  const input = {
    kerf: 0.125,
    stock: [{ id: 'a', name: '3/4', length: 96, width: 48, qty: 1 }, { id: 'b', name: '1/4', length: 48, width: 24, qty: 1 }],
    parts: [{ id: 'back', name: 'Back', length: 36, width: 23, qty: 1, from: 'b' }, { id: 'side', name: 'Side', length: 36, width: 11, qty: 2, from: 'a' }],
  };
  const r = planCuts(input);
  assertBuildable(r, input);
  assert.equal(r.sheets.length, 2);
});

test('random projects always produce buildable plans', () => {
  const rand = rng(42);
  for (let trial = 0; trial < 150; trial++) {
    const kerf = [0, 0.125, 0.25, 3][trial % 4];
    const stock = Array.from({ length: 1 + Math.floor(rand() * 3) }, (_, i) => ({
      id: `s${i}`, name: `S${i}`, length: 20 + Math.round(rand() * 80), width: 5 + Math.round(rand() * 45), qty: 1 + Math.floor(rand() * 3),
    }));
    const parts = Array.from({ length: 1 + Math.floor(rand() * 8) }, (_, i) => ({
      id: `p${i}`, name: `P${i}`, length: 1 + Math.round(rand() * 400) / 8, width: 1 + Math.round(rand() * 200) / 8,
      qty: 1 + Math.floor(rand() * 4), grain: rand() < 0.3, from: rand() < 0.2 ? stock[0].id : undefined,
    }));
    const input = { stock, parts, kerf };
    assertBuildable(planCuts(input), input);
  }
});

test('suggests how much more stock to buy', () => {
  const input = { kerf: 0, stock: [{ id: 's', name: 'Half sheet', length: 48, width: 24, qty: 1 }], parts: [{ id: 'p', name: 'Panel', length: 24, width: 24, qty: 5 }] };
  const r = planCuts(input);
  assert.equal(r.stats.partsPlaced, 2);
  assert.deepEqual(suggestStock(input, r), { stockId: 's', add: 2 });
});

test('no suggestion when the only problem is a part that is too big', () => {
  const input = { kerf: 0, stock: [{ id: 's', name: 'S', length: 48, width: 24, qty: 1 }], parts: [{ id: 'p', name: 'P', length: 60, width: 10, qty: 1 }] };
  assert.equal(suggestStock(input), null);
});

test('ignores rows that are not valid', () => {
  const r = planCuts({ kerf: 0, stock: [{ id: 's', name: 'S', length: 0, width: 24, qty: 1 }], parts: [{ id: 'p', name: 'P', length: 10, width: 10, qty: 0 }] });
  assert.equal(r.stats.partsTotal, 0);
});

test('refuses absurdly large jobs instead of hanging', () => {
  const r = planCuts({ kerf: 0, stock: [{ id: 's', name: 'S', length: 96, width: 48, qty: 1 }], parts: [{ id: 'p', name: 'P', length: 1, width: 1, qty: MAX_INSTANCES + 1 }] });
  assert.equal(r.error, 'too-many-parts');
});

test('a 150-part job plans quickly', () => {
  const rand = rng(7);
  const stock = [{ id: 'a', name: 'A', length: 96, width: 48, qty: 20 }, { id: 'b', name: 'B', length: 48, width: 24, qty: 10 }];
  const parts = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, length: 4 + Math.round(rand() * 40), width: 2 + Math.round(rand() * 20), qty: 5 }));
  const t = performance.now();
  const input = { stock, parts, kerf: 0.125 };
  const r = planCuts(input);
  const ms = performance.now() - t;
  assertBuildable(r, input);
  assert.ok(ms < 3000, `took ${Math.round(ms)}ms`);
});
