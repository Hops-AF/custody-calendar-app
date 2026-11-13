const test = require('node:test');
const assert = require('node:assert/strict');
const { deviationError, getActualChildDay, deviationsOnDate, describeDeviation, computeDeviationReport } = require('./deviation-log');
const { computeCustodySummary } = require('./custody-engine');
const { defaults, newDocument, changeDocument, createBackup, parseBackup } = require('./local-store');

const both = { Sam: true, Lee: true };
// Alex is primary. Jordan has every other weekend, Fri-Sun.
const plan = () => ({
  parents: ['Alex', 'Jordan'], children: ['Sam', 'Lee'],
  entries: [
    { id: 'w1', parent: 'Jordan', beginDate: '2026-09-04', endDate: '2026-09-06', childrenPresent: both, note: '' },
    { id: 'w2', parent: 'Jordan', beginDate: '2026-09-18', endDate: '2026-09-20', childrenPresent: both, note: '' },
  ],
});
const logged = (id, extra) => ({ id, type: 'missed', date: '2026-09-04', endDate: '2026-09-06', children: both, actualParent: 'Alex', note: '', loggedAt: `2026-09-07T12:00:0${id.length}.000Z`, ...extra });
const late = (id, extra) => ({ id, type: 'late', date: '2026-09-04', endDate: '2026-09-04', children: both, minutesLate: 40, lateParent: 'Jordan', note: '', loggedAt: '2026-09-04T23:00:00.000Z', ...extra });
const september = { start: '2026-09-01', end: '2026-09-30' };

test('with nothing logged, actual equals the plan and matches the custody report', () => {
  const report = computeDeviationReport({ ...plan(), deviations: [], ...september });
  assert.deepEqual(report.rows.map((r) => [r.parent, r.plannedDays, r.actualDays, r.difference]), [['Alex', 48, 48, 0], ['Jordan', 12, 12, 0]]);
  assert.equal(report.changedDays, 0);
  assert.deepEqual(report.items, []);
  const summary = computeCustodySummary({ ...plan(), ...september });
  assert.deepEqual(report.rows.map((r) => [r.parent, r.plannedDays, r.plannedPercentage]), summary.rows.map((r) => [r.parent, r.custodyDays, r.percentage]));
  assert.equal(report.totalUnits, summary.totalUnits);
});

test('a missed weekend moves those days to the parent who actually had the children', () => {
  const report = computeDeviationReport({ ...plan(), deviations: [logged('a')], ...september });
  assert.deepEqual(report.rows.map((r) => [r.parent, r.plannedDays, r.actualDays, r.difference]), [['Alex', 48, 54, 6], ['Jordan', 12, 6, -6]]);
  assert.deepEqual(report.rows.map((r) => [r.plannedPercentage, r.actualPercentage]), [[80, 90], [20, 10]]);
  assert.equal(report.changedDays, 6);
  assert.deepEqual(report.counts, { late: 0, missed: 1, swap: 0 });
  assert.deepEqual(report.items.map((i) => [i.deviation.id, i.changedDays, i.plannedParents]), [['a', 6, ['Jordan']]]);
});

test('a swap for one child changes only that child', () => {
  const swap = logged('s', { type: 'swap', date: '2026-09-09', endDate: '2026-09-10', children: { Sam: true, Lee: false }, actualParent: 'Jordan' });
  const context = { ...plan(), deviations: [swap] };
  assert.deepEqual(getActualChildDay('2026-09-09', context, 'Sam'), { conflict: false, planned: 'Alex', actual: 'Jordan', deviation: swap });
  assert.equal(getActualChildDay('2026-09-09', context, 'Lee').actual, 'Alex');
  assert.equal(computeDeviationReport({ ...context, ...september }).changedDays, 2);
  assert.equal(computeDeviationReport({ ...context, ...september, childFilter: 'Lee' }).items.length, 0);
  assert.deepEqual(computeDeviationReport({ ...context, ...september, childFilter: 'Sam' }).rows.map((r) => r.difference), [-2, 2]);
});

test('late exchanges are tallied without changing custody days', () => {
  const report = computeDeviationReport({ ...plan(), deviations: [late('l1'), late('l2', { date: '2026-09-18', endDate: '2026-09-18', minutesLate: 15 }), late('l3', { date: '2026-09-06', endDate: '2026-09-06', minutesLate: 10, lateParent: '' })], ...september });
  assert.equal(report.changedDays, 0);
  assert.deepEqual(report.rows.map((r) => r.difference), [0, 0]);
  assert.deepEqual(report.counts, { late: 3, missed: 0, swap: 0 });
  assert.equal(report.minutesLate, 65);
  assert.deepEqual(report.lateByParent, { Jordan: { count: 2, minutes: 55 } });
  assert.deepEqual(report.items.map((i) => i.deviation.id), ['l1', 'l3', 'l2']);
  assert.deepEqual(report.items[0].plannedParents, ['Jordan']);
});

