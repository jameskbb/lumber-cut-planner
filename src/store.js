// Project data: defaults, validation of untrusted input (files, share links),
// share-link encoding, and conversion from what people type to planner input.
//
// Sizes are stored exactly as typed ("23 5/8") and parsed when planning.

import { parseLength, formatLength, convertLength } from './units.js';

export const STORAGE_KEY = 'lumber-cut-planner/project';
export const MAX_QTY = 999;
const LIMITS = { rows: 200, name: 80, value: 24, title: 120 };

export function newId() {
  return Math.random().toString(36).slice(2, 10);
}

export function letterFor(index) {
  let s = '';
  let n = index + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function blankStock() {
  return { id: newId(), name: '', length: '', width: '', thickness: '', qty: '1', price: '' };
}

export function blankPart() {
  return {
    id: newId(), name: '', length: '', width: '', thickness: '', qty: '1',
    grain: false, from: '', lengthAllowance: '', widthAllowance: '', edgeBand: 'none',
  };
}

export function blankProject(units = 'in') {
  const metric = units === 'mm';
  return {
    v: 1,
    name: 'Untitled project',
    units,
    kerf: metric ? '3' : '1/8',
    stock: [{
      id: newId(), name: 'Plywood', length: metric ? '2440' : '96', width: metric ? '1220' : '48',
      thickness: '', qty: '1', price: '',
    }],
    parts: [blankPart()],
  };
}

export function exampleProject() {
  const ply = newId();
  const back = newId();
  const part = (name, length, width, qty, grain, from = '') => ({ id: newId(), name, length, width, qty: String(qty), grain, from });
  return {
    v: 1,
    name: 'Small bookcase',
    units: 'in',
    kerf: '1/8',
    stock: [
      { id: ply, name: '3/4 birch plywood', length: '96', width: '48', qty: '1' },
      { id: back, name: '1/4 plywood', length: '48', width: '24', qty: '1' },
    ],
    parts: [
      part('Side', '36', '11 1/4', 2, true, ply),
      part('Shelf', '22 1/2', '11 1/4', 3, true, ply),
      part('Top', '24', '12', 1, true, ply),
      part('Door', '35 7/8', '11 7/16', 2, true, ply),
      part('Toe kick', '22 1/2', '3', 1, false, ply),
      part('Back', '36', '23 1/4', 1, true, back),
    ],
  };
}

const text = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, max) : '');
const EDGE_BANDS = new Set(['none', 'length', 'width', 'all']);

/** Validates anything read from a file or link. Throws with a readable message. */
export function sanitizeProject(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.stock) || !Array.isArray(raw.parts)) {
    throw new Error("This file isn't a Lumber Cut Planner project.");
  }
  const seen = new Set();
  const id = (v) => {
    let s = text(v, 12);
    if (!/^[a-z0-9_-]+$/i.test(s) || seen.has(s)) s = newId();
    seen.add(s);
    return s;
  };
  const stock = raw.stock.slice(0, LIMITS.rows).filter((r) => r && typeof r === 'object').map((r) => ({
    id: id(r.id),
    name: text(r.name, LIMITS.name),
    length: text(r.length, LIMITS.value),
    width: text(r.width, LIMITS.value),
    thickness: text(r.thickness, LIMITS.value),
    qty: text(r.qty ?? '1', LIMITS.value),
    price: text(r.price, LIMITS.value),
  }));
  const stockIds = new Set(stock.map((s) => s.id));
  const parts = raw.parts.slice(0, LIMITS.rows).filter((r) => r && typeof r === 'object').map((r) => ({
    id: id(r.id),
    name: text(r.name, LIMITS.name),
    length: text(r.length, LIMITS.value),
    width: text(r.width, LIMITS.value),
    thickness: text(r.thickness, LIMITS.value),
    qty: text(r.qty ?? '1', LIMITS.value),
    grain: r.grain === true,
    from: stockIds.has(r.from) ? r.from : '',
    lengthAllowance: text(r.lengthAllowance, LIMITS.value),
    widthAllowance: text(r.widthAllowance, LIMITS.value),
    edgeBand: EDGE_BANDS.has(r.edgeBand) ? r.edgeBand : 'none',
  }));
  return {
    v: 1,
    name: text(raw.name, LIMITS.title) || 'Untitled project',
    units: raw.units === 'mm' ? 'mm' : 'in',
    kerf: text(raw.kerf ?? '', LIMITS.value),
    stock,
    parts,
  };
}

function readRow(row, units, withQty = true, minQty = 1) {
  const values = {};
  const invalid = [];
  const missing = [];
  for (const field of ['length', 'width']) {
    const t = String(row[field] ?? '').trim();
    if (!t) { missing.push(field); continue; }
    const v = parseLength(t, units);
    if (v === null || !(v > 0)) invalid.push(field); else values[field] = v;
  }
  if (withQty) {
    const t = String(row.qty ?? '').trim();
    if (!t) missing.push('qty');
    else if (!/^\d+$/.test(t) || +t < minQty || +t > MAX_QTY) invalid.push('qty');
    else values.qty = +t;
  }
  return { values, invalid, missing };
}

