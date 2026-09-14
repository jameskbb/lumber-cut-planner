import { planCuts, recommendStock, MAX_INSTANCES } from './planner.js';
import { lengthParts, formatLength } from './units.js';
import * as store from './store.js';
import { renderSheet, nounFor, svgEl } from './sheet-view.js';
import { buildShopRows, shopRowsToCsv } from './shop-output.js';
import { createProjects, webStorageAdapter } from './projects.js';
import { createProjectList } from './project-list.js';
import { initPasteCutList } from './paste-cut-list.js';
import { createShopMode } from './shop-mode.js';

// Milk-paint colours, one per part row.
const PALETTE = ['#E4A596', '#93AACB', '#AFC49A', '#EAAA6E', '#A7B2BA', '#92C4B8', '#BDAAD0', '#DDA3B6'];
const PREFS_KEY = 'lumber-cut-planner/prefs';
const ICONS = {
  remove: 'M5.5 5.5l9 9M14.5 5.5l-9 9',
  grain: 'M2.5 6.5c3-1.6 6 1.6 9 0s4.5-.8 6-.3M2.5 10.5c3-1.6 6 1.6 9 0s4.5-.8 6-.3M2.5 14.5c3-1.6 6 1.6 9 0s4.5-.8 6-.3',
};

const $ = (sel) => document.querySelector(sel);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'value' || k === 'checked') el[k] = v;
      else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

const iconEl = (d) => svgEl('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' }, svgEl('path', { d }));

function readJSON(key) {
  try { const t = localStorage.getItem(key); return t ? JSON.parse(t) : null; } catch { return null; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked or full: the app still works */ }
}

const prefs = { showCuts: true, purchaseObjective: 'cost', ...readJSON(PREFS_KEY) };
if (!['cost', 'waste', 'sheetCount'].includes(prefs.purchaseObjective)) prefs.purchaseObjective = 'cost';
const state = {
  projectId: null, // null while the project isn't saved yet (the first-run example)
  project: null,
  firstRun: false,
  input: null,
  issues: [],
  plan: null,
  recommendation: null,
  progress: { sig: '', done: new Set() },
  hover: null,
  pinned: null,
  partIndex: new Map(),
};

const units = () => state.project.units;
const unitMark = () => (units() === 'mm' ? ' mm' : '"');
const colorOf = (id) => PALETTE[(state.partIndex.get(id) ?? 0) % PALETTE.length];
const letterOf = (id) => store.letterFor(state.partIndex.get(id) ?? 0);

// ---------------------------------------------------------------- persistence

// Saved projects live in src/projects.js; this section connects them to the page.
let browserStorage = null;
try { browserStorage = window.localStorage; } catch { /* blocked: projects stay open but unsaved */ }
const projects = createProjects(webStorageAdapter(browserStorage));
let projectList;

const emptyProgress = () => ({ sig: '', done: new Set() });
const toProgress = (p) => ({ sig: p.sig, done: new Set(p.done) });

let saveTimer;
let dirty = false;
let saveFailed = false;
function save() {
  dirty = true;
  dismissProjectUndo();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 250);
}
// Writes the open project now. An unsaved project gets its place in the list here.
function persist() {
  clearTimeout(saveTimer);
  dirty = false;
  try {
    if (state.projectId) projects.save(state.projectId, state.project);
    else { state.projectId = projects.create(state.project).id; saveProgress(); }
    saveFailed = false;
  } catch (err) {
    dirty = true;
    if (!saveFailed) toast(err.message); // once, not on every keystroke
    saveFailed = true;
  }
}
function flushSave() {
  if (dirty) persist();
}
// Ticked-off cuts are kept per project.
function saveProgress() {
  if (state.projectId) projects.writeProgress(state.projectId, { sig: state.progress.sig, done: [...state.progress.done] });
}

function showProject(id, project, progress, firstRun = false) {
  clearTimeout(planTimer);
  Object.assign(state, { projectId: id, project, progress, firstRun, hover: null, pinned: null });
  if (id) projects.setCurrent(id);
  renderEditor();
  runPlan();
  renderPlan();
}
const openState = () => ({ id: state.projectId, project: state.project, progress: state.progress, firstRun: state.firstRun });
const goBack = (prev) => showProject(prev.id, prev.project, prev.progress, prev.firstRun);

// The Undo that removes a just-created project goes away once that project is edited,
// so it can never throw away work.
let projectUndo = null;
function undoableProject(message, id, prev) {
  toast(message, {
    label: 'Undo',
    run: () => {
      try { projects.remove(id); } catch { /* it stays in the list; nothing is lost */ }
      goBack(prev);
      toast('Undone.');
    },
  });
  projectUndo = { id, line: $('#toast').firstChild };
}
function dismissProjectUndo() {
  if (projectUndo && projectUndo.id === state.projectId && $('#toast').firstChild === projectUndo.line) $('#toast').hidden = true;
  projectUndo = null;
}

// New, example, file and shared link each start a saved project. The open one stays in the list.
function startProject(project, message) {
  flushSave();
  const prev = openState();
  let entry;
  try { entry = projects.create(project); } catch (err) { toast(err.message); return false; }
  showProject(entry.id, project, emptyProgress());
  undoableProject(message, entry.id, prev);
  return true;
}

function openProject(id) {
  if (id === state.projectId) return;
  flushSave();
  const project = projects.read(id);
  if (!project) {
    const name = projects.list().find((e) => e.id === id)?.name || 'That project';
    projects.discard(id);
    toast(`${name} couldn’t be opened because its saved copy is damaged, so it was removed from your projects.`);
    return;
  }
  showProject(id, project, toProgress(projects.readProgress(id)));
  toast(`Opened ${project.name}.`);
}

function duplicateProject() {
  flushSave();
  const prev = openState();
  let copy;
  try { copy = projects.duplicate(state.project); } catch (err) { toast(err.message); return; }
  showProject(copy.entry.id, copy.project, emptyProgress());
  undoableProject(`Duplicated ${prev.project.name}.`, copy.entry.id, prev);
}

function renameProject() {
  const input = $('#project-name');
  input.focus();
  input.select();
}

