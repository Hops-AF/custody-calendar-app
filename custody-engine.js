function pad2(value) {
  return String(value).padStart(2, '0');
}

function parseDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return null;
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) return null;
  return date;
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function enumerateDates(start, end) {
  const startDate = parseDate(start);
  const endDate = parseDate(end);
  if (!startDate || !endDate || endDate < startDate) return [];

  const dates = [];
  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    dates.push(formatDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function entryCoversChild(entry, dateStr, child) {
  if (!entry || !entry.parent || !entry.beginDate || !entry.endDate) return false;
  if (dateStr < entry.beginDate || dateStr > entry.endDate) return false;
  if (!child) return true;
  return Boolean(entry.childrenPresent && entry.childrenPresent[child]);
}

// Where the child stays for this entry: an entry-level override wins, else the
// parent's default address.
function resolveLocation(entry, parentLocations) {
  if (!entry) return '';
  if (entry.location) return entry.location;
  return (parentLocations && parentLocations[entry.parent]) || '';
}

function getChildDayState(dateStr, entries, child) {
  const covering = entries.filter((entry) => entryCoversChild(entry, dateStr, child));
  // Holiday/exception entries override the recurring schedule: when any
  // exception covers this child on this date, only exceptions are considered.
  const exceptions = covering.filter((entry) => entry.isException);
  const pool = exceptions.length ? exceptions : covering;
  const isException = exceptions.length > 0;
  const parents = [...new Set(pool.map((entry) => entry.parent))];

  if (parents.length === 0) {
    return { type: 'unassigned', child, parent: null, parents: [], isException: false, entry: null };
  }
  if (parents.length === 1) {
    // `entry` is the deciding entry, so callers can read location/exchange details.
    return { type: 'single', child, parent: parents[0], parents, isException, entry: pool[0] };
  }
  return { type: 'conflict', child, parent: null, parents, isException, entry: null };
}

function getCalendarDayState(dateStr, entries, children, childFilter) {
  const selectedChildren = childFilter
    ? [childFilter]
    : (children && children.length ? children : [null]);
  const childStates = selectedChildren.map((child) => getChildDayState(dateStr, entries, child));
  const isException = childStates.some((state) => state.isException);

  if (childStates.some((state) => state.type === 'conflict')) {
    return { type: 'conflict', parent: null, childStates, isException };
  }

  const assignedParents = [...new Set(
    childStates.filter((state) => state.type === 'single').map((state) => state.parent)
  )];
  const hasUnassigned = childStates.some((state) => state.type === 'unassigned');

  if (assignedParents.length === 0) return { type: 'unassigned', parent: null, childStates, isException };
  if (assignedParents.length === 1 && !hasUnassigned) {
    return { type: 'single', parent: assignedParents[0], childStates, isException };
  }
  return { type: 'split', parent: null, childStates, isException };
}

function computeCustodySummary({ entries, parents, children, start, end, childFilter = 'all' }) {
  const dates = enumerateDates(start, end);
  if (dates.length === 0) return { rows: [], conflictDays: 0, totalUnits: 0 };

  const primary = parents[0] || null;
  const selectedChildren = childFilter === 'all' ? children : [childFilter];
  const totals = {};
  let conflictDays = 0;
  let totalUnits = 0;

  for (const dateStr of dates) {
    for (const child of selectedChildren) {
      const state = getChildDayState(dateStr, entries, child);
      if (state.type === 'conflict') {
        conflictDays += 1;
        continue;
      }

      const owner = state.type === 'single' ? state.parent : primary;
      if (!owner) continue;
      totals[owner] = (totals[owner] || 0) + 1;
      totalUnits += 1;
    }
  }

  const orderedParents = [
    ...parents,
    ...Object.keys(totals).filter((parent) => !parents.includes(parent)),
  ];
  const rows = orderedParents
    .filter((parent) => totals[parent])
    .map((parent) => ({
      parent,
      custodyDays: totals[parent],
      percentage: totalUnits ? Number(((totals[parent] / totalUnits) * 100).toFixed(1)) : 0,
    }));

  return { rows, conflictDays, totalUnits };
}

// ── Calendar export (iCalendar / .ics) ───────────────────────────────────────

// Collapse consecutive days that share the same parent into one block per child,
// so a two-week stretch becomes a single calendar event instead of 14.
// Days with no explicit entry fall back to the primary parent (matching how
// reporting attributes them) unless fillGapsWithPrimary is false.
function buildCustodyBlocks({ entries, parents, children, start, end, childFilter, fillGapsWithPrimary = true }) {
  const dates = enumerateDates(start, end);
  if (dates.length === 0) return [];

  const primary = (parents && parents[0]) || null;
  const selected = childFilter && childFilter !== 'all'
    ? [childFilter]
    : (children && children.length ? children : [null]);

  const blocks = [];
  for (const child of selected) {
    let current = null;
    for (const dateStr of dates) {
      const state = getChildDayState(dateStr, entries, child);
      let owner = state.type === 'single' ? state.parent : null;
      let deciding = state.entry;
      if (!owner && state.type === 'unassigned' && fillGapsWithPrimary) {
        owner = primary;
        deciding = null; // inferred, not an explicit entry
      }

      if (current && owner === current.parent) {
        current.end = dateStr;
        continue;
      }
      if (current) { blocks.push(current); current = null; }
      if (owner) {
        current = {
          child,
          parent: owner,
          start: dateStr,
          end: dateStr,
          entry: deciding,
          isException: Boolean(state.isException),
          inferred: !deciding,
        };
      }
    }
    if (current) blocks.push(current);
  }
  return blocks;
}

// RFC 5545 TEXT escaping: backslash, semicolon, comma, and newlines.
function escapeICSText(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// RFC 5545 requires folding lines longer than 75 octets; continuation lines
// begin with a single space.
function foldICSLine(line) {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 74) {
    parts.push(' ' + rest.slice(0, 74));
    rest = rest.slice(74);
  }
  if (rest.length) parts.push(' ' + rest);
  return parts.join('\r\n');
}

function icsDate(dateStr) {
  return dateStr.replace(/-/g, '');
}

// All-day DTEND is exclusive, so it points at the day after the block ends.
function icsDayAfter(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return icsDate(dateStr);
  d.setDate(d.getDate() + 1);
  return icsDate(formatDate(d));
}

function slugForUid(value) {
  return String(value || '').replace(/[^A-Za-z0-9]/g, '') || 'x';
}

function buildICS({ blocks, parentLocations, calendarName = 'Custody Calendar', now = new Date(), singleChild = false }) {
  const dtstamp = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}T${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}Z`;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Custody Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeICSText(calendarName)}`,
  ];

  for (const block of blocks) {
    const who = block.child && !singleChild ? `${block.child} with ${block.parent}` : `With ${block.parent}`;
    const holidayName = block.isException && block.entry && block.entry.note ? block.entry.note : '';
    const summary = holidayName ? `${who} (${holidayName})` : who;
    const location = resolveLocation(block.entry, parentLocations)
      || (parentLocations && parentLocations[block.parent])
      || '';

    const descParts = [];
    if (block.entry && block.entry.exchangeTime) descParts.push(`Exchange time: ${block.entry.exchangeTime}`);
    if (block.entry && block.entry.exchangePlace) descParts.push(`Exchange place: ${block.entry.exchangePlace}`);
    if (block.entry && block.entry.note && block.entry.note !== holidayName) descParts.push(block.entry.note);
    if (block.inferred) descParts.push('Default schedule (no specific entry).');

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${slugForUid(block.child)}-${slugForUid(block.parent)}-${icsDate(block.start)}-${icsDate(block.end)}@custody-calendar`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART;VALUE=DATE:${icsDate(block.start)}`);
    lines.push(`DTEND;VALUE=DATE:${icsDayAfter(block.end)}`);
    lines.push(`SUMMARY:${escapeICSText(summary)}`);
    if (location) lines.push(`LOCATION:${escapeICSText(location)}`);
    if (descParts.length) lines.push(`DESCRIPTION:${escapeICSText(descParts.join('\n'))}`);
    lines.push('TRANSP:TRANSPARENT');
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldICSLine).join('\r\n') + '\r\n';
}