function readOptionalLengths(row, units, fields) {
  const values = {};
  const invalid = [];
  for (const [field, allowZero] of fields) {
    const t = String(row[field] ?? '').trim();
    if (!t) continue;
    const v = parseLength(t, units);
    if (v === null || (allowZero ? v < 0 : !(v > 0))) invalid.push(field);
    else values[field] = v;
  }
  return { values, invalid };
}

function readOptionalPrice(row) {
  const t = String(row.price ?? '').trim();
  if (!t) return { values: {}, invalid: [] };
  const price = Number(t);
  return Number.isFinite(price) && price >= 0
    ? { values: { price }, invalid: [] }
    : { values: {}, invalid: ['price'] };
}

const isBlank = (row) =>
  !['name', 'length', 'width', 'thickness', 'price', 'lengthAllowance', 'widthAllowance'].some((field) => String(row[field] ?? '').trim()) &&
  (!row.edgeBand || row.edgeBand === 'none');

/**
 * Converts a project into planner input. Rows with problems are left out and
 * reported in `issues` ({kind, id, index, label, type: 'invalid'|'incomplete', fields}).
 */
export function toPlanInput(project) {
  const { units } = project;
  const issues = [];
  const stock = [];
  const parts = [];

  project.stock.forEach((row, index) => {
    if (isBlank(row)) return;
    const label = row.name.trim() || `Stock ${index + 1}`;
    const { values, invalid, missing } = readRow(row, units, true, 0);
    const optional = readOptionalLengths(row, units, [['thickness', false]]);
    const price = readOptionalPrice(row);
    Object.assign(values, optional.values);
    Object.assign(values, price.values);
    invalid.push(...optional.invalid, ...price.invalid);
    if (invalid.length) issues.push({ kind: 'stock', id: row.id, index, label, type: 'invalid', fields: invalid });
    else if (missing.length) issues.push({ kind: 'stock', id: row.id, index, label, type: 'incomplete', fields: missing });
    else stock.push({ id: row.id, name: label, ...values });
  });

  project.parts.forEach((row, index) => {
    if (isBlank(row)) return;
    const label = row.name.trim() || `Part ${letterFor(index)}`;
    const { values, invalid, missing } = readRow(row, units);
    const optional = readOptionalLengths(row, units, [
      ['thickness', false], ['lengthAllowance', true], ['widthAllowance', true],
    ]);
    Object.assign(values, optional.values);
    invalid.push(...optional.invalid);
    if (invalid.length) issues.push({ kind: 'part', id: row.id, index, label, type: 'invalid', fields: invalid });
    else if (missing.length) issues.push({ kind: 'part', id: row.id, index, label, type: 'incomplete', fields: missing });
    else parts.push({
      id: row.id, name: label, ...values, grain: !!row.grain, from: row.from || null,
      edgeBand: EDGE_BANDS.has(row.edgeBand) ? row.edgeBand : 'none',
    });
  });

  let kerf = 0;
  const kerfText = String(project.kerf ?? '').trim();
  if (kerfText) {
    const v = parseLength(kerfText, units);
    if (v === null || v < 0) issues.push({ kind: 'settings', id: 'kerf', label: 'Blade kerf', type: 'invalid', fields: ['kerf'] });
    else kerf = v;
  }

  return { input: { stock, parts, kerf }, issues };
}

/** Rewrites every size in the project in the other unit system. */
export function convertProjectUnits(project, to) {
  if (project.units === to) return project;
  const from = project.units;
  const conv = (t) => {
    const v = parseLength(t, from);
    return v === null ? t : formatLength(convertLength(v, from, to), to);
  };
  return {
    ...project,
    units: to,
    kerf: conv(project.kerf),
    stock: project.stock.map((r) => ({
      ...r, length: conv(r.length), width: conv(r.width), thickness: conv(r.thickness),
    })),
    parts: project.parts.map((r) => ({
      ...r,
      length: conv(r.length),
      width: conv(r.width),
      thickness: conv(r.thickness),
      lengthAllowance: conv(r.lengthAllowance),
      widthAllowance: conv(r.widthAllowance),
    })),
  };
}

// Share links: the project is compressed (when the browser supports it) and
// base64url-encoded into the URL hash, so nothing is sent to a server.

function toB64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

export async function encodeShare(project) {
  const json = new TextEncoder().encode(JSON.stringify(sanitizeProject(project)));
  if (typeof CompressionStream === 'function') {
    return '1' + toB64url(await pipe(json, new CompressionStream('deflate-raw')));
  }
  return '0' + toB64url(json);
}

export async function decodeShare(code) {
  const kind = code[0];
  let bytes = fromB64url(code.slice(1));
  if (kind === '1') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
  else if (kind !== '0') throw new Error('This share link is incomplete or damaged.');
  return sanitizeProject(JSON.parse(new TextDecoder().decode(bytes)));
}