// Opens the most recently edited project, or a fresh one when none are left.
// Returns the fresh one's id and contents, so Undo can tidy it away.
function openLatest() {
  for (const e of projects.list()) {
    const p = projects.read(e.id);
    if (p) { showProject(e.id, p, toProgress(projects.readProgress(e.id))); return null; }
    projects.discard(e.id);
  }
  const blank = store.blankProject(units());
  let id = null;
  try { id = projects.create(blank).id; } catch { /* storage full: it stays open unsaved */ }
  showProject(id, blank, emptyProgress());
  return id && { id, text: JSON.stringify(store.sanitizeProject(blank)) };
}

function deleteProject() {
  flushSave();
  const gone = openState();
  let saved = null;
  if (gone.id) {
    try { saved = projects.remove(gone.id); } catch { toast(`Couldn’t delete ${gone.project.name}. This browser’s storage is turned off.`); return; }
  }
  const fresh = openLatest();
  toast(`Deleted ${gone.project.name}.`, {
    label: 'Undo',
    run: () => {
      flushSave();
      try { if (saved) projects.restore(saved); } catch (err) { toast(err.message); return; }
      if (fresh && JSON.stringify(projects.read(fresh.id)) === fresh.text) projects.remove(fresh.id);
      goBack(gone);
      toast('Undone.');
    },
  });
}

// "Your projects" shows the open project even before it's saved (the first-run example).
function projectEntries() {
  flushSave();
  const list = projects.list();
  return state.projectId ? list : [{ id: null, name: state.project.name, updatedAt: null }, ...list];
}

// ---------------------------------------------------------------- feedback

let toastTimer;
function toast(message, action) {
  const el = $('#toast');
  el.replaceChildren(h('span', null, message));
  if (action) el.append(h('button', { type: 'button', onclick: () => { el.hidden = true; action.run(); } }, action.label));
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 7000 : 3500);
}

// Replaces or rewrites the whole project, with an Undo in the toast.
function withUndo(message, mutate) {
  const before = structuredClone(state.project);
  mutate();
  refreshAll();
  toast(message, { label: 'Undo', run: () => { state.project = before; refreshAll(); toast('Undone.'); } });
}

function refreshAll() {
  renderEditor();
  save();
  runPlan();
  renderPlan();
}

let planTimer;
function changed() {
  state.firstRun = false;
  save();
  clearTimeout(planTimer);
  planTimer = setTimeout(() => { runPlan(); renderPlan(); }, 140);
}

// ---------------------------------------------------------------- sizes as HTML

function lenEl(value) {
  const { whole, frac } = lengthParts(value, units());
  const visual = h('span', { 'aria-hidden': 'true' });
  if (whole) visual.append(whole);
  if (frac) {
    const [n, d] = frac.split('/');
    visual.append(h('span', { class: 'frac' }, h('sup', null, n), '/', h('sub', null, d)));
  }
  return h('span', { class: 'len' }, h('span', { class: 'sr-only' }, formatLength(value, units())), visual);
}
const dimsEl = (l, w) => h('span', { class: 'dims' }, lenEl(l), ' × ', lenEl(w));

// ---------------------------------------------------------------- editor

function renderEditor() {
  const p = state.project;
  $('#project-name').value = p.name;
  document.title = `${p.name} | Lumber Cut Planner`;
  renderRows('stock');
  renderRows('parts');
  for (const r of document.querySelectorAll('input[name="units"]')) r.checked = r.value === p.units;
  const kerf = $('#kerf');
  kerf.value = p.kerf;
  kerf.inputMode = p.units === 'mm' ? 'decimal' : 'text';
  $('#kerf-unit').textContent = p.units === 'mm' ? 'mm' : 'in';
  $('#kerf-hint').textContent = p.units === 'mm'
    ? 'The width of material your blade removes. Most table saw blades take about 3 mm.'
    : 'The width of material your blade removes. Most table saw blades take 1/8".';
}

function renderRows(kind) {
  const list = $(kind === 'stock' ? '#stock-list' : '#parts-list');
  list.replaceChildren(...state.project[kind].map((row, i) => rowEl(kind, row, i)));
}

function rowInput(kind, row, field, label) {
  const sizeField = ['length', 'width', 'thickness', 'lengthAllowance', 'widthAllowance'].includes(field);
  return h('input', {
    class: `in in-${field}`,
    type: 'text',
    value: row[field] ?? '',
    'aria-label': label,
    autocomplete: 'off',
    spellcheck: 'false',
    enterkeyhint: 'next',
    inputmode: field === 'qty' ? 'numeric' : field === 'price' || (sizeField && units() === 'mm') ? 'decimal' : null,
    maxlength: field === 'name' ? '80' : '24',
    placeholder: field === 'name' ? (kind === 'stock' ? 'Material, e.g. 3/4 plywood' : 'Part name') : null,
    dataset: { kind, id: row.id, field },
    oninput: (e) => {
      row[field] = e.target.value;
      e.target.removeAttribute('aria-invalid');
      changed();
      if (kind === 'stock' && field === 'name') refreshFromSelects();
    },
    onkeydown: (e) => onRowKey(e, kind, row, field),
  });
}

function rowEl(kind, row, i) {
  const isPart = kind === 'parts';
  const who = isPart ? `part ${store.letterFor(i)}` : `stock ${i + 1}`;
  const li = h('li', { class: 'row', dataset: { id: row.id } },
    isPart
      ? h('span', { class: 'badge', style: { '--c': PALETTE[i % PALETTE.length] }, 'aria-hidden': 'true' }, store.letterFor(i))
      : h('span', { class: 'badge badge-stock', 'aria-hidden': 'true' }),
    rowInput(kind, row, 'name', `Name, ${who}`),
    rowInput(kind, row, 'length', `Length, ${who}`),
    rowInput(kind, row, 'width', `Width, ${who}`),
    rowInput(kind, row, 'qty', `Quantity, ${who}`),
  );
  if (isPart) {
    li.append(h('button', {
      type: 'button', class: 'grain', 'aria-pressed': String(!!row.grain),
      'aria-label': `Keep grain along the length, ${who}`,
      title: 'Keep the grain along the length (the part won’t be turned)',
      onclick: (e) => { row.grain = !row.grain; e.currentTarget.setAttribute('aria-pressed', String(row.grain)); changed(); },
    }, iconEl(ICONS.grain)));
    if (state.project.stock.length > 1) {
      const sel = h('select', { class: 'in', 'aria-label': `Cut from, ${who}`, onchange: (e) => { row.from = e.target.value; changed(); } });
      fillFrom(sel, row);
      li.append(h('label', { class: 'from' }, h('span', { 'aria-hidden': 'true' }, 'Cut from'), sel));
    }
    li.addEventListener('pointerenter', () => setHover(row.id));
    li.addEventListener('pointerleave', () => setHover(null));
  }
  const extras = rowExtras(kind, row, who);
  if (extras) li.append(extras);
  // Last in tab order so Tab runs name, length, width, qty; CSS puts it top right.
  li.append(h('button', { type: 'button', class: 'icon-btn del', 'aria-label': `Remove ${who}`, title: 'Remove', onclick: () => removeRow(kind, row.id) }, iconEl(ICONS.remove)));
  return li;
}

