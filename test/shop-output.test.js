import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShopRows, shopRowsToCsv } from '../src/shop-output.js';

const parts = [
  { id: 'side', name: 'Side, "left"', length: 23.625, width: 10, qty: 2, grain: true },
  { id: 'shelf', name: '=1+1', length: 18, width: 8, qty: 1, grain: false },
];
const plan = {
  sheets: [{
    index: 0, copy: 1, stockName: '3/4 plywood',
    placements: [
      { partId: 'side', n: 2, x: 4, y: 2, rotated: false },
      { partId: 'shelf', n: 1, x: 28, y: 0, rotated: true },
    ],
  }],
  unplaced: [{ partId: 'side', reason: 'no-stock', count: 1 }],
};

test('builds one shop row per physical part and preserves placement references', () => {
  const rows = buildShopRows('Cabinet', 'in', parts, plan, (i) => String.fromCharCode(65 + i));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    project: 'Cabinet', partId: 'side', letter: 'A', name: 'Side, "left"', instance: 1, quantity: 2,
    length: 23.625, width: 10, cutLength: 23.625, cutWidth: 10,
    lengthAllowance: 0, widthAllowance: 0, thickness: '', edgeBand: 'none',
    units: 'in', grain: 'Along length', status: 'Unplaced: not enough stock',
    sheet: '', stock: '', stockCopy: '', x: '', y: '', rotated: '',
  });
  assert.equal(rows[1].sheet, 1);
  assert.equal(rows[1].stock, '3/4 plywood');
  assert.equal(rows[1].instance, 2);
  assert.equal(rows[2].rotated, true);
  assert.equal(rows[2].grain, 'Can be turned');
});

test('CSV includes formatted dimensions, correct quoting, and formula protection', () => {
  const rows = buildShopRows('Cabinet', 'in', parts, plan, (i) => String.fromCharCode(65 + i));
  const csv = shopRowsToCsv(rows);
  assert.match(csv, /"Finished length"/);
  assert.match(csv, /"Cut length"/);
  assert.match(csv, /"Edge banding"/);
  assert.match(csv, /"23 5\/8"/);
  assert.match(csv, /"Side, ""left"""/);
  assert.match(csv, /"'=1\+1"/);
  assert.match(csv, /"Placed","1","3\/4 plywood"/);
  assert.equal(csv.split('\r\n').length, 4);
});

test('labels and CSV retain cut allowances, thickness, and edge banding', () => {
  const detailed = [{
    id: 'door', name: 'Door', length: 20, width: 10, cutLength: 20.25, cutWidth: 10.125,
    lengthAllowance: 0.25, widthAllowance: 0.125, thickness: 0.75, edgeBand: 'all', qty: 1, grain: true,
  }];
  const detailedPlan = {
    sheets: [{ index: 0, copy: 1, stockName: 'Birch', placements: [{ partId: 'door', n: 1, x: 0, y: 0, rotated: false, cutLength: 20.25, cutWidth: 10.125 }] }],
    unplaced: [],
  };
  const [row] = buildShopRows('Cabinet', 'in', detailed, detailedPlan, () => 'A');
  assert.equal(row.cutLength, 20.25);
  assert.equal(row.thickness, 0.75);
  assert.equal(row.edgeBand, 'all');
  const csv = shopRowsToCsv([row]);
  assert.match(csv, /"20 1\/4"/);
  assert.match(csv, /"3\/4"/);
  assert.match(csv, /"all"/);
});
