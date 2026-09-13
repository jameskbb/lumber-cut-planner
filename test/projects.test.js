import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProjects, memoryAdapter, editedLabel, copyName, sanitizeProgress, MAX_PROJECTS,
  INDEX_KEY, CURRENT_KEY, LEGACY_PROJECT_KEY, LEGACY_PROGRESS_KEY, projectKey, progressKey,
} from '../src/projects.js';
import { exampleProject, blankProject, sanitizeProject } from '../src/store.js';

// A clock the tests move forward by hand, so "last edited" ordering is exact.
function setup(initial) {
  const kv = memoryAdapter(initial);
  let t = 1_000;
  const projects = createProjects(kv, { now: () => t });
  return { kv, projects, tick: (ms = 1000) => { t += ms; } };
}

const named = (name) => ({ ...blankProject(), name });

test('a first visit has no saved projects', () => {
  const { projects, kv } = setup();
  const opened = projects.open();
  assert.equal(opened.project, null);
  assert.equal(opened.id, null);
  assert.deepEqual(projects.list(), []);
  assert.equal(kv.map.size, 0);
});

test('migrates the old single saved project, and its checklist progress, with nothing lost', () => {
  const old = exampleProject();
  old.name = 'Garage shelves';
  const progress = { sig: '[0.125]', done: ['0-1', '0-2'] };
  const { projects, kv } = setup({
    [LEGACY_PROJECT_KEY]: JSON.stringify(old),
    [LEGACY_PROGRESS_KEY]: JSON.stringify(progress),
  });

  const opened = projects.open();
  assert.ok(opened.id);
  assert.deepEqual(opened.project, sanitizeProject(old));
  assert.deepEqual(opened.progress, progress);
  assert.deepEqual(projects.list().map((e) => e.name), ['Garage shelves']);
  assert.deepEqual(projects.read(opened.id), sanitizeProject(old));
  assert.deepEqual(projects.readProgress(opened.id), progress);
  assert.equal(kv.get(CURRENT_KEY), opened.id);
  // The old keys are cleared only after the new ones are written.
  assert.equal(kv.get(LEGACY_PROJECT_KEY), null);
  assert.equal(kv.get(LEGACY_PROGRESS_KEY), null);

  // Opening again finds the migrated project, not a second copy.
  assert.equal(projects.open().id, opened.id);
  assert.equal(projects.list().length, 1);
});

test('keeps the old project in place if migration cannot write', () => {
  const old = JSON.stringify(exampleProject());
  const kv = memoryAdapter({ [LEGACY_PROJECT_KEY]: old });
  kv.set = () => { throw new Error('QuotaExceededError'); };
  const opened = createProjects(kv).open();
  assert.equal(opened.id, null);
  assert.equal(opened.project.name, 'Small bookcase');
  assert.equal(kv.get(LEGACY_PROJECT_KEY), old);
});

test('an unreadable old project is a first visit, not a crash', () => {
  const { projects } = setup({ [LEGACY_PROJECT_KEY]: '{not json' });
  assert.equal(projects.open().project, null);
});

test('creates projects and reopens the one used last', () => {
  const { projects, kv, tick } = setup();
  const a = projects.create(named('Bookcase'));
  tick();
  const b = projects.create(named('Workbench'));
  assert.equal(kv.get(CURRENT_KEY), b.id);
  assert.deepEqual(projects.list().map((e) => e.name), ['Workbench', 'Bookcase']);

  projects.setCurrent(a.id);
  const opened = projects.open();
  assert.equal(opened.id, a.id);
  assert.equal(opened.project.name, 'Bookcase');
});