// Optional fields sit behind one toggle per section rather than a link on
// every row (see DESIGN.md).
const EXTRA_FIELDS = {
  stock: ['thickness', 'price'],
  parts: ['thickness', 'lengthAllowance', 'widthAllowance', 'edgeBand'],
};
const extrasPref = (kind) => (kind === 'stock' ? 'stockExtras' : 'partExtras');
const extrasOpen = (kind) => !!prefs[extrasPref(kind)];

function setExtras(kind, open) {
  prefs[extrasPref(kind)] = open;
  writeJSON(PREFS_KEY, prefs);
  $(kind === 'stock' ? '#stock-extras' : '#part-extras').checked = open;
  $(kind === 'stock' ? '#stock-extras-hint' : '#part-extras-hint').hidden = !open;
  renderRows(kind);
}

const isSet = (row, field) => (field === 'edgeBand' ? !!row.edgeBand && row.edgeBand !== 'none' : !!String(row[field] ?? '').trim());

// A closed section never hides values that change the plan: they're spelled out on the row.
function extrasSummary(kind, row) {
  const t = (field) => String(row[field] ?? '').trim();
  const bits = [];
  if (isSet(row, 'thickness')) bits.push(`${t('thickness')} thick`);
  if (kind === 'stock') {
    if (isSet(row, 'price')) bits.push(`${t('price')} each`);
  } else {
    if (isSet(row, 'lengthAllowance')) bits.push(`${t('lengthAllowance')} extra length`);
    if (isSet(row, 'widthAllowance')) bits.push(`${t('widthAllowance')} extra width`);
    if (isSet(row, 'edgeBand')) bits.push(edgeBandText(row.edgeBand).toLowerCase());
  }
  const s = bits.join(', ');
  return s && s[0].toUpperCase() + s.slice(1);
}

function detailField(label, control) {
  return h('label', { class: 'detail-field' }, h('span', null, label), control);
}

function rowExtras(kind, row, who) {
  if (!extrasOpen(kind)) {
    const summary = extrasSummary(kind, row);
    if (!summary) return null;
    const first = EXTRA_FIELDS[kind].find((f) => isSet(row, f));
    return h('button', {
      type: 'button', class: 'linkish row-summary', 'aria-label': `${summary}. Edit, ${who}`,
      onclick: () => { setExtras(kind, true); focusField(kind, row.id, first); },
    }, summary);
  }
  const fields = [detailField('Thickness', rowInput(kind, row, 'thickness', `Thickness, ${who}`))];
  if (kind === 'parts') {
    fields.push(
      detailField('Extra length', rowInput(kind, row, 'lengthAllowance', `Extra length, ${who}`)),
      detailField('Extra width', rowInput(kind, row, 'widthAllowance', `Extra width, ${who}`)),
    );
    const edgeBand = h('select', {
      class: 'in', 'aria-label': `Edge banding, ${who}`, dataset: { kind, id: row.id, field: 'edgeBand' },
      onchange: (e) => { row.edgeBand = e.target.value; changed(); },
    },
    h('option', { value: 'none' }, 'None'),
    h('option', { value: 'length' }, 'Both long edges'),
    h('option', { value: 'width' }, 'Both short edges'),
    h('option', { value: 'all' }, 'All four edges'));
    edgeBand.value = row.edgeBand || 'none';
    fields.push(detailField('Edge banding', edgeBand));
  } else {
    fields.push(detailField('Price each', rowInput(kind, row, 'price', `Price each, ${who}`)));
  }
  return h('div', { class: 'row-extras' }, fields);
}

function fillFrom(sel, row) {
  sel.replaceChildren(
    h('option', { value: '' }, 'Any stock'),
    ...state.project.stock.map((s, i) => h('option', { value: s.id }, s.name.trim() || `Stock ${i + 1}`)),
  );
  sel.value = state.project.stock.some((s) => s.id === row.from) ? row.from : '';
}

function refreshFromSelects() {
  for (const li of document.querySelectorAll('#parts-list .row')) {
    const sel = li.querySelector('.from select');
    const row = state.project.parts.find((p) => p.id === li.dataset.id);
    if (sel && row) fillFrom(sel, row);
  }
}

function focusField(kind, id, field) {
  const selector = `[data-kind="${kind}"][data-id="${id}"][data-field="${field}"]`;
  let el = document.querySelector(selector);
  if (!el && EXTRA_FIELDS[kind]?.includes(field) && !extrasOpen(kind)) {
    setExtras(kind, true);
    el = document.querySelector(selector);
  }
  if (el) {
    el.focus();
    el.select?.();
  }
}

function onRowKey(e, kind, row, field) {
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault();
  const rows = state.project[kind];
  const i = rows.indexOf(row);
  if (i === rows.length - 1) addRow(kind);
  else focusField(kind, rows[i + 1].id, field);
}

function addRow(kind) {
  const row = kind === 'stock' ? store.blankStock() : store.blankPart();
  state.project[kind].push(row);
  if (kind === 'stock') renderRows('parts');
  renderRows(kind);
  focusField(kind, row.id, 'name');
  changed();
}

