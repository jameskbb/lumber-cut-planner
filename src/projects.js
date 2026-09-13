// Saved projects: a small index plus one storage entry per project, kept
// behind a tiny key-value adapter ({ get, set, remove } of strings) so the
// browser's localStorage can later be swapped for native or synced storage.
//
// No DOM here. Everything read back is untrusted: project bodies go through
// sanitizeProject, and the index and checklist progress are cleaned too.
//
// Storage layout:
//   lumber-cut-planner/index           {"v":1,"projects":[{id,name,updatedAt}]}
//   lumber-cut-planner/projects/<id>   the project, as saved to a file
//   lumber-cut-planner/progress/<id>   ticked-off cuts: {"sig":"…","done":["0-1"]}
//   lumber-cut-planner/current         id of the project that was open last
// Before this, one project lived at STORAGE_KEY and its progress at
// LEGACY_PROGRESS_KEY; open() moves them into the layout above.

import { sanitizeProject, newId, STORAGE_KEY } from './store.js';

export const MAX_PROJECTS = 100;
export const INDEX_KEY = 'lumber-cut-planner/index';
export const CURRENT_KEY = 'lumber-cut-planner/current';
export const LEGACY_PROJECT_KEY = STORAGE_KEY;
export const LEGACY_PROGRESS_KEY = 'lumber-cut-planner/progress';
export const projectKey = (id) => `lumber-cut-planner/projects/${id}`;
export const progressKey = (id) => `lumber-cut-planner/progress/${id}`;

const NAME_MAX = 120;
const MAX_DONE = 5000;
const validId = (id) => typeof id === 'string' && /^[a-z0-9_-]{1,24}$/i.test(id);
const cleanName = (name) => (typeof name === 'string' ? name.slice(0, NAME_MAX) : '') || 'Untitled project';

/** Wraps a Web Storage object (localStorage) as an adapter. Reads never throw; writes may. */
export function webStorageAdapter(storage) {
  return {
    get(key) { try { return storage ? storage.getItem(key) : null; } catch { return null; } },
    set(key, value) {
      if (!storage) throw new Error('storage unavailable');
      storage.setItem(key, value);
    },
    remove(key) { try { storage?.removeItem(key); } catch { /* nothing to free */ } },
  };
}

/** An in-memory adapter, for tests and for when the browser blocks storage. */
export function memoryAdapter(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get: (key) => (map.has(key) ? map.get(key) : null),
    set: (key, value) => { map.set(key, String(value)); },
    remove: (key) => { map.delete(key); },
  };
}

export function sanitizeProgress(raw) {
  return {
    sig: typeof raw?.sig === 'string' ? raw.sig : '',
    done: Array.isArray(raw?.done)
      ? raw.done.filter((x) => typeof x === 'string' && x.length <= 40).slice(0, MAX_DONE)
      : [],
  };
}

