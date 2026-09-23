// Printable month calendar ("fridge calendar"): pure HTML generation, no React Native imports,
// so it runs under node --test. Rendered to paper/PDF by expo-print in App.js.
//
// Privacy: a fridge page is visible to anyone in the home, so it shows parent and child names,
// custody shading, and exchange times only. Notes, addresses, phone numbers, and exchange places
// are deliberately never included.
const { getChildDayState } = require('./custody-engine');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function safeColor(hex) {
  return /^#[0-9a-f]{6}$/i.test(hex || '') ? hex : '#9ca3af';
}

// Light tint of a parent color: readable dark text on top, and easy on printer ink.
function tint(hex, amount = 0.7) {
  const [r, g, b] = safeColor(hex).slice(1).match(/../g).map((part) => parseInt(part, 16));
  const mix = (c) => Math.round(c + (255 - c) * amount).toString(16).padStart(2, '0');
  return `#${mix(r)}${mix(g)}${mix(b)}`;
}

function dateKey(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function previousDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const prev = new Date(y, m - 1, d - 1);
  return dateKey(prev.getFullYear(), prev.getMonth(), prev.getDate());
}

// Who has one child on one date, using the same primary-parent default as My Days and Reports.
function childDay(dateStr, entries, child, primary) {
  const state = getChildDayState(dateStr, entries, child);
  if (state.type === 'conflict') return { child, parent: null, conflict: true, isException: false, entry: null };
  if (state.type === 'unassigned') return { child, parent: primary, conflict: false, isException: false, entry: null, isDefault: true };
  return { child, parent: state.parent, conflict: false, isException: state.isException, entry: state.entry };
}

// Everything the printed cell needs for one date.
function printDay(dateStr, { entries, children, primary }) {
  const kids = children.length ? children : [null];
  const days = kids.map((child) => {
    const today = childDay(dateStr, entries, child, primary);
    const yesterday = childDay(previousDay(dateStr), entries, child, primary);
    const exchange = Boolean(today.parent && yesterday.parent && today.parent !== yesterday.parent);
    return { ...today, exchange, exchangeTime: exchange ? (today.entry?.exchangeTime || '') : '' };
  });
  const parents = [...new Set(days.filter((d) => !d.conflict).map((d) => d.parent).filter(Boolean))];
  const conflict = days.some((d) => d.conflict);
  return {
    date: dateStr,
    days,
    type: conflict ? 'conflict' : parents.length > 1 ? 'split' : parents.length === 1 ? 'single' : 'empty',
    parent: !conflict && parents.length === 1 ? parents[0] : null,
    isException: days.some((d) => d.isException),
    exchangeTimes: [...new Set(days.filter((d) => d.exchange).map((d) => d.exchangeTime || ''))],
  };
}

function cellStyle(day, colorOf) {
  if (day.type === 'single') {
    const color = colorOf(day.parent);
    return `background:${tint(color)};box-shadow:inset 6px 0 0 ${color};`;
  }
  if (day.type === 'conflict') {
    return 'background:repeating-linear-gradient(45deg,#f3f4f6 0 6px,#e5e7eb 6px 12px);';
  }
  return '';
}

function cellHtml(day, colorOf) {
  const num = Number(day.date.slice(8));
  const lines = [];
  if (day.type === 'single') {
    lines.push(`<div class="who">${escapeHtml(day.parent)}</div>`);
  } else if (day.type === 'split') {
    for (const d of day.days) {
      const color = colorOf(d.parent);
      lines.push(`<div class="kid" style="background:${tint(color)};box-shadow:inset 4px 0 0 ${color}"><span class="kname">${escapeHtml(d.child)}</span> ${escapeHtml(d.parent || '')}</div>`);
    }
  } else if (day.type === 'conflict') {
    lines.push('<div class="warn">Check schedule</div>');
  }
  if (day.exchangeTimes.length) {
    const times = day.exchangeTimes.filter(Boolean);
    lines.push(`<div class="swap">&#8646; ${times.length ? escapeHtml(times.join(', ')) : 'Exchange'}</div>`);
  }
  const flag = day.isException ? '<span class="flag">Holiday</span>' : '';
  return `<td style="${cellStyle(day, colorOf)}"><div class="num">${num}${flag}</div>${lines.join('')}</td>`;
}

