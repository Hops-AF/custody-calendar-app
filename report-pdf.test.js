const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCustodyReport, layout, monthsBetween, PAGE_BUDGET } = require('./report-pdf');
const { applyHolidayRule, newHolidayRule } = require('./holiday-rules');

const both = { Sam: true, Lee: true };
// Alex is primary; Jordan has two weekends in September.
const household = () => ({
  parents: ['Alex', 'Jordan'],
  children: ['Sam', 'Lee'],
  parentColors: { Alex: '#2563eb', Jordan: '#d97706' },
  entries: [
    { id: 'w1', parent: 'Jordan', beginDate: '2026-09-04', endDate: '2026-09-06', childrenPresent: both, note: 'PRIVATE-ENTRY-NOTE', exchangeTime: '6:00 PM', exchangePlace: 'Library lot', location: '12 Elm St' },
    { id: 'w2', parent: 'Jordan', beginDate: '2026-09-18', endDate: '2026-09-20', childrenPresent: both, note: '' },
  ],
  holidayRules: [],
  deviations: [
    { id: 'd1', type: 'missed', date: '2026-09-04', endDate: '2026-09-06', children: both, actualParent: 'Alex', note: 'Texted at 5:40 to cancel', loggedAt: '2026-09-07T12:00:00.000Z' },
    { id: 'd2', type: 'late', date: '2026-09-18', endDate: '2026-09-18', children: both, minutesLate: 30, lateParent: 'Jordan', note: 'Arrived 6:30', loggedAt: '2026-09-18T23:00:00.000Z' },
  ],
});
const september = { start: '2026-09-01', end: '2026-09-30', preparedOn: 'Oct 1, 2026' };
const pages = (html) => (html.match(/<section class="page/g) || []).length;
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the summary states the schedule totals and the planned vs. actual change', () => {
  const html = buildCustodyReport({ ...household(), ...september });
  const t = text(html);
  assert.match(t, /Custody report/);
  assert.match(t, /Period: Sep 1, 2026 &ndash; Sep 30, 2026 \(30 days\)/);
  assert.match(t, /Counted: 60 child-days/);
  assert.match(t, /Alex 48 80% /);
  assert.match(t, /Jordan 12 20% /);
  assert.match(t, /Alex 48 80% 54 90% \+6/);
  assert.match(t, /Jordan 12 20% 6 10% &minus;6/);
  assert.match(t, /6 child-days went differently from the schedule/);
  assert.match(t, /Late exchanges: 1 \(30 minutes in total\)/);
  assert.match(t, /Jordan: late 1 time, 30 minutes/);
  assert.match(t, /Days without a specific entry are credited to Alex \(primary parent\)/);
});

test('the log lists each change with its effect and logged date', () => {
  const t = text(buildCustodyReport({ ...household(), ...september }));
  assert.match(t, /Sep 4 &ndash; Sep 6, 2026 Missed time Sam, Lee With Alex; scheduled Jordan\. 6 child-days changed Texted at 5:40 to cancel Sep 7, 2026/);
  assert.match(t, /Fri, Sep 18, 2026 Late exchange Sam, Lee 30 min late \(Jordan\) Arrived 6:30/);
});

test('log notes can be left out, and private entry details are never included', () => {
  const withNotes = buildCustodyReport({ ...household(), ...september });
  assert.match(withNotes, /Texted at 5:40/);
  const without = buildCustodyReport({ ...household(), ...september, includeNotes: false });
  assert.ok(!without.includes('Texted at 5:40'));
  assert.ok(!without.includes('Arrived 6:30'));
  assert.match(without, /Log notes were left out of this copy/);
  for (const html of [withNotes, without]) {
    for (const secret of ['PRIVATE-ENTRY-NOTE', 'Library lot', '12 Elm St']) assert.ok(!html.includes(secret), secret);
    assert.match(html, /6:00 PM/); // exchange times stay on the calendar
  }
});

test('one calendar page per month in the period, with days outside the period dimmed', () => {
  assert.deepEqual(monthsBetween('2026-11-15', '2027-02-02').map((m) => [m.year, m.month]), [[2026, 10], [2026, 11], [2027, 0], [2027, 1]]);
  const html = buildCustodyReport({ ...household(), start: '2026-09-15', end: '2026-10-10', preparedOn: 'x' });
  const months = html.split('<section class="page">').slice(1);
  assert.equal(months.length, 2);
  assert.match(months[0], /September 2026/);
  assert.match(months[1], /October 2026/);
  assert.equal((months[0].match(/<td class="out"/g) || []).length, 14); // Sep 1-14
  assert.equal((months[1].match(/<td class="out"/g) || []).length, 21); // Oct 11-31
  assert.match(months[0], /Late 30 min/);
  assert.match(months[0], /Faded days fall outside/);
  const whole = buildCustodyReport({ ...household(), ...september });
  assert.ok(!whole.includes('Faded days'));
});

test('calendar pages mark logged days and number every page', () => {
  const html = buildCustodyReport({ ...household(), ...september });
  assert.match(html, /Missed → Alex/);
  const total = pages(html);
  assert.ok(total >= 2);
  assert.match(html, new RegExp(`Page 1 of ${total}`));
  assert.match(html, new RegExp(`Page ${total} of ${total}`));
});

