const { parseDate } = require('./custody-engine');

const STORAGE_KEY = '@custody_calendar_data';
const RECOVERY_KEY = '@custody_calendar_recovery';
const BACKUP_FORMAT = 'custody-calendar-backup';
const MAX_BACKUP_BYTES = 4000000;
const MAX_DOCUMENT_BYTES = 1800000;
const HISTORY_LIMIT = 20;
const FAMILY_KEYS = ['parents', 'children', 'parentColors', 'childColors', 'parentLocations', 'parentPhones', 'entries', 'scheduleAssignments', 'reminderSettings'];

function defaults() {
  return {
    parents: [], children: [], parentColors: {}, childColors: {}, parentLocations: {}, parentPhones: {},
    entries: [], scheduleAssignments: [], reportingMode: 'custom', customStart: '', customEnd: '',
    quarterYear: new Date().getFullYear(), quarter: 'Q1', preset: 'year-to-date', analysisChild: 'all', viewMode: 'calendar',
    reminderSettings: { enabled: false, leadMinutes: 60, showDetails: false },
  };
}

function insist(ok, message) { if (!ok) throw new Error(message); }
function storageFailureMessage(error, operation = 'save') {
  if (operation === 'load') {
    return typeof error?.message === 'string' && error.message.length <= 240
      ? error.message : 'Your saved household could not be read. Retry loading or use a recovery copy.';
  }
  return 'Could not save on this device. Check available storage, then retry or export a complete backup.';
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function string(value, max = 10000) { return typeof value === 'string' && value.length <= max; }
function names(value) { return Array.isArray(value) && value.length <= 100 && value.every((v) => string(v, 100) && v.trim() && !['__proto__', 'constructor', 'prototype'].includes(v)) && new Set(value).size === value.length; }
function date(value) { return value === '' || (typeof value === 'string' && Boolean(parseDate(value))); }
function bytes(value) { return encodeURIComponent(typeof value === 'string' ? value : JSON.stringify(value)).replace(/%[A-F\d]{2}/g, 'x').length; }

function normalizeData(input) {
  insist(object(input), 'The household data is not an object.');
  const d = { ...defaults(), ...input };
  insist(names(d.parents) && names(d.children), 'Parent and child names must be unique, non-empty names.');
  for (const key of ['parentColors', 'childColors', 'parentLocations', 'parentPhones']) {
    insist(object(d[key]) && Object.values(d[key]).every((v) => string(v)), `Invalid ${key}.`);
    if (key.endsWith('Colors')) insist(Object.values(d[key]).every((v) => /^#[a-f\d]{6}$/i.test(v)), 'Invalid household color.');
  }
  insist(Array.isArray(d.entries) && d.entries.length <= 5000, 'Invalid or oversized entry list.');
  const ids = new Set();
  d.entries.forEach((entry) => {
    insist(object(entry) && string(entry.id, 200) && entry.id && !ids.has(entry.id), 'Entries must have unique IDs.');
    ids.add(entry.id);
    insist(string(entry.parent, 100) && date(entry.beginDate) && date(entry.endDate), 'An entry has invalid names or dates.');
    insist(object(entry.childrenPresent) && Object.values(entry.childrenPresent).every((v) => typeof v === 'boolean'), 'Invalid children on an entry.');
    for (const key of ['note', 'location', 'exchangeTime', 'exchangePlace', 'scheduleId']) insist(entry[key] === undefined || string(entry[key]), `Invalid entry ${key}.`);
    insist(entry.isException === undefined || typeof entry.isException === 'boolean', 'Invalid holiday flag.');
  });
  insist(Array.isArray(d.scheduleAssignments) && d.scheduleAssignments.length <= 500, 'Invalid schedule list.');
  const scheduleIds = new Set();
  d.scheduleAssignments.forEach((s) => {
    insist(object(s) && string(s.id, 200) && s.id && !scheduleIds.has(s.id), 'Schedules must have unique IDs.');
    scheduleIds.add(s.id);
    insist(['eow', 'eow-midweek', 'joint-weekly', '2-2-3'].includes(s.preset) && date(s.start) && date(s.end) && names(s.children), 'Invalid recurring schedule.');
    insist(s.eowDay === undefined || ['fri', 'sat'].includes(s.eowDay), 'Invalid weekend start.');
    insist(s.midweek === undefined || (Number.isInteger(s.midweek) && s.midweek >= 0 && s.midweek <= 6), 'Invalid midweek day.');
    for (const key of ['secondary', 'p1', 'p2']) insist(s[key] === undefined || string(s[key], 100), 'Invalid schedule parent.');
  });
  insist(['custom', 'quarter', 'preset'].includes(d.reportingMode) && date(d.customStart) && date(d.customEnd), 'Invalid reporting settings.');
  insist(Number.isInteger(d.quarterYear) && d.quarterYear >= 100 && d.quarterYear <= 9999 && ['Q1', 'Q2', 'Q3', 'Q4'].includes(d.quarter), 'Invalid reporting quarter.');
  insist(['year-to-date', 'last-12-months', 'calendar-year'].includes(d.preset) && string(d.analysisChild, 100), 'Invalid reporting selection.');
  if (d.viewMode === 'list') d.viewMode = 'entries';
  insist(['calendar', 'kid', 'entries', 'reports', 'settings'].includes(d.viewMode), 'Invalid saved screen.');
  insist(object(d.reminderSettings) && typeof d.reminderSettings.enabled === 'boolean' && typeof d.reminderSettings.showDetails === 'boolean' && [15, 60, 1440].includes(d.reminderSettings.leadMinutes), 'Invalid reminder settings.');
  // Keep only the current schema's top-level fields; entry details round-trip intact.
  const result = Object.fromEntries(Object.keys(defaults()).map((key) => [key, d[key]]));
  insist(bytes(result) <= 1000000, 'Household data exceeds the 1 MB safety limit.');
  return JSON.parse(JSON.stringify(result));
}

function snapshot(data) { return Object.fromEntries(FAMILY_KEYS.map((key) => [key, data[key]])); }
function newDocument(data = defaults()) { return { schemaVersion: 1, data: normalizeData(data), history: [], updatedAt: null }; }

function readDocument(raw) {
  if (raw === null) return newDocument();
  insist(typeof raw === 'string' && bytes(raw) <= MAX_BACKUP_BYTES, 'Stored data is too large or unreadable.');
  const input = JSON.parse(raw);
  if (input?.schemaVersion === undefined) {
    insist(object(input) && Array.isArray(input.parents) && Array.isArray(input.children) && Array.isArray(input.entries), 'Unrecognized legacy household data.');
    return newDocument(input);
  }
  insist(input.schemaVersion === 1, 'This data requires a newer app version.');
  insist(object(input.data) && Object.keys(defaults()).every((key) => Object.hasOwn(input.data, key)), 'The saved household is incomplete.');
  insist(Array.isArray(input.history) && input.history.length <= HISTORY_LIMIT, 'Invalid change history.');
  const data = normalizeData(input.data);
  const historyIds = new Set();
  const history = input.history.map((h) => {
    insist(object(h) && string(h.id, 200) && h.id && !historyIds.has(h.id) && string(h.label, 200) && typeof h.at === 'string' && Number.isFinite(Date.parse(h.at)), 'Invalid history record.');
    historyIds.add(h.id);
    insist(object(h.before) && FAMILY_KEYS.every((key) => Object.hasOwn(h.before, key)), 'A history snapshot is incomplete.');
    return { id: h.id, label: h.label, at: h.at, group: string(h.group, 300) ? h.group : null, before: snapshot(normalizeData(h.before)) };
  });
  insist(input.updatedAt === null || Number.isFinite(Date.parse(input.updatedAt)), 'Invalid save date.');
  return { schemaVersion: 1, data, history, updatedAt: input.updatedAt };
}

function describeChange(before, after) {
  if (JSON.stringify(before.parents) !== JSON.stringify(after.parents)) return 'Changed parents or primary parent';
  if (JSON.stringify(before.children) !== JSON.stringify(after.children)) return 'Changed children';
  if (JSON.stringify(before.entries) !== JSON.stringify(after.entries)) {
    if (after.entries.length > before.entries.length) return `Added ${after.entries.length - before.entries.length} custody period(s)`;
    if (after.entries.length < before.entries.length) return `Removed ${before.entries.length - after.entries.length} custody period(s)`;
    return 'Edited custody details';
  }
  if (JSON.stringify(before.reminderSettings) !== JSON.stringify(after.reminderSettings)) return 'Changed reminder preferences';
  return 'Updated household details';
}

function changeDocument(doc, patch, { label, group = null, now = new Date(), id = String(now.getTime()) } = {}) {
  const data = normalizeData({ ...doc.data, ...(typeof patch === 'function' ? patch(doc.data) : patch) });
  if (JSON.stringify(data) === JSON.stringify(doc.data)) return doc;
  const changed = JSON.stringify(snapshot(data)) !== JSON.stringify(snapshot(doc.data));
  let history = [...doc.history];
  if (changed) {
    const last = history[0];
    const merged = group && last?.group === group && now.getTime() - Date.parse(last.at) < 2000;
    const item = { id, at: now.toISOString(), label: label || describeChange(doc.data, data), group, before: merged ? last.before : snapshot(doc.data) };
    history = [item, ...(merged ? history.slice(1) : history)].slice(0, HISTORY_LIMIT);
  }
  const result = { schemaVersion: 1, data, history, updatedAt: now.toISOString() };
  while (history.length && bytes(result) > MAX_DOCUMENT_BYTES) history.pop();
  insist(!changed || history.length > 0, 'Not enough space to retain undo for this change. Save a backup and reduce the household size first.');
  return result;
}

function restoreHistory(doc, id, options) {
  const record = doc.history.find((h) => h.id === id);
  insist(record, 'This history snapshot is no longer available.');
  return changeDocument(doc, record.before, { ...options, label: `Restored before: ${record.label}`.slice(0, 200) });
}

function createBackup(doc, now = new Date()) {
  return JSON.stringify({ format: BACKUP_FORMAT, version: 1, exportedAt: now.toISOString(), document: doc });
}

function replacementDocument(current, incoming, label, importHistory = false, now = new Date()) {
  const restored = changeDocument(current, incoming.data, { label, id: `${now.getTime()}-restore`, now });
  if (!importHistory) return restored;
  const record = { id: `${now.getTime()}-import`, at: now.toISOString(), label, group: null, before: snapshot(current.data) };
  const history = [record, ...incoming.history].slice(0, HISTORY_LIMIT);
  const result = { ...restored, updatedAt: now.toISOString(), history };
  while (history.length && bytes(result) > MAX_DOCUMENT_BYTES) history.pop();
  insist(history.length > 0, 'Not enough space to preserve the current household before restoring.');
  return result;
}

function parseBackup(raw) {
  insist(typeof raw === 'string' && bytes(raw) <= MAX_BACKUP_BYTES, 'Choose a backup smaller than 4 MB.');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('This file is not valid JSON. Choose a Custody Calendar backup.'); }
  insist(value?.format === BACKUP_FORMAT, 'This is not a complete Custody Calendar backup. CSV and calendar files cannot be restored.');
  insist(value.version === 1, 'This backup requires a newer app version.');
  insist(Number.isFinite(Date.parse(value.exportedAt)), 'The backup date is invalid.');
  insist(value.document?.schemaVersion === 1, 'The backup does not contain a complete versioned household.');
  const document = readDocument(JSON.stringify(value.document));
  return { document, exportedAt: value.exportedAt };
}

function createRepository(storage) {
  let queue = Promise.resolve();
  let lastRaw = null;
  function serialize(task) {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  }
  return {
    load: () => serialize(async () => {
      const raw = await storage.getItem(STORAGE_KEY);
      if (raw === null && await storage.getItem(RECOVERY_KEY) !== null) throw new Error('The main save is missing. A recovery copy may be available.');
      const document = readDocument(raw);
      lastRaw = raw;
      return document;
    }),
    recovery: async () => {
      const raw = await storage.getItem(RECOVERY_KEY);
      insist(raw !== null, 'No recovery copy is available.');
      return readDocument(raw);
    },
    save: (document) => serialize(async () => {
      const raw = JSON.stringify(document);
      insist(bytes(raw) <= MAX_DOCUMENT_BYTES, 'The saved document exceeds its safety limit.');
      if (raw === lastRaw) return;
      // Never replace a good recovery copy with corrupt or unwritten state.
      if (lastRaw !== null) await storage.setItem(RECOVERY_KEY, lastRaw);
      await storage.setItem(STORAGE_KEY, raw);
      lastRaw = raw;
    }),
  };
}

module.exports = { STORAGE_KEY, RECOVERY_KEY, HISTORY_LIMIT, MAX_BACKUP_BYTES, defaults, normalizeData, newDocument, readDocument, snapshot, changeDocument, restoreHistory, createBackup, parseBackup, replacementDocument, createRepository, storageFailureMessage };
