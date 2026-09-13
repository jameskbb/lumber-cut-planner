# Lumber Cut Planner

A zero-dependency static web app (installable, works offline) that plans cuts for plywood and boards. Hosted on GitHub Pages from `main`; there's no build step.

**Before changing anything people see (layout, styles, copy, notices, labels, printouts), read [DESIGN.md](DESIGN.md) and follow it.**

## Commands

- `npm start` serves the app at http://localhost:8000 (ES modules don't load from `file://`).
- `npm test` runs the Node test suite.

## Code

- `src/planner.js` must stay pure (no DOM). It will be reused in a native iOS app later.
- `src/store.js` validates everything from files and share links; treat that data as untrusted.
- `src/app.js` builds DOM with `h()` and `textContent`. Never put user text into `innerHTML`.
- Add new files that must work offline to the `SHELL` list in `sw.js`.

## Repo rules

- The repo is public: no secrets, emails or absolute home paths in files.
- There's deliberately no license. Don't add one.
