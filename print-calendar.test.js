const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrintableCalendar, printDay, tint } = require('./print-calendar');

const parents = ['Alex', 'Jordan'];
const children = ['Sam', 'Lee'];
const parentColors = { Alex: '#2563eb', Jordan: '#16a34a' };
const entry = (parent, beginDate, endDate, kids = children, extra = {}) => ({
  id: `${parent}-${beginDate}`, parent, beginDate, endDate,
  childrenPresent: Object.fromEntries(kids.map((k) => [k, true])), ...extra,
});
const ctx = (entries) => ({ entries, children, primary: 'Alex' });

test('days without an entry show the primary parent, matching My Days and reports', () => {
  const day = printDay('2026-09-02', ctx([]));
  assert.equal(day.type, 'single');
  assert.equal(day.parent, 'Alex');
  assert.deepEqual(day.exchangeTimes, []);
});

test('exchange is marked on the first day with the incoming entry time, not on following days', () => {
  const entries = [entry('Jordan', '2026-09-11', '2026-09-13', children, { exchangeTime: '6:00 PM' })];
  assert.deepEqual(printDay('2026-09-11', ctx(entries)).exchangeTimes, ['6:00 PM']);
  assert.deepEqual(printDay('2026-09-12', ctx(entries)).exchangeTimes, []);
  // Return to the primary parent by default: an exchange with no known time.
  assert.deepEqual(printDay('2026-09-14', ctx(entries)).exchangeTimes, ['']);
});

test('siblings with different parents print as a split day; same-child overlap prints as conflict', () => {
  const split = printDay('2026-09-05', ctx([entry('Jordan', '2026-09-05', '2026-09-05', ['Lee'])]));
  assert.equal(split.type, 'split');
  assert.deepEqual(split.days.map((d) => [d.child, d.parent]), [['Sam', 'Alex'], ['Lee', 'Jordan']]);

  const conflict = printDay('2026-09-05', ctx([
    entry('Jordan', '2026-09-05', '2026-09-05', ['Sam']),
    entry('Alex', '2026-09-05', '2026-09-05', ['Sam']),
  ]));
  assert.equal(conflict.type, 'conflict');
});

test('holiday exceptions override the base schedule and are flagged', () => {
  const day = printDay('2026-12-25', ctx([
    entry('Alex', '2026-12-20', '2026-12-31'),
    entry('Jordan', '2026-12-25', '2026-12-25', children, { isException: true }),
  ]));
  assert.equal(day.parent, 'Jordan');
  assert.equal(day.isException, true);
});

test('printed page has every day of the month and one page per month', () => {
  const html = buildPrintableCalendar({
    months: [{ year: 2026, month: 8 }, { year: 2026, month: 9 }],
    entries: [], parents, children, parentColors, printedOn: 'Sep 22, 2026',
  });
  assert.equal((html.match(/<section class="page">/g) || []).length, 2);
  assert.match(html, /September 2026/);
  assert.match(html, /October 2026/);
  const september = html.split('<section class="page">')[1];
  assert.equal((september.match(/<div class="num">/g) || []).length, 30);
  assert.match(html, /size: 11in 8.5in/);
});

test('fridge page never includes notes, addresses, phones, or exchange places', () => {
  const html = buildPrintableCalendar({
    months: [{ year: 2026, month: 8 }],
    entries: [entry('Jordan', '2026-09-11', '2026-09-13', children, {
      exchangeTime: '6:00 PM', exchangePlace: 'Library lot', location: '12 Elm St', notes: 'Private note',
    })],
    parents, children, parentColors, printedOn: 'Sep 22, 2026',
  });
  assert.match(html, /6:00 PM/);
  for (const secret of ['Library lot', '12 Elm St', 'Private note']) assert.ok(!html.includes(secret), secret);
});

test('names are HTML-escaped and invalid colors fall back safely', () => {
  const html = buildPrintableCalendar({
    months: [{ year: 2026, month: 8 }],
    entries: [], parents: ['<b>Alex</b>'], children: ['Sam & "Lee"'],
    parentColors: { '<b>Alex</b>': 'red;}</style><script>' }, printedOn: 'today',
  });
  assert.ok(!html.includes('<b>Alex</b>'));
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;b&gt;Alex&lt;\/b&gt;/);
  assert.match(html, /Sam &amp; &quot;Lee&quot;/);
});

test('tint lightens toward white', () => {
  assert.equal(tint('#000000', 0.5), '#808080');
  assert.equal(tint('#ffffff'), '#ffffff');
});