function removeRow(kind, id) {
  const rows = state.project[kind];
  const i = rows.findIndex((r) => r.id === id);
  if (i < 0) return;
  const label = rows[i].name.trim() || (kind === 'stock' ? `stock ${i + 1}` : `part ${store.letterFor(i)}`);
  withUndo(`Removed ${label}.`, () => {
    rows.splice(i, 1);
    if (kind === 'stock') for (const p of state.project.parts) if (p.from === id) p.from = '';
    if (kind === 'parts' && !rows.length) rows.push(store.blankPart());
  });
  const next = state.project[kind][Math.min(i, state.project[kind].length - 1)];
  if (next) focusField(kind, next.id, 'name');
  else $(kind === 'stock' ? '#add-stock' : '#add-part').focus();
}

// Takes someone to the first row that still needs filling in, or a new one.
function goToEmpty(kind) {
  setTab('setup');
  const row = state.project[kind].find((r) => !r.name.trim() && !r.length.trim());
  if (row) focusField(kind, row.id, 'name'); else addRow(kind);
}

// ---------------------------------------------------------------- planning

function runPlan() {
  const { input, issues } = store.toPlanInput(state.project);
  state.input = input;
  state.issues = issues;
  state.plan = planCuts(input);
  // The optimizer is fast (tens of ms), so the fix is ready without a button press.
  const short = state.plan.unplaced.some((u) => u.reason === 'no-stock');
  state.recommendation = short ? recommendStock(input, state.plan, { objective: purchaseObjective() }) : null;

  // Ticked-off cuts only make sense for the plan they were ticked on.
  const sig = JSON.stringify([
    input.kerf,
    input.stock.map((s) => [s.id, s.length, s.width, s.thickness, s.qty]),
    input.parts.map((p) => [p.id, p.length, p.width, p.thickness, p.lengthAllowance, p.widthAllowance, p.edgeBand, p.qty, p.grain, p.from]),
  ]);
  if (sig !== state.progress.sig) {
    state.progress = { sig, done: new Set() };
    saveProgress();
  }
}

// The field being typed in isn't flagged until the person leaves it, so
// "23 5/" doesn't flash an error halfway through typing a fraction.
function visibleIssues() {
  const a = document.activeElement;
  const typing = a && a.dataset && a.dataset.field ? { id: a.dataset.id || 'kerf', field: a.dataset.field } : null;
  return state.issues.filter((i) => !(typing && i.id === typing.id && i.fields.includes(typing.field)));
}

const FIELD_NAMES = {
  length: 'length', width: 'width', thickness: 'thickness', lengthAllowance: 'extra length',
  widthAllowance: 'extra width', price: 'price', qty: 'quantity', kerf: 'blade kerf',
};
const joinWords = (words) => (words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0]);

function describeInvalid(issue) {
  if (issue.kind === 'settings') return units() === 'mm' ? 'use a size like 3 or 3.2' : 'use a size like 1/8 or 0.125';
  const sizes = issue.fields.filter((f) => f !== 'qty' && f !== 'price');
  const parts = [];
  if (sizes.length) parts.push(`${joinWords(sizes.map((f) => FIELD_NAMES[f]))} should look like ${units() === 'mm' ? '600 or 600.5' : '23 5/8, 23.625 or 2\' 6"'}`);
  if (issue.fields.includes('price')) parts.push('price must be zero or a positive decimal number');
  if (issue.fields.includes('qty')) parts.push(`quantity must be a whole number from ${issue.kind === 'stock' ? 0 : 1} to ${store.MAX_QTY}`);
  return parts.join('; ');
}

function focusIssue(issue) {
  setTab('setup');
  if (issue.kind === 'settings') { $('#kerf').focus(); return; }
  focusField(issue.kind === 'part' ? 'parts' : 'stock', issue.id, issue.fields[0]);
}

function issueNotices(issues) {
  const out = [];
  const invalid = issues.filter((i) => i.type === 'invalid');
  const incomplete = issues.filter((i) => i.type === 'incomplete');
  if (invalid.length) {
    out.push(h('div', { class: 'notice is-problem' },
      h('p', null, invalid.length === 1
        ? 'One entry can’t be read, so it’s left out of the plan.'
        : `${invalid.length} entries can’t be read, so they’re left out of the plan.`),
      h('ul', null, invalid.map((i) => h('li', null,
        h('button', { type: 'button', class: 'linkish', onclick: () => focusIssue(i) }, i.label), `: ${describeInvalid(i)}.`)))));
  }
  if (incomplete.length) {
    out.push(h('div', { class: 'notice' },
      h('ul', null, incomplete.map((i) => h('li', null,
        h('button', { type: 'button', class: 'linkish', onclick: () => focusIssue(i) }, i.label),
        ` needs a ${joinWords(i.fields.map((f) => FIELD_NAMES[f]))}.`)))));
  }
  return out;
}

const formatPrice = (value) => value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const hasPrices = () => state.input.stock.some((s) => s.price != null);

// "Lowest cost" means nothing until prices exist, so fall back to least left over.
function purchaseObjective() {
  return prefs.purchaseObjective === 'cost' && !hasPrices() ? 'waste' : prefs.purchaseObjective;
}

// "1 sheet of 3/4 birch plywood", never "1 3/4 birch plywood".
function purchaseWords(recommendation) {
  return joinWords(recommendation.purchases.map((purchase) => {
    const stock = state.input.stock.find((s) => s.id === purchase.stockId);
    const noun = stock ? nounFor(stock, units()).toLowerCase() : 'sheet';
    return `${purchase.qty} ${noun}${purchase.qty === 1 ? '' : 's'} of ${purchase.stockName}`;
  }));
}

function applyRecommendedPurchase() {
  const recommendation = state.recommendation;
  if (!recommendation) return;
  withUndo(`Added ${purchaseWords(recommendation)}.`, () => {
    for (const purchase of recommendation.purchases) {
      const row = state.project.stock.find((stock) => stock.id === purchase.stockId);
      if (row) row.qty = String((parseInt(row.qty, 10) || 0) + purchase.qty);
    }
  });
}

