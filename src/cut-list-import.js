// Reads a pasted or opened cut list into part rows: rows copied from a
// spreadsheet (tab-separated), CSV files, cut-list exports from SketchUp and
// Fusion 360, or a typed list like "Side, 36, 11 1/4, 2".
//
// Pure (no DOM) so the iOS app can reuse it. Sizes are kept as the text people
// typed, the same way the app stores them; each line that can't be read is
// reported with a reason instead of failing the whole paste.

import { parseLength } from './units.js';

export const MAX_PARTS = 200; // LIMITS.rows in store.js
const MAX_QTY = 999;
const NAME_MAX = 80;
const VALUE_MAX = 24;
const TEXT_MAX = 200;

// Column headings, best match first for each field. Covers generic sheets plus:
// Fusion 360 "Export Cutlist" add-in: count, material, length (in), width (in), height (in), names
//   and its Cutlist Evo layout: Length, Width, Thickness, Quantity, Rotation, Name, Material, Banding
// OpenCutList (SketchUp): No., Designation, Quantity, Length - raw, ..., Length, Width, Thickness, Material name
// CutList (SketchUp, Steve Racz): Part #, Sub-Assembly, Description, Copies, Thickness(T), Width(W),
//   Length(L), Material Type, Material Name, Can Rotate
const HEADINGS = {
  name: ['name', 'part name', 'designation', 'description', 'label', 'part', 'names', 'component', 'item', 'title'],
  length: ['length', 'l', 'len', 'finished length', 'length raw', 'cut length', 'cutting length'],
  width: ['width', 'w', 'wid', 'finished width', 'width raw', 'cut width', 'cutting width'],
  qty: ['qty', 'quantity', 'count', 'pcs', 'copies', 'number of parts', 'amount', 'pieces', 'no of pieces'],
  thickness: ['thickness', 't', 'thick', 'height', 'thickness raw'],
  grain: ['grain', 'grain direction', 'keep grain', 'grain along length'],
  turn: ['can rotate', 'rotate', 'can be turned', 'rotation allowed'],
  material: ['material', 'material name', 'species', 'stock', 'material type'],
};
const ALIASES = new Map();
for (const [field, names] of Object.entries(HEADINGS)) names.forEach((name, rank) => ALIASES.set(name, { field, rank }));

const HEADING_UNITS = {
  in: 'in', inch: 'in', inches: 'in', '"': 'in', ft: 'ft', feet: 'ft',
  mm: 'mm', millimeters: 'mm', millimetres: 'mm', cm: 'cm', centimeters: 'cm', centimetres: 'cm', m: 'm',
};
const UNIT_SUFFIX = { in: '"', ft: "'", mm: ' mm', cm: ' cm', m: ' m' };

const YES = /^(?:y|yes|true|1|x|✓|✔|l|long|length|lengthwise|along(?: the)? length)$/i;

// Tab if any line has one (spreadsheets); semicolon if every line has one
// (European CSV, where the comma is the decimal mark); otherwise comma.
function detectDelimiter(text) {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim()).slice(0, 20);
  if (lines.some((l) => l.includes('\t'))) return '\t';
  if (lines.length && lines.every((l) => l.includes(';'))) return ';';
  return ',';
}

// A quoted CSV field is never this long in a cut list; past it, the quote is literal.
const QUOTED_MAX = 4000;

// The field that starts with the double quote at `i`, if it's really quoted
// CSV: the first quote that isn't doubled ("" is a literal quote) must close
// it, followed only by spaces and then the delimiter or the end of the line.
// A field that spans lines must also not end in a digit, because 6" there is
// far more likely an inch mark than the end of a quoted cell. Returns
// {content, next} or null, and null means the opening quote is literal.
function quotedField(text, i, delim) {
  const n = text.length;
  const limit = Math.min(n, i + 1 + QUOTED_MAX);
  let content = '';
  let j = i + 1;
  while (j < limit) {
    if (text[j] !== '"') { content += text[j++]; continue; }
    if (text[j + 1] === '"') { content += '"'; j += 2; continue; }
    let k = j + 1;
    while (k < n && (text[k] === ' ' || text[k] === '\t') && text[k] !== delim) k++;
    const after = text[k];
    if (!(k >= n || after === delim || after === '\n' || after === '\r')) return null;
    if (/[\r\n]/.test(content) && /\d\s*$/.test(content)) return null;
    return { content, next: k };
  }
  return null;
}

