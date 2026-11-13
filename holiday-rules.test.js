const test = require('node:test');
const assert = require('node:assert/strict');
const {
  HOLIDAYS, nthWeekday, easterSunday, holidayDate, holidayRange, holidayRuleError,
  expandHolidayRule, applyHolidayRule, removeHolidayRule, newHolidayRule, holidayRuleOverlaps,
} = require('./holiday-rules');
const { getChildDayState, computeCustodySummary } = require('./custody-engine');
const { defaults, newDocument, changeDocument, readDocument, createBackup, parseBackup, SCHEMA_VERSION } = require('./local-store');

const household = () => ({ ...defaults(), parents: ['Alex', 'Jordan'], children: ['Sam', 'Lee'], entries: [] });
const rule = (holiday, extra = {}) => ({
  ...newHolidayRule({ id: 'r-' + holiday, holiday, parents: ['Alex', 'Jordan'], children: ['Sam', 'Lee'], year: 2026 }),
  ...extra,
});

test('floating holidays land on the right dates', () => {
  const on = (holiday, year) => holidayDate({ holiday }, year);
  assert.equal(on('thanksgiving', 2026), '2026-11-26');
  assert.equal(on('thanksgiving', 2027), '2027-11-25');
  assert.equal(on('thanksgiving', 2023), '2023-11-23'); // November starting on a Wednesday
  assert.equal(on('memorial-day', 2026), '2026-05-25');
  assert.equal(on('memorial-day', 2027), '2027-05-31'); // last Monday is the 31st
  assert.equal(on('labor-day', 2026), '2026-09-07');
  assert.equal(on('labor-day', 2025), '2025-09-01'); // month starts on the weekday
  assert.equal(on('mothers-day', 2026), '2026-05-10');
  assert.equal(on('fathers-day', 2026), '2026-06-21');
  assert.equal(on('mlk-day', 2027), '2027-01-18');
  assert.equal(on('presidents-day', 2027), '2027-02-15');
  assert.equal(on('christmas-day', 2030), '2030-12-25');
  assert.equal(on('not-a-holiday', 2026), null);
});

test('Easter matches published dates', () => {
  assert.equal(easterSunday(2024), '2024-03-31');
  assert.equal(easterSunday(2025), '2025-04-20');
  assert.equal(easterSunday(2026), '2026-04-05');
  assert.equal(easterSunday(2027), '2027-03-28');
  assert.equal(easterSunday(2038), '2038-04-25'); // latest possible date
});

test('a fifth weekday that does not exist returns null instead of rolling over', () => {
  assert.equal(nthWeekday(2026, 2, 1, 5), null);
  assert.equal(nthWeekday(2026, 3, 1, 5), '2026-03-30');
});

test('every catalog holiday resolves to a valid date in every year', () => {
  for (const holiday of HOLIDAYS) {
    for (let year = 2020; year <= 2045; year += 1) {
      assert.match(holidayDate({ holiday: holiday.key }, year), new RegExp(`^${year}-\\d\\d-\\d\\d$`), `${holiday.key} ${year}`);
    }
  }
});

test('the period extends before and after the holiday, across a year boundary', () => {
  assert.deepEqual(holidayRange(rule('thanksgiving', { daysBefore: 1, daysAfter: 3 }), 2026),
    { date: '2026-11-26', start: '2026-11-25', end: '2026-11-29' });
  assert.deepEqual(holidayRange(rule('new-years-eve', { daysAfter: 1 }), 2026),
    { date: '2026-12-31', start: '2026-12-31', end: '2027-01-01' });
});

test('even and odd years alternate between parents by the holiday year', () => {
  const entries = expandHolidayRule(rule('thanksgiving', { evenParent: 'Alex', oddParent: 'Jordan', fromYear: 2026, toYear: 2029 }), ['Sam', 'Lee']);
  assert.deepEqual(entries.map((e) => [e.beginDate.slice(0, 4), e.parent]), [['2026', 'Alex'], ['2027', 'Jordan'], ['2028', 'Alex'], ['2029', 'Jordan']]);
  assert.ok(entries.every((e) => e.isException && e.holidayRuleId === 'r-thanksgiving' && e.note === 'Thanksgiving'));
  assert.deepEqual(entries[0].childrenPresent, { Sam: true, Lee: true });
});

