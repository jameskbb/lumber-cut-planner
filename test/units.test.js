import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLength, formatLength, lengthParts } from '../src/units.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('parses inch values people type', () => {
  const cases = {
    '23': 23, '23.5': 23.5, '.5': 0.5, '23 5/8': 23.625, '23-5/8': 23.625, '23 - 5/8': 23.625,
    '5/8': 0.625, '23 5/8"': 23.625, '48in': 48, '48 inches': 48,
    "2'": 24, "2' 6\"": 30, "2'6-1/2\"": 30.5, '4ft': 48, '4 ft 3': 51, '8′': 96,
  };
  for (const [input, expected] of Object.entries(cases)) close(parseLength(input, 'in'), expected);
});

test('converts metric input in inch mode and inch input in mm mode', () => {
  close(parseLength('25.4mm', 'in'), 1);
  close(parseLength('2.54 cm', 'in'), 1);
  close(parseLength('2"', 'mm'), 50.8);
  close(parseLength('60cm', 'mm'), 600);
  close(parseLength('1,5', 'mm'), 1.5);
});

test('rejects text that is not a length', () => {
  for (const bad of ['', '  ', 'abc', '5/0', '-3', '12x', '1/2/3', "'"]) {
    assert.equal(parseLength(bad, 'in'), null, JSON.stringify(bad));
  }
});

test('formats inches as reduced fractions to 1/32', () => {
  assert.equal(formatLength(23.625, 'in'), '23 5/8');
  assert.equal(formatLength(0.125, 'in'), '1/8');
  assert.equal(formatLength(24, 'in'), '24');
  assert.equal(formatLength(11.2519, 'in'), '11 1/4');
  assert.equal(formatLength(0.99999, 'in'), '1');
});

test('formats millimetres to one decimal', () => {
  assert.equal(formatLength(285.75, 'mm'), '285.8');
  assert.equal(formatLength(600, 'mm'), '600');
});

test('splits lengths for typesetting', () => {
  assert.deepEqual(lengthParts(0.5, 'in'), { whole: '', frac: '1/2', approx: false });
  assert.deepEqual(lengthParts(24.5, 'in'), { whole: '24', frac: '1/2', approx: false });
  assert.equal(lengthParts(1 / 3, 'in').approx, true);
});
