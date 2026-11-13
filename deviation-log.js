const { parseDate, enumerateDates, getChildDayState } = require('./custody-engine');

// Planned vs. actual. Entries and schedules describe the plan; this log records
// where reality differed. Days with nothing logged are treated as having gone
// to plan.
//
// Record shape:
//   { id, type, date, endDate, children: { name: true }, note, loggedAt,
//     minutesLate, lateParent,      // type 'late'
//     actualParent }                // type 'missed' or 'swap'
//
// 'late'   an exchange on `date` happened late. Custody days do not change.
// 'missed' scheduled time did not happen; the children were with actualParent.
// 'swap'   both parents agreed to a change; the children were with actualParent.

const TYPES = ['late', 'missed', 'swap'];
const TYPE_LABELS = { late: 'Late exchange', missed: 'Missed time', swap: 'Agreed swap' };
const MAX_DEVIATIONS = 2000;
const MAX_MINUTES_LATE = 1440;

function isName(value) { return typeof value === 'string' && value.trim() !== '' && value.length <= 100; }

// Returns '' for a valid record, otherwise a message suitable for the editor.
function deviationError(d) {
  if (d === null || typeof d !== 'object' || Array.isArray(d)) return 'Invalid log entry.';
  if (typeof d.id !== 'string' || !d.id || d.id.length > 200) return 'Invalid log entry.';
  if (!TYPES.includes(d.type)) return 'Choose what happened.';
  if (!parseDate(d.date) || !parseDate(d.endDate)) return 'Choose a date.';
  if (d.endDate < d.date) return 'The last day must be on or after the first day.';
  if (d.children === null || typeof d.children !== 'object' || Array.isArray(d.children) || !Object.values(d.children).every((v) => typeof v === 'boolean')) return 'Invalid children on a log entry.';
  if (typeof d.note !== 'string' || d.note.length > 10000) return 'The note is too long.';
  if (typeof d.loggedAt !== 'string' || !Number.isFinite(Date.parse(d.loggedAt))) return 'Invalid log entry.';
  if (d.type === 'late') {
    if (d.endDate !== d.date) return 'A late exchange is logged on a single day.';
    if (!Number.isInteger(d.minutesLate) || d.minutesLate < 1 || d.minutesLate > MAX_MINUTES_LATE) return 'Enter how many minutes late, from 1 to 1440.';
    if (d.lateParent !== undefined && d.lateParent !== '' && !isName(d.lateParent)) return 'Invalid parent on a log entry.';
  } else if (!isName(d.actualParent)) {
    return 'Choose who the children were actually with.';
  }
  return '';
}

function covers(deviation, dateStr, child) {
  if (dateStr < deviation.date || dateStr > deviation.endDate) return false;
  return !child || Boolean(deviation.children && deviation.children[child]);
}

// The log entry that decides who actually had this child on this date. When
// more than one applies, the most recently added wins, so a correction can be
// logged over an earlier entry.
function actualOverride(dateStr, child, deviations) {
  let found = null;
  for (const deviation of deviations || []) {
    if (deviation.type !== 'late' && covers(deviation, dateStr, child)) found = deviation;
  }
  return found;
}

// Planned and actual parent for one child on one date. Dates with no explicit
// entry are planned for the primary parent, matching reports.
function getActualChildDay(dateStr, { entries, parents, deviations }, child) {
  const state = getChildDayState(dateStr, entries, child);
  const conflict = state.type === 'conflict';
  const planned = state.type === 'single' ? state.parent : conflict ? null : ((parents && parents[0]) || null);
  const deviation = actualOverride(dateStr, child, deviations);
  return { conflict, planned, actual: deviation ? deviation.actualParent : planned, deviation };
}

function deviationsOnDate(dateStr, deviations, child) {
  return (deviations || []).filter((deviation) => covers(deviation, dateStr, child));
}

function childNames(deviation) {
  return Object.keys(deviation.children || {}).filter((child) => deviation.children[child]);
}

function describeDeviation(deviation) {
  if (deviation.type === 'late') {
    return `${TYPE_LABELS.late}: ${deviation.minutesLate} min` + (deviation.lateParent ? ` (${deviation.lateParent})` : '');
  }
  return `${TYPE_LABELS[deviation.type]}: with ${deviation.actualParent}`;
}

