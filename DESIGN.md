# Design guide

Read this before changing anything people see: layout, styles, copy, notices, labels or printouts. Lumber Cut Planner has a deliberate look and voice. New features should fit it, not add a second one.

## Who it's for

Hobbyist woodworkers planning cuts for plywood and boards, often on a phone next to the saw with dusty hands and bad light. The job: enter stock and parts, get a plan you can follow at the saw without second-guessing it.

## The look

A galvanized-steel tool around warm birch sheets. The interface stays cool, quiet and grey so the wood and the cuts carry the page.

| Token | Hex | Used for |
| --- | --- | --- |
| `--ground` / `--panel` | `#E7EAE9` / `#F6F7F6` | Page and panel backgrounds |
| `--ink` / `--ink-2` | `#23272B` / `#545D63` | Text (graphite pencil); `--ink-2` for secondary text |
| `--birch` family | `#EDD8AE` and friends | Stock in the diagrams. Nothing else. |
| `--tape` | `#F2C12E` | The tape-measure rulers and the logo. Not buttons. |
| `--crayon` | `#C33A2C` | Saw cuts, and problems that stop a plan. Not decoration. |
| Milk-paint palette | `PALETTE` in `src/app.js` | One color per part, the same on screen, in lists and on labels |

Primary buttons are graphite (`.btn-dark`); everything else is outlined (`.btn`). Don't add new colors. Every color above already means something.

**One bold element.** The sheet diagram (tape rulers, birch, numbered crayon cuts) is the memorable thing. Keep everything around it disciplined. A new feature earns its place through clarity, not visual weight.

## Type

- One family: Archivo, bundled in `fonts/` so the app works offline. Never load fonts or scripts from a CDN.
- The width axis does the expressive work: 125% for the wordmark, 108–112% for headings, 100% for body, about 82% for labels inside diagrams.
- Minimum sizes: 16px in inputs (smaller makes iOS zoom), 13px (`0.8125rem`) for hints and secondary text, 9pt on printed labels.
- Fractions are typeset with `lenEl()` / `appendLength()`. Never print "11 1/4" as flat text where a size is displayed.

## Layout and structure

- Materials on the left, plan on the right; on phones, two tabs. Content is left-aligned.
- Structure must carry information. Numbered markers are only for the cut order, because that really is a sequence.
- Don't repeat the same control or link on every row. Put optional fields behind one toggle per section. When a closed section hides values that change the plan, show them on the row in plain words.
- A notice says what's wrong and offers the fix as one primary button. Work the app can do fast (under ~100 ms) happens automatically; don't make people press "Calculate".
- Anything that replaces or deletes work goes through `withUndo()`, so there's an Undo in the toast instead of a confirm dialog.

## Words

- Sentence case, plain verbs, no filler. Errors explain what happened and how to fix it; they don't apologize.
- A button says exactly what happens, and the toast echoes it: "Add 1 sheet of 3/4 birch plywood" gives "Added 1 sheet of 3/4 birch plywood."
- Say "sheet of 3/4 plywood", never "1 3/4 plywood", which reads as a fraction.
- Avoid template tells: middle-dot lists ("A · B · C"), arrows standing in for words ("Grain → length"), all-caps labels, "Word — fragment" headings, and decorative labels above content.

Keep the vocabulary consistent:

| Say | Not |
| --- | --- |
| stock; a sheet or a board | SKU, material item, stock piece |
| part | piece, component |
| can be turned / keep the grain along the length | unrestricted, rotation allowed |
| rip / crosscut | cut along X / Y |
| left over | extra purchased area, waste percentage |
| extra length / extra width | allowance |

## Motion and accessibility

- Motion only answers an action (highlighting, the toast). No entrance animations. Respect `prefers-reduced-motion`.
- Tap targets at least 44px on touch (`--tap`), visible focus rings, labels on every control, and text alternatives for the diagrams (the cut list).

## Before you commit a UI change

1. `npm test`
2. Look at it: desktop around 1440px and a phone at 390px, plus print preview if you touched printing.
3. Read every new string aloud against the Words section above.
