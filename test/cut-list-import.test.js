import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCutList, MAX_PARTS, MAX_PROBLEMS } from '../src/cut-list-import.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
const brief = (p) => [p.name, p.length, p.width, p.qty];

test('reads a typed list without headings, defaulting quantity to 1', () => {
  const r = parseCutList('Side, 36, 11 1/4, 2\nTop, 24, 12\n');
  assert.deepEqual(r.parts.map(brief), [['Side', '36', '11 1/4', '2'], ['Top', '24', '12', '1']]);
  assert.equal(r.hasHeadings, false);
  assert.equal(r.problems.length, 0);
  close(r.parts[0].values.width, 11.25);
});

test('reads a line that starts with a size as a part with no name', () => {
  const r = parseCutList('36, 11 1/4, 2\n24, 12');
  assert.deepEqual(r.parts.map(brief), [['', '36', '11 1/4', '2'], ['', '24', '12', '1']]);
  // Four values: the first one is a name, even when it's a number.
  assert.deepEqual(brief(parseCutList('12, 36, 11 1/4, 2').parts[0]), ['12', '36', '11 1/4', '2']);
});

test('reads rows copied from a spreadsheet (tab-separated) with headings', () => {
  const r = parseCutList('Part\tLength\tWidth\tQty\nSide\t36\t11 1/4\t2\nShelf\t22 1/2\t11 1/4\t3\n');
  assert.equal(r.delimiter, '\t');
  assert.equal(r.hasHeadings, true);
  assert.deepEqual(r.parts.map(brief), [['Side', '36', '11 1/4', '2'], ['Shelf', '22 1/2', '11 1/4', '3']]);
});

test('unquotes spreadsheet cells that contain inch marks or commas', () => {
  const r = parseCutList('Door\t"35 7/8"""\t"11 7/16"""\t2\n"Shelf, adjustable"\t22 1/2\t11 1/4\t3');
  assert.deepEqual(r.parts.map(brief), [['Door', '35 7/8"', '11 7/16"', '2'], ['Shelf, adjustable', '22 1/2', '11 1/4', '3']]);
});

test('reads quoted CSV fields, including ones that span lines', () => {
  const r = parseCutList('"Shelf, adjustable",22 1/2,11 1/4,3\n"Back\npanel",36,23 1/4,1\nRail,20,3');
  assert.deepEqual(r.parts.map(brief), [
    ['Shelf, adjustable', '22 1/2', '11 1/4', '3'], ['Back\npanel', '36', '23 1/4', '1'], ['Rail', '20', '3', '1'],
  ]);
  assert.equal(r.rows[2].line, 4);
});

test('keeps unquoted feet and inch marks in comma-separated lines', () => {
  const r = parseCutList('Rail, 2\' 6", 3 1/2, 4');
  assert.deepEqual(brief(r.parts[0]), ['Rail', '2\' 6"', '3 1/2', '4']);
  close(r.parts[0].values.length, 30);
});

test('maps headings in any order and case, with grain and thickness', () => {
  const r = parseCutList('QTY,W,L,Description,Grain,T\n2,11 1/4,36,Side,yes,3/4\n1,12,24,Top,,');
  assert.deepEqual(r.parts.map(brief), [['Side', '36', '11 1/4', '2'], ['Top', '24', '12', '1']]);
  assert.equal(r.parts[0].grain, true);
  assert.equal(r.parts[0].thickness, '3/4');
  assert.equal(r.parts[1].grain, null);
  assert.equal(r.parts[1].thickness, '');
});

test('reads metric sizes in an inch project and plain numbers in a millimetre project', () => {
  const inch = parseCutList('Side, 600mm, 30 cm, 2', { units: 'in' });
  assert.deepEqual(brief(inch.parts[0]), ['Side', '600mm', '30 cm', '2']);
  close(inch.parts[0].values.length, 600 / 25.4);
  const mm = parseCutList('Side; 600; 285,5; 2', { units: 'mm' });
  assert.deepEqual(brief(mm.parts[0]), ['Side', '600', '285,5', '2']);
  close(mm.parts[0].values.width, 285.5);
});