test('very long periods leave out calendars and say why', () => {
  const html = buildCustodyReport({ ...household(), start: '2024-01-01', end: '2026-12-31', preparedOn: 'x' });
  assert.ok(!html.includes('<section class="page">'));
  assert.match(text(html), /This period covers 36; choose a shorter period/);
});

test('a single-child report counts days, lists only that child and their holidays', () => {
  let data = household();
  data = { ...data, ...applyHolidayRule(data, { ...newHolidayRule({ id: 'lee-bday', holiday: 'custom', parents: data.parents, children: ['Lee'], year: 2026 }), name: 'Lee birthday', month: 9, day: 10, evenParent: 'Jordan', oddParent: 'Alex' }) };
  data = { ...data, ...applyHolidayRule(data, newHolidayRule({ id: 'labor', holiday: 'labor-day', parents: data.parents, children: ['Sam', 'Lee'], year: 2026 })) };
  const lee = text(buildCustodyReport({ ...data, ...september, childFilter: 'Lee' }));
  assert.match(lee, /Children: Lee /);
  assert.match(lee, /Counted: 30 days/);
  assert.match(lee, /Lee birthday Thu, Sep 10, 2026 Jordan Even years: Jordan; odd years: Alex Lee/);
  assert.match(lee, /Labor Day Sep 5 &ndash; Sep 7, 2026 Alex/);
  assert.ok(!lee.includes('Days by child'));
  const sam = text(buildCustodyReport({ ...data, ...september, childFilter: 'Sam' }));
  assert.ok(!sam.includes('Lee birthday'));
  const all = text(buildCustodyReport({ ...data, ...september }));
  assert.match(all, /Days by child \(schedule\)/);
});

test('a long log flows onto more pages, repeating the table header, with every entry once', () => {
  const data = household();
  data.deviations = Array.from({ length: 70 }, (_, i) => ({
    id: `late${i}`, type: 'late', date: '2026-09-02', endDate: '2026-09-02', children: both, minutesLate: i + 1, lateParent: 'Jordan',
    note: i % 7 === 0 ? 'A long note. '.repeat(60) : `note ${i}`, loggedAt: '2026-09-02T20:00:00.000Z',
  }));
  const html = buildCustodyReport({ ...data, ...september });
  const flow = html.split('<section class="page rp">').slice(1);
  assert.ok(flow.length >= 4, `expected several summary pages, got ${flow.length}`);
  const logPages = flow.filter((p) => p.includes('class="c-date"'));
  assert.ok(logPages.length >= 3);
  for (let i = 0; i < 70; i += 1) assert.equal((html.match(new RegExp(`>${i + 1} min late`, 'g')) || []).length, 1, `entry ${i}`);
  assert.match(html, /Page 1 of /);
});

test('layout keeps every page within its height budget unless one row alone is taller', () => {
  const table = { head: '<tr><th>x</th></tr>', headH: 28 };
  const blocks = [{ html: '<h2>a</h2>', h: 38, reserve: 60 }, ...Array.from({ length: 50 }, (_, i) => ({ table, html: `<tr><td>${i}</td></tr>`, h: 30 + (i % 5) * 20 }))];
  const result = layout(blocks, 300);
  assert.ok(result.length > 5);
  for (const page of result) assert.equal((page.match(/<table/g) || []).length, (page.match(/<\/table>/g) || []).length);
  assert.equal(result.join('').match(/<tr><td>/g).length, 50);
  assert.ok(result.every((page, i) => i === 0 || page.startsWith('<table')));
  // A heading never sits alone at the bottom of a page.
  const tight = layout([{ html: 'x', h: 280 }, { html: '<h2>b</h2>', h: 38, reserve: 60 }, { table, html: '<tr><td>r</td></tr>', h: 30 }], 300);
  assert.equal(tight.length, 2);
  assert.ok(tight[1].startsWith('<h2>b</h2>'));
  assert.ok(PAGE_BUDGET > 600);
});

test('names and notes are HTML-escaped and invalid periods are rejected', () => {
  const data = household();
  data.parents = ['<b>Alex</b>', 'Jordan'];
  data.deviations[0].actualParent = '<b>Alex</b>';
  data.deviations[0].note = '</td><script>alert(1)</script>';
  const html = buildCustodyReport({ ...data, ...september });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<b>Alex</b>'));
  assert.match(html, /&lt;b&gt;Alex&lt;\/b&gt;/);
  assert.throws(() => buildCustodyReport({ ...data, start: '2026-09-30', end: '2026-09-01' }), /end date/);
  assert.throws(() => buildCustodyReport({ ...data, start: '', end: '2026-09-01' }), /end date/);
});

test('with nothing logged the report says so instead of an empty comparison', () => {
  const data = household();
  data.deviations = [];
  const html = buildCustodyReport({ ...data, ...september });
  assert.match(text(html), /Nothing was logged in this period/);
  assert.ok(!html.includes('<h2>Logged changes</h2>'));
  assert.ok(!html.includes('Logged changes are listed'));
});