test('orders projects by when they were last edited, and ignores saves with no change', () => {
  const { projects, tick } = setup();
  const a = projects.create(named('A'));
  tick();
  const b = projects.create(named('B'));
  tick();
  const c = projects.create(named('C'));
  assert.deepEqual(projects.list().map((e) => e.name), ['C', 'B', 'A']);

  tick();
  const edited = projects.read(a.id);
  edited.kerf = '3/32';
  assert.equal(projects.save(a.id, edited), true);
  assert.deepEqual(projects.list().map((e) => e.name), ['A', 'C', 'B']);

  // Opening a project (saving it unchanged) doesn't count as an edit.
  tick();
  assert.equal(projects.save(b.id, projects.read(b.id)), false);
  assert.deepEqual(projects.list().map((e) => e.name), ['A', 'C', 'B']);
  assert.ok(c.id);
});

test('renames a project in the list and in its saved copy', () => {
  const { projects, tick } = setup();
  const a = projects.create(named('Bookcase'));
  tick();
  projects.create(named('Workbench'));
  tick();
  projects.rename(a.id, '  Hall bookcase  ');
  assert.equal(projects.read(a.id).name, 'Hall bookcase');
  assert.deepEqual(projects.list().map((e) => e.name), ['Hall bookcase', 'Workbench']);
  projects.rename(a.id, '   ');
  assert.equal(projects.read(a.id).name, 'Untitled project');
});

test('duplicates a project under a new name, leaving the original alone', () => {
  const { projects, tick } = setup();
  const original = exampleProject();
  const a = projects.create(original);
  tick();
  const { entry, project } = projects.duplicate(original);
  assert.notEqual(entry.id, a.id);
  assert.equal(project.name, 'Small bookcase (copy)');
  assert.deepEqual(projects.read(entry.id).parts, sanitizeProject(original).parts);
  assert.equal(projects.read(a.id).name, 'Small bookcase');
  assert.deepEqual(projects.list().map((e) => e.name), ['Small bookcase (copy)', 'Small bookcase']);

  // Changing the copy never touches the original.
  project.parts[0].length = '40';
  projects.save(entry.id, project);
  assert.equal(projects.read(a.id).parts[0].length, '36');

  tick();
  assert.equal(projects.duplicate(original).project.name, 'Small bookcase (copy 2)');
  assert.equal(copyName('Small bookcase (copy)', []), 'Small bookcase (copy)');
  assert.equal(copyName('x'.repeat(120)).length, 120);
});

test('deletes a project and its progress, and can bring both back', () => {
  const { projects, kv, tick } = setup();
  const a = projects.create(named('Keep'));
  tick();
  const b = projects.create(named('Delete me'));
  projects.writeProgress(b.id, { sig: 's', done: ['0-1'] });

  const snapshot = projects.remove(b.id);
  assert.deepEqual(projects.list().map((e) => e.name), ['Keep']);
  assert.equal(projects.read(b.id), null);
  assert.equal(kv.get(progressKey(b.id)), null);
  assert.equal(kv.get(CURRENT_KEY), null);
  assert.equal(projects.open().id, a.id);

  projects.restore(snapshot);
  assert.deepEqual(projects.list().map((e) => e.name), ['Delete me', 'Keep']);
  assert.deepEqual(projects.readProgress(b.id), { sig: 's', done: ['0-1'] });
  assert.equal(kv.get(CURRENT_KEY), b.id);
});

test('checklist progress is kept per project', () => {
  const { projects } = setup();
  const a = projects.create(named('A'));
  const b = projects.create(named('B'));
  projects.writeProgress(a.id, { sig: 'x', done: ['0-1'] });
  assert.deepEqual(projects.readProgress(b.id), { sig: '', done: [] });
  assert.deepEqual(projects.readProgress(a.id), { sig: 'x', done: ['0-1'] });
  assert.deepEqual(sanitizeProgress({ sig: 5, done: ['ok', 7, 'x'.repeat(41)] }), { sig: '', done: ['ok'] });
});