test('the same parent every year, and one child only', () => {
  const entries = expandHolidayRule(rule('mothers-day', { evenParent: 'Jordan', oddParent: 'Jordan', children: ['Lee'], toYear: 2028 }), ['Sam', 'Lee']);
  assert.deepEqual([...new Set(entries.map((e) => e.parent))], ['Jordan']);
  assert.deepEqual(entries[0].childrenPresent, { Sam: false, Lee: true });
});

test('a custom February 29 date is skipped in non-leap years', () => {
  const leap = rule('custom', { name: 'Leap birthday', month: 2, day: 29, fromYear: 2026, toYear: 2032 });
  assert.equal(holidayRuleError(leap), '');
  assert.deepEqual(expandHolidayRule(leap, ['Sam']).map((e) => e.beginDate), ['2028-02-29', '2032-02-29']);
});

test('invalid rules are rejected with a reason', () => {
  assert.equal(holidayRuleError(rule('thanksgiving')), '');
  assert.match(holidayRuleError(rule('thanksgiving', { holiday: 'festivus' })), /Choose a holiday/);
  assert.match(holidayRuleError(rule('custom', { name: '' })), /name/);
  assert.match(holidayRuleError(rule('custom', { name: 'Bad', month: 2, day: 30 })), /real calendar date/);
  assert.match(holidayRuleError(rule('thanksgiving', { oddParent: '' })), /even years and for odd years/);
  assert.match(holidayRuleError(rule('thanksgiving', { fromYear: 2030, toYear: 2026 })), /last year/);
  assert.match(holidayRuleError(rule('thanksgiving', { toYear: 2099 })), /at most 20 years/);
  assert.match(holidayRuleError(rule('thanksgiving', { daysAfter: 45 })), /too long/);
  assert.match(holidayRuleError(rule('thanksgiving', { children: ['Sam', 'Sam'] })), /children/);
  assert.throws(() => applyHolidayRule(household(), rule('thanksgiving', { evenParent: '' })), /even years/);
});

test('a holiday rule overrides the recurring schedule and changes the report', () => {
  const data = { ...household(), entries: [{ id: 'week', parent: 'Jordan', beginDate: '2026-11-23', endDate: '2026-11-29', childrenPresent: { Sam: true, Lee: true }, note: '' }] };
  const next = { ...data, ...applyHolidayRule(data, rule('thanksgiving', { evenParent: 'Alex', oddParent: 'Jordan' })) };
  assert.equal(getChildDayState('2026-11-25', next.entries, 'Sam').parent, 'Jordan');
  const holiday = getChildDayState('2026-11-26', next.entries, 'Sam');
  assert.equal(holiday.parent, 'Alex');
  assert.equal(holiday.isException, true);
  const report = computeCustodySummary({ ...next, start: '2026-11-23', end: '2026-11-29' });
  assert.deepEqual(report.rows.map((r) => [r.parent, r.custodyDays]), [['Alex', 8], ['Jordan', 6]]);
});