// ── Kid view ─────────────────────────────────────────────────────────────────

// Answers "where am I today, and when do I switch?" for one child.
// `next` is the upcoming block, and its exchange details describe the handoff
// into that parent's time.
function getKidView({ entries, parents, children, child, today, daysAhead = 14 }) {
  const startDate = parseDate(today);
  if (!startDate) return { current: null, next: null, daysUntilChange: null, upcoming: [] };

  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + daysAhead);

  const blocks = buildCustodyBlocks({
    entries,
    parents,
    children,
    start: today,
    end: formatDate(endDate),
    childFilter: child || 'all',
  });

  const current = blocks.find((b) => today >= b.start && today <= b.end) || null;
  const next = blocks.find((b) => b.start > today) || null;
  const daysUntilChange = next
    ? Math.round((parseDate(next.start) - startDate) / 86400000)
    : null;

  return { current, next, daysUntilChange, upcoming: blocks };
}

// ── Shareable kid page ───────────────────────────────────────────────────────

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Serialise the real engine functions into the shared page so it uses the same
// tested logic rather than a drifting copy.
function kidEngineSource() {
  return [
    pad2, parseDate, formatDate, enumerateDates, entryCoversChild,
    getChildDayState, buildCustodyBlocks, getKidView, resolveLocation,
  ].map((fn) => fn.toString()).join('\n\n');
}

