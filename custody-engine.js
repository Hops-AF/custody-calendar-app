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

module.exports = {
  buildCustodyBlocks,
  buildICS,
  escapeICSText,
  computeCustodySummary,
  enumerateDates,
  getCalendarDayState,
  getChildDayState,
  parseDate,
  resolveLocation,
};