test('saving a rule again replaces its own entries and leaves others alone', () => {
  const manual = { id: 'manual', parent: 'Jordan', beginDate: '2026-07-01', endDate: '2026-07-07', childrenPresent: { Sam: true, Lee: true }, note: 'Trip', isException: true };
  let data = { ...household(), entries: [manual] };
  data = { ...data, ...applyHolidayRule(data, rule('thanksgiving')) };
  data = { ...data, ...applyHolidayRule(data, rule('christmas-day')) };
  assert.equal(data.entries.length, 11);
  data = { ...data, ...applyHolidayRule(data, rule('thanksgiving', { toYear: 2027, daysAfter: 0 })) };
  assert.equal(data.holidayRules.length, 2);
  assert.deepEqual(data.holidayRules.map((r) => r.id), ['r-thanksgiving', 'r-christmas-day']);
  assert.deepEqual(data.entries.filter((e) => e.holidayRuleId === 'r-thanksgiving').map((e) => e.endDate), ['2026-11-26', '2027-11-25']);
  assert.equal(data.entries.filter((e) => e.holidayRuleId === 'r-christmas-day').length, 5);
  data = { ...data, ...removeHolidayRule(data, 'r-christmas-day') };
  assert.deepEqual(data.holidayRules.map((r) => r.id), ['r-thanksgiving']);
  assert.deepEqual(data.entries.map((e) => e.id), ['manual', 'r-thanksgiving:2026', 'r-thanksgiving:2027']);
});

test('overlapping holidays that disagree are reported before saving', () => {
  let data = household();
  data = { ...data, ...applyHolidayRule(data, rule('christmas-eve', { evenParent: 'Alex', oddParent: 'Jordan', toYear: 2027 })) };
  const clash = rule('christmas-day', { evenParent: 'Jordan', oddParent: 'Alex', daysBefore: 1, toYear: 2027 });
  assert.deepEqual(holidayRuleOverlaps(data, clash).map((o) => [o.year, o.with]), [[2026, 'Christmas Eve'], [2027, 'Christmas Eve']]);
  assert.deepEqual(holidayRuleOverlaps(data, rule('christmas-day', { evenParent: 'Jordan', oddParent: 'Alex', toYear: 2027 })), []);
  // Same parent on the shared day is not a conflict.
  assert.deepEqual(holidayRuleOverlaps(data, rule('christmas-day', { evenParent: 'Alex', oddParent: 'Jordan', daysBefore: 1, toYear: 2027 })), []);
});

test('rules are saved, undone and backed up with the household', () => {
  const start = newDocument(household());
  const doc = changeDocument(start, (data) => applyHolidayRule(data, rule('thanksgiving')), { id: '1', now: new Date(2026, 8, 1) });
  assert.equal(doc.schemaVersion, SCHEMA_VERSION);
  assert.equal(doc.history[0].label, 'Changed holiday rules');
  assert.deepEqual(doc.history[0].before.holidayRules, []);
  assert.deepEqual(parseBackup(createBackup(doc)).document, doc);
  assert.throws(() => changeDocument(doc, { holidayRules: [rule('thanksgiving'), rule('thanksgiving')] }), /unique/);
  assert.throws(() => changeDocument(doc, { holidayRules: [rule('thanksgiving', { toYear: 2020 })] }), /last year/);
});

test('saves and backups from before holiday rules still load', () => {
  const old = JSON.parse(JSON.stringify(changeDocument(newDocument(household()), { parents: ['Jordan', 'Alex'] }, { id: '1', now: new Date(2026, 8, 1) })));
  old.schemaVersion = 1;
  for (const target of [old.data, old.history[0].before]) { delete target.holidayRules; delete target.deviations; }
  const loaded = readDocument(JSON.stringify(old));
  assert.equal(loaded.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(loaded.data.holidayRules, []);
  assert.deepEqual(loaded.data.deviations, []);
  assert.deepEqual(loaded.history[0].before.parents, ['Alex', 'Jordan']);
  const backup = JSON.stringify({ format: 'custody-calendar-backup', version: 1, exportedAt: '2026-09-01T00:00:00.000Z', document: old });
  assert.deepEqual(parseBackup(backup).document.data.parents, ['Jordan', 'Alex']);
  // A current save that is missing the new lists is damaged, not old.
  const damaged = { ...old, schemaVersion: SCHEMA_VERSION };
  assert.throws(() => readDocument(JSON.stringify(damaged)), /incomplete/);
  assert.throws(() => parseBackup(backup.replace('"schemaVersion":1', '"schemaVersion":99')), /newer app version/);
});
