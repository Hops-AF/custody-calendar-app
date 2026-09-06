const test = require('node:test');
const assert = require('node:assert/strict');
const { monthWeeks, textOnColor, dayDetails, dayShareText } = require('./calendar-ui');

test('calendar always has seven columns aligned to real weekdays', () => {
  for (let year = 2024; year <= 2028; year++) {
    for (let month = 0; month < 12; month++) {
      const weeks = monthWeeks(year, month);
      weeks.forEach((week) => {
        assert.equal(week.length, 7);
        week.forEach((date, column) => { if (date) assert.equal(new Date(date + 'T12:00:00').getDay(), column); });
      });
      assert.equal(weeks.flat().filter(Boolean).length, new Date(year, month + 1, 0).getDate());
    }
  }
  assert.equal(monthWeeks(2026, 8)[0][2], '2026-09-01');
  assert.equal(monthWeeks(2026, 8)[0][6], '2026-09-05');
});

test('parent colors use a readable foreground for light and dark fills', () => {
  assert.equal(textOnColor('#ffffff'), '#000000');
  assert.equal(textOnColor('#000000'), '#ffffff');
  assert.equal(textOnColor('#2563eb'), '#ffffff');
  assert.equal(textOnColor('#ca8a04'), '#000000');
  assert.equal(textOnColor(null), '#182421');
});

const entry = (parent, child, extra = {}) => ({
  id: parent + child, parent, beginDate: '2026-09-06', endDate: '2026-09-06', childrenPresent: { [child]: true }, ...extra,
});
const base = { date: '2026-09-06', parents: ['Alex', 'Jordan'], children: ['Sam', 'Robin'], parentLocations: { Alex: 'Home' } };

test('daily plan distinguishes a primary default from an explicit sibling assignment', () => {
  const details = dayDetails({ ...base, entries: [entry('Jordan', 'Sam')] });
  assert.equal(details[0].parent, 'Jordan');
  assert.equal(details[0].source, 'Scheduled');
  assert.equal(details[1].parent, 'Alex');
  assert.equal(details[1].source, 'Primary-parent default');
  assert.equal(details[1].location, 'Home');
  assert.equal(dayDetails({ ...base, entries: [], childFilter: 'Robin' }).length, 1);
});

test('conflicts are reviewable and never default to a parent', () => {
  const details = dayDetails({ ...base, entries: [entry('Alex', 'Sam'), entry('Jordan', 'Sam')], childFilter: 'Sam' });
  assert.equal(details[0].type, 'conflict');
  assert.equal(details[0].parent, null);
  assert.equal(details[0].entries.length, 2);
  assert.match(dayShareText(base.date, details), /Schedule needs review/);
});

test('day share contains logistics, not private notes or implied confirmation', () => {
  const details = dayDetails({ ...base, childFilter: 'Sam', entries: [entry('Jordan', 'Sam', {
    exchangeTime: '6:00 PM', exchangePlace: 'School', note: 'PRIVATE_NOTE',
  })] });
  const text = dayShareText(base.date, details);
  assert.match(text, /6:00 PM/);
  assert.match(text, /School/);
  assert.match(text, /Not a live update or confirmation/);
  assert.equal(text.includes('PRIVATE_NOTE'), false);
});

test('holiday details override the recurring assignment and missing logistics stay explicit', () => {
  const details = dayDetails({ ...base, childFilter: 'Sam', entries: [entry('Alex', 'Sam'), entry('Jordan', 'Sam', { isException: true })] });
  assert.equal(details[0].parent, 'Jordan');
  assert.equal(details[0].source, 'Holiday / exception');
  assert.match(dayShareText(base.date, details), /Exchange time: Not set/);
  assert.match(dayShareText(base.date, details), /Exchange place: Not set/);
});
