const { getChildDayState, resolveLocation } = require('./custody-engine');

function monthWeeks(year, month) {
  const first = new Date(year, month, 1).getDay();
  const count = new Date(year, month + 1, 0).getDate();
  return Array.from({ length: Math.ceil((first + count) / 7) }, (_, week) =>
    Array.from({ length: 7 }, (_, column) => {
      const day = week * 7 + column - first + 1;
      return day < 1 || day > count ? null
        : `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }));
}

function textOnColor(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return '#182421';
  const channels = hex.slice(1).match(/../g).map((part) => {
    const s = parseInt(part, 16) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return (luminance + 0.05) / 0.05 > 1.05 / (luminance + 0.05) ? '#000000' : '#ffffff';
}

function dayDetails({ date, entries, parents, children, childFilter, parentLocations }) {
  const selected = childFilter ? [childFilter] : (children.length ? children : [null]);
  return selected.map((child) => {
    const state = getChildDayState(date, entries, child);
    const parent = state.type === 'unassigned' ? parents[0] || null : state.parent;
    return {
      child, parent, type: state.type, entry: state.entry,
      source: state.type === 'conflict' ? 'Overlapping entries'
        : state.type === 'unassigned' ? (parent ? 'Primary-parent default' : 'No schedule')
        : state.isException ? 'Holiday / exception' : 'Scheduled',
      location: resolveLocation(state.entry, parentLocations) || (parentLocations[parent] || ''),
      entries: entries.filter((e) => e.parent && e.beginDate <= date && e.endDate >= date && (!child || e.childrenPresent?.[child])),
    };
  });
}

function dayShareText(date, details) {
  return [
    `Family schedule | ${date}`,
    ...details.map((d) => [
      `${d.child || 'Family'}: ${d.type === 'conflict' ? 'Schedule needs review' : d.parent || 'Not scheduled'}`,
      `Basis: ${d.source}`,
      d.type === 'conflict' ? null : `Exchange time: ${d.entry?.exchangeTime || 'Not set'}`,
      d.type === 'conflict' ? null : `Exchange place: ${d.entry?.exchangePlace || 'Not set'}`,
      d.type === 'conflict' || !d.location ? null : `Staying at: ${d.location}`,
    ].filter(Boolean).join('\n')),
    'Snapshot from one device. Not a live update or confirmation by either parent.',
  ].join('\n\n');
}

module.exports = { monthWeeks, textOnColor, dayDetails, dayShareText };