function unplacedNotices() {
  const { plan, recommendation, input } = state;
  const out = [];
  const short = plan.unplaced.filter((u) => u.reason === 'no-stock');
  const tooBig = plan.unplaced.filter((u) => u.reason === 'too-big');
  const wrongThickness = plan.unplaced.filter((u) => u.reason === 'wrong-thickness');

  if (short.length) {
    const names = short.map((u) => (u.count > 1 ? `${u.name} ×${u.count}` : u.name));
    const box = h('div', { class: 'notice is-problem' }, h('p', null, `There isn’t enough stock for ${joinWords(names)}.`));
    if (recommendation) {
      const what = purchaseWords(recommendation);
      const cost = recommendation.priceComplete && recommendation.totalCost !== null ? `, for ${formatPrice(recommendation.totalCost)}` : '';
      const leftover = Math.round(recommendation.waste * 100);
      box.append(h('p', null, `Buying ${what} fits everything${cost}.${leftover >= 1 ? ` About ${leftover}% of it will be left over.` : ''}`));

      const withPrices = hasPrices();
      const goal = h('select', {
        class: 'in purchase-objective', 'aria-label': 'Choose what to buy by',
        onchange: (e) => { prefs.purchaseObjective = e.target.value; writeJSON(PREFS_KEY, prefs); runPlan(); renderPlan(); },
      },
      h('option', { value: 'waste' }, 'Least left over'),
      h('option', { value: 'cost', disabled: !withPrices }, withPrices ? 'Lowest cost' : 'Lowest cost (add prices first)'),
      h('option', { value: 'sheetCount' }, 'Fewest to buy'));
      goal.value = purchaseObjective();
      box.append(h('div', { class: 'purchase-tools' },
        h('button', { type: 'button', class: 'btn btn-dark', onclick: applyRecommendedPurchase }, `Add ${what}`),
        h('label', null, h('span', null, 'Choose by'), goal)));
      if (withPrices && !recommendation.priceComplete && purchaseObjective() === 'cost') {
        box.append(h('p', { class: 'hint' }, 'Some stock has no price, so it’s compared by size instead.'));
      }
    } else {
      box.append(h('p', null, 'None of the listed stock sizes can hold these parts. Add a bigger size under Stock, with quantity 0 if you don’t have it yet.'));
    }
    out.push(box);
  }

  for (const u of tooBig) {
    const part = input.parts.find((p) => p.id === u.partId);
    const cutLength = u.cutLength ?? u.length;
    const cutWidth = u.cutWidth ?? u.width;
    const allowed = input.stock.filter((s) => (!part.from || s.id === part.from) &&
      (part.thickness == null || (s.thickness != null && Math.abs(part.thickness - s.thickness) < 1e-6)));
    const turnFits = part.grain && allowed.some((s) => cutWidth <= s.length && cutLength <= s.width);
    const box = h('div', { class: 'notice is-problem' },
      h('p', null, `${u.name} (`, dimsEl(cutLength, cutWidth), ` cut size) is bigger than any stock it can be cut from.`));
    if (turnFits) {
      const row = state.project.parts.find((p) => p.id === u.partId);
      box.append(
        h('p', null, 'It would fit if it could be turned so the grain runs across it.'),
        h('button', { type: 'button', class: 'btn', onclick: () => withUndo(`${u.name} can now be turned.`, () => { row.grain = false; }) }, 'Allow turning this part'));
    }
    out.push(box);
  }

  for (const u of wrongThickness) {
    const row = state.project.parts.find((p) => p.id === u.partId);
    const box = h('div', { class: 'notice is-problem' },
      h('p', null, `${u.name} needs `, lenEl(u.thickness), ` thick stock, but none of its allowed stock has that thickness.`));
    if (row) box.append(h('button', {
      type: 'button', class: 'btn', onclick: () => { setTab('setup'); focusField('parts', row.id, 'thickness'); },
    }, 'Review thickness'));
    out.push(box);
  }
  return out;
}

function summaryEl() {
  const { stats, sheets } = state.plan;
  if (!sheets.length) return h('p', { class: 'summary' }, 'None of the parts fit on the stock you have.');
  const counts = new Map();
  for (const s of sheets) {
    const noun = nounFor(s, units()).toLowerCase();
    counts.set(noun, (counts.get(noun) || 0) + 1);
  }
  const where = [...counts].map(([noun, c]) => `${c} ${noun}${c === 1 ? '' : 's'}`).join(' and ');
  const pct = Math.round(stats.yield * 100);
  let lead;
  if (stats.partsPlaced < stats.partsTotal) lead = `${stats.partsPlaced} of ${stats.partsTotal} parts fit on `;
  else if (stats.partsTotal === 1) lead = 'The part fits on ';
  else lead = `All ${stats.partsTotal} parts fit on `;
  return h('p', { class: 'summary' }, lead, h('strong', null, where), `, using ${pct}% of the material.`);
}

// Opens the "Paste a cut list" dialog; set in init() once it's ready.
let openPasteCutList = null;

function emptyEl(hasStock, hasParts) {
  let message, action;
  if (!hasStock && !hasParts) {
    message = 'Add the stock you have and the parts you need. The layout appears here as you type.';
    action = h('button', { type: 'button', class: 'btn btn-dark', onclick: () => goToEmpty('stock') }, 'Add stock');
  } else if (!hasParts) {
    message = 'Add the parts you need to cut. The layout appears here as you type.';
    action = h('button', { type: 'button', class: 'btn btn-dark', onclick: () => goToEmpty('parts') }, 'Add a part');
  } else {
    message = 'Add the sheets or boards you have to cut from.';
    action = h('button', { type: 'button', class: 'btn btn-dark', onclick: () => goToEmpty('stock') }, 'Add stock');
  }
  const paste = hasParts ? null
    : h('button', { type: 'button', class: 'btn', 'aria-haspopup': 'dialog', onclick: () => openPasteCutList?.() }, 'Paste a cut list');
  return h('div', { class: 'empty' }, h('p', null, message),
    h('div', { class: 'actions-row' }, action, paste, h('button', { type: 'button', class: 'btn', onclick: () => commands.example() }, 'Load example project')));
}