function percent(part, whole) {
  return whole ? Number(((part / whole) * 100).toFixed(1)) : 0;
}

// Compares the plan with what was logged over a reporting window. Counts
// child-days the same way computeCustodySummary does, and leaves conflicting
// plan days out of both columns.
function computeDeviationReport({ entries, parents, children, deviations, start, end, childFilter = 'all' }) {
  const empty = { rows: [], totalUnits: 0, conflictDays: 0, changedDays: 0, counts: { late: 0, missed: 0, swap: 0 }, minutesLate: 0, lateByParent: {}, items: [] };
  const dates = enumerateDates(start, end);
  if (dates.length === 0) return empty;

  const selectedChildren = childFilter === 'all' ? children : [childFilter];
  const context = { entries, parents, deviations };
  const planned = {};
  const actual = {};
  const perItem = {}; // deviation id -> { changedDays, plannedParents:Set }
  let totalUnits = 0;
  let conflictDays = 0;
  let changedDays = 0;

  for (const dateStr of dates) {
    for (const child of selectedChildren) {
      const day = getActualChildDay(dateStr, context, child);
      if (day.conflict) { conflictDays += 1; continue; }
      if (!day.planned) continue;
      planned[day.planned] = (planned[day.planned] || 0) + 1;
      actual[day.actual] = (actual[day.actual] || 0) + 1;
      totalUnits += 1;
      if (day.deviation) {
        const item = perItem[day.deviation.id] || (perItem[day.deviation.id] = { changedDays: 0, plannedParents: new Set() });
        item.plannedParents.add(day.planned);
        if (day.actual !== day.planned) { item.changedDays += 1; changedDays += 1; }
      }
    }
  }

  const inWindow = (deviations || []).filter((deviation) =>
    deviation.date <= end && deviation.endDate >= start &&
    (childFilter === 'all' || !Object.keys(deviation.children || {}).length || deviation.children[childFilter]));

  const counts = { late: 0, missed: 0, swap: 0 };
  const lateByParent = {};
  let minutesLate = 0;
  const items = inWindow.map((deviation) => {
    counts[deviation.type] += 1;
    if (deviation.type === 'late') {
      minutesLate += deviation.minutesLate;
      if (deviation.lateParent) {
        const tally = lateByParent[deviation.lateParent] || (lateByParent[deviation.lateParent] = { count: 0, minutes: 0 });
        tally.count += 1;
        tally.minutes += deviation.minutesLate;
      }
      const receiving = new Set();
      const names = childNames(deviation).filter((child) => selectedChildren.includes(child));
      for (const child of (names.length ? names : selectedChildren)) {
        const day = getActualChildDay(deviation.date, context, child);
        if (day.planned) receiving.add(day.planned);
      }
      return { deviation, changedDays: 0, plannedParents: [...receiving] };
    }
    const tally = perItem[deviation.id];
    return { deviation, changedDays: tally ? tally.changedDays : 0, plannedParents: tally ? [...tally.plannedParents] : [] };
  }).sort((a, b) => a.deviation.date.localeCompare(b.deviation.date) || a.deviation.loggedAt.localeCompare(b.deviation.loggedAt));

  const names = [...parents, ...Object.keys({ ...planned, ...actual }).filter((parent) => !parents.includes(parent))];
  const rows = names.filter((parent) => planned[parent] || actual[parent]).map((parent) => ({
    parent,
    plannedDays: planned[parent] || 0,
    actualDays: actual[parent] || 0,
    difference: (actual[parent] || 0) - (planned[parent] || 0),
    plannedPercentage: percent(planned[parent] || 0, totalUnits),
    actualPercentage: percent(actual[parent] || 0, totalUnits),
  }));

  return { rows, totalUnits, conflictDays, changedDays, counts, minutesLate, lateByParent, items };
}

module.exports = {
  TYPES, TYPE_LABELS, MAX_DEVIATIONS, MAX_MINUTES_LATE,
  deviationError, actualOverride, getActualChildDay, deviationsOnDate,
  childNames, describeDeviation, computeDeviationReport,
};