/** "Small bookcase" → "Small bookcase (copy)", then "(copy 2)" and so on. */
export function copyName(name, taken = []) {
  const base = cleanName(name).replace(/ \(copy(?: \d+)?\)$/, '');
  const names = new Set(taken);
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? ' (copy)' : ` (copy ${n})`;
    const candidate = base.slice(0, NAME_MAX - suffix.length) + suffix;
    if (!names.has(candidate)) return candidate;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Edited today", "Edited yesterday", "Edited 12 Aug", "Edited 12 Aug 2025", in local time. */
export function editedLabel(time, now = Date.now()) {
  if (!Number.isFinite(time)) return 'Not saved yet';
  const d = new Date(time);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (time >= startOfToday) return 'Edited today';
  if (time >= new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime()) return 'Edited yesterday';
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === today.getFullYear() ? `Edited ${day}` : `Edited ${day} ${d.getFullYear()}`;
}

const SAVE_FAILED = (name) =>
  `Couldn’t save ${name}: this browser’s storage is full or turned off. Your work is still open here. Use Save to file to keep a copy.`;

export function createProjects(kv, { now = () => Date.now() } = {}) {
  const parse = (key) => {
    const text = kv.get(key);
    if (text === null || text === undefined) return undefined;
    try { return JSON.parse(text); } catch { return null; }
  };

  // Reads the index fresh every time, so two open tabs don't erase each other's projects.
  function readIndex() {
    const raw = parse(INDEX_KEY);
    if (raw === undefined) return null;
    const list = Array.isArray(raw?.projects) ? raw.projects : [];
    const seen = new Set();
    const out = [];
    for (const e of list) {
      if (!e || !validId(e.id) || seen.has(e.id)) continue;
      seen.add(e.id);
      out.push({ id: e.id, name: cleanName(e.name), updatedAt: Number.isFinite(e.updatedAt) ? e.updatedAt : 0 });
      if (out.length >= MAX_PROJECTS) break;
    }
    return out;
  }
  const entries = () => readIndex() || [];
  const writeIndex = (list) => kv.set(INDEX_KEY, JSON.stringify({ v: 1, projects: list }));

  function read(id) {
    if (!validId(id)) return null;
    const raw = parse(projectKey(id));
    if (!raw) return null;
    try { return sanitizeProject(raw); } catch { return null; }
  }

  function readProgress(id) {
    return sanitizeProgress(validId(id) ? parse(progressKey(id)) : null);
  }

  function writeProgress(id, progress) {
    if (!validId(id)) return false;
    try { kv.set(progressKey(id), JSON.stringify(sanitizeProgress(progress))); return true; } catch { return false; }
  }

  function setCurrent(id) {
    try { kv.set(CURRENT_KEY, id); } catch { /* only affects which project opens next time */ }
  }

  /** Saved projects, most recently edited first. */
  function list() {
    return entries().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Saves a project as a new entry and makes it current. Throws a readable Error. */
  function create(project, { id = newId(), updatedAt = now(), progress = null } = {}) {
    const list = entries().filter((e) => e.id !== id);
    if (list.length >= MAX_PROJECTS) {
      throw new Error(`You have ${MAX_PROJECTS} saved projects, the most this browser keeps. Delete one you don’t need, then try again.`);
    }
    const entry = { id, name: cleanName(project.name), updatedAt };
    try {
      kv.set(projectKey(id), JSON.stringify(project));
      if (progress) kv.set(progressKey(id), JSON.stringify(sanitizeProgress(progress)));
      writeIndex([...list, entry]);
    } catch {
      kv.remove(projectKey(id));
      kv.remove(progressKey(id));
      throw new Error(SAVE_FAILED(entry.name));
    }
    setCurrent(id);
    return entry;
  }

  /**
   * Writes the project if it changed, and moves it to the top of the list.
   * Returns false when nothing changed. Throws a readable Error when storage fails.
   */
  function save(id, project) {
    const body = JSON.stringify(project);
    const list = entries();
    const entry = list.find((e) => e.id === id);
    if (entry && entry.name === cleanName(project.name) && kv.get(projectKey(id)) === body) return false;
    if (!entry && list.length >= MAX_PROJECTS) throw new Error(SAVE_FAILED(cleanName(project.name)));
    try {
      kv.set(projectKey(id), body);
      const next = { id, name: cleanName(project.name), updatedAt: now() };
      writeIndex(entry ? list.map((e) => (e.id === id ? next : e)) : [...list, next]);
    } catch {
      throw new Error(SAVE_FAILED(cleanName(project.name)));
    }
    return true;
  }

  function rename(id, name) {
    const project = read(id);
    if (!project) throw new Error('That project isn’t saved on this device any more.');
    project.name = cleanName(typeof name === 'string' ? name.trim() : '');
    save(id, project);
    return project;
  }

  /** Saves a copy under a new name ("… (copy)") and makes it current. */
  function duplicate(project) {
    const copy = structuredClone(project);
    copy.name = copyName(project.name, entries().map((e) => e.name));
    return { entry: create(copy), project: copy };
  }

  /** Deletes a project. Returns what restore() needs to bring it back. */
  function remove(id) {
    const list = entries();
    const entry = list.find((e) => e.id === id) || null;
    const snapshot = { entry, body: kv.get(projectKey(id)), progress: kv.get(progressKey(id)) };
    writeIndex(list.filter((e) => e.id !== id));
    kv.remove(projectKey(id));
    kv.remove(progressKey(id));
    if (kv.get(CURRENT_KEY) === id) kv.remove(CURRENT_KEY);
    return snapshot;
  }

  function restore(snapshot) {
    const { entry, body, progress } = snapshot;
    if (!entry || body === null) throw new Error('That project can’t be brought back.');
    try {
      kv.set(projectKey(entry.id), body);
      if (progress !== null) kv.set(progressKey(entry.id), progress);
      writeIndex([...entries().filter((e) => e.id !== entry.id), entry]);
    } catch {
      throw new Error(SAVE_FAILED(entry.name));
    }
    setCurrent(entry.id);
    return entry;
  }

  /**
   * Loads the project to show at start-up, moving an old single saved project
   * into the list first. Damaged entries are dropped and named in `damaged`.
   * Returns { id, project, progress, damaged }; project is null for a first visit.
   */
  function open() {
    const damaged = [];
    let list = readIndex();

    if (list === null) {
      // No index yet: this is a first visit, or the old single-project layout.
      list = [];
      const legacy = parse(LEGACY_PROJECT_KEY);
      let project = null;
      if (legacy) { try { project = sanitizeProject(legacy); } catch { /* unreadable: nothing to keep */ } }
      if (project) {
        const progress = sanitizeProgress(parse(LEGACY_PROGRESS_KEY));
        try {
          const entry = create(project, { progress });
          kv.remove(LEGACY_PROJECT_KEY);
          kv.remove(LEGACY_PROGRESS_KEY);
          return { id: entry.id, project, progress, damaged };
        } catch {
          // Storage is full or blocked: keep the old keys and carry on unsaved.
          return { id: null, project, progress, damaged };
        }
      }
    }

    // An index that couldn't be read still leaves the last open project reachable.
    const current = kv.get(CURRENT_KEY);
    if (validId(current) && !list.some((e) => e.id === current)) {
      const p = read(current);
      if (p) {
        list.push({ id: current, name: p.name, updatedAt: now() });
        try { writeIndex(list); } catch { /* still usable this session */ }
      }
    }

    const order = [...list].sort((a, b) => (b.id === current) - (a.id === current) || b.updatedAt - a.updatedAt);
    for (const entry of order) {
      const project = read(entry.id);
      if (project) {
        setCurrent(entry.id);
        return { id: entry.id, project, progress: readProgress(entry.id), damaged };
      }
      damaged.push(entry.name);
      discard(entry.id);
    }
    return { id: null, project: null, progress: sanitizeProgress(null), damaged };
  }

  /** Drops an entry whose saved copy can't be read. */
  function discard(id) {
    try { writeIndex(entries().filter((e) => e.id !== id)); } catch { /* retried next time */ }
    kv.remove(projectKey(id));
    kv.remove(progressKey(id));
  }

  return { open, list, read, create, save, rename, duplicate, remove, restore, discard, readProgress, writeProgress, setCurrent };
}