function sheetEl(sheet, i, width) {
  const key = String(i);
  const title = `${nounFor(sheet, units())} ${i + 1}`;
  const svg = renderSheet(sheet, {
    width,
    maxHeight: Math.max(320, window.innerHeight * 0.72),
    units: units(),
    colorOf,
    letterOf,
    done: state.progress.done,
    showCuts: prefs.showCuts,
    key,
    label: `${title}, ${sheet.stockName}: layout of ${sheet.placements.length} parts. The cut list below describes it.`,
  });
  svg.addEventListener('pointerover', (e) => { const g = e.target.closest('.sv-part'); setHover(g ? g.dataset.part : null); });
  svg.addEventListener('pointerleave', () => setHover(null));
  svg.addEventListener('click', (e) => {
    const g = e.target.closest('.sv-part');
    state.pinned = g && state.pinned !== g.dataset.part ? g.dataset.part : null;
    applyHighlight();
  });

  const steps = sheet.cuts.length
    ? h('ol', { class: 'steps' }, sheet.cuts.map((c) => stepEl(c, `${key}-${c.n}`)))
    : h('p', { class: 'hint' }, 'No cuts needed: the part uses the whole piece.');

  const groups = new Map();
  for (const p of sheet.placements) {
    const g = groups.get(p.partId) || { partId: p.partId, name: p.name, count: 0, placement: p };
    g.count += 1;
    groups.set(p.partId, g);
  }
  const partList = h('ul', { class: 'plist' }, [...groups.values()].map((g) => {
    const part = state.input.parts.find((p) => p.id === g.partId);
    const details = [];
    if ((part.lengthAllowance ?? 0) > 0 || (part.widthAllowance ?? 0) > 0) {
      details.push(h('span', null, 'Cut ', dimsEl(part.length + (part.lengthAllowance ?? 0), part.width + (part.widthAllowance ?? 0))));
    }
    if (part.thickness != null) details.push(h('span', null, lenEl(part.thickness), ' thick'));
    if (part.edgeBand && part.edgeBand !== 'none') details.push(h('span', null, edgeBandText(part.edgeBand)));
    const li = h('li', { dataset: { part: g.partId } },
      h('span', { class: 'badge', style: { '--c': colorOf(g.partId) }, 'aria-hidden': 'true' }, letterOf(g.partId)),
      h('span', null,
        h('span', { class: 'name' }, g.name), ' ', dimsEl(part.length, part.width),
        details.length ? h('span', { class: 'part-details' }, details) : null),
      h('span', { class: 'qty' }, `×${g.count}`));
    li.addEventListener('pointerenter', () => setHover(g.partId));
    li.addEventListener('pointerleave', () => setHover(null));
    return li;
  }));

  const minKeep = units() === 'mm' ? 75 : 3;
  const keep = sheet.offcuts.filter((o) => Math.min(o.l, o.w) >= minKeep).slice(0, 6);

  return h('article', { class: 'sheet', 'aria-labelledby': `sheet-h-${key}` },
    h('div', { class: 'sheet-head' },
      h('h3', { id: `sheet-h-${key}` }, title),
      h('span', { class: 'sheet-meta' }, `${sheet.stockName}, `, dimsEl(sheet.length, sheet.width),
        sheet.thickness != null ? h('span', null, ' × ', lenEl(sheet.thickness), ' thick') : null),
      h('span', { class: 'sheet-yield' }, `${Math.round(sheet.yield * 100)}% used`)),
    h('figure', null, svg),
    h('div', { class: 'sheet-body' },
      h('section', null, h('h4', null, 'Cut order'), steps),
      h('section', null,
        h('h4', null, 'Parts'), partList,
        keep.length ? h('div', { class: 'offcuts' }, h('h4', null, 'Offcuts worth keeping'),
          h('ul', null, keep.map((o) => h('li', null, dimsEl(o.l, o.w))))) : null)));
}

function edgeBandText(mode) {
  return ({ length: 'Band length edges', width: 'Band width edges', all: 'Band all edges' })[mode] || '';
}

function stepEl(c, cutKey) {
  const done = state.progress.done.has(cutKey);
  const rip = c.type === 'rip';
  const li = h('li', { class: done ? 'is-done' : null, dataset: { cut: cutKey } },
    h('label', null,
      h('input', { type: 'checkbox', checked: done, onchange: (e) => markCut(cutKey, e.target.checked) }),
      h('span', { class: 'step-n', 'aria-hidden': 'true' }, String(c.n)),
      h('span', null,
        h('span', { class: 'step-text' },
          h('span', { class: 'sr-only' }, `Cut ${c.n}: `),
          `${rip ? 'Rip' : 'Crosscut'} the `, dimsEl(c.piece.l, c.piece.w), ' piece at ', lenEl(c.offset)),
        h('span', { class: 'step-from' }, rip ? 'measured from its top edge' : 'measured from its left end'))));
  li.addEventListener('pointerenter', () => setCutHighlight(cutKey));
  li.addEventListener('pointerleave', () => setCutHighlight(null));
  li.addEventListener('focusin', () => setCutHighlight(cutKey));
  li.addEventListener('focusout', () => setCutHighlight(null));
  return li;
}

function markCut(cutKey, done) {
  if (done) state.progress.done.add(cutKey); else state.progress.done.delete(cutKey);
  saveProgress();
  for (const el of document.querySelectorAll(`[data-cut="${cutKey}"]`)) el.classList.toggle('is-done', done);
  shopMode.syncEntry();
}

// Shop mode shares the checklist's progress, so it ticks cuts through markCut.
const shopMode = createShopMode({
  h, lenEl, dimsEl, units, colorOf, letterOf, markCut, printLabels, toast,
  getPlan: () => state.plan,
  getDone: () => state.progress.done,
  // markCut doesn't touch the checkboxes, so redraw the checklist on the way out.
  onClose: () => renderPlan(),
});

let lastWidth = 0;
function planWidth() {
  const w = $('#plan-body').clientWidth;
  return w > 0 ? w : Math.min(window.innerWidth - 32, 1200);
}

