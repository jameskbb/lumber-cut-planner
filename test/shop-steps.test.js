import test from 'node:test';
import assert from 'node:assert/strict';
import { planCuts } from '../src/planner.js';
import { buildShopSteps, cutParents, cutKey, isStepDone, firstOpenStep, nextOpenStep, stepPieces } from '../src/shop-steps.js';

const EPS = 1e-6;

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cut = (n, type, offset, x, y, l, w) => ({ n, type, axis: type === 'rip' ? 'y' : 'x', offset, pos: (type === 'rip' ? y : x) + offset, piece: { x, y, l, w } });

// The two pieces a cut leaves, worked out from the saw's geometry.
function childrenOf(c, kerf) {
  const { x, y, l, w } = c.piece;
  if (c.type === 'crosscut') return [{ x, y, l: c.offset, w }, { x: x + c.offset + kerf, y, l: l - c.offset - kerf, w }];
  return [{ x, y, l, w: c.offset }, { x, y: y + c.offset + kerf, l, w: w - c.offset - kerf }];
}
const samePiece = (a, b) => ['x', 'y', 'l', 'w'].every((k) => Math.abs(a[k] - b[k]) < 1e-6);

// Checks, independently of the module, that every cut in the step order
// cuts a piece that's already been cut free, and that each step is one setting.
function assertPhysicallyOrdered(plan, steps) {
  const seen = new Set();
  for (const step of steps) {
    const sheet = plan.sheets[step.sheetIndex];
    for (const c of step.cuts) {
      assert.equal(c.type, step.type, 'one kind of cut per step');
      assert.ok(Math.abs(c.offset - step.offset) < EPS, 'one setting per step');
      const whole = samePiece(c.piece, { x: 0, y: 0, l: sheet.length, w: sheet.width });
      if (!whole) {
        const maker = sheet.cuts.find((d) => childrenOf(d, sheet.kerf).some((p) => samePiece(p, c.piece)));
        assert.ok(maker, `cut ${c.n} cuts a piece some cut produces`);
        assert.ok(seen.has(cutKey(step.sheetIndex, maker)), `cut ${c.n} comes after cut ${maker.n}, which makes its piece`);
      }
      seen.add(c.key);
    }
  }
  const total = plan.sheets.reduce((a, s) => a + s.cuts.length, 0);
  assert.equal(seen.size, total, 'every cut appears exactly once');
}

// Sheet 96 x 48, no kerf. Two strips ripped at 10, each crosscut at 20, and a
// third strip ripped at 5 whose crosscut at 20 has to wait for that rip.
const reorderSheet = {
  length: 96, width: 48, kerf: 0,
  cuts: [
    cut(1, 'rip', 10, 0, 0, 96, 48),
    cut(2, 'crosscut', 20, 0, 0, 96, 10),
    cut(3, 'rip', 10, 0, 10, 96, 38),
    cut(4, 'crosscut', 20, 0, 10, 96, 10),
    cut(5, 'rip', 5, 0, 20, 96, 28),
    cut(6, 'crosscut', 20, 0, 20, 96, 5),
  ],
};

test('finds the cut that makes each piece', () => {
  assert.deepEqual(cutParents(reorderSheet.cuts), [-1, 0, 0, 2, 2, 4]);
});

test('groups cuts at the same setting and respects what each cut needs first', () => {
  const plan = { sheets: [reorderSheet] };
  const steps = buildShopSteps(plan);
  assert.deepEqual(steps.map((s) => s.cuts.map((c) => c.n)), [[1, 3], [2, 4], [5], [6]]);
  assert.deepEqual(steps.map((s) => [s.type, s.offset]), [['rip', 10], ['crosscut', 20], ['rip', 5], ['crosscut', 20]]);
  // Cut 6 is at the same setting as step 2, but its piece only exists after cut 5.
  assert.ok(!steps[1].cuts.some((c) => c.n === 6));
  assertPhysicallyOrdered(plan, steps);
});

test('groups a run of rips made one after another from what is left over', () => {
  const plan = planCuts({
    stock: [{ id: 's', name: 'Ply', length: 96, width: 48, qty: 1 }],
    parts: [{ id: 'p', name: 'Strip', length: 96, width: 11.25, qty: 4, grain: true }],
    kerf: 0.125,
  });
  const steps = buildShopSteps(plan);
  assert.equal(steps.length, 1, 'one fence setting for all four strips');
  assert.equal(steps[0].type, 'rip');
  assert.equal(steps[0].offset, 11.25);
  assert.equal(steps[0].cuts.length, plan.sheets[0].cuts.length);
  assert.equal(stepPieces(steps[0]).length, 1, 'every later piece is left over from the first');
  assertPhysicallyOrdered(plan, steps);
});

