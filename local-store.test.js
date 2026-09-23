const test = require('node:test');
const assert = require('node:assert/strict');
const { defaults, newDocument, readDocument, changeDocument, restoreHistory, replacementDocument, createBackup, parseBackup, createRepository, storageFailureMessage, STORAGE_KEY, RECOVERY_KEY } = require('./local-store');

const family = () => ({ ...defaults(), parents: ['Alex', 'Jordan'], children: ['Sam'],
  entries: [{ id: 'one', parent: 'Jordan', beginDate: '2026-09-11', endDate: '2026-09-13', childrenPresent: { Sam: true }, note: 'Private note', exchangeTime: '6:00 PM' }],
  parentColors: { Alex: '#2563eb' }, parentLocations: { Jordan: 'School road' }, parentPhones: { Jordan: '555-0100' },
});
const stamp = (id) => ({ id: String(id), now: new Date(2026, 8, 1, 12, 0, id * 5) });
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { map, calls: [], failKey: null,
    async getItem(key) { return map.get(key) ?? null; },
    async setItem(key, value) { this.calls.push(key); if (this.failKey === key) throw new Error('Disk full'); map.set(key, value); },
  };
}

test('native storage errors cannot fill the screen with file paths', () => {
  const nativeError = new Error('Failed to write /private/household '.repeat(200));
  const save = storageFailureMessage(nativeError);
  assert.ok(save.length < 160);
  assert.doesNotMatch(save, /\/private/);
  assert.match(save, /retry.*backup/);
  assert.ok(storageFailureMessage(nativeError, 'load').length < 160);
  assert.equal(storageFailureMessage(new Error('The saved household is incomplete.'), 'load'), 'The saved household is incomplete.');
  assert.ok(storageFailureMessage(null, 'load'));
});

