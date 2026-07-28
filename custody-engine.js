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

module.exports = {
  computeCustodySummary,
  enumerateDates,
  getCalendarDayState,
  getChildDayState,
  parseDate,
  resolveLocation,
};