test('skips damaged projects and tells which ones were dropped', () => {
  const { projects, kv, tick } = setup();
  const good = projects.create(named('Good'));
  tick();
  const bad = projects.create(named('Broken'));
  tick();
  const worse = projects.create(named('Also broken'));
  kv.set(projectKey(bad.id), '{"stock":"nope"}');
  kv.set(projectKey(worse.id), '{oops');

  const opened = projects.open();
  assert.equal(opened.id, good.id);
  assert.deepEqual(opened.damaged, ['Also broken', 'Broken']);
  assert.deepEqual(projects.list().map((e) => e.name), ['Good']);
  assert.equal(projects.read(bad.id), null);
});

test('cleans a tampered index and survives an unreadable one', () => {
  const p = named('Real');
  const { projects, kv } = setup({
    [INDEX_KEY]: JSON.stringify({ projects: [
      { id: '<img onerror>', name: 'Bad id', updatedAt: 5 },
      { id: 'abc', name: { x: 1 }, updatedAt: 'soon' },
      { id: 'abc', name: 'Duplicate', updatedAt: 9 },
      null,
    ] }),
    [projectKey('abc')]: JSON.stringify(p),
  });
  assert.deepEqual(projects.list(), [{ id: 'abc', name: 'Untitled project', updatedAt: 0 }]);

  // An index that isn't JSON at all still reopens the last project used.
  kv.set(INDEX_KEY, 'garbage');
  kv.set(CURRENT_KEY, 'abc');
  const opened = projects.open();
  assert.equal(opened.id, 'abc');
  assert.equal(opened.project.name, 'Real');
  assert.deepEqual(projects.list().map((e) => e.id), ['abc']);
});

test(`keeps at most ${MAX_PROJECTS} projects`, () => {
  const { projects } = setup();
  for (let i = 0; i < MAX_PROJECTS; i++) projects.create(named(`P${i}`));
  assert.throws(() => projects.create(named('One too many')), /100 saved projects/);
  assert.throws(() => projects.duplicate(named('P1')), /Delete one you don’t need/);
  assert.equal(projects.list().length, MAX_PROJECTS);
});

test('a full or blocked storage fails loudly and leaves saved projects intact', () => {
  const { projects, kv } = setup();
  const a = projects.create(named('Safe'));
  const realSet = kv.set;
  kv.set = () => { throw new Error('QuotaExceededError'); };

  const changed = named('Safe');
  changed.kerf = '1/16';
  assert.throws(() => projects.save(a.id, changed), /Couldn’t save Safe: this browser’s storage is full/);
  assert.throws(() => projects.create(named('New')), /Save to file/);
  assert.equal(projects.writeProgress(a.id, { sig: '', done: [] }), false);

  kv.set = realSet;
  assert.equal(projects.read(a.id).kerf, '1/8');
  assert.deepEqual(projects.list().map((e) => e.name), ['Safe']);
});

test('a failed index write does not leave half a project behind', () => {
  const { projects, kv } = setup();
  const realSet = kv.set;
  kv.set = (key, value) => { if (key === INDEX_KEY) throw new Error('full'); realSet(key, value); };
  assert.throws(() => projects.create(named('Half')));
  kv.set = realSet;
  assert.deepEqual([...kv.map.keys()], []);
});

test('describes when a project was last edited in plain words', () => {
  const now = new Date(2026, 8, 13, 15, 0).getTime();
  assert.equal(editedLabel(new Date(2026, 8, 13, 0, 5).getTime(), now), 'Edited today');
  assert.equal(editedLabel(new Date(2026, 8, 12, 23, 59).getTime(), now), 'Edited yesterday');
  assert.equal(editedLabel(new Date(2026, 7, 12, 9, 0).getTime(), now), 'Edited 12 Aug');
  assert.equal(editedLabel(new Date(2025, 0, 3, 9, 0).getTime(), now), 'Edited 3 Jan 2025');
  assert.equal(editedLabel(now + 60_000, now), 'Edited today');
  assert.equal(editedLabel(null, now), 'Not saved yet');
});