test('maps each cut to the checklist key for its sheet and number', () => {
  const plan = { sheets: [reorderSheet, { ...reorderSheet }] };
  const steps = buildShopSteps(plan);
  assert.equal(cutKey(1, { n: 3 }), '1-3');
  const keys = steps.flatMap((s) => s.keys);
  assert.equal(new Set(keys).size, 12);
  assert.deepEqual(steps.filter((s) => s.sheetIndex === 1).flatMap((s) => s.keys), ['1-1', '1-3', '1-2', '1-4', '1-5', '1-6']);
  assert.ok(steps.every((s, i) => s.index === i));
  // Steps never mix sheets, and sheets stay in order.
  assert.ok(steps.every((s) => s.keys.every((k) => k.startsWith(`${s.sheetIndex}-`))));
  assert.deepEqual(steps.map((s) => s.sheetIndex), [0, 0, 0, 0, 1, 1, 1, 1]);
});

test('keeps the planner order when no two cuts share a setting', () => {
  const sheet = {
    length: 96, width: 48, kerf: 0,
    cuts: [
      cut(1, 'rip', 24, 0, 0, 96, 48),
      cut(2, 'crosscut', 30, 0, 0, 96, 24),
      cut(3, 'rip', 12, 30, 0, 66, 24),
      cut(4, 'crosscut', 40, 0, 24, 96, 24),
    ],
  };
  const steps = buildShopSteps({ sheets: [sheet] });
  assert.equal(steps.length, 4);
  assert.deepEqual(steps.map((s) => s.cuts.map((c) => c.n)), [[1], [2], [3], [4]]);
  assert.deepEqual(steps.map((s) => s.keys[0]), ['0-1', '0-2', '0-3', '0-4']);
});

test('a plan with no cuts has no steps', () => {
  assert.deepEqual(buildShopSteps({ sheets: [{ length: 10, width: 10, kerf: 0, cuts: [] }] }), []);
  assert.deepEqual(buildShopSteps({ sheets: [] }), []);
  assert.deepEqual(buildShopSteps(null), []);
});

test('finds where to resume, counting a step done only when all its cuts are', () => {
  const steps = buildShopSteps({ sheets: [reorderSheet] });
  const done = new Set();
  assert.equal(firstOpenStep(steps, done), 0);
  done.add('0-1');
  assert.equal(isStepDone(steps[0], done), false, 'cut 3 is still to make');
  assert.equal(firstOpenStep(steps, done), 0);
  done.add('0-3');
  assert.equal(firstOpenStep(steps, done), 1);
  done.add('0-5');
  assert.equal(nextOpenStep(steps, done, 1), 3, 'skips the step already done');
  assert.equal(nextOpenStep(steps, done, 3), 1, 'wraps round to a skipped step');
  for (const k of steps.flatMap((s) => s.keys)) done.add(k);
  assert.equal(firstOpenStep(steps, done), -1);
  assert.equal(nextOpenStep(steps, done, 0), -1);
});

test('every step order from real plans is physically possible', () => {
  const rand = rng(7);
  let grouped = 0;
  for (let t = 0; t < 60; t++) {
    const units = rand() < 0.5;
    const stock = [{ id: 's1', name: 'Ply', length: 96, width: 48, qty: 3 }, { id: 's2', name: 'Board', length: 96, width: 11.25, qty: 4 }];
    const parts = Array.from({ length: 1 + Math.floor(rand() * 6) }, (_, i) => ({
      id: `p${i}`, name: `P${i}`,
      length: units ? [12, 18, 23.75, 30, 36][Math.floor(rand() * 5)] : 4 + Math.round(rand() * 40),
      width: units ? [3.5, 5.5, 11.25, 16][Math.floor(rand() * 4)] : 2 + Math.round(rand() * 20),
      qty: 1 + Math.floor(rand() * 5), grain: rand() < 0.5,
    }));
    const plan = planCuts({ stock, parts, kerf: rand() < 0.5 ? 0.125 : 0 });
    const steps = buildShopSteps(plan);
    assertPhysicallyOrdered(plan, steps);
    grouped += steps.filter((s) => s.cuts.length > 1).length;
  }
  assert.ok(grouped > 0, 'real plans do produce grouped steps');
});
