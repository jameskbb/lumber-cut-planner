// Shop mode: a full-screen view for a phone at the saw that shows one step at
// a time. Its progress is the cut checklist's progress (same keys, same
// markCut), so ticking a cut in either place ticks it in both.

import { renderSheet, nounFor } from './sheet-view.js';
import { formatLength } from './units.js';
import { buildShopSteps, cutKey, isStepDone, firstOpenStep, nextOpenStep, stepPieces } from './shop-steps.js';
import { closeOnBack } from './back-gesture.js';

// A second tap this soon after moving on is a double tap, not a second cut.
const DOUBLE_TAP_MS = 350;
// Keep in step with the side-by-side layout in css/shop.css.
const WIDE = '(min-width: 700px) and (orientation: landscape), (min-width: 960px)';

const joinWords = (words) => (words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0]);

export function createShopMode(app) {
  const { h, lenEl, dimsEl, units, colorOf, letterOf, markCut, getPlan, getDone, printLabels, toast } = app;
  const entry = document.getElementById('shop-btn');
  const ui = {};
  let dialog = null;
  let back = null;
  let shownPlan = null;
  let steps = [];
  let index = 0;
  let listOpen = false;
  let lastMove = 0;
  let lastSheet = -1;
  // Steps passed over while they still had cuts to make. Later steps may need
  // them, so they come round again and are marked in the step list.
  let skipped = new Set();
  // The step on screen is a skipped one that Done or Skip for now came back to.
  let cameBack = false;
  let lock = null;
  let locking = false;
  let drawQueued = false;

  const plan = () => getPlan();
  const finished = () => index >= steps.length;
  const say = (v) => `${formatLength(v, units())}${units() === 'mm' ? ' mm' : ' inches'}`;
  const totalCuts = () => steps.reduce((a, s) => a + s.cuts.length, 0);
  const doneCuts = () => { const d = getDone(); return steps.reduce((a, s) => a + s.keys.filter((k) => d.has(k)).length, 0); };

  function sheetTitle(i) {
    const sheets = plan().sheets;
    const noun = nounFor(sheets[i], units());
    const same = sheets.every((s) => nounFor(s, units()) === noun);
    return same && sheets.length > 1 ? `${noun} ${i + 1} of ${sheets.length}` : `${noun} ${i + 1}`;
  }

  // ------------------------------------------------------------ entry point

  function syncEntry() {
    if (dialog?.open && plan() !== shownPlan) replan();
    if (!entry) return;
    const p = plan();
    const keys = p && !p.error ? p.sheets.flatMap((s, i) => s.cuts.map((c) => cutKey(i, c))) : [];
    entry.hidden = !keys.length;
    if (!keys.length) return;
    const done = getDone();
    const some = keys.some((k) => done.has(k));
    const all = keys.every((k) => done.has(k));
    // With every cut ticked, the button opens the steps again from the first one.
    entry.textContent = all ? 'Review cuts' : some ? 'Continue cutting' : 'Start cutting';
  }
  entry?.addEventListener('click', () => open());

  // ------------------------------------------------------------ building

  function build() {
    ui.exit = h('button', { type: 'button', class: 'btn', onclick: () => exit() }, 'Back to plan');
    ui.listBtn = h('button', { type: 'button', class: 'btn', 'aria-expanded': 'false', 'aria-controls': 'shop-list', onclick: () => setList(!listOpen) }, 'All steps');
    ui.caption = h('figcaption', { class: 'shop-where' });
    ui.art = h('div', { class: 'shop-art has-cut-hl' });
    ui.figure = h('figure', { class: 'shop-figure' }, ui.caption, ui.art);
    ui.step = h('div', { class: 'shop-step' });
    ui.prev = h('button', { type: 'button', class: 'btn', onclick: () => prev() }, 'Previous');
    ui.skip = h('button', { type: 'button', class: 'btn', onclick: () => skip() }, 'Skip for now');
    ui.done = h('button', { type: 'button', class: 'btn btn-dark shop-done', onclick: () => primary() }, 'Done');
    ui.panel = h('div', { class: 'shop-panel' },
      ui.step,
      h('div', { class: 'shop-controls' }, h('div', { class: 'shop-nav' }, ui.prev, ui.skip), ui.done));
    ui.finish = h('div', { class: 'shop-finish' });
    ui.list = h('div', { class: 'shop-list', id: 'shop-list' });
    ui.live = h('p', { class: 'sr-only', 'aria-live': 'polite' });
    dialog = h('dialog', { class: 'shop', 'aria-label': 'Cutting, one step at a time' },
      h('header', { class: 'shop-bar' }, ui.exit, ui.listBtn),
      h('div', { class: 'shop-body' }, ui.figure, ui.panel, ui.finish, ui.list),
      ui.live);

    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      if (listOpen) setList(false); else exit();
    });
    dialog.addEventListener('close', cleanup);
    dialog.addEventListener('keydown', onKey);
    // The phone's back gesture leaves shop mode rather than the app.
    back = closeOnBack(dialog, 'shopMode');
    document.body.append(dialog);
    new ResizeObserver(queueDraw).observe(ui.art);
  }

  // ------------------------------------------------------------ open and close

  const stepsSig = (list) => JSON.stringify(list.map((s) => [s.sheetIndex, s.type, s.offset, s.cuts.map((c) => [c.key, c.piece])]));

  // The plan was recalculated while shop mode was open (another project, or a
  // pending edit landing): keep going if the cuts are the same, start again
  // at the first open step if they changed, and leave if there are none.
  function replan() {
    shownPlan = plan();
    const fresh = buildShopSteps(shownPlan);
    if (!fresh.length) {
      exit();
      toast?.('The plan changed and has no cuts to make now, so you’re back at the plan.');
      return;
    }
    const same = stepsSig(fresh) === stepsSig(steps);
    steps = fresh;
    if (!same) {
      const first = firstOpenStep(steps, getDone());
      index = first < 0 ? steps.length : first;
      listOpen = false;
      lastSheet = -1;
      skipped = new Set();
      cameBack = false;
    }
    update(!same);
  }

  function open() {
    shownPlan = plan();
    steps = buildShopSteps(shownPlan);
    if (!steps.length) return;
    if (!dialog) build();
    // Every cut done ("Review cuts"): go through them again from the start.
    const first = firstOpenStep(steps, getDone());
    index = first < 0 ? 0 : first;
    listOpen = false;
    lastSheet = -1;
    lastMove = 0;
    skipped = new Set();
    cameBack = false;
    dialog.showModal();
    back.opened();
    wake();
    update();
  }

  function exit() {
    if (dialog?.open) dialog.close();
  }

  function cleanup() {
    releaseWake();
    listOpen = false;
    back.closed();
    app.onClose?.();
    syncEntry();
    if (entry && !entry.hidden) entry.focus();
  }

  // ------------------------------------------------------------ keep the screen on

  async function wake() {
    if (!('wakeLock' in navigator) || lock || locking || document.visibilityState !== 'visible') return;
    locking = true;
    try {
      const l = await navigator.wakeLock.request('screen');
      if (!dialog?.open) { l.release().catch(() => {}); return; }
      lock = l;
      l.addEventListener('release', () => { if (lock === l) lock = null; });
    } catch { /* not allowed here (battery saver, no permission): the screen may dim as usual */ } finally {
      locking = false;
    }
  }

  function releaseWake() {
    const l = lock;
    lock = null;
    l?.release().catch(() => {});
  }

  // The browser drops the lock whenever the page is hidden.
  document.addEventListener('visibilitychange', () => {
    if (dialog?.open && document.visibilityState === 'visible') wake();
  });

  // ------------------------------------------------------------ moving between steps

  // `auto` is a move made for the person (Done, Skip for now), not a jump they chose.
  function moveTo(i, auto = false) {
    const target = Math.max(0, Math.min(i, steps.length));
    const done = getDone();
    for (let k = index; k < target && k < steps.length; k++) if (!isStepDone(steps[k], done)) skipped.add(k);
    cameBack = auto && target < steps.length && skipped.has(target) && !isStepDone(steps[target], done);
    index = target;
    lastMove = Date.now();
    listOpen = false;
    update();
  }

  function afterLast() {
    const open = firstOpenStep(steps, getDone());
    return open < 0 ? steps.length : open;
  }

  // Done: mark every cut in the step and go to the next one still to make.
  function primary() {
    if (finished() || Date.now() - lastMove < DOUBLE_TAP_MS) return;
    const step = steps[index];
    const done = getDone();
    if (isStepDone(step, done)) {
      moveTo(index + 1 < steps.length ? index + 1 : afterLast(), true);
      return;
    }
    for (const k of step.keys) if (!done.has(k)) markCut(k, true);
    const n = nextOpenStep(steps, getDone(), index);
    moveTo(n < 0 ? steps.length : n, true);
  }

  function prev() {
    if (index > 0) moveTo(index - 1);
  }

  function next() {
    if (index < steps.length - 1) moveTo(index + 1);
  }

  // Skip for now: on to the next step with a cut to make, coming round to
  // earlier skipped steps after the last one.
  function skipTarget() {
    const n = nextOpenStep(steps, getDone(), index);
    return n === index ? -1 : n;
  }

  function skip() {
    const n = skipTarget();
    if (n < 0) return;
    skipped.add(index);
    moveTo(n, true);
  }

  function markNotDone() {
    for (const k of steps[index].keys) markCut(k, false);
    update(false);
    ui.live.textContent = 'Marked as not done.';
    ui.done.focus();
  }

  function setList(openList) {
    listOpen = openList;
    update(false);
    if (openList) {
      const current = ui.list.querySelector('[aria-current]') || ui.list.querySelector('button');
      current?.focus();
      current?.scrollIntoView({ block: 'center' });
    }
  }

  function onKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const activate = e.key === 'Enter' || e.key === ' ';
    // Holding a key down must never run through several cuts.
    if (activate && e.repeat) { e.preventDefault(); return; }
    if (listOpen) return;
    const onOtherControl = e.target !== ui.done && e.target.closest?.('button, a, input, select, textarea');
    if (activate && !onOtherControl && !finished()) {
      e.preventDefault();
      primary();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      prev();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      next();
    }
  }

  // ------------------------------------------------------------ rendering

  function update(moved = true) {
    const end = finished();
    ui.listBtn.setAttribute('aria-expanded', String(listOpen));
    ui.listBtn.textContent = listOpen ? 'Hide steps' : 'All steps';
    ui.figure.hidden = end || listOpen;
    ui.panel.hidden = end || listOpen;
    ui.finish.hidden = !end || listOpen;
    ui.list.hidden = !listOpen;
    if (listOpen) renderList();
    else if (end) renderFinish();
    else { renderStep(); draw(); }
    if (moved) {
      announce();
      if (!listOpen) (end ? ui.finish.querySelector('.btn-dark') : ui.done).focus();
    }
    syncEntry();
  }

  const badge = (c, done) => h('span', { class: `step-n${done.has(c.key) ? ' is-done' : ''}`, 'aria-hidden': 'true' }, String(c.n));

  function renderStep() {
    const step = steps[index];
    const done = getDone();
    const sheet = plan().sheets[step.sheetIndex];
    const rip = step.type === 'rip';
    const count = step.cuts.length;
    const doneCount = step.keys.filter((k) => done.has(k)).length;
    const stepDone = doneCount === count;

    ui.caption.replaceChildren(
      h('span', null, h('strong', null, sheetTitle(step.sheetIndex)), `, ${sheet.stockName}`),
      h('span', { class: 'shop-count' }, `Step ${index + 1} of ${steps.length}`));

    const head = count > 1
      ? h('h2', { class: 'shop-head' }, `Make ${count} ${rip ? 'rips' : 'crosscuts'} at`)
      : h('h2', { class: 'shop-head' }, badge(step.cuts[0], done),
        h('span', null, h('span', { class: 'sr-only' }, `Cut ${step.cuts[0].n}: `),
          `${rip ? 'Rip' : 'Crosscut'} the `, dimsEl(step.cuts[0].piece.l, step.cuts[0].piece.w), ' piece at'));
    const from = count > 1
      ? (rip ? 'measured from each piece’s top edge' : 'measured from each piece’s left end')
      : (rip ? 'measured from its top edge' : 'measured from its left end');
    const kids = [
      cameBack && !stepDone ? h('p', { class: 'shop-back' }, count > 1 ? 'Back to the cuts you skipped.' : 'Back to the cut you skipped.') : null,
      head,
      h('p', { class: 'shop-setting' }, lenEl(step.offset),
        h('span', { class: `shop-unit${units() === 'mm' ? ' is-mm' : ''}`, 'aria-hidden': 'true' }, units() === 'mm' ? 'mm' : '"')),
      h('p', { class: 'shop-from' }, from),
    ];
    if (count > 1) {
      kids.push(h('ul', { class: 'shop-pieces' }, step.cuts.map((c) => h('li', { class: done.has(c.key) ? 'is-done' : null },
        badge(c, done),
        h('span', null, h('span', { class: 'sr-only' }, `Cut ${c.n}: the `), dimsEl(c.piece.l, c.piece.w), ' piece',
          done.has(c.key) ? h('span', { class: 'sr-only' }, ', done') : null)))));
    }
    if (stepDone) {
      kids.push(h('p', { class: 'shop-status' }, count > 1 ? 'These cuts are done. ' : 'This cut is done. ',
        h('button', { type: 'button', class: 'linkish', onclick: markNotDone }, 'Mark as not done')));
    } else if (doneCount) {
      kids.push(h('p', { class: 'shop-status' }, `${doneCount} of these ${count} cuts are done.`));
    }
    ui.step.classList.toggle('is-done', stepDone);
    ui.step.replaceChildren(...kids.filter(Boolean));

    ui.prev.disabled = index === 0;
    ui.skip.hidden = stepDone;
    ui.skip.disabled = skipTarget() < 0;
    ui.done.textContent = stepDone ? 'Next step' : 'Done';
  }

  // The diagram, zoomed to the piece on the saw with the cut drawn in crayon.
  function queueDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; draw(); });
  }

  function draw() {
    if (!dialog?.open || listOpen || finished()) return;
    // Side by side, the diagram gets the column's height. Stacked, it gets up
    // to about half the screen and the frame shrinks to fit what it shows.
    const cw = ui.art.clientWidth;
    const room = matchMedia(WIDE).matches ? ui.figure.clientHeight - ui.caption.offsetHeight - 6 : window.innerHeight * 0.45;
    if (cw < 40 || room < 40) return;
    const step = steps[index];
    const sheet = plan().sheets[step.sheetIndex];
    const pieces = stepPieces(step);
    const whole = pieces.length === 1 && pieces[0].l >= sheet.length - 1e-6 && pieces[0].w >= sheet.width - 1e-6;
    const nums = step.cuts.map((c) => c.n);
    const svg = renderSheet(sheet, {
      width: cw,
      maxHeight: room,
      units: units(),
      colorOf,
      letterOf,
      done: getDone(),
      showCuts: true,
      key: String(step.sheetIndex),
      id: 'shop',
      view: cropFor(sheet, pieces, cw / room),
      focus: whole ? null : pieces,
      label: `${sheetTitle(step.sheetIndex)} layout, zoomed in on the piece to cut, with ${nums.length > 1 ? `cuts ${joinWords(nums.map(String))}` : `cut ${nums[0]}`} in red. The step describes the cut.`,
    });
    const vb = svg.viewBox.baseVal;
    ui.art.style.aspectRatio = `${vb.width} / ${vb.height}`;
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    for (const k of step.keys) for (const el of svg.querySelectorAll(`[data-cut="${k}"]`)) el.classList.add('is-hl');
    ui.art.replaceChildren(svg);
  }

  // The area to show: the piece with a margin, enough of the sheet to see
  // where it sits, and the shape of the frame, kept on the sheet.
  function cropFor(sheet, pieces, aspect) {
    let x0 = Math.min(...pieces.map((p) => p.x));
    let y0 = Math.min(...pieces.map((p) => p.y));
    let x1 = Math.max(...pieces.map((p) => p.x + p.l));
    let y1 = Math.max(...pieces.map((p) => p.y + p.w));
    const m = Math.max(x1 - x0, y1 - y0) * 0.1;
    x0 -= m; y0 -= m; x1 += m; y1 += m;
    const grow = (a0, a1, min) => { const d = Math.max(0, min - (a1 - a0)) / 2; return [a0 - d, a1 + d]; };
    [x0, x1] = grow(x0, x1, sheet.length * 0.3);
    [y0, y1] = grow(y0, y1, sheet.width * 0.3);
    if ((x1 - x0) / (y1 - y0) < aspect) [x0, x1] = grow(x0, x1, (y1 - y0) * aspect);
    else [y0, y1] = grow(y0, y1, (x1 - x0) / aspect);
    const fit = (a0, a1, max) => {
      const span = Math.min(a1 - a0, max);
      const start = Math.max(0, Math.min(a0, max - span));
      return [start, start + span];
    };
    [x0, x1] = fit(x0, x1, sheet.length);
    [y0, y1] = fit(y0, y1, sheet.width);
    return { x: x0, y: y0, l: x1 - x0, w: y1 - y0 };
  }

  function renderFinish() {
    const n = totalCuts();
    ui.finish.replaceChildren(
      h('h2', null, n === 1 ? 'The cut is done.' : `All ${n} cuts are done.`),
      h('p', null, plan().unplaced.length
        ? 'Some parts didn’t fit on your stock, so they aren’t cut yet. The plan shows what to do.'
        : 'Every part in the plan is cut.'),
      h('div', { class: 'shop-finish-actions' },
        h('button', { type: 'button', class: 'btn btn-dark', onclick: () => exit() }, 'Back to plan'),
        printLabels ? h('button', { type: 'button', class: 'btn', onclick: () => { exit(); printLabels(); } }, 'Print part labels') : null));
  }

  function renderList() {
    const done = getDone();
    const sections = [];
    steps.forEach((s, i) => {
      if (!sections.length || sections.at(-1).sheetIndex !== s.sheetIndex) sections.push({ sheetIndex: s.sheetIndex, items: [] });
      const rip = s.type === 'rip';
      const count = s.cuts.length;
      const isDone = isStepDone(s, done);
      const wasSkipped = !isDone && skipped.has(i);
      const nums = s.cuts.map((c) => String(c.n));
      sections.at(-1).items.push(h('li', null, h('button', {
        type: 'button', class: `shop-jump${isDone ? ' is-done' : ''}`, 'aria-current': i === index ? 'step' : null,
        onclick: () => moveTo(i),
      },
      h('span', { class: 'shop-jump-n' }, s.cuts.map((c) => badge(c, done))),
      h('span', { class: 'shop-jump-text' },
        h('span', { class: 'sr-only' }, `Step ${i + 1}, ${count > 1 ? `cuts ${joinWords(nums)}` : `cut ${nums[0]}`}: `),
        count > 1 ? `${count} ${rip ? 'rips' : 'crosscuts'} at ` : `${rip ? 'Rip' : 'Crosscut'} at `,
        lenEl(s.offset),
        isDone ? h('span', { class: 'sr-only' }, ', done') : null,
        wasSkipped ? h('span', { class: 'shop-skipped' }, h('span', { class: 'sr-only' }, ', '), 'Skipped, still to do') : null))));
    });
    const sheets = plan().sheets;
    const skippedCuts = [...skipped].filter((i) => i < steps.length)
      .reduce((a, i) => a + steps[i].keys.filter((k) => !done.has(k)).length, 0);
    const sum = `${doneCuts()} of ${totalCuts()} cuts done.`;
    ui.list.replaceChildren(
      h('p', { class: 'shop-list-sum' }, skippedCuts
        ? `${sum} ${skippedCuts === 1
          ? 'The cut you skipped is still to do. It comes round again after the last step.'
          : `The ${skippedCuts} cuts you skipped are still to do. They come round again after the last step.`}`
        : sum),
      ...sections.map((sec) => h('section', null,
        h('h3', null, sheetTitle(sec.sheetIndex), h('span', { class: 'shop-list-stock' }, `, ${sheets[sec.sheetIndex].stockName}`)),
        h('ol', null, sec.items))));
  }

  function announce() {
    if (finished()) {
      ui.live.textContent = totalCuts() === 1 ? 'The cut is done.' : `All ${totalCuts()} cuts are done.`;
      return;
    }
    const step = steps[index];
    const sheet = plan().sheets[step.sheetIndex];
    const rip = step.type === 'rip';
    const nums = step.cuts.map((c) => String(c.n));
    const where = step.sheetIndex !== lastSheet ? ` ${sheetTitle(step.sheetIndex)}, ${sheet.stockName}.` : '';
    lastSheet = step.sheetIndex;
    const p = step.cuts[0].piece;
    const what = step.cuts.length > 1
      ? `Make ${nums.length} ${rip ? 'rips' : 'crosscuts'} at ${say(step.offset)}, measured from each piece’s ${rip ? 'top edge' : 'left end'}: cuts ${joinWords(nums)}.`
      : `Cut ${nums[0]}: ${rip ? 'rip' : 'crosscut'} the ${formatLength(p.l, units())} by ${formatLength(p.w, units())} piece at ${say(step.offset)}, measured from its ${rip ? 'top edge' : 'left end'}.`;
    const state = isStepDone(step, getDone()) ? ' Already done.' : '';
    const again = cameBack ? ' Back to a step you skipped.' : '';
    ui.live.textContent = `Step ${index + 1} of ${steps.length}.${again}${where} ${what}${state}`;
  }

  return { open, syncEntry };
}
