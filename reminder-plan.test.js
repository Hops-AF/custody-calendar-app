const test = require('node:test');
const assert = require('node:assert/strict');
const { defaults } = require('./local-store');
const { exchangeDate, planReminders, createReminderScheduler } = require('./reminder-plan');
const event = (extra = {}) => ({ id: 'e', parent: 'Jordan', beginDate: '2026-09-11', endDate: '2026-09-13', childrenPresent: { Sam: true }, exchangeTime: '6:00 PM', exchangePlace: 'School', ...extra });
const data = (extra = {}) => ({ ...defaults(), parents: ['Alex', 'Jordan'], children: ['Sam'], entries: [event()], ...extra });
const now = new Date(2026, 8, 10, 12);

test('exchange times accept 12-hour and 24-hour formats and reject invalid times', () => {
  assert.equal(exchangeDate('2026-09-11', '12:00 AM').getHours(), 0);
  assert.equal(exchangeDate('2026-09-11', '12:00 PM').getHours(), 12);
  assert.equal(exchangeDate('2026-09-11', '18:30').getHours(), 18);
  for (const time of ['13:00 PM', '25:00', '6:88 PM', 'after school', '']) assert.equal(exchangeDate('2026-09-11', time), null);
});
test('reminders are scheduled once per real child handoff and hide personal details by default', () => {
  const plan = planReminders(data(), now);
  assert.equal(plan.notifications.length, 1);
  assert.equal(new Date(plan.notifications[0].fireAt).getHours(), 17);
  assert.equal(plan.notifications[0].content.body.includes('Sam'), false);
  assert.equal(plan.notifications[0].content.body.includes('School'), false);
  assert.equal(plan.missingTimes, 1); // return to the primary has no explicit time
});
test('no reminders for same-parent entries, elapsed triggers or overlapping ownership', () => {
  assert.equal(planReminders(data({ entries: [event({ parent: 'Alex' })] }), now).notifications.length, 0);
  assert.equal(planReminders(data(), new Date(2026, 8, 11, 17, 30)).notifications.length, 0);
  const conflict = planReminders(data({ entries: [event(), event({ id: 'other', parent: 'Alex' })] }), now);
  assert.equal(conflict.notifications.length, 0);
  assert.ok(conflict.conflicts > 0);
});
test('child-specific and holiday entries control the deciding exchange details', () => {
  const settings = { enabled: true, leadMinutes: 15, showDetails: true };
  const plan = planReminders(data({ children: ['Sam', 'Robin'], reminderSettings: settings,
    entries: [event({ parent: 'Alex', childrenPresent: { Sam: true, Robin: true } }), event({ isException: true })] }), now);
  assert.equal(plan.notifications.length, 1);
  assert.match(plan.notifications[0].content.body, /Sam: time with Jordan/);
  assert.equal(new Date(plan.notifications[0].fireAt).getMinutes(), 45);
});
test('bounded scheduling keeps the earliest notifications', () => {
  const entries = Array.from({ length: 20 }, (_, i) => event({ id: String(i), beginDate: `2026-09-${String(11 + i).padStart(2, '0')}`, endDate: `2026-09-${String(11 + i).padStart(2, '0')}`, parent: i % 2 ? 'Alex' : 'Jordan' }));
  const plan = planReminders(data({ entries }), now, 3);
  assert.equal(plan.notifications.length, 3);
  assert.ok(plan.total > 3);
  assert.ok(plan.notifications[0].fireAt < plan.notifications[1].fireAt);
});
test('scheduler deduplicates, replaces edited alerts and cancels only its own reminders', async () => {
  const pending = new Map([['unrelated', { identifier: 'unrelated', content: { data: {} } }]]);
  let scheduled = 0;
  const api = {
    getAllScheduledNotificationsAsync: async () => [...pending.values()],
    cancelScheduledNotificationAsync: async (id) => pending.delete(id),
    scheduleNotificationAsync: async (n) => { scheduled++; pending.set(n.identifier, n); },
  };
  const sync = createReminderScheduler(api), plan = planReminders(data(), now).notifications;
  await sync(plan); await sync(plan);
  assert.equal(scheduled, 1);
  await sync(plan.map((p) => ({ ...p, fireAt: p.fireAt + 60000 })));
  assert.equal(scheduled, 2);
  await sync([]);
  assert.deepEqual([...pending.keys()], ['unrelated']);
});
test('a scheduling failure is surfaced and can be retried', async () => {
  let fails = true;
  const sync = createReminderScheduler({ getAllScheduledNotificationsAsync: async () => [], cancelScheduledNotificationAsync: async () => {},
    scheduleNotificationAsync: async () => { if (fails) throw new Error('denied'); } });
  const plan = planReminders(data(), now).notifications;
  await assert.rejects(sync(plan), /denied/);
  fails = false; assert.equal(await sync(plan), 1);
});
test('DST gaps do not silently shift exchange times', () => {
  const { execFileSync } = require('node:child_process');
  const output = execFileSync(process.execPath, ['-e', `const {exchangeDate}=require('./reminder-plan'); console.log(exchangeDate('2026-03-08','2:30 AM'));`],
    { cwd: __dirname, env: { ...process.env, TZ: 'America/Chicago' }, encoding: 'utf8' });
  assert.equal(output.trim(), 'null');
});