function renderPlan() {
  const { plan, input } = state;
  state.partIndex = new Map(state.project.parts.map((p, i) => [p.id, i]));
  const issues = visibleIssues();
  const kids = [
    h('div', { class: 'print-head' },
      h('h1', null, state.project.name),
      h('p', null, `Sizes in ${units() === 'mm' ? 'millimetres' : 'inches'}. Blade kerf ${formatLength(input.kerf, units())}${unitMark()}.`)),
  ];

  if (state.firstRun) {
    kids.push(h('div', { class: 'notice' },
      h('p', null, 'This is an example project, so you can see how a plan looks. Change any size and the plan updates.'),
      h('button', { type: 'button', class: 'btn btn-dark', onclick: () => commands.new() }, 'Start your own project')));
  }

  const hasStock = input.stock.length > 0;
  const hasParts = input.parts.length > 0;
  if (plan.error === 'too-many-parts') {
    kids.push(h('div', { class: 'notice is-problem' },
      h('p', null, `That’s more than ${MAX_INSTANCES.toLocaleString()} parts, which is too many to plan at once. Split the project into smaller batches.`)));
  } else if (hasStock && hasParts) {
    kids.push(summaryEl());
  }
  kids.push(...issueNotices(issues));

  if (!hasStock || !hasParts) {
    kids.push(emptyEl(hasStock, hasParts));
  } else if (!plan.error) {
    kids.push(...unplacedNotices());
    const width = planWidth();
    lastWidth = width;
    plan.sheets.forEach((s, i) => kids.push(sheetEl(s, i, width)));
  }

  $('#plan-body').replaceChildren(...kids);
  applyFieldErrors(issues);
  applyHighlight();
  updateTabCount(issues);
  shopMode.syncEntry();
}

function applyFieldErrors(issues) {
  for (const el of document.querySelectorAll('[aria-invalid="true"]')) el.removeAttribute('aria-invalid');
  for (const i of issues) {
    if (i.type !== 'invalid') continue;
    for (const f of i.fields) {
      const el = f === 'kerf' ? $('#kerf')
        : document.querySelector(`[data-kind="${i.kind === 'part' ? 'parts' : 'stock'}"][data-id="${i.id}"][data-field="${f}"]`);
      if (el) el.setAttribute('aria-invalid', 'true');
    }
  }
}

function updateTabCount(issues) {
  const el = $('#tab-count');
  const problems = issues.filter((i) => i.type === 'invalid').length + state.plan.unplaced.length;
  el.classList.toggle('is-problem', problems > 0);
  el.textContent = problems ? '!' : state.plan.sheets.length ? String(state.plan.sheets.length) : '';
  el.title = problems ? 'Needs attention' : '';
}

// ---------------------------------------------------------------- highlighting

function setHover(id) {
  state.hover = id;
  applyHighlight();
}

function applyHighlight() {
  const id = state.hover ?? state.pinned;
  $('#plan-body').classList.toggle('has-hl', !!id);
  for (const el of document.querySelectorAll('.is-hl[data-part], .row.is-hl')) el.classList.remove('is-hl');
  if (id) for (const el of document.querySelectorAll(`[data-part="${id}"], .row[data-id="${id}"]`)) el.classList.add('is-hl');
}

function setCutHighlight(cutKey) {
  $('#plan-body').classList.toggle('has-cut-hl', !!cutKey);
  for (const el of document.querySelectorAll('[data-cut].is-hl')) el.classList.remove('is-hl');
  if (cutKey) for (const el of document.querySelectorAll(`[data-cut="${cutKey}"]`)) el.classList.add('is-hl');
}

// ---------------------------------------------------------------- chrome

function setTab(tab) {
  document.body.dataset.tab = tab;
  for (const b of document.querySelectorAll('.tabbar button')) b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

function shopRows() {
  // A pending input debounce should never make a printed/exported plan stale.
  clearTimeout(planTimer);
  runPlan();
  renderPlan();
  return buildShopRows(state.project.name, units(), state.input.parts, state.plan, store.letterFor);
}

function printPlan() {
  delete document.body.dataset.printMode;
  window.print();
}

function labelEl(row) {
  const location = row.status === 'Placed'
    ? `Sheet ${row.sheet}, ${row.stock}`
    : row.status;
  const hasAllowance = row.cutLength !== row.length || row.cutWidth !== row.width;
  const notes = [];
  if (row.thickness !== '') notes.push(h('span', null, lenEl(row.thickness), ' thick'));
  if (row.edgeBand !== 'none') notes.push(h('span', null, edgeBandText(row.edgeBand)));
  return h('article', { class: `part-label${row.status === 'Placed' ? '' : ' is-unplaced'}` },
    h('p', { class: 'label-project' }, row.project),
    h('div', { class: 'label-part' },
      h('span', { class: 'label-letter', style: { '--c': colorOf(row.partId) } }, row.letter),
      h('h2', null, row.name)),
    h('div', { class: 'label-dims' },
      h('p', null, hasAllowance ? 'Finished ' : '', dimsEl(row.length, row.width), h('span', { class: 'label-unit' }, unitMark())),
      hasAllowance ? h('p', { class: 'label-cut-size' }, 'Cut ', dimsEl(row.cutLength, row.cutWidth), h('span', { class: 'label-unit' }, unitMark())) : null),
    h('div', { class: 'label-meta' },
      h('p', null, `Part ${row.instance} of ${row.quantity}`),
      h('p', null, row.grain === 'Along length' ? 'Grain along the length' : 'Can be turned')),
    notes.length ? h('p', { class: 'label-notes' }, notes) : null,
    h('p', { class: 'label-location' }, location));
}

function printLabels() {
  const rows = shopRows();
  if (!rows.length) { toast('Add at least one complete part before printing labels.'); return; }
  $('#part-labels').replaceChildren(
    h('header', { class: 'labels-head' }, h('h1', null, state.project.name), h('p', null, `${rows.length} part label${rows.length === 1 ? '' : 's'}`)),
    h('div', { class: 'label-grid' }, rows.map(labelEl)));
  document.body.dataset.printMode = 'labels';
  // Let the browser lay out the newly-created label grid before opening preview.
  requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
}

function exportCsv() {
  const rows = shopRows();
  if (!rows.length) { toast('Add at least one complete part before exporting.'); return; }
  const blob = new Blob(['\uFEFF', shopRowsToCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `${slug(state.project.name) || 'cut-plan'}-parts.csv` });
  document.body.append(a);
  a.click();
  const url = a.href;
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${rows.length} part${rows.length === 1 ? '' : 's'} to CSV.`);
}

async function shareLink() {
  let url;
  try {
    url = `${location.origin}${location.pathname}#p=${await store.encodeShare(state.project)}`;
  } catch {
    toast('Couldn’t create a link for this project.');
    return;
  }
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title: state.project.name, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied. Anyone with the link can open a copy of this project.');
  } catch {
    window.prompt('Copy this link to share the project:', url);
  }
}

