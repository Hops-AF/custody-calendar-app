const { getChildDayState, enumerateDates, parseDate } = require('./custody-engine');

const REMINDER_PREFIX = 'custody-exchange-';
function dateString(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function exchangeDate(day, time) {
  const match = typeof time === 'string' && time.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || hour > 23 || (match[3] && (hour < 1 || hour > 12))) return null;
  if (match[3]) hour = hour % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0);
  const date = parseDate(day);
  if (!date) return null;
  date.setHours(hour, minute, 0, 0);
  // A nonexistent spring-forward local time must not be silently moved.
  return date.getHours() === hour && date.getMinutes() === minute ? date : null;
}

function planReminders(data, now = new Date(), limit = 48) {
  const end = new Date(now); end.setDate(end.getDate() + 90);
  const start = new Date(now); start.setDate(start.getDate() - 1);
  const dates = enumerateDates(dateString(start), dateString(end));
  const notifications = [];
  let missingTimes = 0;
  let conflicts = 0;
  for (const child of data.children) {
    let previous = null;
    for (const day of dates) {
      const state = getChildDayState(day, data.entries, child);
      const parent = state.type === 'unassigned' ? data.parents[0] : state.parent;
      if (day >= dateString(now) && state.type === 'conflict') conflicts++;
      if (previous && previous.type !== 'conflict' && state.type !== 'conflict' && parent && previous.parent && parent !== previous.parent) {
        const exchange = exchangeDate(day, state.entry?.exchangeTime);
        if (!exchange) { if (day >= dateString(now)) missingTimes++; }
        else {
          const fireAt = exchange.getTime() - data.reminderSettings.leadMinutes * 60000;
          if (fireAt > now.getTime()) {
            const identifier = REMINDER_PREFIX + encodeURIComponent(JSON.stringify([child, day, parent]));
            notifications.push({ identifier, fireAt,
              content: {
                title: 'Upcoming exchange',
                body: data.reminderSettings.showDetails
                  ? `${child}: time with ${parent} at ${state.entry.exchangeTime}${state.entry.exchangePlace ? ' • ' + state.entry.exchangePlace : ''}`
                  : 'An exchange is coming up. Open Custody Calendar for details.',
                data: { kind: 'custody-exchange', date: day },
              },
            });
          }
        }
      }
      previous = { type: state.type, parent };
    }
  }
  notifications.sort((a, b) => a.fireAt - b.fireAt || a.identifier.localeCompare(b.identifier));
  return { notifications: notifications.slice(0, limit), missingTimes, conflicts, total: notifications.length };
}

function createReminderScheduler(api) {
  let queue = Promise.resolve();
  return (wanted) => {
    const run = queue.then(async () => {
      const pending = (await api.getAllScheduledNotificationsAsync()).filter((n) => n.identifier.startsWith(REMINDER_PREFIX));
      const byId = new Map(wanted.map((n) => [n.identifier, n]));
      for (const old of pending) {
        const next = byId.get(old.identifier);
        if (!next || old.content.data?.signature !== JSON.stringify(next)) await api.cancelScheduledNotificationAsync(old.identifier);
        else byId.delete(old.identifier);
      }
      for (const next of byId.values()) {
        await api.scheduleNotificationAsync({
          identifier: next.identifier,
          content: { ...next.content, sound: 'default', data: { ...next.content.data, signature: JSON.stringify(next) } },
          trigger: { type: 'date', date: new Date(next.fireAt), channelId: 'custody-exchanges' },
        });
      }
      return wanted.length;
    });
    queue = run.catch(() => {});
    return run;
  };
}

module.exports = { REMINDER_PREFIX, exchangeDate, planReminders, createReminderScheduler };