test('reads the Fusion 360 Export Cutlist CSV, using the unit in the headings', () => {
  const csv = 'count,material,length (in),width (in),height (in),names\n2,Pine,6.00,2.00,0.50,"Left,Right"\n';
  const r = parseCutList(csv, { units: 'in' });
  assert.deepEqual(brief(r.parts[0]), ['Left,Right', '6.00', '2.00', '2']);
  assert.equal(r.parts[0].thickness, '0.50');
  assert.equal(r.parts[0].material, 'Pine');

  const mm = parseCutList(csv, { units: 'mm' });
  assert.equal(mm.parts[0].length, '6.00"');
  close(mm.parts[0].values.length, 152.4);

  const metric = parseCutList('count,material,length (mm),width (mm),height (mm),names\n1,Birch,600.00,300.00,18.00,Shelf', { units: 'in' });
  assert.equal(metric.parts[0].length, '600.00 mm');
  close(metric.parts[0].values.thickness, 18 / 25.4);
});

test('reads the Fusion 360 Cutlist Evo tab-separated layout', () => {
  const tsv = 'Length\tWidth\tThickness\tQuantity\tRotation\tName\tMaterial\tBanding\n6.00\t2.00\t0.50\t2\tL,L\tLeft,Right\tPine\tN,N\n';
  const r = parseCutList(tsv);
  assert.deepEqual(brief(r.parts[0]), ['Left,Right', '6.00', '2.00', '2']);
  assert.equal(r.parts[0].material, 'Pine');
});

test('reads an OpenCutList export: semicolons, decimal commas and finished sizes', () => {
  const csv = [
    'No.;Designation;Quantity;Length - raw;Width - raw;Thickness - raw;Length;Width;Thickness;Area - final;Material type;Material name',
    'A;Side;2;610 mm;305 mm;19 mm;600 mm;300 mm;18 mm;0,36 m²;Sheet good;Birch plywood',
    'B;Shelf;3;420 mm;305 mm;19 mm;412,5 mm;300 mm;18 mm;0,12 m²;Sheet good;Birch plywood',
  ].join('\n');
  const r = parseCutList(csv, { units: 'mm' });
  assert.equal(r.delimiter, ';');
  assert.deepEqual(r.parts.map(brief), [['Side', '600 mm', '300 mm', '2'], ['Shelf', '412,5 mm', '300 mm', '3']]);
  assert.equal(r.parts[0].thickness, '18 mm');
  assert.equal(r.parts[0].material, 'Birch plywood');
  close(r.parts[1].values.length, 412.5);
});

test('reads SketchUp CutList exports, including a title line and repeated headings', () => {
  const clp = [
    'Part #,Sub-Assembly,Description,Copies,Thickness(T),Width(W),Length(L),Material Type,Material Name,Can Rotate,',
    '1,Case,Side,2,3/4",11 1/4",36",Sheet Good,Birch Plywood,No,',
    '2,Case,Toe kick,1,3/4",3",22 1/2",Sheet Good,Birch Plywood,Yes,',
  ].join('\n');
  const r = parseCutList(clp);
  assert.deepEqual(r.parts.map(brief), [['Side', '36"', '11 1/4"', '2'], ['Toe kick', '22 1/2"', '3"', '1']]);
  assert.equal(r.parts[0].grain, true);
  assert.equal(r.parts[1].grain, false);
  assert.equal(r.parts[0].material, 'Birch Plywood');

  const list = [
    'Project: Bookcase',
    'Part #,Sub-Assembly,Description,Length(L),Width(W),Thickness(T),Board Feet,Material,',
    '1,,Side,~ 36",11 1/4",3/4",2.8,Pine,',
    'Part #,Sub-Assembly,Description,Length(L),Width(W),Thickness(T),Board Feet,Material,',
    '2,,Shelf,22 1/2",11 1/4",3/4",1.8,Pine,',
  ].join('\r\n');
  const r2 = parseCutList(list);
  assert.deepEqual(r2.parts.map(brief), [['Side', '36"', '11 1/4"', '1'], ['Shelf', '22 1/2"', '11 1/4"', '1']]);
  assert.equal(r2.problems.length, 0);
});

