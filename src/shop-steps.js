// Turns a cut plan into steps to follow at the saw, one fence setting at a
// time. Pure functions with no DOM access, so they can be reused anywhere.
//
// A step is one or more cuts made at the same setting: the same kind of cut
// (rip or crosscut) at the same offset. Cuts are only grouped when every
// piece they cut already exists, so the order is always physically possible.

const EPS = 1e-6;

/** The key the cut checklist stores progress under: sheet index and cut number. */
export const cutKey = (sheetIndex, cut) => `${sheetIndex}-${cut.n}`;

const contains = (outer, inner) =>
  inner.x >= outer.x - EPS && inner.y >= outer.y - EPS &&
  inner.x + inner.l <= outer.x + outer.l + EPS && inner.y + inner.w <= outer.y + outer.w + EPS;

const sameSetting = (a, b) => a.type === b.type && Math.abs(a.offset - b.offset) <= EPS;

/**
 * For each cut, the index of the cut that produces the piece it cuts, or -1
 * when it cuts the whole sheet. That's the smallest earlier piece containing
 * it: every cut splits a piece in two, so the pieces nest like a tree and the
 * planner lists a cut before any cut of the pieces it makes.
 */
export function cutParents(cuts) {
  return cuts.map((c, i) => {
    let parent = -1;
    for (let j = 0; j < i; j++) {
      const p = cuts[j].piece;
      if (!contains(p, c.piece)) continue;
      if (parent < 0 || p.l * p.w <= cuts[parent].piece.l * cuts[parent].piece.w + EPS) parent = j;
    }
    return parent;
  });
}

/**
 * @param plan the result of planCuts()
 * @returns {Array<{index, sheetIndex, type: 'rip'|'crosscut', offset, cuts: Array<{n, key, type, offset, piece}>, keys: string[]}>}
 */
export function buildShopSteps(plan) {
  const steps = [];
  (plan?.sheets || []).forEach((sheet, sheetIndex) => {
    const cuts = sheet.cuts || [];
    const parent = cutParents(cuts);
    const made = cuts.map(() => false);
    // A cut is ready once the piece it cuts has been cut free.
    const ready = (i) => !made[i] && (parent[i] < 0 || made[parent[i]]);

    for (let lead = 0; lead < cuts.length; lead++) {
      if (made[lead]) continue;
      // The first cut not yet made is always ready: its parent comes earlier.
      const group = [lead];
      made[lead] = true;
      // A parent always comes before its children, so one forward pass also
      // picks up pieces made by cuts added to this group.
      for (let i = lead + 1; i < cuts.length; i++) {
        if (ready(i) && sameSetting(cuts[i], cuts[lead])) {
          group.push(i);
          made[i] = true;
        }
      }
      const stepCuts = group.map((i) => ({
        n: cuts[i].n,
        key: cutKey(sheetIndex, cuts[i]),
        type: cuts[i].type,
        offset: cuts[i].offset,
        piece: cuts[i].piece,
      }));
      steps.push({
        index: steps.length,
        sheetIndex,
        type: cuts[lead].type,
        offset: cuts[lead].offset,
        cuts: stepCuts,
        keys: stepCuts.map((c) => c.key),
      });
    }
  });
  return steps;
}

export const isStepDone = (step, done) => step.keys.every((k) => done.has(k));

/** Index of the first step with a cut left to make, or -1 when every cut is done. */
export function firstOpenStep(steps, done) {
  return steps.findIndex((s) => !isStepDone(s, done));
}

/** The next step after `from` with a cut left to make, wrapping round; -1 when every cut is done. */
export function nextOpenStep(steps, done, from) {
  for (let k = 1; k <= steps.length; k++) {
    const i = (from + k) % steps.length;
    if (!isStepDone(steps[i], done)) return i;
  }
  return -1;
}

/** The pieces in a step that aren't cut from another piece in the same step. */
export function stepPieces(step) {
  const pieces = step.cuts.map((c) => c.piece);
  return pieces.filter((p, i) => !pieces.some((q, j) => j !== i && contains(q, p) && !(contains(p, q) && j > i)));
}