function saveFile() {
  const blob = new Blob([JSON.stringify(state.project, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `${slug(state.project.name) || 'cut-plan'}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Project file saved.');
}

const commands = {
  share: shareLink,
  print: printPlan,
  labels: printLabels,
  csv: exportCsv,
  projects: () => projectList.open(),
  new: () => {
    if (!startProject(store.blankProject(units()), 'Started a new project.')) return;
    setTab('setup');
    focusField('parts', state.project.parts[0].id, 'name');
  },
  open: () => $('#file-input').click(),
  save: saveFile,
  example: () => startProject(store.exampleProject(), 'Loaded the example project.'),
};

function bindChrome() {
  $('#project-name').addEventListener('input', (e) => {
    state.project.name = e.target.value;
    document.title = `${e.target.value || 'Untitled project'} | Lumber Cut Planner`;
    save();
  });
  let nameBefore = '';
  $('#project-name').addEventListener('focus', () => { nameBefore = state.project.name; });
  $('#project-name').addEventListener('change', (e) => {
    if (!e.target.value.trim()) { state.project.name = 'Untitled project'; e.target.value = state.project.name; save(); }
    flushSave();
    if (state.project.name !== nameBefore) toast(`Renamed to ${state.project.name}.`);
    nameBefore = state.project.name;
  });

  for (const kind of ['stock', 'parts']) {
    const box = $(kind === 'stock' ? '#stock-extras' : '#part-extras');
    box.checked = extrasOpen(kind);
    $(kind === 'stock' ? '#stock-extras-hint' : '#part-extras-hint').hidden = !extrasOpen(kind);
    box.addEventListener('change', () => setExtras(kind, box.checked));
  }

  $('#add-stock').addEventListener('click', () => addRow('stock'));
  $('#add-part').addEventListener('click', () => addRow('parts'));
  openPasteCutList = initPasteCutList({ h, lenEl, withUndo, palette: PALETTE, state, button: $('#paste-parts') }).open;

  const kerf = $('#kerf');
  kerf.dataset.field = 'kerf';
  kerf.addEventListener('input', () => { state.project.kerf = kerf.value; kerf.removeAttribute('aria-invalid'); changed(); });

  for (const r of document.querySelectorAll('input[name="units"]')) {
    r.addEventListener('change', () => {
      if (!r.checked || r.value === units()) return;
      const to = r.value;
      withUndo(to === 'mm' ? 'Switched to millimetres.' : 'Switched to inches.', () => {
        state.project = store.convertProjectUnits(state.project, to);
      });
    });
  }

  // Re-check a field once the person leaves it.
  $('#setup').addEventListener('focusout', () => setTimeout(() => renderPlan(), 0));

  const showCuts = $('#show-cuts');
  showCuts.checked = prefs.showCuts;
  showCuts.addEventListener('change', () => { prefs.showCuts = showCuts.checked; writeJSON(PREFS_KEY, prefs); renderPlan(); });

  $('#share-btn').addEventListener('click', shareLink);
  $('#print-btn').addEventListener('click', printPlan);

  const menuBtn = $('#menu-btn');
  const menu = $('#menu');
  const items = () => [...menu.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
  const setMenu = (open) => {
    menu.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
    if (open) items()[0]?.focus();
  };
  menuBtn.addEventListener('click', () => setMenu(menu.hidden));
  document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.menu-wrap')) setMenu(false); });
  menu.addEventListener('keydown', (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'Escape') { setMenu(false); menuBtn.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
  });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cmd]');
    if (!b) return;
    setMenu(false);
    commands[b.dataset.cmd]();
  });

  $('#file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const p = store.sanitizeProject(JSON.parse(await file.text()));
      startProject(p, `Opened ${p.name}.`);
    } catch (err) {
      toast(err instanceof SyntaxError ? 'That file isn’t a project file. Choose a .json file saved from Lumber Cut Planner.' : err.message);
    }
  });

  for (const b of document.querySelectorAll('.tabbar button')) b.addEventListener('click', () => { setTab(b.dataset.tab); window.scrollTo(0, 0); });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.pinned) { state.pinned = null; applyHighlight(); } });

  new ResizeObserver(() => {
    const w = $('#plan-body').clientWidth;
    if (w > 0 && Math.abs(w - lastWidth) > 4) renderPlan();
  }).observe($('#plan-body'));

  window.addEventListener('pagehide', flushSave);
  window.addEventListener('afterprint', () => { delete document.body.dataset.printMode; });
}

// ---------------------------------------------------------------- start

async function init() {
  // Also moves an older single saved project (and its ticked cuts) into the list.
  const opened = projects.open();
  if (opened.project) {
    state.projectId = opened.id;
    state.project = opened.project;
    state.progress = toProgress(opened.progress);
  } else {
    state.project = store.exampleProject();
    state.firstRun = true;
  }

  projectList = createProjectList({
    h, iconEl, panel: $('#projects'), opener: $('#menu-btn'),
    entries: projectEntries,
    currentId: () => state.projectId,
    actions: { open: openProject, create: () => commands.new(), rename: renameProject, duplicate: duplicateProject, remove: deleteProject },
  });
  bindChrome();
  renderEditor();
  runPlan();
  renderPlan();
  if (matchMedia('(max-width: 959px)').matches && state.plan.sheets.length) setTab('plan');
  if (opened.damaged.length) {
    const n = opened.damaged.length;
    toast(`${joinWords(opened.damaged)} couldn’t be opened because ${n === 1 ? 'its saved copy is' : 'their saved copies are'} damaged, so ${n === 1 ? 'it was' : 'they were'} removed from your projects.`);
  }

  const m = location.hash.match(/^#p=([A-Za-z0-9_-]+)$/);
  if (m) {
    history.replaceState(null, '', location.pathname + location.search);
    let shared;
    try {
      shared = await store.decodeShare(m[1]);
    } catch {
      shared = null;
    }
    if (shared) startProject(shared, `Opened ${shared.name} from a shared link.`);
    else toast('This share link is incomplete or damaged. Ask for a new link.');
  }

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