test('skips blank lines, a byte order mark and Windows line endings', () => {
  const r = parseCutList('\uFEFFSide,36,11 1/4,2\r\n\r\n  \r\n,,,\r\nTop,24,12,1\r\n');
  assert.deepEqual(r.parts.map(brief), [['Side', '36', '11 1/4', '2'], ['Top', '24', '12', '1']]);
  assert.deepEqual(r.rows.map((row) => row.line), [1, 5]);
});

test('reports each line it can’t read and keeps the rest', () => {
  const r = parseCutList([
    'Side, 36, 11 1/4, 2',
    'Door, 35 7/8, wide, 2',
    'Shelf, 22',
    'Top 24 12',
    'Leg, 30, 3, two',
    'Zero, 0, 12',
    'Rail, 20, 3, 1000',
    'Stile, 30, 2 1/2, 2 pcs',
  ].join('\n'));
  assert.deepEqual(r.parts.map(brief), [['Side', '36', '11 1/4', '2'], ['Stile', '30', '2 1/2', '2']]);
  assert.deepEqual(r.problems.map((p) => [p.line, p.text]), [
    [2, 'Door, 35 7/8, wide, 2'], [3, 'Shelf, 22'], [4, 'Top 24 12'], [5, 'Leg, 30, 3, two'], [6, 'Zero, 0, 12'], [7, 'Rail, 20, 3, 1000'],
  ]);
  const reasons = r.problems.map((p) => p.reason);
  assert.equal(reasons[0], 'The width “wide” should look like 23 5/8, 23.625 or 2\' 6".');
  assert.equal(reasons[1], 'Needs a width.');
  assert.equal(reasons[2], 'Separate the name, length, width and quantity with commas or tabs.');
  assert.equal(reasons[3], 'The quantity “two” should be a whole number from 1 to 999.');
  assert.equal(reasons[4], 'The length “0” should be more than 0.');
  assert.match(reasons[5], /from 1 to 999/);
  assert.equal(parseCutList('Side', { units: 'mm' }).problems[0].reason, 'Separate the name, length, width and quantity with commas or tabs.');
  assert.equal(parseCutList('Side, 90x, 30', { units: 'mm' }).problems[0].reason, 'The length “90x” should look like 600 or 600.5.');
  assert.equal(parseCutList('Name,Length,Width\nSide,,').problems[0].reason, 'Needs a length and a width.');
});

test('respects the part limit and counts what is left out', () => {
  const lines = Array.from({ length: MAX_PARTS + 5 }, (_, i) => `Part ${i + 1}, 10, 5`).join('\n');
  const r = parseCutList(lines);
  assert.equal(r.parts.length, MAX_PARTS);
  assert.equal(r.leftOut, 5);
  const some = parseCutList('A,1,1\nB,2,2\nbad\nC,3,3', { room: 1 });
  assert.deepEqual(some.parts.map((p) => p.name), ['A']);
  assert.equal(some.leftOut, 2);
  assert.equal(some.problems.length, 1);
  assert.equal(parseCutList('A,1,1', { room: 0 }).parts.length, 0);
});

test('stores sizes as typed, trimmed, and caps long names', () => {
  const r = parseCutList(`${'x'.repeat(120)},  23 5/8  , 23.625 , 3`);
  assert.equal(r.parts[0].name.length, 80);
  assert.equal(r.parts[0].length, '23 5/8');
  assert.equal(r.parts[0].width, '23.625');
  assert.equal(parseCutList('').parts.length, 0);
  assert.equal(parseCutList(null).rows.length, 0);
});

test('a stray opening quote is literal and doesn’t swallow the lines after it', () => {
  const r = parseCutList([
    'Side, 36, 11 1/4, 2',
    '"Top, 24, 12',
    'Door, 35 7/8, wide, 2',
    'Rail, 2\' 6", 3',
    'Shelf, 22 1/2, 11 1/4, 3',
  ].join('\n'));
  assert.deepEqual(r.parts.map(brief), [
    ['Side', '36', '11 1/4', '2'], ['"Top', '24', '12', '1'], ['Rail', '2\' 6"', '3', '1'], ['Shelf', '22 1/2', '11 1/4', '3'],
  ]);
  assert.deepEqual(r.problems.map((p) => p.line), [3]);
  assert.deepEqual(r.rows.map((row) => row.line), [1, 2, 3, 4, 5]);
});