// Splits text into records of fields. A field that starts with a double quote
// is quoted CSV when quotedField() says so, and then it may span lines; any
// other quote is literal, so inch marks like 2' 6" survive unquoted.
function readRecords(text, delim) {
  const records = [];
  const n = text.length;
  let fields = [];
  let field = '';
  let line = 1;
  let start = 1;
  let from = 0;
  let i = 0;
  let hadQuotes = false;
  const end = (at) => {
    fields.push(field);
    records.push({ line: start, text: text.slice(from, at), fields, quoted: hadQuotes });
    fields = [];
    field = '';
    hadQuotes = false;
  };
  while (i < n) {
    const c = text[i];
    if (c === '"' && !field.trim()) {
      const quoted = quotedField(text, i, delim);
      if (quoted) {
        hadQuotes = true;
        line += (quoted.content.match(/\r\n|\r|\n/g) || []).length;
        field = quoted.content;
        i = quoted.next;
        continue;
      }
    }
    if (c === delim) { fields.push(field); field = ''; i++; continue; }
    if (c === '\n' || c === '\r') {
      end(i);
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      line++;
      start = line;
      from = i;
      continue;
    }
    field += c;
    i++;
  }
  if (from < n || fields.length) end(n);
  return records;
}

// Trimmed fields without the empty ones a line ends with.
function tidy(fields) {
  const out = fields.map((f) => f.trim());
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

function readHeading(cell) {
  let unit = null;
  const key = cell.toLowerCase()
    .replace(/[([]\s*([^)\]]*?)\s*[)\]]/g, (_, inside) => { unit = HEADING_UNITS[inside] ?? unit; return ' '; })
    .replace(/[_.:-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { key, unit };
}

// A heading row names at least two known columns, one of them a size.
function headingMap(fields) {
  const cols = {};
  let known = 0;
  fields.forEach((cell, index) => {
    const { key, unit } = readHeading(cell);
    const hit = ALIASES.get(key);
    if (!hit) return;
    known++;
    const current = cols[hit.field];
    if (!current || hit.rank < current.rank) cols[hit.field] = { index, rank: hit.rank, unit };
  });
  return known >= 2 && (cols.length || cols.width) ? cols : null;
}

function sizeExample(units) {
  return units === 'mm' ? '600 or 600.5' : '23 5/8, 23.625 or 2\' 6"';
}

// Fraction characters (11½, ¾, ⅝) become the "11 1/2" text the app reads.
const FRACTIONS = {
  '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4', '⅕': '1/5', '⅖': '2/5', '⅗': '3/5', '⅘': '4/5',
  '⅙': '1/6', '⅚': '5/6', '⅐': '1/7', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8', '⅑': '1/9', '⅒': '1/10',
};
const FRACTION_CHAR = new RegExp(`(\\d?)\\s*([${Object.keys(FRACTIONS).join('')}])`, 'gu');
const plainFractions = (text) => text
  .replace(FRACTION_CHAR, (_, whole, f) => `${whole ? `${whole} ` : ''}${FRACTIONS[f]}`)
  .replace(/(\d)\s*⁄\s*(\d)/g, '$1/$2');

function readSize(raw, unit, units, label) {
  let text = plainFractions(String(raw ?? '').trim().replace(/^~\s*/, ''));
  if (!text) return { missing: label };
  // A bare number under a heading like "Length (mm)" is in that unit.
  if (unit && unit !== units && /^[\d\s.,/-]+$/.test(text)) text += UNIT_SUFFIX[unit];
  const value = text.length > VALUE_MAX ? null : parseLength(text, units);
  if (value === null) return { reason: `The ${label} “${clip(raw)}” should look like ${sizeExample(units)}.` };
  if (!(value > 0)) return { reason: `The ${label} “${clip(raw)}” should be more than 0.` };
  return { text, value };
}

function readQty(raw) {
  const text = String(raw ?? '').trim();
  const t = text.replace(/^[x×]\s*/i, '').replace(/\s*(?:x|×|pcs?\.?|pieces?|ea\.?)$/i, '');
  if (!t) return { text: '1' };
  const m = t.match(/^(\d+)(?:\.0+)?$/);
  const n = m ? parseInt(m[1], 10) : NaN;
  if (!(n >= 1 && n <= MAX_QTY)) return { reason: `The quantity “${clip(text)}” should be a whole number from 1 to ${MAX_QTY}.` };
  return { text: String(n) };
}

const clip = (s, max = 40) => {
  const t = String(s ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// Without headings: name, length, width, qty. A line that starts with a size
// and has no more than three values has no name: length, width, qty.
function defaultColumns(fields, units) {
  const numberFirst = parseLength(fields[0], units) !== null && fields.length <= 3;
  const at = (index) => ({ index, unit: null });
  return numberFirst
    ? { length: at(0), width: at(1), qty: at(2) }
    : { name: at(0), length: at(1), width: at(2), qty: at(3) };
}

function readPart(fields, cols, units, delimited) {
  const get = (field) => (cols[field] ? fields[cols[field].index] ?? '' : '');
  if (!delimited && fields.length === 1 && !cols.header) {
    return { reason: 'Separate the name, length, width and quantity with commas or tabs.' };
  }
  const length = readSize(get('length'), cols.length?.unit, units, 'length');
  const width = readSize(get('width'), cols.width?.unit, units, 'width');
  const missing = [length.missing, width.missing].filter(Boolean);
  if (missing.length) return { reason: `Needs a ${missing.join(' and a ')}.` };
  if (length.reason) return { reason: length.reason };
  if (width.reason) return { reason: width.reason };
  const qty = readQty(get('qty'));
  if (qty.reason) return { reason: qty.reason };

  let thickness = { text: '', value: null };
  if (String(get('thickness')).trim()) {
    thickness = readSize(get('thickness'), cols.thickness?.unit, units, 'thickness');
    if (thickness.reason) return { reason: thickness.reason };
  }
  let grain = null;
  if (cols.grain && get('grain').trim()) grain = YES.test(get('grain').trim());
  else if (cols.turn && get('turn').trim()) grain = !YES.test(get('turn').trim());

  return {
    part: {
      name: get('name').trim().slice(0, NAME_MAX),
      length: length.text,
      width: width.text,
      qty: qty.text,
      thickness: thickness.text,
      grain,
      material: get('material').trim().slice(0, NAME_MAX),
      values: { length: length.value, width: width.value, thickness: thickness.value },
    },
  };
}

// Unreadable lines kept with their reasons; the rest are only counted, so a
// huge paste of junk doesn't sit in memory.
export const MAX_PROBLEMS = 1000;

/**
 * Reads a cut list. `room` is how many more parts the project can take.
 * Returns {rows, parts, problems, unreadable, leftOut, hasHeadings, delimiter},
 * where each row is {line, text, part} or {line, text, reason} in the order of
 * the input. `problems` holds the first MAX_PROBLEMS unreadable lines and
 * `unreadable` counts all of them; leftOut counts readable parts past `room`.
 * Without headings, a part whose line has values after the quantity lists
 * them in `part.extra`, since they're left out.
 */
export function parseCutList(input, { units = 'in', room = MAX_PARTS } = {}) {
  const text = String(input ?? '').replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(text);
  const records = readRecords(text, delimiter)
    .map((r) => ({ ...r, fields: tidy(r.fields) }))
    .filter((r) => r.fields.length);

  // Headings may follow a title line or two (SketchUp CutList writes "Project: ...").
  let headings = null;
  let first = 0;
  for (let k = 0; k < Math.min(3, records.length); k++) {
    const map = headingMap(records[k].fields);
    if (map) { headings = map; first = k + 1; break; }
    if (records[k].fields.length > 1) break;
  }

  const rows = [];
  let taken = 0;
  let leftOut = 0;
  let unreadable = 0;
  for (const record of records.slice(first)) {
    // Exports repeat the headings above each section; they aren't parts.
    if (headings && headingMap(record.fields)) continue;
    const columnsFor = (f) => (headings ? { ...headings, header: true } : defaultColumns(f, units));
    let { fields } = record;
    let cols = columnsFor(fields);
    const delimited = record.text.includes(delimiter) || fields.length > 1;
    let read = readPart(fields, cols, units, delimited);
    // "Rail, 2' 6", 3 reads as quoted CSV. When that doesn't make a part,
    // try the line again with its quotes as inch marks.
    if (read.reason && record.quoted && !/[\r\n]/.test(record.text)) {
      const literal = tidy(record.text.split(delimiter));
      const literalCols = columnsFor(literal);
      const retry = readPart(literal, literalCols, units, true);
      if (!retry.reason) { fields = literal; cols = literalCols; read = retry; }
    }
    const base = { line: record.line, text: record.text.trim().slice(0, TEXT_MAX) };
    if (read.reason) {
      if (unreadable++ < MAX_PROBLEMS) rows.push({ ...base, reason: read.reason });
      continue;
    }
    if (taken >= room) { leftOut++; continue; }
    taken++;
    // A 285,5 mm width split at its comma shows up here as one value too many.
    if (!headings) {
      const used = Math.max(...Object.values(cols).map((c) => c.index)) + 1;
      const extra = fields.slice(used).filter(Boolean).map((f) => clip(f));
      if (extra.length) read.part.extra = extra;
    }
    rows.push({ ...base, part: read.part });
  }

  return {
    rows,
    parts: rows.filter((r) => r.part).map((r) => r.part),
    problems: rows.filter((r) => r.reason),
    unreadable,
    leftOut,
    hasHeadings: !!headings,
    delimiter,
  };
}
