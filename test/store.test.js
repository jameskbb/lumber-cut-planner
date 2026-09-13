import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeProject, toPlanInput, convertProjectUnits, encodeShare, decodeShare,
  exampleProject, blankProject, letterFor,
} from '../src/store.js';
import { planCuts } from '../src/planner.js';

test('rejects files that are not projects', () => {
  for (const bad of [null, 'hi', {}, { stock: [] }, { stock: 'x', parts: [] }]) {
    assert.throws(() => sanitizeProject(bad), /isn't a Lumber Cut Planner project/);
  }
});

test('cleans untrusted project data', () => {
  const p = sanitizeProject({
    name: 'x'.repeat(500), units: 'furlongs', kerf: 1,
    stock: [{ id: '<script>', name: { evil: true }, length: 96, width: '48', qty: 2 }, 'junk'],
    parts: [{ id: 'a', name: 'Side', length: '36', width: '11 1/4', grain: 'yes', from: 'missing' }],
  });
  assert.equal(p.name.length, 120);
  assert.equal(p.units, 'in');
  assert.equal(p.stock.length, 1);
  assert.match(p.stock[0].id, /^[a-z0-9]+$/);
  assert.equal(p.stock[0].name, '');
  assert.equal(p.stock[0].length, '96');
  assert.equal(p.parts[0].grain, false);
  assert.equal(p.parts[0].from, '');
  assert.equal(p.parts[0].qty, '1');
});

test('reports invalid and incomplete rows and skips blank ones', () => {
  const project = blankProject();
  project.parts = [
    { id: 'a', name: 'Side', length: '36', width: 'wide', qty: '2' },
    { id: 'b', name: 'Shelf', length: '22', width: '', qty: '1' },
    { id: 'c', name: '', length: '', width: '', qty: '1' },
    { id: 'd', name: '', length: '10', width: '5', qty: '1' },
  ];
  const { input, issues } = toPlanInput(project);
  assert.deepEqual(issues.map((i) => [i.id, i.type, i.fields]), [['a', 'invalid', ['width']], ['b', 'incomplete', ['width']]]);
  assert.equal(input.parts.length, 1);
  assert.equal(input.parts[0].name, 'Part D');
});

test('the example project plans with nothing left over', () => {
  const { input, issues } = toPlanInput(exampleProject());
  assert.equal(issues.length, 0);
  const r = planCuts(input);
  assert.equal(r.unplaced.length, 0);
  assert.equal(r.sheets.length, 2);
});

test('switching units converts every size', () => {
  const mm = convertProjectUnits(exampleProject(), 'mm');
  assert.equal(mm.stock[0].length, '2438.4');
  assert.equal(mm.kerf, '3.2');
  const back = convertProjectUnits(mm, 'in');
  assert.equal(back.parts[0].width, '11 1/4');
});

test('share links round-trip a project', async () => {
  const p = exampleProject();
  const code = await encodeShare(p);
  assert.match(code, /^[01][A-Za-z0-9_-]+$/);
  assert.deepEqual(await decodeShare(code), sanitizeProject(p));
  await assert.rejects(decodeShare('9abc'));
});

test('part letters continue past Z', () => {
  assert.deepEqual([0, 25, 26, 27].map(letterFor), ['A', 'Z', 'AA', 'AB']);
});