test('legacy data migrates without changing household contents', () => {
  const old = family(); delete old.reminderSettings; old.viewMode = 'list';
  const doc = readDocument(JSON.stringify(old));
  assert.deepEqual(doc.data.entries, old.entries);
  assert.equal(doc.data.viewMode, 'entries');
  assert.equal(doc.data.reminderSettings.enabled, false);
  assert.equal(doc.history.length, 0);
});
test('complete backups round-trip private notes, settings, schedules and history', () => {
  const data = { ...family(), childColors: { Sam: '#dc2626' },
    scheduleAssignments: [{ id: 'schedule', preset: 'eow', start: '2026-09-01', end: '2026-12-31', children: ['Sam'], secondary: 'Jordan', eowDay: 'fri' }],
    reminderSettings: { enabled: true, leadMinutes: 15, showDetails: true }, reportingMode: 'quarter', quarterYear: 2026, quarter: 'Q3', analysisChild: 'Sam',
  };
  const doc = changeDocument(newDocument(data), { parentPhones: { Jordan: '555-0200' } }, stamp(1));
  const restored = parseBackup(createBackup(doc)).document;
  assert.deepEqual(restored, doc);
  assert.equal(restored.data.entries[0].note, 'Private note');
});
test('restore previews reject nonbackups, unsupported versions and incomplete data', () => {
  for (const raw of ['bad json', '[]', JSON.stringify({ parents: [] }), 'x'.repeat(4000001)]) assert.throws(() => parseBackup(raw));
  const backup = JSON.parse(createBackup(newDocument(family())));
  backup.version = 8; assert.throws(() => parseBackup(JSON.stringify(backup)), /newer/);
  backup.version = 1; delete backup.document.data.entries;
  assert.throws(() => parseBackup(JSON.stringify(backup)), /incomplete/);
});
test('invalid and duplicate IDs and bad types cannot replace valid household data', () => {
  const good = newDocument(family());
  for (const patch of [{ parents: ['Alex', 'Alex'] }, { children: '__proto__' }, { entries: [...good.data.entries, ...good.data.entries] },
    { reminderSettings: { enabled: 'yes' } }, { entries: [{ ...good.data.entries[0], beginDate: '2026-02-30' }] }]) {
    assert.throws(() => changeDocument(good, patch));
    assert.equal(good.data.entries.length, 1);
  }
});
test('incomplete or ambiguous history and wrapped legacy backups are rejected', () => {
  const doc = changeDocument(newDocument(family()), { entries: [] }, stamp(1));
  const incomplete = JSON.parse(createBackup(doc));
  delete incomplete.document.history[0].before.parents;
  assert.throws(() => parseBackup(JSON.stringify(incomplete)), /incomplete/);
  const duplicate = JSON.parse(createBackup(doc));
  duplicate.document.history.push(duplicate.document.history[0]);
  assert.throws(() => parseBackup(JSON.stringify(duplicate)), /history/);
  const legacy = JSON.parse(createBackup(doc));
  legacy.document = family();
  assert.throws(() => parseBackup(JSON.stringify(legacy)), /versioned/);
});
test('oversized changes cannot silently discard the required undo snapshot', () => {
  const data = family();
  data.entries = Array.from({ length: 94 }, (_, i) => ({ ...data.entries[0], id: String(i), note: 'x'.repeat(9900) }));
  const doc = newDocument(data);
  assert.throws(() => changeDocument(doc, { parentPhones: {} }, stamp(1)), /retain undo/);
  assert.equal(doc.data.parentPhones.Jordan, '555-0100');
});
test('failed restore leaves the current durable household recoverable', async () => {
  const current = newDocument(family());
  const raw = JSON.stringify(current);
  const storage = fakeStorage({ [STORAGE_KEY]: raw });
  const repo = createRepository(storage); await repo.load();
  const incoming = newDocument({ ...family(), parents: ['Other'] });
  const restored = replacementDocument(current, incoming, 'Restored backup', true);
  storage.failKey = STORAGE_KEY;
  await assert.rejects(repo.save(restored), /Disk full/);
  assert.deepEqual((await repo.load()).data, current.data);
  assert.deepEqual((await repo.recovery()).data, current.data);
});
test('one transaction undoes all related fields together and supports redo via history', () => {
  const initial = newDocument(family());
  const cleared = changeDocument(initial, { entries: [], scheduleAssignments: [], parents: [] }, { ...stamp(1), label: 'Reset household' });
  assert.equal(cleared.history.length, 1);
  const undone = restoreHistory(cleared, cleared.history[0].id, stamp(2));
  assert.deepEqual(undone.data, initial.data);
  const redone = restoreHistory(undone, undone.history[0].id, stamp(3));
  assert.deepEqual(redone.data.entries, []);
});
test('navigation and reporting preferences do not crowd undo history', () => {
  const next = changeDocument(newDocument(family()), { viewMode: 'settings', reportingMode: 'preset' }, stamp(1));
  assert.equal(next.history.length, 0);
});
test('typing coalesces into one undo point but discrete changes do not', () => {
  let doc = newDocument(family());
  doc = changeDocument(doc, { parentPhones: { Jordan: '1' } }, { group: 'phone', id: 'a', now: new Date('2026-09-01T12:00:00Z') });
  doc = changeDocument(doc, { parentPhones: { Jordan: '12' } }, { group: 'phone', id: 'b', now: new Date('2026-09-01T12:00:01Z') });
  assert.equal(doc.history.length, 1);
  assert.equal(doc.history[0].before.parentPhones.Jordan, '555-0100');
  doc = changeDocument(doc, { entries: [] }, stamp(3));
  assert.equal(doc.history.length, 2);
});
test('history is bounded and external restore keeps imported snapshots plus current recovery', () => {
  let source = newDocument(family());
  for (let i = 0; i < 25; i++) source = changeDocument(source, { parentPhones: { Jordan: String(i) } }, stamp(i));
  assert.equal(source.history.length, 20);
  const target = newDocument({ ...family(), children: ['Other'] });
  const imported = replacementDocument(target, source, 'Restored backup', true);
  assert.deepEqual(imported.data, source.data);
  assert.deepEqual(imported.history[0].before.children, ['Other']);
  assert.equal(imported.history[1].id, source.history[0].id);
});
test('save failures preserve the primary document and remain retryable', async () => {
  const original = JSON.stringify(family());
  const storage = fakeStorage({ [STORAGE_KEY]: original });
  const repo = createRepository(storage);
  const doc = await repo.load();
  const next = changeDocument(doc, { entries: [] }, stamp(1));
  storage.failKey = STORAGE_KEY;
  await assert.rejects(repo.save(next), /Disk full/);
  assert.equal(storage.map.get(STORAGE_KEY), original);
  assert.equal(storage.map.get(RECOVERY_KEY), original);
  storage.failKey = null; await repo.save(next);
  assert.equal(readDocument(storage.map.get(STORAGE_KEY)).data.entries.length, 0);
});
test('recovery-copy failure aborts the main save', async () => {
  const raw = JSON.stringify(family()), storage = fakeStorage({ [STORAGE_KEY]: raw });
  const repo = createRepository(storage); await repo.load();
  storage.failKey = RECOVERY_KEY;
  await assert.rejects(repo.save(newDocument()), /Disk full/);
  assert.equal(storage.map.get(STORAGE_KEY), raw);
});
test('corrupt or missing primary data never becomes a fresh install when recovery exists', async () => {
  for (const broken of ['{bad', null]) {
    const storage = fakeStorage({ [RECOVERY_KEY]: JSON.stringify(newDocument(family())) });
    if (broken) storage.map.set(STORAGE_KEY, broken);
    const repo = createRepository(storage);
    await assert.rejects(repo.load());
    assert.equal(storage.calls.length, 0);
    const recovery = await repo.recovery(); await repo.save(recovery);
    assert.deepEqual((await repo.load()).data, family());
  }
});
test('serialized writes finish in order, including after a rejected write', async () => {
  const storage = fakeStorage(), repo = createRepository(storage); await repo.load();
  const a = newDocument(family()), b = changeDocument(a, { entries: [] }, stamp(1));
  await Promise.all([repo.save(a), repo.save(b)]);
  assert.equal(readDocument(storage.map.get(STORAGE_KEY)).data.entries.length, 0);
  assert.equal(readDocument(storage.map.get(RECOVERY_KEY)).data.entries.length, 1);
});