// A self-contained HTML page for a child: no network, no CDN, no editing.
// The schedule data is embedded and re-evaluated each time it is opened, so it
// stays correct as days pass (within the exported window).
function buildKidPage({ entries, parents, children, parentColors, parentLocations, parentPhones, validFrom, validTo, generatedOn }) {
  const data = {
    entries, parents, children, parentColors, parentLocations, parentPhones,
    validFrom, validTo, generatedOn,
  };
  // Guard against "</script>" inside any string field breaking out of the tag.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const title = children && children.length ? `${children.join(' & ')} — Schedule` : 'Custody Schedule';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin:0; padding:16px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
         background:#f4f5f7; color:#111827; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:520px; margin:0 auto; }
  h1 { font-size:1.15rem; margin:0 0 12px; color:#374151; }
  .tabs { display:flex; flex-wrap:wrap; gap:6px; justify-content:center; margin-bottom:12px; }
  .tab { border:none; border-radius:999px; padding:8px 16px; font-size:0.95rem; cursor:pointer;
         background:#e5e7eb; color:#374151; }
  .tab[aria-pressed="true"] { color:#fff; font-weight:700; }
  .today { border-radius:16px; padding:22px; color:#fff; margin-bottom:12px; }
  .today .label { font-size:0.72rem; letter-spacing:.14em; font-weight:700; opacity:.85; }
  .today .who { font-size:1.85rem; font-weight:800; margin:4px 0 10px; line-height:1.15; }
  .today .meta { font-size:1rem; margin-top:4px; }
  .card { background:#fff; border-radius:14px; padding:16px; margin-bottom:12px;
          box-shadow:0 1px 3px rgba(0,0,0,.08); }
  .card h2 { font-size:.72rem; letter-spacing:.1em; text-transform:uppercase; color:#6b7280; margin:0 0 8px; }
  .next-who { font-size:1.25rem; font-weight:700; }
  .next-when { color:#374151; margin-top:3px; }
  .next-meta { color:#4b5563; margin-top:6px; }
  .row { display:flex; align-items:center; padding:8px 0; }
  .bar { width:6px; height:34px; border-radius:3px; margin-right:12px; flex:none; }
  .row .name { font-weight:600; }
  .row .when { font-size:.85rem; color:#6b7280; }
  .foot { text-align:center; color:#6b7280; font-size:.8rem; margin-top:16px; line-height:1.5; }
  .warn { background:#fef3c7; border:1px solid #f59e0b; color:#92400e; border-radius:12px;
          padding:12px 14px; margin-bottom:12px; font-size:.9rem; }
  @media (prefers-color-scheme: dark) {
    body { background:#0f1115; color:#e5e7eb; }
    .card { background:#1a1d24; box-shadow:none; }
    h1, .next-who { color:#e5e7eb; }
    .next-when, .next-meta, .row .when, .foot { color:#9ca3af; }
    .tab { background:#272b33; color:#d1d5db; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>${escapeHtml(title)}</h1>
  <div id="tabs" class="tabs"></div>
  <div id="app"></div>
  <div class="foot" id="foot"></div>
</div>
<script>
const DATA = ${json};

${kidEngineSource()}

var COLOR_FALLBACK = ['#2563eb','#16a34a','#d97706','#7c3aed','#db2777','#0d9488'];
function colorFor(name, list, overrides) {
  if (overrides && overrides[name]) return overrides[name];
  var i = list.indexOf(name);
  return i >= 0 ? COLOR_FALLBACK[i % COLOR_FALLBACK.length] : '#9ca3af';
}
function todayStr() {
  var d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth()+1) + '-' + pad2(d.getDate());
}
function fmt(ds, opts) {
  var d = parseDate(ds);
  return d ? d.toLocaleDateString('en-US', opts) : '';
}
var weekday = function (ds) { return fmt(ds, { weekday:'long' }); };
var shortDate = function (ds) { return fmt(ds, { month:'short', day:'numeric' }); };
function countdown(n) { return n === 0 ? 'today' : n === 1 ? 'tomorrow' : 'in ' + n + ' days'; }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

var active = (DATA.children && DATA.children[0]) || null;

function render() {
  var today = todayStr();
  var app = document.getElementById('app');
  var html = '';

  if (DATA.validTo && today > DATA.validTo) {
    html += '<div class="warn">This schedule ended on ' + esc(shortDate(DATA.validTo)) +
            '. Ask for an updated one.</div>';
  } else if (DATA.validFrom && today < DATA.validFrom) {
    html += '<div class="warn">This schedule starts ' + esc(shortDate(DATA.validFrom)) + '.</div>';
  }

  var view = getKidView({
    entries: DATA.entries, parents: DATA.parents, children: DATA.children,
    child: active, today: today, daysAhead: 14
  });

  var col = view.current ? colorFor(view.current.parent, DATA.parents, DATA.parentColors) : '#9ca3af';
  var loc = view.current
    ? (resolveLocation(view.current.entry, DATA.parentLocations) ||
       (DATA.parentLocations && DATA.parentLocations[view.current.parent]) || '')
    : '';
  var phone = view.current ? ((DATA.parentPhones && DATA.parentPhones[view.current.parent]) || '') : '';

  html += '<div class="today" style="background:' + esc(col) + '">' +
          '<div class="label">TODAY</div><div class="who">' +
          (view.current ? "You're with " + esc(view.current.parent) : 'No schedule for today') +
          '</div>';
  if (view.current && view.current.isException && view.current.entry && view.current.entry.note)
    html += '<div class="meta">\\uD83C\\uDF81 ' + esc(view.current.entry.note) + '</div>';
  if (loc) html += '<div class="meta">\\uD83D\\uDCCD ' + esc(loc) + '</div>';
  if (phone) html += '<div class="meta">\\uD83D\\uDCDE <a style="color:inherit" href="tel:' +
                     esc(phone.replace(/[^0-9+]/g,'')) + '">' + esc(phone) + '</a></div>';
  if (view.current) html += '<div class="meta">Until ' + esc(weekday(view.current.end)) + ', ' +
                            esc(shortDate(view.current.end)) + '</div>';
  html += '</div>';

  html += '<div class="card"><h2>Next switch</h2>';
  if (view.next) {
    html += '<div class="next-who">You go to <span style="color:' +
            esc(colorFor(view.next.parent, DATA.parents, DATA.parentColors)) + '">' +
            esc(view.next.parent) + '</span></div>' +
            '<div class="next-when">' + esc(weekday(view.next.start)) + ', ' +
            esc(shortDate(view.next.start)) + ' &middot; ' + esc(countdown(view.daysUntilChange)) + '</div>';
    if (view.next.entry && view.next.entry.exchangeTime)
      html += '<div class="next-meta">\\uD83D\\uDD55 ' + esc(view.next.entry.exchangeTime) + '</div>';
    if (view.next.entry && view.next.entry.exchangePlace)
      html += '<div class="next-meta">\\uD83D\\uDE97 Meet at ' + esc(view.next.entry.exchangePlace) + '</div>';
  } else {
    html += '<div class="next-meta">No switch in the next two weeks.</div>';
  }
  html += '</div>';

  html += '<div class="card"><h2>Next two weeks</h2>';
  if (!view.upcoming.length) html += '<div class="next-meta">Nothing scheduled.</div>';
  view.upcoming.forEach(function (b) {
    html += '<div class="row"><span class="bar" style="background:' +
            esc(colorFor(b.parent, DATA.parents, DATA.parentColors)) + '"></span><div><div class="name">' +
            esc(b.parent) + (b.isException ? ' \\uD83C\\uDF81' : '') + '</div><div class="when">' +
            (b.start === b.end
              ? esc(weekday(b.start)) + ', ' + esc(shortDate(b.start))
              : esc(shortDate(b.start)) + ' \\u2013 ' + esc(shortDate(b.end))) +
            '</div></div></div>';
  });
  html += '</div>';

  app.innerHTML = html;
  document.getElementById('foot').textContent =
    'Schedule shared on ' + shortDate(DATA.generatedOn) + '. Ask a parent for an updated copy.';
}

function renderTabs() {
  var el = document.getElementById('tabs');
  el.innerHTML = '';
  if (!DATA.children || DATA.children.length < 2) { el.style.display = 'none'; return; }
  DATA.children.forEach(function (c) {
    var b = document.createElement('button');
    b.className = 'tab';
    b.textContent = c;
    b.setAttribute('aria-pressed', String(c === active));
    if (c === active) b.style.background = colorFor(c, DATA.children, {});
    b.onclick = function () { active = c; renderTabs(); render(); };
    el.appendChild(b);
  });
}
function boot() { renderTabs(); render(); }
boot();
</script>
</body>
</html>`;
}

module.exports = {
  buildCustodyBlocks,
  buildICS,
  buildKidPage,
  getKidView,
  escapeICSText,
  computeCustodySummary,
  enumerateDates,
  getCalendarDayState,
  getChildDayState,
  parseDate,
  resolveLocation,
};
