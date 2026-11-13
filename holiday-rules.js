const { parseDate } = require('./custody-engine');

// Recurring holiday rules from a parenting plan, such as "Thanksgiving goes to
// one parent in even years and the other in odd years". A rule generates one
// holiday/exception entry per year, which overrides the recurring schedule.
//
// Rule shape:
//   { id, holiday, name, month?, day?, daysBefore, daysAfter,
//     evenParent, oddParent, children: [names], fromYear, toYear }
// `holiday` is a key from HOLIDAYS, or 'custom' with its own month and day
// (birthdays, for example). The year of the holiday itself decides even/odd.

const MAX_RULES = 100;
const MAX_YEAR_SPAN = 20;
const MAX_DAYS_BEFORE = 14;
const MAX_DAYS_AFTER = 30;

// US holidays. `before`/`after` are only starting points for a new rule; orders
// differ, so the span is always editable.
const HOLIDAYS = [
  { key: 'new-years-day', name: "New Year's Day", fixed: [1, 1] },
  { key: 'mlk-day', name: 'Martin Luther King Jr. Day', nth: [1, 1, 3], before: 2 },
  { key: 'presidents-day', name: "Presidents' Day", nth: [2, 1, 3], before: 2 },
  { key: 'easter', name: 'Easter', easter: true },
  { key: 'mothers-day', name: "Mother's Day", nth: [5, 0, 2] },
  { key: 'memorial-day', name: 'Memorial Day', nth: [5, 1, -1], before: 2 },
  { key: 'fathers-day', name: "Father's Day", nth: [6, 0, 3] },
  { key: 'juneteenth', name: 'Juneteenth', fixed: [6, 19] },
  { key: 'independence-day', name: 'Independence Day', fixed: [7, 4] },
  { key: 'labor-day', name: 'Labor Day', nth: [9, 1, 1], before: 2 },
  { key: 'halloween', name: 'Halloween', fixed: [10, 31] },
  { key: 'thanksgiving', name: 'Thanksgiving', nth: [11, 4, 4], after: 3 },
  { key: 'christmas-eve', name: 'Christmas Eve', fixed: [12, 24] },
  { key: 'christmas-day', name: 'Christmas Day', fixed: [12, 25] },
  { key: 'new-years-eve', name: "New Year's Eve", fixed: [12, 31] },
];
const HOLIDAY_BY_KEY = Object.fromEntries(HOLIDAYS.map((h) => [h.key, h]));

function pad2(value) { return String(value).padStart(2, '0'); }
function iso(year, month, day) { return `${year}-${pad2(month)}-${pad2(day)}`; }

// The nth given weekday of a month (n = -1 for the last one). month is 1-12,
// weekday is 0 (Sunday) to 6.
function nthWeekday(year, month, weekday, n) {
  if (n > 0) {
    const first = new Date(year, month - 1, 1).getDay();
    const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
    return day <= new Date(year, month, 0).getDate() ? iso(year, month, day) : null;
  }
  const lastDay = new Date(year, month, 0).getDate();
  const last = new Date(year, month - 1, lastDay).getDay();
  return iso(year, month, lastDay - ((last - weekday + 7) % 7));
}

// Western (Gregorian) Easter Sunday, by the anonymous Gregorian algorithm.
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

