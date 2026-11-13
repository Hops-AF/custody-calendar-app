// Custody report: a multi-page PDF for a reporting window, meant to be kept or handed to an
// attorney. Pure HTML generation like print-calendar.js, so it runs under node --test; App.js
// renders it with expo-print at US Letter landscape (792 x 612 pt, zero margins).
//
// Contents: custody days by schedule, planned vs. actual, per-child totals, holiday rules in
// the period, the log of changes, and one month calendar per month.
//
// Privacy: private entry notes, addresses, phone numbers and exchange places are never
// included. Log notes are included only when includeNotes is true.
const { computeCustodySummary, enumerateDates, parseDate } = require('./custody-engine');
const { computeDeviationReport, deviationsOnDate, childNames, TYPE_LABELS } = require('./deviation-log');
const { holidayRange, ruleParentForYear } = require('./holiday-rules');
const { monthPage, MONTH_CSS, MONTHS, escapeHtml, safeColor, tint } = require('./print-calendar');

const MAX_CALENDAR_MONTHS = 24;
// Usable height of a flowing page: 816px sheet, minus padding and the page footer.
const PAGE_BUDGET = 690;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const esc = escapeHtml;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const signed = (value) => (value > 0 ? `+${value}` : value < 0 ? `&minus;${Math.abs(value)}` : '0');

