import test from 'node:test';
import assert from 'node:assert/strict';
import { planCuts, recommendStock, suggestStock } from '../src/planner.js';

function project(parts, stock) {
  return { kerf: 0, parts, stock };
}

test('legacy suggestStock keeps its compact response', () => {
  const input = project(
    [{ id: 'p', name: 'Panel', length: 10, width: 10, qty: 3 }],
    [{ id: 's', name: 'Sheet', length: 10, width: 10, qty: 1, price: 4 }],
  );
  assert.deepEqual(suggestStock(input), { stockId: 's', add: 2 });
});

test('cost optimization can recommend a mixed purchase', () => {
  const input = project(
    [{ id: 'p', name: 'Panel', length: 10, width: 10, qty: 3 }],
    [
      { id: 'small', name: 'Small', length: 10, width: 10, qty: 0, price: 2 },
      { id: 'double', name: 'Double', length: 20, width: 10, qty: 0, price: 3 },
    ],
  );

  const initialPlan = planCuts(input);
  assert.equal(initialPlan.unplaced[0].reason, 'no-stock');
  const recommendation = recommendStock(input, initialPlan, { objective: 'cost' });
  assert.deepEqual(recommendation.purchases, [
    { stockId: 'small', stockName: 'Small', qty: 1, unitPrice: 2, cost: 2, area: 100 },
    { stockId: 'double', stockName: 'Double', qty: 1, unitPrice: 3, cost: 3, area: 200 },
  ]);
  assert.equal(recommendation.totalCost, 5);
  assert.equal(recommendation.totalSheets, 2);
  assert.equal(recommendation.plan.unplaced.length, 0);
});

test('objectives choose cost, raw-area waste, or sheet count independently', () => {
  const input = project(
    [{ id: 'p', name: 'Panel', length: 10, width: 10, qty: 4 }],
    [
      { id: 'small', name: 'Small', length: 10, width: 10, qty: 0, price: 1 },
      { id: 'large', name: 'Large', length: 20, width: 10, qty: 0, price: 10 },
    ],
  );

  const cost = recommendStock(input, undefined, { objective: 'cost' });
  const waste = recommendStock(input, undefined, { objective: 'waste' });
  const sheets = recommendStock(input, undefined, { objective: 'sheetCount' });

  assert.deepEqual(cost.purchases.map(({ stockId, qty }) => ({ stockId, qty })), [{ stockId: 'small', qty: 4 }]);
  assert.equal(cost.totalCost, 4);
  assert.equal(waste.totalArea, 400);
  assert.equal(waste.wasteArea, 0);
  assert.equal(sheets.totalSheets, 2);
  assert.deepEqual(sheets.purchases.map(({ stockId, qty }) => ({ stockId, qty })), [{ stockId: 'large', qty: 2 }]);
});

test('cost objective reports an area fallback when prices are missing', () => {
  const input = project(
    [{ id: 'p', name: 'Panel', length: 10, width: 10, qty: 1 }],
    [{ id: 's', name: 'Sheet', length: 10, width: 10, qty: 0 }],
  );
  const recommendation = recommendStock(input);
  assert.equal(recommendation.priceComplete, false);
  assert.equal(recommendation.totalCost, null);
  assert.equal(recommendation.purchases[0].unitPrice, null);
});

test('purchase recommendations honor stock assignments and thickness', () => {
  const input = project(
    [
      { id: 'thin-part', name: 'Thin', length: 10, width: 10, thickness: 0.25, qty: 1, from: 'thin' },
      { id: 'thick-part', name: 'Thick', length: 10, width: 10, thickness: 0.75, qty: 1, from: 'thick' },
    ],
    [
      { id: 'thin', name: 'Thin stock', length: 10, width: 10, thickness: 0.25, qty: 0, price: 2 },
      { id: 'thick', name: 'Thick stock', length: 10, width: 10, thickness: 0.75, qty: 0, price: 3 },
    ],
  );
  const recommendation = recommendStock(input);
  assert.deepEqual(recommendation.purchases.map(({ stockId, qty }) => ({ stockId, qty })), [
    { stockId: 'thin', qty: 1 },
    { stockId: 'thick', qty: 1 },
  ]);
  assert.equal(recommendation.plan.unplaced.length, 0);
});

test('returns null when buying stock cannot solve the remaining problem', () => {
  const input = project(
    [{ id: 'p', name: 'Oversize', length: 30, width: 10, qty: 1 }],
    [{ id: 's', name: 'Sheet', length: 20, width: 10, qty: 0, price: 2 }],
  );
  assert.equal(recommendStock(input), null);
});

test('rejects unknown purchase objectives', () => {
  const input = project([], []);
  assert.throws(() => recommendStock(input, undefined, { objective: 'speed' }), RangeError);
});