function shift(dateStr, days) {
  const date = parseDate(dateStr);
  date.setDate(date.getDate() + days);
  return iso(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

// The holiday's own date in a year, or null when it does not occur (a custom
// February 29 rule in a non-leap year).
function holidayDate(rule, year) {
  if (rule.holiday === 'custom') {
    const dateStr = iso(year, rule.month, rule.day);
    return parseDate(dateStr) ? dateStr : null;
  }
  const holiday = HOLIDAY_BY_KEY[rule.holiday];
  if (!holiday) return null;
  if (holiday.fixed) return iso(year, holiday.fixed[0], holiday.fixed[1]);
  if (holiday.easter) return easterSunday(year);
  return nthWeekday(year, holiday.nth[0], holiday.nth[1], holiday.nth[2]);
}

function holidayRange(rule, year) {
  const anchor = holidayDate(rule, year);
  if (!anchor) return null;
  return { date: anchor, start: shift(anchor, -(rule.daysBefore || 0)), end: shift(anchor, rule.daysAfter || 0) };
}

function ruleParentForYear(rule, year) {
  return year % 2 === 0 ? rule.evenParent : rule.oddParent;
}

function isInt(value, min, max) { return Number.isInteger(value) && value >= min && value <= max; }
function isName(value) { return typeof value === 'string' && value.trim() !== '' && value.length <= 100; }

// Returns '' for a valid rule, otherwise a message suitable for the editor.
function holidayRuleError(rule) {
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) return 'Invalid holiday rule.';
  if (typeof rule.id !== 'string' || !rule.id || rule.id.length > 200) return 'Invalid holiday rule.';
  if (rule.holiday !== 'custom' && !HOLIDAY_BY_KEY[rule.holiday]) return 'Choose a holiday.';
  if (!isName(rule.name)) return 'Give this holiday a name.';
  if (rule.holiday === 'custom') {
    if (!isInt(rule.month, 1, 12) || !isInt(rule.day, 1, 31) || !parseDate(iso(2024, rule.month, rule.day))) return 'Choose a real calendar date.';
  }
  if (!isInt(rule.daysBefore, 0, MAX_DAYS_BEFORE) || !isInt(rule.daysAfter, 0, MAX_DAYS_AFTER)) return 'The holiday period is too long.';
  if (!isName(rule.evenParent) || !isName(rule.oddParent)) return 'Choose a parent for even years and for odd years.';
  if (!Array.isArray(rule.children) || rule.children.length > 100 || !rule.children.every(isName) || new Set(rule.children).size !== rule.children.length) return 'Invalid children on a holiday rule.';
  if (!isInt(rule.fromYear, 1900, 9999) || !isInt(rule.toYear, 1900, 9999) || rule.toYear < rule.fromYear) return 'The last year must be on or after the first year.';
  if (rule.toYear - rule.fromYear + 1 > MAX_YEAR_SPAN) return `A rule can cover at most ${MAX_YEAR_SPAN} years.`;
  return '';
}

// One holiday entry per year. IDs are derived from the rule so regenerating a
// rule replaces its own entries instead of duplicating them.
function expandHolidayRule(rule, householdChildren) {
  const entries = [];
  for (let year = rule.fromYear; year <= rule.toYear; year += 1) {
    const range = holidayRange(rule, year);
    if (!range) continue;
    entries.push({
      id: `${rule.id}:${year}`,
      parent: ruleParentForYear(rule, year),
      beginDate: range.start,
      endDate: range.end,
      childrenPresent: Object.fromEntries((householdChildren || []).map((child) => [child, rule.children.includes(child)])),
      note: rule.name,
      isException: true,
      holidayRuleId: rule.id,
    });
  }
  return entries;
}

// Patches for the household store. Saving a rule regenerates its entries, so
// hand edits to those entries are replaced.
function applyHolidayRule(data, rule) {
  const error = holidayRuleError(rule);
  if (error) throw new Error(error);
  const others = (data.holidayRules || []).filter((r) => r.id !== rule.id);
  if (others.length >= MAX_RULES) throw new Error(`A household can have at most ${MAX_RULES} holiday rules.`);
  const exists = (data.holidayRules || []).some((r) => r.id === rule.id);
  return {
    holidayRules: exists ? data.holidayRules.map((r) => (r.id === rule.id ? rule : r)) : [...others, rule],
    entries: [...data.entries.filter((entry) => entry.holidayRuleId !== rule.id), ...expandHolidayRule(rule, data.children)],
  };
}

function removeHolidayRule(data, ruleId) {
  return {
    holidayRules: (data.holidayRules || []).filter((r) => r.id !== ruleId),
    entries: data.entries.filter((entry) => entry.holidayRuleId !== ruleId),
  };
}

// A starting rule for the editor. Every other year alternates from `year`.
function newHolidayRule({ id, holiday, parents, children, year }) {
  const preset = HOLIDAY_BY_KEY[holiday];
  const first = (parents && parents[0]) || '';
  const second = (parents && parents[1]) || first;
  return {
    id,
    holiday: preset ? holiday : 'custom',
    name: preset ? preset.name : '',
    ...(preset ? {} : { month: 1, day: 1 }),
    daysBefore: (preset && preset.before) || 0,
    daysAfter: (preset && preset.after) || 0,
    evenParent: first,
    oddParent: second,
    children: [...(children || [])],
    fromYear: year,
    toYear: year + 4,
  };
}

// Dates in the rule's years where it gives the same child to a different
// parent than another holiday entry. Those days show as conflicts on the
// calendar, so the editor warns before saving.
function holidayRuleOverlaps(data, rule) {
  const others = data.entries.filter((entry) => entry.isException && entry.holidayRuleId !== rule.id && entry.parent && entry.beginDate && entry.endDate);
  const overlaps = [];
  for (const mine of expandHolidayRule(rule, data.children)) {
    for (const other of others) {
      if (other.endDate < mine.beginDate || other.beginDate > mine.endDate || other.parent === mine.parent) continue;
      const shared = Object.keys(mine.childrenPresent).some((child) => mine.childrenPresent[child] && other.childrenPresent && other.childrenPresent[child]);
      if (shared || !Object.keys(mine.childrenPresent).length) {
        overlaps.push({ year: Number(mine.id.slice(mine.id.lastIndexOf(':') + 1)), start: mine.beginDate, end: mine.endDate, with: other.note || 'another holiday entry' });
      }
    }
  }
  return overlaps;
}

module.exports = {
  HOLIDAYS, MAX_RULES, MAX_YEAR_SPAN, MAX_DAYS_BEFORE, MAX_DAYS_AFTER,
  nthWeekday, easterSunday, holidayDate, holidayRange, ruleParentForYear,
  holidayRuleError, expandHolidayRule, applyHolidayRule, removeHolidayRule,
  newHolidayRule, holidayRuleOverlaps,
};