function monthPage(year, month, ctx) {
  const first = new Date(year, month, 1).getDay();
  const count = new Date(year, month + 1, 0).getDate();
  const weeks = Math.ceil((first + count) / 7);
  const rows = [];
  for (let w = 0; w < weeks; w++) {
    const cells = [];
    for (let c = 0; c < 7; c++) {
      const day = w * 7 + c - first + 1;
      cells.push(day < 1 || day > count
        ? '<td class="blank"></td>'
        : cellHtml(printDay(dateKey(year, month, day), ctx), ctx.colorOf));
    }
    rows.push(`<tr>${cells.join('')}</tr>`);
  }
  const who = ctx.children.length ? ctx.children.join(' & ') : 'Family';
  const legend = ctx.parents.map((p) => (
    `<span class="lg"><span class="sw" style="background:${tint(ctx.colorOf(p))};box-shadow:inset 6px 0 0 ${ctx.colorOf(p)}"></span>${escapeHtml(p)}</span>`
  )).join('');
  return `<section class="page">
  <header><h1>${MONTHS[month]} ${year}</h1><div class="sub">${escapeHtml(who)}</div></header>
  <table class="${weeks > 5 ? 'six' : ''}"><thead><tr>${WEEKDAYS.map((d) => `<th>${d}</th>`).join('')}</tr></thead>
  <tbody>${rows.join('')}</tbody></table>
  <footer><div class="legend">${legend}<span class="lg">&#8646; exchange day</span></div>
  <div class="note">${ctx.primary ? `Days without a specific entry show ${escapeHtml(ctx.primary)} (primary parent). ` : ''}Printed ${escapeHtml(ctx.printedOn)} &mdash; check the app for later changes.</div></footer>
</section>`;
}

// months: [{ year, month }] with month 0-11. parentColors: { [parentName]: '#rrggbb' } (resolved).
function buildPrintableCalendar({ months, entries, parents, children, parentColors = {}, printedOn }) {
  const ctx = {
    entries: entries || [],
    parents: parents || [],
    children: children || [],
    primary: (parents && parents[0]) || null,
    colorOf: (name) => safeColor(parentColors[name]),
    printedOn: printedOn || '',
  };
  const title = `Custody calendar ${months.map((m) => `${MONTHS[m.month]} ${m.year}`).join(', ')}`;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  /* One US Letter landscape sheet per month (11in x 8.5in = 1056 x 816 CSS px at 96/in).
     App.js renders with expo-print printToFileAsync at exactly 792 x 612 pt with zero margins. */
  @page { size: 11in 8.5in; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; }
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #111827; }
  .page { width: 1056px; height: 816px; padding: 36px 38px 28px; display: flex; flex-direction: column; overflow: hidden; page-break-after: always; break-after: page; }
  .page:last-child { page-break-after: auto; break-after: auto; }
  header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
  h1 { font-size: 32px; margin: 0; }
  .sub { font-size: 18px; color: #374151; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #4b5563; padding: 4px; border: 1px solid #9ca3af; background: #f9fafb; }
  td { vertical-align: top; border: 1px solid #9ca3af; padding: 4px 6px 4px 13px; height: 118px; overflow: hidden; }
  table.six td { height: 98px; }
  td.blank { background: #fff; }
  .num { font-size: 16px; font-weight: 700; display: flex; justify-content: space-between; align-items: center; }
  .flag { font-size: 10px; font-weight: 700; border: 1px solid #111827; border-radius: 3px; padding: 0 3px; }
  .who { font-size: 18px; font-weight: 700; margin-top: 6px; }
  .kid { font-size: 12.5px; margin-top: 3px; font-weight: 600; padding: 2px 4px 2px 9px; border-radius: 2px; }
  .kname { color: #374151; font-weight: 400; }
  .warn { font-size: 13px; font-weight: 700; margin-top: 6px; }
  .swap { font-size: 12.5px; font-weight: 700; margin-top: 4px; }
  footer { margin-top: auto; padding-top: 8px; font-size: 12px; color: #374151; }
  .legend { display: flex; flex-wrap: wrap; gap: 18px; margin-bottom: 4px; font-weight: 600; color: #111827; }
  .lg { display: inline-flex; align-items: center; gap: 6px; }
  .sw { display: inline-block; width: 26px; height: 14px; }
</style></head>
<body>${months.map((m) => monthPage(m.year, m.month, ctx)).join('\n')}</body></html>`;
}

module.exports = { buildPrintableCalendar, printDay, tint };
