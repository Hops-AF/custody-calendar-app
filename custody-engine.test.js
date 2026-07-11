const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeCustodySummary,
  enumerateDates,
  getCalendarDayState,
} = require('./custody-engine');

function entry(parent, beginDate, endDate, children) {
  return {
    parent,
    beginDate,
    endDate,
    childrenPresent: Object.fromEntries(children.map((child) => [child, true])),
  };
}

test('enumerates inclusive local dates across month boundaries', () => {
  assert.deepEqual(enumerateDates('2026-01-31', '2026-02-02'), [
    '2026-01-31', '2026-02-01', '2026-02-02',
  ]);
});

test('distinguishes a split sibling schedule from a conflict', () => {
  const entries = [
    entry('Mom', '2026-06-10', '2026-06-10', ['Sam']),
    entry('Dad', '2026-06-10', '2026-06-10', ['Alex']),
  ];
  const state = getCalendarDayState('2026-06-10', entries, ['Sam', 'Alex'], null);
  assert.equal(state.type, 'split');
});

test('detects a conflict only when the same child has two parents', () => {
  const entries = [
    entry('Mom', '2026-06-10', '2026-06-10', ['Sam']),
    entry('Dad', '2026-06-10', '2026-06-10', ['Sam']),
  ];
  const state = getCalendarDayState('2026-06-10', entries, ['Sam'], 'Sam');
  assert.equal(state.type, 'conflict');
});

test('counts a one-day midweek assignment as one custody unit', () => {
  const result = computeCustodySummary({
    entries: [entry('Dad', '2026-06-03', '2026-06-03', ['Sam'])],
    parents: ['Mom', 'Dad'],
    children: ['Sam'],
    start: '2026-06-01',
    end: '2026-06-07',
    childFilter: 'Sam',
  });
  assert.deepEqual(result.rows, [
    { parent: 'Mom', custodyDays: 6, percentage: 85.7 },
    { parent: 'Dad', custodyDays: 1, percentage: 14.3 },
  ]);
});

test('a 2-2-3 cycle totals 50/50 over fourteen days', () => {
  const entries = [
    entry('Mom', '2026-06-01', '2026-06-02', ['Sam']),
    entry('Dad', '2026-06-03', '2026-06-04', ['Sam']),
    entry('Mom', '2026-06-05', '2026-06-07', ['Sam']),
    entry('Dad', '2026-06-08', '2026-06-09', ['Sam']),
    entry('Mom', '2026-06-10', '2026-06-11', ['Sam']),
    entry('Dad', '2026-06-12', '2026-06-14', ['Sam']),
  ];
  const result = computeCustodySummary({
    entries,
    parents: ['Mom', 'Dad'],
    children: ['Sam'],
    start: '2026-06-01',
    end: '2026-06-14',
    childFilter: 'Sam',
  });
  assert.deepEqual(result.rows, [
    { parent: 'Mom', custodyDays: 7, percentage: 50 },
    { parent: 'Dad', custodyDays: 7, percentage: 50 },
  ]);
});

test('excludes conflicting child-days and reports them', () => {
  const entries = [
    entry('Mom', '2026-06-01', '2026-06-01', ['Sam']),
    entry('Dad', '2026-06-01', '2026-06-01', ['Sam']),
  ];
  const result = computeCustodySummary({
    entries,
    parents: ['Mom', 'Dad'],
    children: ['Sam'],
    start: '2026-06-01',
    end: '2026-06-01',
    childFilter: 'Sam',
  });
  assert.equal(result.conflictDays, 1);
  assert.equal(result.totalUnits, 0);
});