// Locale-independent date labels, so the report reads the same on every device.
function shortDate(dateStr, withYear = true) {
  const d = parseDate(dateStr);
  if (!d) return '';
  return `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}${withYear ? `, ${d.getFullYear()}` : ''}`;
}
function dayDate(dateStr) {
  const d = parseDate(dateStr);
  return d ? `${WEEKDAYS[d.getDay()]}, ${shortDate(dateStr)}` : '';
}
function rangeLabel(start, end) {
  if (start === end) return dayDate(start);
  return start.slice(0, 4) === end.slice(0, 4)
    ? `${shortDate(start, false)} &ndash; ${shortDate(end)}`
    : `${shortDate(start)} &ndash; ${shortDate(end)}`;
}
function loggedDate(iso) {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}, ${d.getFullYear()}` : '';
}

// Rough line count for a wrapped table cell.
function lines(text, perLine) {
  return String(text || '').split('\n').reduce((sum, part) => sum + Math.max(1, Math.ceil(part.length / perLine)), 0);
}

// ── layout ───────────────────────────────────────────────────────────────────

// Packs blocks into fixed-height pages. Table rows repeat their table header on each page, and
// a heading reserves room for what follows it so it never ends a page on its own.
function layout(blocks, budget = PAGE_BUDGET) {
  const pages = [];
  let current = [];
  let used = 0;
  let openTable = null;
  const closeTable = () => { if (openTable) { current.push('</tbody></table>'); openTable = null; } };
  const newPage = () => { closeTable(); pages.push(current.join('')); current = []; used = 0; };

  for (const block of blocks) {
    if (block.table) {
      const table = block.table;
      const need = (openTable === table ? 0 : table.headH) + block.h;
      if (used > 0 && used + need > budget) newPage();
      if (openTable !== table) {
        closeTable();
        current.push(`<table class="rt ${table.cls || ''}"><thead>${table.head}</thead><tbody>`);
        used += table.headH;
        openTable = table;
      }
      current.push(block.html);
      used += block.h;
    } else {
      closeTable();
      if (used > 0 && used + block.h + (block.reserve || 0) > budget) newPage();
      current.push(block.html);
      used += block.h;
    }
  }
  closeTable();
  if (current.length) pages.push(current.join(''));
  return pages;
}

const heading = (title, reserve) => ({ html: `<h2>${esc(title)}</h2>`, h: 38, reserve });
const para = (html, textLength, perLine = 150) => ({ html: `<p>${html}</p>`, h: lines(' '.repeat(textLength), perLine) * 18 + 8 });

function tableRows(table, rows) {
  return rows.map((row) => ({ table, html: row.html, h: row.h }));
}

// ── sections ─────────────────────────────────────────────────────────────────

function swatch(color) {
  return `<span class="sw" style="background:${tint(color)};box-shadow:inset 5px 0 0 ${color}"></span>`;
}

function summarySection({ summary, unit, primary, colorOf }) {
  const blocks = [];
  if (!summary.rows.length) return [heading('Custody days by schedule'), para('No custody days fall in this period.', 40)];
  const table = { head: `<tr><th>Parent</th><th class="n">${esc(unit)}</th><th class="n">Share</th></tr>`, headH: 28, cls: 'narrow' };
  const rows = summary.rows.map((r) => ({
    h: 30,
    html: `<tr><td>${swatch(colorOf(r.parent))}${esc(r.parent)}</td><td class="n">${r.custodyDays}</td><td class="n">${r.percentage}%</td></tr>`,
  }));
  blocks.push(heading('Custody days by schedule', table.headH + 30), ...tableRows(table, rows));
  const notes = [];
  if (primary) notes.push(`Days without a specific entry are credited to ${esc(primary)} (primary parent).`);
  if (summary.conflictDays) notes.push(`${plural(summary.conflictDays, 'child-day')} with overlapping entries for the same child ${summary.conflictDays === 1 ? 'is' : 'are'} left out until corrected.`);
  if (notes.length) blocks.push(para(notes.join(' '), notes.join(' ').length));
  return blocks;
}

function actualSection({ report, unit, colorOf }) {
  const { counts } = report;
  const total = counts.late + counts.missed + counts.swap;
  if (!total) {
    return [heading('Planned vs. actual'), para('Nothing was logged in this period, so actual days are shown as matching the schedule.', 90)];
  }
  const table = {
    head: `<tr><th>Parent</th><th class="n">Planned</th><th class="n">Actual</th><th class="n">Change</th></tr>`,
    headH: 28, cls: 'narrow',
  };
  const rows = report.rows.map((r) => ({
    h: 30,
    html: `<tr><td>${swatch(colorOf(r.parent))}${esc(r.parent)}</td><td class="n">${r.plannedDays} <span class="pc">${r.plannedPercentage}%</span></td>`
      + `<td class="n">${r.actualDays} <span class="pc">${r.actualPercentage}%</span></td><td class="n${r.difference ? ' chg' : ''}">${signed(r.difference)}</td></tr>`,
  }));
  const facts = [];
  if (report.changedDays) facts.push(`${report.changedDays} ${unit.toLowerCase()} went differently from the schedule.`);
  if (counts.missed) facts.push(`Missed time: ${counts.missed}.`);
  if (counts.swap) facts.push(`Agreed swaps: ${counts.swap}.`);
  if (counts.late) facts.push(`Late exchanges: ${counts.late} (${plural(report.minutesLate, 'minute')} in total).`);
  for (const [parent, tally] of Object.entries(report.lateByParent)) {
    facts.push(`${parent}: late ${plural(tally.count, 'time')}, ${plural(tally.minutes, 'minute')}.`);
  }
  const text = facts.join(' ');
  return [
    heading('Planned vs. actual', table.headH + 30),
    ...tableRows(table, rows),
    para(esc(text), text.length),
  ];
}

function childSection({ entries, parents, children, start, end, colorOf }) {
  const perChild = children.map((child) => ({
    child, summary: computeCustodySummary({ entries, parents, children, start, end, childFilter: child }),
  }));
  const shown = [...new Set(perChild.flatMap((c) => c.summary.rows.map((r) => r.parent)))];
  if (!shown.length) return [];
  const table = {
    head: `<tr><th>Child</th>${shown.map((p) => `<th class="n">${swatch(colorOf(p))}${esc(p)}</th>`).join('')}</tr>`,
    headH: 28, cls: shown.length <= 3 ? 'narrow' : '',
  };
  const rows = perChild.map(({ child, summary }) => ({
    h: 30,
    html: `<tr><td>${esc(child)}</td>${shown.map((p) => {
      const row = summary.rows.find((r) => r.parent === p);
      return `<td class="n">${row ? `${row.custodyDays} <span class="pc">${row.percentage}%</span>` : '0'}</td>`;
    }).join('')}</tr>`,
  }));
  return [heading('Days by child (schedule)', table.headH + 30), ...tableRows(table, rows)];
}

function rulesSection({ holidayRules, start, end, children, childFilter }) {
  const items = [];
  const startYear = Number(start.slice(0, 4));
  const endYear = Number(end.slice(0, 4));
  for (const rule of holidayRules || []) {
    if (childFilter !== 'all' && !rule.children.includes(childFilter)) continue;
    for (let year = Math.max(startYear, rule.fromYear); year <= Math.min(endYear, rule.toYear); year += 1) {
      const range = holidayRange(rule, year);
      if (range && range.start <= end && range.end >= start) items.push({ rule, year, range });
    }
  }
  if (!items.length) return [];
  items.sort((a, b) => a.range.start.localeCompare(b.range.start));
  const table = {
    head: '<tr><th>Holiday</th><th>Dates</th><th>With</th><th>Rule</th><th>Children</th></tr>', headH: 28,
  };
  const rows = items.map(({ rule, year, range }) => {
    const ruleText = rule.evenParent === rule.oddParent ? `Every year: ${rule.evenParent}` : `Even years: ${rule.evenParent}; odd years: ${rule.oddParent}`;
    const kids = rule.children.length === children.length ? 'All' : rule.children.join(', ');
    return {
      h: Math.max(lines(ruleText, 34), lines(kids, 18)) * 16 + 14,
      html: `<tr><td>${esc(rule.name)}</td><td>${rangeLabel(range.start, range.end)}</td><td>${esc(ruleParentForYear(rule, year))}</td>`
        + `<td>${esc(ruleText)}</td><td>${esc(kids)}</td></tr>`,
    };
  });
  return [heading('Holidays in this period', table.headH + rows[0].h), ...tableRows(table, rows)];
}

function logSection({ report, unit, includeNotes }) {
  if (!report.items.length) return [];
  const table = {
    head: `<tr><th class="c-date">Date</th><th class="c-what">What happened</th><th class="c-kids">Children</th><th class="c-effect">Effect</th>`
      + `${includeNotes ? '<th class="c-note">Note</th>' : ''}<th class="c-logged">Logged</th></tr>`,
    headH: 28, cls: 'log',
  };
  const rows = report.items.map(({ deviation: d, changedDays, plannedParents }) => {
    const kids = childNames(d).join(', ') || 'All children';
    const effect = d.type === 'late'
      ? `${d.minutesLate} min late${d.lateParent ? ` (${d.lateParent})` : ''}`
      : `With ${d.actualParent}${plannedParents.length ? `; scheduled ${plannedParents.join(' / ')}` : ''}. `
        + (changedDays ? `${changedDays} ${unit.toLowerCase()} changed` : 'No change to the count');
    const note = includeNotes ? d.note || '' : '';
    const h = Math.max(lines(effect, 26), lines(kids, 16), includeNotes ? lines(note, 48) : 1, 1) * 16 + 14;
    return {
      h,
      html: `<tr><td>${rangeLabel(d.date, d.endDate)}</td><td>${esc(TYPE_LABELS[d.type])}</td><td>${esc(kids)}</td><td>${esc(effect)}</td>`
        + `${includeNotes ? `<td class="note">${esc(note)}</td>` : ''}<td>${esc(loggedDate(d.loggedAt))}</td></tr>`,
    };
  });
  return [heading('Logged changes', table.headH + rows[0].h), ...tableRows(table, rows)];
}

function aboutSection({ includeNotes, calendarNote }) {
  const items = [
    'Schedule days come from the custody entries, schedules and holiday rules recorded in Custody Calendar. Each date counts once for each child.',
    'Actual days apply the logged changes listed in this report. Days with nothing logged are counted as going to plan.',
    'Prepared from one parent’s records on their own device. It has not been confirmed by the other parent and is not a verified record.',
    includeNotes ? '' : 'Log notes were left out of this copy.',
    'Private entry notes, home addresses, phone numbers and exchange places are not included.',
    calendarNote || '',
  ].filter(Boolean);
  return [heading('About this report', 80), ...items.map((text) => para(esc(text), text.length))];
}

// ── report ───────────────────────────────────────────────────────────────────

function monthsBetween(start, end) {
  const months = [];
  let year = Number(start.slice(0, 4));
  let month = Number(start.slice(5, 7)) - 1;
  const lastYear = Number(end.slice(0, 4));
  const lastMonth = Number(end.slice(5, 7)) - 1;
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    months.push({ year, month });
    month += 1;
    if (month === 12) { month = 0; year += 1; }
  }
  return months;
}

function calendarMarks(dateStr, deviations, child) {
  return [...new Set(deviationsOnDate(dateStr, deviations, child).map((d) => (
    d.type === 'late' ? `Late ${d.minutesLate} min` : `${d.type === 'swap' ? 'Swap' : 'Missed'} → ${d.actualParent}`
  )))];
}

// parentColors: { [parentName]: '#rrggbb' } (resolved). childFilter: 'all' or a child's name.
function buildCustodyReport({
  entries = [], parents = [], children = [], deviations = [], holidayRules = [], parentColors = {},
  start, end, childFilter = 'all', includeNotes = true, preparedOn = '',
}) {
  if (!parseDate(start) || !parseDate(end) || end < start) throw new Error('Choose a reporting period with an end date on or after the start date.');

  const selectedChildren = childFilter === 'all' ? children : [childFilter];
  const unit = childFilter === 'all' && children.length > 1 ? 'Child-days' : 'Days';
  const primary = parents[0] || null;
  const colorOf = (name) => safeColor(parentColors[name]);
  const who = selectedChildren.length ? selectedChildren.join(' & ') : 'Family';
  const period = `${shortDate(start)} &ndash; ${shortDate(end)}`;
  const dayCount = enumerateDates(start, end).length;

  const summary = computeCustodySummary({ entries, parents, children, start, end, childFilter });
  const report = computeDeviationReport({ entries, parents, children, deviations, start, end, childFilter });

  const months = monthsBetween(start, end);
  const showCalendars = months.length <= MAX_CALENDAR_MONTHS;
  const calendarNote = showCalendars ? ''
    : `Month calendars are included for periods of up to ${MAX_CALENDAR_MONTHS} months. This period covers ${months.length}; choose a shorter period to include them.`;

  const intro = {
    h: 150,
    html: `<div class="intro"><div class="title">Custody report</div>`
      + `<div class="meta"><div><b>Children:</b> ${esc(who)}</div><div><b>Period:</b> ${period} (${plural(dayCount, 'day')})</div>`
      + `<div><b>Counted:</b> ${summary.totalUnits} ${esc(unit.toLowerCase())}</div><div><b>Prepared:</b> ${esc(preparedOn)}</div></div></div>`,
  };

  const blocks = [
    intro,
    ...summarySection({ summary, unit, primary, colorOf }),
    ...actualSection({ report, unit, colorOf }),
    ...(childFilter === 'all' && children.length > 1 ? childSection({ entries, parents, children, start, end, colorOf }) : []),
    ...rulesSection({ holidayRules, start, end, children, childFilter }),
    ...logSection({ report, unit, includeNotes }),
    ...aboutSection({ includeNotes, calendarNote }),
  ];

  const flowPages = layout(blocks);
  const total = flowPages.length + (showCalendars ? months.length : 0);
  const footer = (n) => `Custody report &middot; ${esc(who)} &middot; ${period} &middot; Page ${n} of ${total}`;

  const ctx = {
    entries,
    parents,
    children: selectedChildren,
    primary,
    colorOf,
    printedOn: preparedOn,
    markOf: (date) => calendarMarks(date, deviations, childFilter === 'all' ? null : childFilter),
    isOutside: (date) => date < start || date > end,
    pageNote: (year, month) => {
      const n = flowPages.length + months.findIndex((m) => m.year === year && m.month === month) + 1;
      const partial = `${year}-${String(month + 1).padStart(2, '0')}` === start.slice(0, 7) && start.slice(8) !== '01'
        || `${year}-${String(month + 1).padStart(2, '0')}` === end.slice(0, 7) && Number(end.slice(8)) !== new Date(year, month + 1, 0).getDate();
      return `Schedule shown. ${partial ? `Faded days fall outside ${shortDate(start)} to ${shortDate(end)} and are not counted. ` : ''}`
        + `${report.items.length ? 'Logged changes are listed on each day. ' : ''}Page ${n} of ${total}.`;
    },
  };

  const flowHtml = flowPages.map((page, i) => `<section class="page rp"><div class="flow">${page}</div><div class="rfoot">${footer(i + 1)}</div></section>`);
  const monthHtml = showCalendars ? months.map((m) => monthPage(m.year, m.month, ctx)) : [];

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Custody report ${esc(start)} to ${esc(end)}</title>
<style>
${MONTH_CSS}
  .rp { padding: 40px 44px 28px; }
  .flow { flex: 1; overflow: hidden; }
  .rfoot { font-size: 11px; color: #4b5563; border-top: 1px solid #d1d5db; padding-top: 6px; }
  .intro { border-bottom: 2px solid #111827; padding-bottom: 12px; margin-bottom: 6px; }
  .title { font-size: 30px; font-weight: 800; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; font-size: 14px; margin-top: 10px; color: #1f2937; }
  h2 { font-size: 17px; margin: 16px 0 8px; }
  p { font-size: 13px; line-height: 18px; margin: 6px 0; color: #1f2937; }
  table.rt { margin-bottom: 4px; }
  table.rt.narrow { width: 62%; }
  .rt th { text-align: left; font-size: 10.5px; padding: 6px 8px; height: auto; }
  .rt td { height: auto; padding: 6px 8px; font-size: 12.5px; line-height: 16px; vertical-align: top; overflow: visible; }
  .rt .n { text-align: right; white-space: nowrap; }
  .rt .pc { color: #4b5563; font-size: 11px; margin-left: 4px; }
  .rt .chg { font-weight: 700; }
  .rt .note { white-space: pre-wrap; font-size: 11.5px; line-height: 15px; }
  .rt .sw { width: 18px; height: 11px; margin-right: 7px; vertical-align: -1px; }
  .log .c-date { width: 140px; } .log .c-what { width: 110px; } .log .c-kids { width: 105px; }
  .log .c-effect { width: 185px; } .log .c-logged { width: 88px; }
</style></head>
<body>${[...flowHtml, ...monthHtml].join('\n')}</body></html>`;
}

module.exports = { buildCustodyReport, layout, monthsBetween, MAX_CALENDAR_MONTHS, PAGE_BUDGET };