test('only the part of a logged change inside the window is counted', () => {
  const long = logged('long', { date: '2026-08-30', endDate: '2026-09-05' });
  const report = computeDeviationReport({ ...plan(), deviations: [long], ...september });
  assert.equal(report.changedDays, 4); // Sep 4 and 5, two children
  assert.equal(computeDeviationReport({ ...plan(), deviations: [long], start: '2026-10-01', end: '2026-10-31' }).items.length, 0);
});

test('a later log entry corrects an earlier one for the same days', () => {
  const context = { ...plan(), deviations: [logged('a'), logged('bb', { date: '2026-09-06', endDate: '2026-09-06', actualParent: 'Jordan' })] };
  assert.equal(getActualChildDay('2026-09-05', context, 'Sam').actual, 'Alex');
  assert.equal(getActualChildDay('2026-09-06', context, 'Sam').actual, 'Jordan');
  const report = computeDeviationReport({ ...context, ...september });
  assert.equal(report.changedDays, 4);
  assert.deepEqual(report.items.map((i) => [i.deviation.id, i.changedDays]), [['a', 4], ['bb', 0]]);
});

test('a log entry that matches the plan changes nothing', () => {
  const report = computeDeviationReport({ ...plan(), deviations: [logged('same', { actualParent: 'Jordan' })], ...september });
  assert.equal(report.changedDays, 0);
  assert.equal(report.items[0].changedDays, 0);
});

test('conflicting plan days are left out of both columns', () => {
  const data = plan();
  data.entries.push({ id: 'clash', parent: 'Alex', beginDate: '2026-09-05', endDate: '2026-09-05', childrenPresent: both, note: '' });
  const report = computeDeviationReport({ ...data, deviations: [logged('a')], ...september });
  assert.equal(report.conflictDays, 2);
  assert.equal(report.totalUnits, 58);
  assert.equal(report.changedDays, 4);
  assert.equal(report.rows.reduce((sum, r) => sum + r.plannedDays, 0), report.rows.reduce((sum, r) => sum + r.actualDays, 0));
});

test('someone outside the household can be the actual caregiver', () => {
  const report = computeDeviationReport({ ...plan(), deviations: [logged('g', { actualParent: 'Grandma' })], ...september });
  assert.deepEqual(report.rows.map((r) => [r.parent, r.plannedDays, r.actualDays]), [['Alex', 48, 48], ['Jordan', 12, 6], ['Grandma', 0, 6]]);
});

test('an empty or reversed window yields an empty report', () => {
  assert.deepEqual(computeDeviationReport({ ...plan(), deviations: [logged('a')], start: '', end: '' }).rows, []);
  assert.deepEqual(computeDeviationReport({ ...plan(), deviations: [logged('a')], start: '2026-09-30', end: '2026-09-01' }).items, []);
});

test('entries for a date list every kind of logged change for that child', () => {
  const list = [logged('a'), late('l1'), logged('s', { children: { Sam: false, Lee: true }, date: '2026-09-05', endDate: '2026-09-05' })];
  assert.deepEqual(deviationsOnDate('2026-09-04', list, 'Sam').map((d) => d.id), ['a', 'l1']);
  assert.deepEqual(deviationsOnDate('2026-09-05', list, null).map((d) => d.id), ['a', 's']);
  assert.deepEqual(deviationsOnDate('2026-09-05', list, 'Sam').map((d) => d.id), ['a']);
  assert.equal(describeDeviation(late('l1')), 'Late exchange: 40 min (Jordan)');
  assert.equal(describeDeviation(logged('a')), 'Missed time: with Alex');
});

test('invalid log entries are rejected with a reason', () => {
  assert.equal(deviationError(logged('a')), '');
  assert.equal(deviationError(late('l')), '');
  assert.match(deviationError(logged('a', { type: 'argument' })), /what happened/);
  assert.match(deviationError(logged('a', { date: '2026-02-30' })), /date/);
  assert.match(deviationError(logged('a', { endDate: '2026-09-01' })), /last day/);
  assert.match(deviationError(logged('a', { actualParent: '' })), /actually with/);
  assert.match(deviationError(late('l', { minutesLate: 0 })), /minutes late/);
  assert.match(deviationError(late('l', { minutesLate: 12.5 })), /minutes late/);
  assert.match(deviationError(late('l', { endDate: '2026-09-05' })), /single day/);
  assert.match(deviationError(logged('a', { loggedAt: 'yesterday' })), /Invalid/);
  assert.match(deviationError(logged('a', { children: ['Sam'] })), /children/);
});

test('the log is saved, undone and backed up with the household', () => {
  const start = newDocument({ ...defaults(), ...plan() });
  const doc = changeDocument(start, { deviations: [logged('a', { note: 'Texted at 5:40 to cancel' }), late('l1')] }, { id: '1', now: new Date(2026, 8, 7) });
  assert.equal(doc.history[0].label, 'Changed the planned-vs-actual log');
  assert.deepEqual(doc.history[0].before.deviations, []);
  assert.deepEqual(parseBackup(createBackup(doc)).document, doc);
  assert.throws(() => changeDocument(doc, { deviations: [logged('a'), logged('a')] }), /unique/);
  assert.throws(() => changeDocument(doc, { deviations: [late('l', { minutesLate: 5000 })] }), /minutes late/);
});