test('a quote is only a CSV quote when its closing quote ends the field', () => {
  // Closed, but followed by more text: the quotes are inch marks.
  assert.deepEqual(brief(parseCutList('"12" wide shelf, 24, 12').parts[0]), ['"12" wide shelf', '24', '12', '1']);
  // Never closed.
  assert.deepEqual(brief(parseCutList('"Top, 24, 12').parts[0]), ['"Top', '24', '12', '1']);
  // Closed by an inch mark: read as CSV that makes no part, so the quotes are inch marks.
  assert.deepEqual(brief(parseCutList('"Rail, 2\' 6", 3').parts[0]), ['"Rail', '2\' 6"', '3', '1']);
  // Closed with spaces before the delimiter.
  assert.deepEqual(brief(parseCutList('"Shelf, adjustable" , 22 1/2, 11 1/4, 3').parts[0]), ['Shelf, adjustable', '22 1/2', '11 1/4', '3']);
});

test('reads real quoted CSV: embedded delimiters, doubled quotes and quoted sizes', () => {
  const csv = [
    'Name,Length,Width,Qty',
    '"Shelf, adjustable","22 1/2","11 1/4",3',
    '"Door ""A""","35 7/8""",12,1',
    '"Back',
    'panel",36,23 1/4,1',
    'Rail,20,3,2',
  ].join('\r\n');
  const r = parseCutList(csv);
  assert.deepEqual(r.parts.map(brief), [
    ['Shelf, adjustable', '22 1/2', '11 1/4', '3'], ['Door "A"', '35 7/8"', '12', '1'], ['Back\r\npanel', '36', '23 1/4', '1'], ['Rail', '20', '3', '2'],
  ]);
  assert.deepEqual(r.rows.map((row) => row.line), [2, 3, 4, 6]);
  assert.equal(r.problems.length, 0);
});

test('reads fraction characters as fractions', () => {
  const r = parseCutList('Side, 11½, ¾, 2\nRail, 2\' 6½", 3 ⅝\nStile, 30, 2⁄3');
  assert.deepEqual(r.parts.map(brief), [['Side', '11 1/2', '3/4', '2'], ['Rail', '2\' 6 1/2"', '3 5/8', '1'], ['Stile', '30', '2/3', '1']]);
  close(r.parts[0].values.length, 11.5);
  close(r.parts[1].values.length, 30.5);
  close(r.parts[1].values.width, 3.625);
});

test('lists values after the quantity, so a split decimal comma shows', () => {
  const r = parseCutList('Side, 600, 285,5, 2', { units: 'mm' });
  assert.deepEqual(brief(r.parts[0]), ['Side', '600', '285', '5']);
  assert.deepEqual(r.parts[0].extra, ['2']);
  assert.equal(parseCutList('Side, 600, 285, 2', { units: 'mm' }).parts[0].extra, undefined);
  assert.equal(parseCutList('Name,Length,Width,Qty,Notes\nSide,600,285,2,oak').parts[0].extra, undefined);
});

test('keeps the first unreadable lines and counts the rest', () => {
  const junk = Array.from({ length: MAX_PROBLEMS + 500 }, (_, i) => `junk ${i}`);
  const r = parseCutList([...junk, 'Side, 36, 11 1/4, 2'].join('\n'));
  assert.equal(r.problems.length, MAX_PROBLEMS);
  assert.equal(r.unreadable, MAX_PROBLEMS + 500);
  assert.equal(r.rows.length, MAX_PROBLEMS + 1);
  assert.equal(r.problems.at(-1).text, `junk ${MAX_PROBLEMS - 1}`);
  assert.deepEqual(brief(r.parts[0]), ['Side', '36', '11 1/4', '2']);
  assert.equal(parseCutList('a\nb').unreadable, 2);
});
