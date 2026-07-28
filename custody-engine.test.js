const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeCustodySummary,
  enumerateDates,
  getCalendarDayState,
  getChildDayState,
  resolveLocation,
  buildCustodyBlocks,
  buildICS,
  escapeICSText,
  getKidView,
} = require('./custody-engine');

function entry(parent, beginDate, endDate, children) {
  return {
    parent,
    beginDate,
    endDate,
    childrenPresent: Object.fromEntries(children.map((child) => [child, true])),
  };
}

function holiday(parent, beginDate, endDate, children) {
  return { ...entry(parent, beginDate, endDate, children), isException: true };
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

test('a holiday exception overrides the recurring schedule for that child-day', () => {
  const entries = [
    entry('Mom', '2026-12-25', '2026-12-25', ['Sam']),
    holiday('Dad', '2026-12-25', '2026-12-25', ['Sam']),
  ];
  const state = getChildDayState('2026-12-25', entries, 'Sam');
  assert.equal(state.type, 'single');
  assert.equal(state.parent, 'Dad');
  assert.equal(state.isException, true);
});

test('two holiday exceptions for the same child still conflict', () => {
  const entries = [
    holiday('Mom', '2026-12-25', '2026-12-25', ['Sam']),
    holiday('Dad', '2026-12-25', '2026-12-25', ['Sam']),
  ];
  const state = getChildDayState('2026-12-25', entries, 'Sam');
  assert.equal(state.type, 'conflict');
});

test('reporting credits the holiday parent, not the base schedule', () => {
  const result = computeCustodySummary({
    entries: [
      entry('Mom', '2026-12-24', '2026-12-26', ['Sam']),
      holiday('Dad', '2026-12-25', '2026-12-25', ['Sam']),
    ],
    parents: ['Mom', 'Dad'],
    children: ['Sam'],
    start: '2026-12-24',
    end: '2026-12-26',
    childFilter: 'Sam',
  });
  assert.deepEqual(result.rows, [
    { parent: 'Mom', custodyDays: 2, percentage: 66.7 },
    { parent: 'Dad', custodyDays: 1, percentage: 33.3 },
  ]);
});

test('location falls back to the parent default address', () => {
  const parentLocations = { Mom: "Mom's house, 1 Elm St" };
  const e = entry('Mom', '2026-06-10', '2026-06-10', ['Sam']);
  assert.equal(resolveLocation(e, parentLocations), "Mom's house, 1 Elm St");
});

test('an entry-level location overrides the parent default', () => {
  const parentLocations = { Mom: "Mom's house, 1 Elm St" };
  const e = { ...entry('Mom', '2026-06-10', '2026-06-10', ['Sam']), location: 'Grandma’s cabin' };
  assert.equal(resolveLocation(e, parentLocations), 'Grandma’s cabin');
});

test('an assigned day exposes the deciding entry so callers can read exchange details', () => {
  const base = entry('Mom', '2026-12-24', '2026-12-26', ['Sam']);
  const override = { ...holiday('Dad', '2026-12-25', '2026-12-25', ['Sam']), exchangeTime: '10:00 AM', exchangePlace: 'Library' };
  const state = getChildDayState('2026-12-25', [base, override], 'Sam');
  assert.equal(state.entry.exchangePlace, 'Library');
  assert.equal(state.entry.exchangeTime, '10:00 AM');
});

test('unassigned and conflicting days expose no deciding entry', () => {
  assert.equal(getChildDayState('2026-06-10', [], 'Sam').entry, null);
  const conflicting = [
    entry('Mom', '2026-06-10', '2026-06-10', ['Sam']),
    entry('Dad', '2026-06-10', '2026-06-10', ['Sam']),
  ];
  assert.equal(getChildDayState('2026-06-10', conflicting, 'Sam').entry, null);
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

// ── Calendar export ──────────────────────────────────────────────────────────

test('merges consecutive same-parent days into one block', () => {
  const blocks = buildCustodyBlocks({
    entries: [entry('Dad', '2026-06-05', '2026-06-07', ['Sam'])],
    parents: ['Mom', 'Dad'],
    children: ['Sam'],
    start: '2026-06-05',
    end: '2026-06-07',
    fillGapsWithPrimary: false,
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].start, '2026-06-05');
  assert.equal(blocks[0].end, '2026-06-07');
  assert.equal(blocks[0].parent, 'Dad');
});

test('splits blocks when the parent changes and fills gaps with the primary', () => {
  const blocks = buildCustodyBlocks({
    entries: [entry('Dad', '2026-06-03', '2026-06-03', ['Sam'])],
    parents: ['Mom', 'Dad'],
    children: ['Sam'],
    start: '2026-06-01',
    end: '2026-06-05',
  });
  assert.deepEqual(
    blocks.map((b) => [b.parent, b.start, b.end]),
    [['Mom', '2026-06-01', '2026-06-02'], ['Dad', '2026-06-03', '2026-06-03'], ['Mom', '2026-06-04', '2026-06-05']]
  );
  assert.equal(blocks[0].inferred, true);
  assert.equal(blocks[1].inferred, false);
});

test('a holiday override becomes its own block', () => {
  const blocks = buildCustodyBlocks({
    entries: [
      entry('Mom', '2026-12-24', '2026-12-26', ['Sam']),
      { ...entry('Dad', '2026-12-25', '2026-12-25', ['Sam']), isException: true, note: 'Christmas' },
    ],
    parents: ['Mom', 'Dad'],
    children: ['Sam'],
    start: '2026-12-24',
    end: '2026-12-26',
  });
  assert.deepEqual(blocks.map((b) => b.parent), ['Mom', 'Dad', 'Mom']);
  assert.equal(blocks[1].isException, true);
});

test('all-day DTEND is exclusive (the day after the block ends)', () => {
  const ics = buildICS({
    blocks: [{ child: 'Sam', parent: 'Dad', start: '2026-06-05', end: '2026-06-07', entry: null, inferred: true }],
    parentLocations: {},
  });
  assert.match(ics, /DTSTART;VALUE=DATE:20260605/);
  assert.match(ics, /DTEND;VALUE=DATE:20260608/);
});

test('escapes commas and semicolons so addresses survive import', () => {
  assert.equal(escapeICSText("Dad's place, 42 Oak Ave; unit 3"), "Dad's place\\, 42 Oak Ave\\; unit 3");
  const ics = buildICS({
    blocks: [{ child: 'Sam', parent: 'Dad', start: '2026-06-05', end: '2026-06-05', entry: null, inferred: false }],
    parentLocations: { Dad: 'Dad\'s place, 42 Oak Ave' },
  });
  assert.match(ics, /LOCATION:Dad's place\\, 42 Oak Ave/);
});

test('produces a well-formed calendar with CRLF endings and folded long lines', () => {
  const longNote = 'x'.repeat(200);
  const ics = buildICS({
    blocks: [{
      child: 'Sam', parent: 'Dad', start: '2026-06-05', end: '2026-06-05',
      entry: { parent: 'Dad', note: longNote }, isException: false, inferred: false,
    }],
    parentLocations: {},
  });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.trimEnd().endsWith('END:VCALENDAR'));
  assert.match(ics, /VERSION:2\.0/);
  // Every physical line must be within the 75-octet limit.
  for (const line of ics.split('\r\n')) {
    assert.ok(line.length <= 75, `line too long (${line.length}): ${line.slice(0, 40)}…`);
  }
  // Folded continuation lines begin with a space.
  assert.match(ics, /\r\n x/);
});

test('names the child only when exporting several children', () => {
  const block = { child: 'Sam', parent: 'Dad', start: '2026-06-05', end: '2026-06-05', entry: null, inferred: false };
  assert.match(buildICS({ blocks: [block], parentLocations: {} }), /SUMMARY:Sam with Dad/);
  assert.match(buildICS({ blocks: [block], parentLocations: {}, singleChild: true }), /SUMMARY:With Dad/);
});

test('puts exchange details in the event description', () => {
  const ics = buildICS({
    blocks: [{
      child: 'Sam', parent: 'Dad', start: '2026-06-05', end: '2026-06-05',
      entry: { parent: 'Dad', exchangeTime: '6:00 PM', exchangePlace: 'School' }, inferred: false,
    }],
    parentLocations: {},
  });
  assert.match(ics, /DESCRIPTION:Exchange time: 6:00 PM\\nExchange place: School/);
});

// ── Kid view ─────────────────────────────────────────────────────────────────

test('kid view reports who today is with and when the next switch happens', () => {
  const entries = [
    entry('Mom', '2026-06-01', '2026-06-04', ['Sam']),
    entry('Dad', '2026-06-05', '2026-06-07', ['Sam']),
  ];
  const view = getKidView({
    entries, parents: ['Mom', 'Dad'], children: ['Sam'],
    child: 'Sam', today: '2026-06-02',
  });
  assert.equal(view.current.parent, 'Mom');
  assert.equal(view.next.parent, 'Dad');
  assert.equal(view.next.start, '2026-06-05');
  assert.equal(view.daysUntilChange, 3);
});

test('kid view surfaces the exchange details of the upcoming handoff', () => {
  const entries = [
    entry('Mom', '2026-06-01', '2026-06-04', ['Sam']),
    { ...entry('Dad', '2026-06-05', '2026-06-07', ['Sam']), exchangeTime: '6:00 PM', exchangePlace: 'School' },
  ];
  const view = getKidView({
    entries, parents: ['Mom', 'Dad'], children: ['Sam'],
    child: 'Sam', today: '2026-06-04',
  });
  assert.equal(view.daysUntilChange, 1);
  assert.equal(view.next.entry.exchangeTime, '6:00 PM');
  assert.equal(view.next.entry.exchangePlace, 'School');
});

test('kid view only follows the selected child when siblings differ', () => {
  const entries = [
    entry('Mom', '2026-06-01', '2026-06-07', ['Sam']),
    entry('Dad', '2026-06-01', '2026-06-07', ['Alex']),
  ];
  const base = { entries, parents: ['Mom', 'Dad'], children: ['Sam', 'Alex'], today: '2026-06-02' };
  assert.equal(getKidView({ ...base, child: 'Sam' }).current.parent, 'Mom');
  assert.equal(getKidView({ ...base, child: 'Alex' }).current.parent, 'Dad');
});

test('kid view reports no upcoming switch when one parent has the whole window', () => {
  const view = getKidView({
    entries: [entry('Mom', '2026-06-01', '2026-07-30', ['Sam'])],
    parents: ['Mom', 'Dad'], children: ['Sam'],
    child: 'Sam', today: '2026-06-02', daysAhead: 14,
  });
  assert.equal(view.current.parent, 'Mom');
  assert.equal(view.next, null);
  assert.equal(view.daysUntilChange, null);
});

test('kid view degrades gracefully on a bad date', () => {
  const view = getKidView({ entries: [], parents: [], children: [], child: null, today: 'nonsense' });
  assert.deepEqual(view, { current: null, next: null, daysUntilChange: null, upcoming: [] });
});
