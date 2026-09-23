const { defaults, normalizeData } = require('./local-store');

const ENTRY_KEYS = ['id', 'parent', 'beginDate', 'endDate', 'childrenPresent', 'isException', 'exchangeTime', 'exchangePlace'];
function publicEntry(entry) {
  return Object.fromEntries(ENTRY_KEYS.filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]]));
}

// Explicit allowlists keep private notes, contact details, history, and future fields local.
function sharedPlan(data) {
  const clean = normalizeData(data);
  if (clean.parents.length !== 2 || !clean.children.length) throw new Error('Add exactly two parents and at least one child before sharing.');
  if (clean.entries.some((e) => !clean.parents.includes(e.parent) || !e.beginDate || !e.endDate || e.endDate < e.beginDate || !clean.children.some((c) => e.childrenPresent[c]))) {
    throw new Error('Finish or remove incomplete custody periods before sharing.');
  }
  return {
    parents: clean.parents, children: clean.children,
    parentColors: Object.fromEntries(clean.parents.filter((p) => clean.parentColors[p]).map((p) => [p, clean.parentColors[p]])),
    childColors: Object.fromEntries(clean.children.filter((c) => clean.childColors[c]).map((c) => [c, clean.childColors[c]])),
    entries: clean.entries.map((e) => ({ ...publicEntry(e), childrenPresent: Object.fromEntries(clean.children.map((c) => [c, Boolean(e.childrenPresent[c])])) })),
  };
}

function displayPlan(plan) { return { ...defaults(), ...plan }; }
function requestSummary(request) {
  if (request.kind === 'initial') return 'Starting schedule';
  const entry = request.after_entry || request.before_entry;
  return `${request.kind === 'delete' ? 'Remove' : request.before_entry ? 'Change' : 'Add'}: ${entry.parent}, ${entry.beginDate} to ${entry.endDate}`;
}
function sharedError(error) {
  const message = error?.message || '';
  if (/fetch|network|timeout/i.test(message)) return 'Could not reach the shared workspace. Nothing is confirmed until the server responds. Refresh before retrying.';
  if (/JWT|refresh token|session/i.test(message)) return 'Your sign-in has expired. Sign in again.';
  return message.length > 0 && message.length < 250 ? message : 'The shared workspace could not complete this action. Refresh and try again.';
}

module.exports = { publicEntry, sharedPlan, displayPlan, requestSummary, sharedError };
