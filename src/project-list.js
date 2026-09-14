// "Your projects": a panel that opens from the Project menu, on the same
// surface as the menu, listing saved projects by when they were last edited.
//
// Actions sit only on the open project (rename, duplicate, delete), so no
// control repeats down the list; every other row is itself the way to open
// that project. Non-modal on purpose: the toast's Undo stays reachable.

import { editedLabel } from './projects.js';

const CHECK = 'M4.5 10.5l3.5 3.5 7.5-8';

/**
 * @param {object} o
 * @param {Function} o.h           the app's element builder
 * @param {Function} o.iconEl      builds an icon from a path
 * @param {HTMLElement} o.panel    the empty panel element
 * @param {HTMLElement} o.opener   where focus returns on close
 * @param {Function} o.entries     () => [{id, name, updatedAt}], most recent first
 * @param {Function} o.currentId   () => id of the open project
 * @param {object} o.actions       { open(id), create(), rename(), duplicate(), remove() }
 */
export function createProjectList({ h, iconEl, panel, opener, entries, currentId, actions }) {
  // The open project's row takes focus too, so the arrow keys can come back to it.
  const stops = () => [...panel.querySelectorAll('.projects-current, button')];

  function close({ restoreFocus = true } = {}) {
    if (panel.hidden) return;
    panel.hidden = true;
    if (restoreFocus) opener.focus();
  }

  // Close first so an action that moves focus (rename, new project) keeps it.
  const run = (action, ...args) => () => { close(); action(...args); };

  function currentRow(e) {
    const name = e.name;
    return h('li', { class: 'projects-current', 'aria-current': 'true', tabindex: '-1' },
      h('span', { class: 'projects-check' }, iconEl(CHECK)),
      h('p', { class: 'projects-name' }, name, h('span', { class: 'sr-only' }, ', open now')),
      h('p', { class: 'projects-when' }, editedLabel(e.updatedAt)),
      h('div', { class: 'projects-actions' },
        h('button', { type: 'button', class: 'btn', 'aria-label': `Rename ${name}`, onclick: run(actions.rename) }, 'Rename'),
        h('button', { type: 'button', class: 'btn', 'aria-label': `Duplicate ${name}`, onclick: run(actions.duplicate) }, 'Duplicate'),
        h('button', { type: 'button', class: 'btn', 'aria-label': `Delete ${name}`, onclick: run(actions.remove) }, 'Delete')));
  }

  function otherRow(e) {
    const when = editedLabel(e.updatedAt);
    return h('li', null,
      h('button', {
        type: 'button', class: 'projects-open', 'aria-label': `Open ${e.name}, ${when.toLowerCase()}`,
        onclick: run(actions.open, e.id),
      },
      h('span', { class: 'projects-name' }, e.name),
      h('span', { class: 'projects-when' }, when)));
  }

  function render() {
    const cur = currentId();
    panel.replaceChildren(
      h('h2', { class: 'projects-title', id: 'projects-h', tabindex: '-1' }, 'Your projects'),
      h('ul', { class: 'projects-list' }, entries().map((e) => (e.id === cur ? currentRow(e) : otherRow(e)))),
      h('div', { class: 'projects-foot' },
        h('button', { type: 'button', class: 'btn btn-dark', onclick: run(actions.create) }, 'New project'),
        h('p', { class: 'hint' }, 'Projects are saved in this browser on this device. Use Save to file to keep a copy anywhere else.')));
  }

  function open() {
    render();
    panel.hidden = false;
    // Start on the open project, not on its Rename button.
    (panel.querySelector('.projects-current') || panel.querySelector('.projects-title')).focus();
  }

  panel.addEventListener('keydown', (e) => {
    const list = stops();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length].focus(); }
  });
  // Tabbing or clicking away closes it, like the menu.
  panel.addEventListener('focusout', (e) => {
    if (e.relatedTarget && !panel.contains(e.relatedTarget)) close({ restoreFocus: false });
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !e.target.closest('.menu-wrap')) close({ restoreFocus: false });
  });
  opener.addEventListener('click', () => close({ restoreFocus: false }));

  return { open, close, get isOpen() { return !panel.hidden; } };
}
