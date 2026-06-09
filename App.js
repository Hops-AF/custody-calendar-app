import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, Switch,
  Modal, Alert, StyleSheet, SafeAreaView, StatusBar, Platform,
  KeyboardAvoidingView,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

// ── helpers ───────────────────────────────────────────────────────────────────

function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

function toDate(d) {
  if (!d || typeof d !== 'string') return null;
  const parsed = new Date(d + 'T00:00:00.000');
  return isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateStr(date) {
  if (!date) return '';
  return date.toISOString().split('T')[0];
}

function displayDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return new Date(parseInt(y), parseInt(m) - 1, parseInt(d))
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function daysInclusive(start, end) {
  const s = toDate(start), e = toDate(end);
  if (!s || !e || e < s) return null;
  return Math.floor((e - s) / 86400000) + 1;
}

function nightsInclusive(start, end) {
  const d = daysInclusive(start, end);
  return d === null ? null : Math.max(0, d - 1);
}

function overlapDays(a0, a1, b0, b1) {
  const aS = toDate(a0), aE = toDate(a1), bS = toDate(b0), bE = toDate(b1);
  if (!aS || !aE || !bS || !bE) return 0;
  const oS = new Date(Math.max(aS, bS));
  const oE = new Date(Math.min(aE, bE));
  if (oS > oE) return 0;
  return Math.floor((oE - oS) / 86400000) + 1;
}

// Local-time-safe date helpers (avoid UTC shift from toISOString)
function pad2(n) { return String(n).padStart(2, '0'); }

function localTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

// Who has the child the night of `dateStr`? An entry [begin,end] covers the
// nights begin .. end-1 (handoff happens on the end day). Nights not covered
// by any explicit entry default to the primary parent.
function getNightOwner(dateStr, entries, primaryParent) {
  const owners = [];
  for (const e of entries) {
    if (!e.beginDate || !e.endDate || !e.parent) continue;
    if (dateStr >= e.beginDate && dateStr < e.endDate) owners.push(e.parent);
  }
  const distinct = [...new Set(owners)];
  if (distinct.length === 0) return { parent: primaryParent || null, conflict: false, explicit: false };
  if (distinct.length === 1) return { parent: distinct[0], conflict: false, explicit: true };
  return { parent: distinct[0], conflict: true, explicit: true };
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

const PARENT_PALETTE = [
  { bg: '#dbeafe', fg: '#1d4ed8', solid: '#2563eb' }, // blue
  { bg: '#dcfce7', fg: '#15803d', solid: '#16a34a' }, // green
  { bg: '#fef3c7', fg: '#b45309', solid: '#d97706' }, // amber
  { bg: '#ede9fe', fg: '#6d28d9', solid: '#7c3aed' }, // purple
  { bg: '#fce7f3', fg: '#be185d', solid: '#db2777' }, // pink
  { bg: '#ccfbf1', fg: '#0f766e', solid: '#0d9488' }, // teal
];

// ── storage ───────────────────────────────────────────────────────────────────

const STORAGE_KEY = '@custody_calendar_data';

async function saveData(data) {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.error('Save failed', e);
  }
}

async function loadData() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

// ── schedule generators ───────────────────────────────────────────────────────

function generateEOWSchedule(secondaryParent, startDateStr, endDateStr, childrenList, weekendStartDay) {
  const entries = [];
  const start = new Date(startDateStr + 'T00:00:00.000');
  const end = new Date(endDateStr + 'T00:00:00.000');
  const targetDay = weekendStartDay === 'fri' ? 5 : 6;

  let current = new Date(start);
  while (current.getDay() !== targetDay) current.setDate(current.getDate() + 1);

  let weekendNum = 0;
  while (current <= end) {
    if (weekendNum % 2 === 0) {
      const wStart = new Date(current);
      const wEnd = new Date(current);
      while (wEnd.getDay() !== 0) wEnd.setDate(wEnd.getDate() + 1);
      const actualStart = wStart < start ? new Date(start) : wStart;
      const actualEnd = wEnd > end ? new Date(end) : wEnd;
      if (actualStart <= actualEnd) {
        const cp = {};
        childrenList.forEach((c) => { cp[c] = true; });
        entries.push({
          id: generateId(),
          parent: secondaryParent,
          beginDate: actualStart.toISOString().split('T')[0],
          endDate: actualEnd.toISOString().split('T')[0],
          childrenPresent: cp,
          note: 'EOW',
        });
      }
    }
    current.setDate(current.getDate() + 7);
    weekendNum++;
  }
  return entries;
}

function generateJointWeeklySchedule(parent1, parent2, startDateStr, endDateStr, childrenList) {
  const entries = [];
  const start = new Date(startDateStr + 'T00:00:00.000');
  const end = new Date(endDateStr + 'T00:00:00.000');

  let current = new Date(start);
  while (current.getDay() !== 1) current.setDate(current.getDate() + 1);

  let weekNum = 0;
  while (current <= end) {
    const wStart = new Date(current);
    const wEnd = new Date(current);
    wEnd.setDate(wEnd.getDate() + 6);
    const parent = weekNum % 2 === 0 ? parent1 : parent2;
    const actualStart = wStart < start ? new Date(start) : wStart;
    const actualEnd = wEnd > end ? new Date(end) : wEnd;
    if (actualStart <= actualEnd) {
      const cp = {};
      childrenList.forEach((c) => { cp[c] = true; });
      entries.push({
        id: generateId(),
        parent,
        beginDate: actualStart.toISOString().split('T')[0],
        endDate: actualEnd.toISOString().split('T')[0],
        childrenPresent: cp,
        note: `Week ${weekNum + 1}`,
      });
    }
    current.setDate(current.getDate() + 7);
    weekNum++;
  }
  return entries;
}

// ── CalendarView ──────────────────────────────────────────────────────────────

function CalendarView({ entries, parents, onAddEntry }) {
  const now = new Date();
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth());
  const [selectedDay, setSelectedDay] = useState(null);

  const primary = parents[0] || null;
  const todayStr = localTodayStr();

  const colorFor = (parent) => {
    const idx = parents.indexOf(parent);
    return idx >= 0 ? PARENT_PALETTE[idx % PARENT_PALETTE.length] : null;
  };

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDow = new Date(viewYear, viewMonth, 1).getDay();

  const prevMonth = () => {
    setSelectedDay(null);
    if (viewMonth === 0) { setViewMonth(11); setViewYear((y) => y - 1); }
    else setViewMonth((m) => m - 1);
  };
  const nextMonth = () => {
    setSelectedDay(null);
    if (viewMonth === 11) { setViewMonth(0); setViewYear((y) => y + 1); }
    else setViewMonth((m) => m + 1);
  };

  // Nights-per-parent tally for the displayed month
  const monthTally = {};
  let hasConflict = false;
  for (let day = 1; day <= daysInMonth; day++) {
    const ds = `${viewYear}-${pad2(viewMonth + 1)}-${pad2(day)}`;
    const owner = getNightOwner(ds, entries, primary);
    if (owner.conflict) hasConflict = true;
    if (owner.parent) monthTally[owner.parent] = (monthTally[owner.parent] || 0) + 1;
  }

  const selectedOwner = selectedDay ? getNightOwner(selectedDay, entries, primary) : null;
  const selectedEntries = selectedDay
    ? entries.filter((e) => e.beginDate && e.endDate && selectedDay >= e.beginDate && selectedDay < e.endDate)
    : [];

  return (
    <View>
      {/* Calendar grid */}
      <View style={styles.card}>
        <View style={styles.calNav}>
          <TouchableOpacity onPress={prevMonth} style={styles.calNavBtn}>
            <Text style={styles.calNavArrow}>‹</Text>
          </TouchableOpacity>
          <Text style={styles.calNavTitle}>{MONTH_NAMES[viewMonth]} {viewYear}</Text>
          <TouchableOpacity onPress={nextMonth} style={styles.calNavBtn}>
            <Text style={styles.calNavArrow}>›</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.calWeekRow}>
          {DAY_NAMES.map((d) => <Text key={d} style={styles.calWeekday}>{d}</Text>)}
        </View>

        <View style={styles.calGrid}>
          {Array.from({ length: firstDow }).map((_, i) => <View key={'blank' + i} style={styles.calCell} />)}
          {Array.from({ length: daysInMonth }).map((_, i) => {
            const day = i + 1;
            const ds = `${viewYear}-${pad2(viewMonth + 1)}-${pad2(day)}`;
            const owner = getNightOwner(ds, entries, primary);
            const col = owner.parent ? colorFor(owner.parent) : null;
            const isToday = ds === todayStr;
            const isSel = ds === selectedDay;
            return (
              <TouchableOpacity key={day} style={styles.calCell} activeOpacity={0.6} onPress={() => setSelectedDay(isSel ? null : ds)}>
                <View style={[
                  styles.calDay,
                  col && { backgroundColor: col.bg },
                  owner.conflict && styles.calDayConflict,
                  isSel && styles.calDaySelected,
                ]}>
                  <Text style={[styles.calDayNum, col && { color: col.fg }, isToday && styles.calDayToday]}>{day}</Text>
                  {col && <View style={[styles.calDot, { backgroundColor: col.solid }]} />}
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Legend + month tally */}
      <View style={styles.card}>
        <Text style={styles.fieldLabel}>Legend · nights this month</Text>
        {parents.length === 0 && (
          <Text style={styles.modalEmpty}>Add parents in the Entries tab to color the calendar.</Text>
        )}
        {parents.map((p, idx) => {
          const col = colorFor(p);
          return (
            <View key={p} style={styles.legendRow}>
              <View style={[styles.legendSwatch, { backgroundColor: col.solid }]} />
              <Text style={styles.legendText}>{p}{idx === 0 ? ' (Primary)' : ''}</Text>
              <Text style={styles.legendCount}>{monthTally[p] || 0} nights</Text>
            </View>
          );
        })}
        {hasConflict && (
          <Text style={styles.calConflictNote}>⚠ Some nights have conflicting entries (outlined in red).</Text>
        )}
        <Text style={styles.calHint}>
          Each day shows who the child stays with that night. Unassigned nights default to the primary parent.
        </Text>
      </View>

      {/* Selected day detail */}
      {selectedDay && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>{displayDate(selectedDay)}</Text>
          <Text style={styles.windowInfo}>
            Night with: <Text style={{ fontWeight: '700', color: '#111827' }}>{selectedOwner?.parent || '—'}</Text>
            {selectedOwner?.conflict ? '  ⚠ conflicting entries' : (selectedOwner?.explicit ? '' : '  (default · primary)')}
          </Text>
          {selectedEntries.map((e) => (
            <View key={e.id} style={styles.durationBadge}>
              <Text style={styles.durationText}>
                {e.parent}: {displayDate(e.beginDate)} – {displayDate(e.endDate)}{e.note ? ` · ${e.note}` : ''}
              </Text>
            </View>
          ))}
          <TouchableOpacity style={[styles.btnPrimary, { marginTop: 12, alignSelf: 'flex-start' }]} onPress={() => onAddEntry(selectedDay)}>
            <Text style={styles.btnText}>+ Add entry on this day</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [parents, setParents] = useState([]);
  const [children, setChildren] = useState([]);
  const [entries, setEntries] = useState([
    { id: generateId(), parent: '', beginDate: '', endDate: '', childrenPresent: {}, note: '' },
  ]);
  const [newParentName, setNewParentName] = useState('');
  const [newChildName, setNewChildName] = useState('');
  const [showConfig, setShowConfig] = useState(true);
  const [showReporting, setShowReporting] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Reporting
  const [reportingMode, setReportingMode] = useState('custom');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [quarterYear, setQuarterYear] = useState(new Date().getFullYear());
  const [quarter, setQuarter] = useState('Q1');
  const [preset, setPreset] = useState('year-to-date');
  const [analysisChild, setAnalysisChild] = useState('all');

  // UI state
  const [viewMode, setViewMode] = useState('list'); // 'list' | 'calendar'
  const [datePicker, setDatePicker] = useState(null); // { context, field, current }
  const [parentPickerEntryId, setParentPickerEntryId] = useState(null);

  // Schedule generator state
  const [showScheduleGen, setShowScheduleGen] = useState(false);
  const [schedulePattern, setSchedulePattern] = useState('eow');
  const [scheduleStart, setScheduleStart] = useState('');
  const [scheduleEnd, setScheduleEnd] = useState('');
  const [scheduleSecondaryParent, setScheduleSecondaryParent] = useState('');
  const [scheduleJointParent1, setScheduleJointParent1] = useState('');
  const [scheduleJointParent2, setScheduleJointParent2] = useState('');
  const [scheduleEOWDay, setScheduleEOWDay] = useState('fri');
  const [scheduleParentPickerTarget, setScheduleParentPickerTarget] = useState(null);

  const today = new Date();
  const todayStr = formatDateStr(today);
  const currentYear = today.getFullYear();

  // ── persistence ──────────────────────────────────────────────────────────────

  useEffect(() => {
    loadData().then((data) => {
      if (data) {
        if (data.parents) setParents(data.parents);
        if (data.children) setChildren(data.children);
        if (data.entries) setEntries(data.entries);
        if (data.reportingMode) setReportingMode(data.reportingMode);
        if (data.customStart) setCustomStart(data.customStart);
        if (data.customEnd) setCustomEnd(data.customEnd);
        if (data.quarterYear) setQuarterYear(data.quarterYear);
        if (data.quarter) setQuarter(data.quarter);
        if (data.preset) setPreset(data.preset);
        if (data.analysisChild) setAnalysisChild(data.analysisChild);
      }
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!loaded) return;
    saveData({ parents, children, entries, reportingMode, customStart, customEnd, quarterYear, quarter, preset, analysisChild });
  }, [loaded, parents, children, entries, reportingMode, customStart, customEnd, quarterYear, quarter, preset, analysisChild]);

  // ── config ───────────────────────────────────────────────────────────────────

  const addParent = () => {
    const name = newParentName.trim();
    if (!name || parents.includes(name)) return;
    setParents([...parents, name]);
    setNewParentName('');
  };

  const removeParent = (parent) => {
    if (parents.length <= 1) return;
    Alert.alert('Remove Parent', `Remove "${parent}"?`, [
      { text: 'Cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => setParents(parents.filter((p) => p !== parent)) },
    ]);
  };

  const addChild = () => {
    const name = newChildName.trim();
    if (!name || children.includes(name)) return;
    setChildren([...children, name]);
    setEntries(entries.map((e) => ({ ...e, childrenPresent: { ...e.childrenPresent, [name]: true } })));
    setNewChildName('');
  };

  const removeChild = (child) => {
    if (children.length <= 1) return;
    Alert.alert('Remove Child', `Remove "${child}"?`, [
      { text: 'Cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: () => {
          setChildren(children.filter((c) => c !== child));
          setEntries(entries.map((e) => {
            const cp = { ...e.childrenPresent };
            delete cp[child];
            return { ...e, childrenPresent: cp };
          }));
          if (analysisChild === child) setAnalysisChild('all');
        },
      },
    ]);
  };

  // ── entries ──────────────────────────────────────────────────────────────────

  const addRow = () => {
    const cp = {};
    children.forEach((c) => { cp[c] = true; });
    setEntries([...entries, { id: generateId(), parent: '', beginDate: '', endDate: '', childrenPresent: cp, note: '' }]);
  };

  const addEntryOnDay = (dayStr) => {
    const cp = {};
    children.forEach((c) => { cp[c] = true; });
    setEntries([...entries, { id: generateId(), parent: '', beginDate: dayStr, endDate: addDays(dayStr, 1), childrenPresent: cp, note: '' }]);
    setViewMode('list');
  };

  const removeRow = (id) => {
    if (entries.length <= 1) return;
    setEntries(entries.filter((e) => e.id !== id));
  };

  const updateEntry = (id, field, value) => {
    setEntries(entries.map((e) => (e.id === id ? { ...e, [field]: value } : e)));
  };

  const clearAll = () => {
    Alert.alert('Clear All', 'Clear all entries? This cannot be undone.', [
      { text: 'Cancel' },
      {
        text: 'Clear', style: 'destructive', onPress: () => {
          const cp = {};
          children.forEach((c) => { cp[c] = true; });
          setEntries([{ id: generateId(), parent: '', beginDate: '', endDate: '', childrenPresent: cp, note: '' }]);
        },
      },
    ]);
  };

  const runScheduleGenerator = () => {
    let newEntries = [];
    if (schedulePattern === 'eow') {
      if (!scheduleSecondaryParent || !scheduleStart || !scheduleEnd) {
        Alert.alert('Missing Info', 'Please select a parent and set a date range.');
        return;
      }
      newEntries = generateEOWSchedule(scheduleSecondaryParent, scheduleStart, scheduleEnd, children, scheduleEOWDay);
    } else {
      if (!scheduleJointParent1 || !scheduleJointParent2 || !scheduleStart || !scheduleEnd) {
        Alert.alert('Missing Info', 'Please select both parents and set a date range.');
        return;
      }
      newEntries = generateJointWeeklySchedule(scheduleJointParent1, scheduleJointParent2, scheduleStart, scheduleEnd, children);
    }
    if (newEntries.length === 0) {
      Alert.alert('No Entries', 'No entries generated. Check your date range.');
      return;
    }
    Alert.alert(
      'Generated ' + newEntries.length + ' entries',
      'Replace existing entries or add to them?',
      [
        { text: 'Cancel' },
        { text: 'Add to Existing', onPress: () => { setEntries([...entries, ...newEntries]); setShowScheduleGen(false); } },
        { text: 'Replace All', style: 'destructive', onPress: () => { setEntries(newEntries); setShowScheduleGen(false); } },
      ]
    );
  };

  // ── reporting ────────────────────────────────────────────────────────────────

  const reportingWindow = useMemo(() => {
    if (reportingMode === 'custom') return { start: customStart, end: customEnd };
    if (reportingMode === 'quarter') {
      const map = {
        Q1: { start: `${quarterYear}-01-01`, end: `${quarterYear}-03-31` },
        Q2: { start: `${quarterYear}-04-01`, end: `${quarterYear}-06-30` },
        Q3: { start: `${quarterYear}-07-01`, end: `${quarterYear}-09-30` },
        Q4: { start: `${quarterYear}-10-01`, end: `${quarterYear}-12-31` },
      };
      return map[quarter];
    }
    if (reportingMode === 'preset') {
      if (preset === 'year-to-date') return { start: `${currentYear}-01-01`, end: todayStr };
      if (preset === 'last-12-months') {
        const s = new Date(today);
        s.setFullYear(s.getFullYear() - 1);
        return { start: formatDateStr(s), end: todayStr };
      }
      if (preset === 'calendar-year') return { start: `${currentYear}-01-01`, end: `${currentYear}-12-31` };
    }
    return { start: '', end: '' };
  }, [reportingMode, customStart, customEnd, quarterYear, quarter, preset]);

  const windowSummary = useMemo(() => {
    if (!reportingWindow.start || !reportingWindow.end) return [];
    const ps = {};
    entries.forEach((entry) => {
      if (!entry.beginDate || !entry.endDate) return;
      const days = overlapDays(entry.beginDate, entry.endDate, reportingWindow.start, reportingWindow.end);
      const nights = Math.max(0, days - 1);
      let childNights = 0;
      if (analysisChild === 'all') {
        children.forEach((c) => { if (entry.childrenPresent[c]) childNights += nights; });
      } else {
        if (entry.childrenPresent[analysisChild]) childNights = nights;
      }
      if (!ps[entry.parent]) ps[entry.parent] = { days: 0, nights: 0 };
      ps[entry.parent].days += days;
      ps[entry.parent].nights += childNights;
    });

    // Primary parent gets all nights not explicitly covered by other entries.
    // Only enter entries for non-primary custody periods; primary's share is inferred.
    const primary = parents[0];
    if (primary && reportingWindow.start && reportingWindow.end) {
      const wDays = daysInclusive(reportingWindow.start, reportingWindow.end);
      const wNights = wDays ? Math.max(0, wDays - 1) : 0;
      const totalPossible = analysisChild === 'all' ? wNights * children.length : wNights;
      const totalExplicit = Object.values(ps).reduce((s, d) => s + d.nights, 0);
      const gapNights = Math.max(0, totalPossible - totalExplicit);
      if (gapNights > 0) {
        if (!ps[primary]) ps[primary] = { days: 0, nights: 0 };
        ps[primary].nights += gapNights;
        ps[primary].days += gapNights;
      }
    }

    const total = Object.values(ps).reduce((s, p) => s + p.nights, 0);
    return Object.entries(ps).map(([parent, data]) => ({
      parent,
      days: data.days,
      nights: data.nights,
      percentage: total > 0 ? ((data.nights / total) * 100).toFixed(1) : '0.0',
    }));
  }, [entries, reportingWindow, analysisChild, children, parents]);

  const totalWindowNights = windowSummary.reduce((s, p) => s + p.nights, 0);

  const footerTotals = useMemo(() => {
    let totalDays = 0, totalNights = 0;
    entries.forEach((e) => {
      const d = daysInclusive(e.beginDate, e.endDate);
      const n = nightsInclusive(e.beginDate, e.endDate);
      if (d !== null) { totalDays += d; totalNights += n; }
    });
    return { totalDays, totalNights };
  }, [entries]);

  // ── export ───────────────────────────────────────────────────────────────────

  const exportCSV = async () => {
    try {
      const esc = (v) => {
        const s = v === null || v === undefined ? '' : String(v);
        return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csvRow = (arr) => arr.map(esc).join(',');

      const headers = ['Parent', 'Begin Date', 'End Date', 'Duration (days)', 'Duration (nights)', ...children, 'Note'];
      const rows = entries.map((e) => [
        e.parent, e.beginDate, e.endDate,
        daysInclusive(e.beginDate, e.endDate) ?? '',
        nightsInclusive(e.beginDate, e.endDate) ?? '',
        ...children.map((c) => (e.childrenPresent[c] ? 'Yes' : 'No')),
        e.note,
      ]);

      const childLabel = analysisChild === 'all' ? 'All Children' : analysisChild;
      const windowLabel = reportingWindow.start && reportingWindow.end
        ? `${reportingWindow.start} to ${reportingWindow.end} (${childLabel})`
        : '(no window set)';

      const summaryHeaders = ['Parent', 'Days', 'Nights', '% Nights'];
      const summaryRows = windowSummary.map((item) => [item.parent, item.days, item.nights, `${item.percentage}%`]);

      let csv = `# CUSTODY CALENDAR EXPORT\n# Generated: ${new Date().toLocaleString()}\n\n`;
      csv += '# CUSTODY ENTRIES\n';
      csv += csvRow(headers) + '\n' + rows.map(csvRow).join('\n');
      csv += `\n\n# SUMMARY REPORT\n# ${windowLabel}\n`;
      csv += summaryRows.length > 0
        ? csvRow(summaryHeaders) + '\n' + summaryRows.map(csvRow).join('\n')
        : 'No data for selected window';

      const path = FileSystem.documentDirectory + `Custody_Calendar_${todayStr}.csv`;
      await FileSystem.writeAsStringAsync(path, csv, { encoding: FileSystem.EncodingType.UTF8 });
      await Sharing.shareAsync(path, { mimeType: 'text/csv', dialogTitle: 'Export Custody Calendar' });
    } catch (e) {
      Alert.alert('Export Failed', e.message);
    }
  };

  // ── date picker ──────────────────────────────────────────────────────────────

  const openDatePicker = (context, field, currentStr) => {
    const current = currentStr ? toDate(currentStr) : new Date();
    setDatePicker({ context, field, current: current || new Date() });
  };

  const onDateChange = (_event, selectedDate) => {
    if (!selectedDate) { setDatePicker(null); return; }
    const { context, field } = datePicker;
    const dateStr = formatDateStr(selectedDate);
    if (context === 'reporting') {
      if (field === 'customStart') setCustomStart(dateStr);
      else setCustomEnd(dateStr);
    } else if (context === 'sched') {
      if (field === 'scheduleStart') setScheduleStart(dateStr);
      else setScheduleEnd(dateStr);
    } else {
      updateEntry(context, field, dateStr);
    }
    setDatePicker(null);
  };

  // ── render ───────────────────────────────────────────────────────────────────

  if (!loaded) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>Loading…</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor="#f9fafb" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">

          {/* Header */}
          <View style={styles.headerBox}>
            <Text style={styles.headerTitle}>Custody Calendar</Text>
            {children.length > 0 && (
              <Text style={styles.headerSub}>{children.join(' & ')}</Text>
            )}
          </View>

          {/* View toggle */}
          <View style={styles.segment}>
            {[{ id: 'list', label: 'Entries' }, { id: 'calendar', label: 'Calendar' }].map((m) => (
              <TouchableOpacity
                key={m.id}
                style={[styles.segmentBtn, viewMode === m.id && styles.segmentBtnActive]}
                onPress={() => setViewMode(m.id)}
              >
                <Text style={[styles.segmentText, viewMode === m.id && styles.segmentTextActive]}>{m.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {viewMode === 'calendar' ? (
            <CalendarView entries={entries} parents={parents} onAddEntry={addEntryOnDay} />
          ) : (
          <>
          {/* Configuration */}
          <View style={styles.card}>
            <TouchableOpacity style={styles.sectionHeader} onPress={() => setShowConfig(!showConfig)}>
              <Text style={styles.sectionTitle}>Configuration</Text>
              <Text style={styles.toggleBtn}>{showConfig ? 'Hide' : 'Show'}</Text>
            </TouchableOpacity>
            {!showConfig && (parents.length === 0 || children.length === 0) && (
              <Text style={styles.warnText}>⚠ Add parents and children before entering dates.</Text>
            )}
            {showConfig && (
              <View>
                {/* Parents */}
                <Text style={styles.fieldLabel}>Parents</Text>
                <View style={styles.tagRow}>
                  {parents.map((p, i) => (
                    <View key={p} style={styles.tag}>
                      <Text style={styles.tagText}>{p}{i === 0 ? ' (Primary)' : ''}</Text>
                      <TouchableOpacity onPress={() => removeParent(p)} disabled={parents.length === 1}>
                        <Text style={[styles.tagX, parents.length === 1 && styles.tagXDisabled]}>×</Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
                <View style={styles.inputRow}>
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    value={newParentName}
                    onChangeText={setNewParentName}
                    onSubmitEditing={addParent}
                    placeholder="New parent name"
                    returnKeyType="done"
                  />
                  <TouchableOpacity style={styles.btnPrimary} onPress={addParent}>
                    <Text style={styles.btnText}>Add</Text>
                  </TouchableOpacity>
                </View>

                {/* Children */}
                <Text style={[styles.fieldLabel, { marginTop: 16 }]}>Children</Text>
                <View style={styles.tagRow}>
                  {children.map((c) => (
                    <View key={c} style={styles.tag}>
                      <Text style={styles.tagText}>{c}</Text>
                      <TouchableOpacity onPress={() => removeChild(c)} disabled={children.length === 1}>
                        <Text style={[styles.tagX, children.length === 1 && styles.tagXDisabled]}>×</Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
                <View style={styles.inputRow}>
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    value={newChildName}
                    onChangeText={setNewChildName}
                    onSubmitEditing={addChild}
                    placeholder="New child name"
                    returnKeyType="done"
                  />
                  <TouchableOpacity style={styles.btnPrimary} onPress={addChild}>
                    <Text style={styles.btnText}>Add</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>

          {/* Actions */}
          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.btnPrimary} onPress={addRow}>
              <Text style={styles.btnText}>+ Add Entry</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.btnPrimary} onPress={() => setShowScheduleGen(true)}>
              <Text style={styles.btnText}>⚡ Generate</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.btnSuccess} onPress={exportCSV}>
              <Text style={styles.btnText}>Export CSV</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.btnDanger} onPress={clearAll}>
              <Text style={styles.btnText}>Clear All</Text>
            </TouchableOpacity>
          </View>

          {/* Reporting */}
          <View style={styles.card}>
            <TouchableOpacity style={styles.sectionHeader} onPress={() => setShowReporting(!showReporting)}>
              <Text style={styles.sectionTitle}>Reporting & Analysis</Text>
              <Text style={styles.toggleBtn}>{showReporting ? 'Hide' : 'Show'}</Text>
            </TouchableOpacity>
            {showReporting && (
              <View>
                {/* Mode tabs */}
                <View style={styles.tabRow}>
                  {['custom', 'quarter', 'preset'].map((mode) => (
                    <TouchableOpacity
                      key={mode}
                      style={[styles.tab, reportingMode === mode && styles.tabActive]}
                      onPress={() => setReportingMode(mode)}
                    >
                      <Text style={[styles.tabText, reportingMode === mode && styles.tabTextActive]}>
                        {mode.charAt(0).toUpperCase() + mode.slice(1)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {reportingMode === 'custom' && (
                  <View style={styles.dateRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.fieldLabel}>Start Date</Text>
                      <TouchableOpacity style={styles.dateBtn} onPress={() => openDatePicker('reporting', 'customStart', customStart)}>
                        <Text style={customStart ? styles.dateBtnText : styles.dateBtnPlaceholder}>
                          {customStart ? displayDate(customStart) : 'Select…'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.fieldLabel}>End Date</Text>
                      <TouchableOpacity style={styles.dateBtn} onPress={() => openDatePicker('reporting', 'customEnd', customEnd)}>
                        <Text style={customEnd ? styles.dateBtnText : styles.dateBtnPlaceholder}>
                          {customEnd ? displayDate(customEnd) : 'Select…'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}

                {reportingMode === 'quarter' && (
                  <View style={styles.dateRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.fieldLabel}>Year</Text>
                      <View style={styles.stepper}>
                        <TouchableOpacity onPress={() => setQuarterYear((y) => y - 1)} style={styles.stepperBtn}>
                          <Text style={styles.stepperArrow}>‹</Text>
                        </TouchableOpacity>
                        <Text style={styles.stepperValue}>{quarterYear}</Text>
                        <TouchableOpacity onPress={() => setQuarterYear((y) => y + 1)} style={styles.stepperBtn}>
                          <Text style={styles.stepperArrow}>›</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.fieldLabel}>Quarter</Text>
                      <View style={styles.chipRow}>
                        {['Q1', 'Q2', 'Q3', 'Q4'].map((q) => (
                          <TouchableOpacity key={q} style={[styles.chip, quarter === q && styles.chipActive]} onPress={() => setQuarter(q)}>
                            <Text style={[styles.chipText, quarter === q && styles.chipTextActive]}>{q}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </View>
                  </View>
                )}

                {reportingMode === 'preset' && (
                  <View>
                    <Text style={styles.fieldLabel}>Preset</Text>
                    <View style={styles.chipRow}>
                      {[
                        { value: 'year-to-date', label: 'YTD' },
                        { value: 'last-12-months', label: 'Last 12 Mo' },
                        { value: 'calendar-year', label: 'Calendar Year' },
                      ].map((p) => (
                        <TouchableOpacity key={p.value} style={[styles.chip, preset === p.value && styles.chipActive]} onPress={() => setPreset(p.value)}>
                          <Text style={[styles.chipText, preset === p.value && styles.chipTextActive]}>{p.label}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                )}

                {/* Analysis child */}
                <Text style={[styles.fieldLabel, { marginTop: 12 }]}>Analysis</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={styles.chipRow}>
                    {['all', ...children].map((c) => (
                      <TouchableOpacity key={c} style={[styles.chip, analysisChild === c && styles.chipActive]} onPress={() => setAnalysisChild(c)}>
                        <Text style={[styles.chipText, analysisChild === c && styles.chipTextActive]}>
                          {c === 'all' ? 'All Children' : c}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </ScrollView>

                <Text style={styles.windowInfo}>
                  Window: {reportingWindow.start || 'not set'} → {reportingWindow.end || 'not set'}
                </Text>
                <Text style={styles.windowInfo}>Total nights in window: {totalWindowNights}</Text>

                {windowSummary.length > 0 && (
                  <View style={{ marginTop: 12 }}>
                    <Text style={styles.fieldLabel}>Summary by Parent</Text>
                    <View style={styles.table}>
                      <View style={[styles.tableRow, styles.tableHeader]}>
                        {['Parent', 'Days', 'Nights', '% Nights'].map((h) => (
                          <Text key={h} style={[styles.tableCell, styles.tableCellHeader]}>{h}</Text>
                        ))}
                      </View>
                      {windowSummary.map((item, i) => (
                        <View key={i} style={[styles.tableRow, i % 2 === 1 && styles.tableRowAlt]}>
                          <Text style={styles.tableCell}>{item.parent}</Text>
                          <Text style={styles.tableCell}>{item.days}</Text>
                          <Text style={styles.tableCell}>{item.nights}</Text>
                          <Text style={styles.tableCell}>{item.percentage}%</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                )}
              </View>
            )}
          </View>

          {/* Entries */}
          {entries.map((entry) => {
            const days = daysInclusive(entry.beginDate, entry.endDate);
            const nights = nightsInclusive(entry.beginDate, entry.endDate);
            return (
              <View key={entry.id} style={styles.entryCard}>
                <View style={styles.entryCardHeader}>
                  <Text style={styles.entryCardTitle}>
                    {entry.beginDate && entry.endDate
                      ? `${displayDate(entry.beginDate)} – ${displayDate(entry.endDate)}`
                      : 'New Entry'}
                  </Text>
                  <TouchableOpacity onPress={() => removeRow(entry.id)} disabled={entries.length === 1}>
                    <Text style={[styles.deleteBtn, entries.length === 1 && styles.deleteBtnDisabled]}>🗑️</Text>
                  </TouchableOpacity>
                </View>

                {/* Parent */}
                <Text style={styles.fieldLabel}>Parent</Text>
                <TouchableOpacity style={styles.selectBtn} onPress={() => setParentPickerEntryId(entry.id)}>
                  <Text style={entry.parent ? styles.selectBtnText : styles.selectBtnPlaceholder}>
                    {entry.parent || 'Select parent…'}
                  </Text>
                  <Text style={styles.selectArrow}>›</Text>
                </TouchableOpacity>

                {/* Date Range */}
                <Text style={styles.fieldLabel}>Date Range</Text>
                <View style={styles.dateRow}>
                  <TouchableOpacity style={[styles.dateBtn, { flex: 1 }]} onPress={() => openDatePicker(entry.id, 'beginDate', entry.beginDate)}>
                    <Text style={entry.beginDate ? styles.dateBtnText : styles.dateBtnPlaceholder}>
                      {entry.beginDate ? displayDate(entry.beginDate) : 'Start date'}
                    </Text>
                  </TouchableOpacity>
                  <Text style={styles.dateSep}>→</Text>
                  <TouchableOpacity style={[styles.dateBtn, { flex: 1 }]} onPress={() => openDatePicker(entry.id, 'endDate', entry.endDate)}>
                    <Text style={entry.endDate ? styles.dateBtnText : styles.dateBtnPlaceholder}>
                      {entry.endDate ? displayDate(entry.endDate) : 'End date'}
                    </Text>
                  </TouchableOpacity>
                </View>

                {/* Duration */}
                {days !== null && (
                  <View style={styles.durationBadge}>
                    <Text style={styles.durationText}>{days} days · {nights} nights</Text>
                  </View>
                )}

                {/* Children present */}
                {children.length > 0 && (
                  <View style={{ marginTop: 10 }}>
                    <Text style={styles.fieldLabel}>Children Present</Text>
                    {children.map((child) => (
                      <View key={child} style={styles.switchRow}>
                        <Text style={styles.switchLabel}>{child}</Text>
                        <Switch
                          value={entry.childrenPresent[child] || false}
                          onValueChange={(val) => {
                            const cp = { ...entry.childrenPresent, [child]: val };
                            updateEntry(entry.id, 'childrenPresent', cp);
                          }}
                          trackColor={{ false: '#d1d5db', true: '#93c5fd' }}
                          thumbColor={entry.childrenPresent[child] ? '#2563eb' : '#f3f4f6'}
                        />
                      </View>
                    ))}
                  </View>
                )}

                {/* Note */}
                <Text style={[styles.fieldLabel, { marginTop: 10 }]}>Note</Text>
                <TextInput
                  style={styles.input}
                  value={entry.note}
                  onChangeText={(v) => updateEntry(entry.id, 'note', v)}
                  placeholder="Optional note"
                />
              </View>
            );
          })}

          {/* Footer */}
          <View style={styles.footer}>
            <Text style={styles.footerText}>Total Days: {footerTotals.totalDays}</Text>
            <Text style={styles.footerText}>Total Nights: {footerTotals.totalNights}</Text>
          </View>
          </>
          )}

        </ScrollView>
      </KeyboardAvoidingView>

      {/* Native Date Picker */}
      {datePicker && (
        <DateTimePicker
          value={datePicker.current}
          mode="date"
          display={Platform.OS === 'ios' ? 'spinner' : 'default'}
          onChange={onDateChange}
        />
      )}

      {/* Parent Picker Modal */}
      <Modal
        visible={parentPickerEntryId !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setParentPickerEntryId(null)}
      >
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setParentPickerEntryId(null)}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Select Parent</Text>
            {parents.length === 0 && (
              <Text style={styles.modalEmpty}>No parents configured yet. Add parents in Configuration.</Text>
            )}
            {parents.map((p) => (
              <TouchableOpacity
                key={p}
                style={styles.modalOption}
                onPress={() => {
                  updateEntry(parentPickerEntryId, 'parent', p);
                  setParentPickerEntryId(null);
                }}
              >
                <Text style={styles.modalOptionText}>{p}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={styles.modalCancel} onPress={() => setParentPickerEntryId(null)}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Schedule Generator Modal */}
      <Modal
        visible={showScheduleGen}
        transparent
        animationType="slide"
        onRequestClose={() => setShowScheduleGen(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalBox, { maxHeight: '85%' }]}>
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.modalTitle}>Generate Schedule</Text>

              {/* Pattern */}
              <Text style={[styles.fieldLabel, { marginHorizontal: 16, marginTop: 12 }]}>Custody Pattern</Text>
              <View style={[styles.chipRow, { marginHorizontal: 16, marginBottom: 12 }]}>
                <TouchableOpacity
                  style={[styles.chip, schedulePattern === 'eow' && styles.chipActive]}
                  onPress={() => setSchedulePattern('eow')}
                >
                  <Text style={[styles.chipText, schedulePattern === 'eow' && styles.chipTextActive]}>Primary + Every Other Weekend</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.chip, schedulePattern === 'joint-weekly' && styles.chipActive]}
                  onPress={() => setSchedulePattern('joint-weekly')}
                >
                  <Text style={[styles.chipText, schedulePattern === 'joint-weekly' && styles.chipTextActive]}>Joint / Alternating Weekly</Text>
                </TouchableOpacity>
              </View>

              {/* Date range */}
              <Text style={[styles.fieldLabel, { marginHorizontal: 16 }]}>Date Range</Text>
              <View style={[styles.dateRow, { marginHorizontal: 16 }]}>
                <TouchableOpacity style={[styles.dateBtn, { flex: 1 }]} onPress={() => openDatePicker('sched', 'scheduleStart', scheduleStart)}>
                  <Text style={scheduleStart ? styles.dateBtnText : styles.dateBtnPlaceholder}>
                    {scheduleStart ? displayDate(scheduleStart) : 'Start date'}
                  </Text>
                </TouchableOpacity>
                <Text style={styles.dateSep}>→</Text>
                <TouchableOpacity style={[styles.dateBtn, { flex: 1 }]} onPress={() => openDatePicker('sched', 'scheduleEnd', scheduleEnd)}>
                  <Text style={scheduleEnd ? styles.dateBtnText : styles.dateBtnPlaceholder}>
                    {scheduleEnd ? displayDate(scheduleEnd) : 'End date'}
                  </Text>
                </TouchableOpacity>
              </View>

              {/* EOW options */}
              {schedulePattern === 'eow' && (
                <View style={{ marginHorizontal: 16 }}>
                  <Text style={[styles.fieldLabel, { marginTop: 12 }]}>Non-Primary Parent (gets EOW)</Text>
                  <TouchableOpacity style={styles.selectBtn} onPress={() => setScheduleParentPickerTarget('secondary')}>
                    <Text style={scheduleSecondaryParent ? styles.selectBtnText : styles.selectBtnPlaceholder}>
                      {scheduleSecondaryParent || 'Select parent…'}
                    </Text>
                    <Text style={styles.selectArrow}>›</Text>
                  </TouchableOpacity>
                  <Text style={[styles.fieldLabel, { marginTop: 8 }]}>Weekend Starts On</Text>
                  <View style={styles.chipRow}>
                    <TouchableOpacity style={[styles.chip, scheduleEOWDay === 'fri' && styles.chipActive]} onPress={() => setScheduleEOWDay('fri')}>
                      <Text style={[styles.chipText, scheduleEOWDay === 'fri' && styles.chipTextActive]}>Friday</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.chip, scheduleEOWDay === 'sat' && styles.chipActive]} onPress={() => setScheduleEOWDay('sat')}>
                      <Text style={[styles.chipText, scheduleEOWDay === 'sat' && styles.chipTextActive]}>Saturday</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {/* Joint weekly options */}
              {schedulePattern === 'joint-weekly' && (
                <View style={{ marginHorizontal: 16 }}>
                  <Text style={[styles.fieldLabel, { marginTop: 12 }]}>Parent — Week 1</Text>
                  <TouchableOpacity style={styles.selectBtn} onPress={() => setScheduleParentPickerTarget('joint1')}>
                    <Text style={scheduleJointParent1 ? styles.selectBtnText : styles.selectBtnPlaceholder}>
                      {scheduleJointParent1 || 'Select parent…'}
                    </Text>
                    <Text style={styles.selectArrow}>›</Text>
                  </TouchableOpacity>
                  <Text style={[styles.fieldLabel, { marginTop: 8 }]}>Parent — Week 2</Text>
                  <TouchableOpacity style={styles.selectBtn} onPress={() => setScheduleParentPickerTarget('joint2')}>
                    <Text style={scheduleJointParent2 ? styles.selectBtnText : styles.selectBtnPlaceholder}>
                      {scheduleJointParent2 || 'Select parent…'}
                    </Text>
                    <Text style={styles.selectArrow}>›</Text>
                  </TouchableOpacity>
                </View>
              )}

              <View style={[styles.actionRow, { margin: 16 }]}>
                <TouchableOpacity style={styles.btnSuccess} onPress={runScheduleGenerator}>
                  <Text style={styles.btnText}>Generate Entries</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.btnDanger} onPress={() => setShowScheduleGen(false)}>
                  <Text style={styles.btnText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </View>

        {/* Parent picker inside schedule modal */}
        <Modal
          visible={scheduleParentPickerTarget !== null}
          transparent
          animationType="fade"
          onRequestClose={() => setScheduleParentPickerTarget(null)}
        >
          <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setScheduleParentPickerTarget(null)}>
            <View style={styles.modalBox}>
              <Text style={styles.modalTitle}>Select Parent</Text>
              {parents.map((p) => (
                <TouchableOpacity
                  key={p}
                  style={styles.modalOption}
                  onPress={() => {
                    if (scheduleParentPickerTarget === 'secondary') setScheduleSecondaryParent(p);
                    else if (scheduleParentPickerTarget === 'joint1') setScheduleJointParent1(p);
                    else if (scheduleParentPickerTarget === 'joint2') setScheduleJointParent2(p);
                    setScheduleParentPickerTarget(null);
                  }}
                >
                  <Text style={styles.modalOptionText}>{p}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity style={styles.modalCancel} onPress={() => setScheduleParentPickerTarget(null)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </Modal>
      </Modal>

    </SafeAreaView>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#f9fafb' },
  scroll: { flex: 1 },
  container: { padding: 16, paddingBottom: 48 },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { fontSize: 16, color: '#6b7280' },

  headerBox: { marginBottom: 16 },
  headerTitle: { fontSize: 24, fontWeight: '700', color: '#111827' },
  headerSub: { fontSize: 15, color: '#6b7280', marginTop: 2 },

  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  sectionTitle: { fontSize: 16, fontWeight: '600', color: '#111827' },
  toggleBtn: { fontSize: 14, color: '#2563eb', fontWeight: '500' },
  warnText: { fontSize: 13, color: '#b45309', marginTop: 4 },

  fieldLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },

  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#eff6ff',
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  tagText: { fontSize: 13, color: '#1d4ed8', marginRight: 4 },
  tagX: { fontSize: 18, color: '#dc2626', lineHeight: 20 },
  tagXDisabled: { color: '#d1d5db' },

  inputRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
    color: '#111827',
    backgroundColor: '#fff',
  },

  actionRow: { flexDirection: 'row', gap: 8, marginBottom: 12, flexWrap: 'wrap' },
  btnPrimary: { backgroundColor: '#2563eb', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8 },
  btnSuccess: { backgroundColor: '#16a34a', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8 },
  btnDanger: { backgroundColor: '#dc2626', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8 },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 14 },

  tabRow: { flexDirection: 'row', gap: 6, marginBottom: 12 },
  tab: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d1d5db',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  tabActive: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  tabText: { fontSize: 13, color: '#6b7280', fontWeight: '500' },
  tabTextActive: { color: '#fff' },

  dateRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  dateBtn: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    backgroundColor: '#fff',
  },
  dateBtnText: { fontSize: 13, color: '#111827' },
  dateBtnPlaceholder: { fontSize: 13, color: '#9ca3af' },
  dateSep: { alignSelf: 'center', color: '#6b7280', fontSize: 14 },

  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    overflow: 'hidden',
  },
  stepperBtn: { paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#f3f4f6' },
  stepperArrow: { fontSize: 18, color: '#374151' },
  stepperValue: { flex: 1, textAlign: 'center', fontSize: 14, fontWeight: '600', color: '#111827' },

  chipRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: 4 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#fff',
  },
  chipActive: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  chipText: { fontSize: 13, color: '#374151' },
  chipTextActive: { color: '#fff', fontWeight: '600' },

  windowInfo: { fontSize: 13, color: '#6b7280', marginTop: 6 },

  // View toggle (segmented control)
  segment: { flexDirection: 'row', backgroundColor: '#e5e7eb', borderRadius: 10, padding: 3, marginBottom: 12 },
  segmentBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  segmentBtnActive: {
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 1,
  },
  segmentText: { fontSize: 14, color: '#6b7280', fontWeight: '500' },
  segmentTextActive: { color: '#111827', fontWeight: '700' },

  // Calendar
  calNav: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  calNavBtn: { paddingHorizontal: 16, paddingVertical: 4 },
  calNavArrow: { fontSize: 26, color: '#2563eb', fontWeight: '600' },
  calNavTitle: { fontSize: 17, fontWeight: '700', color: '#111827' },
  calWeekRow: { flexDirection: 'row', marginBottom: 4 },
  calWeekday: { flex: 1, textAlign: 'center', fontSize: 12, fontWeight: '600', color: '#9ca3af' },
  calGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  calCell: { width: `${100 / 7}%`, aspectRatio: 1, padding: 2 },
  calDay: { flex: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'transparent' },
  calDayNum: { fontSize: 14, color: '#374151', fontWeight: '500' },
  calDayToday: { fontWeight: '800', textDecorationLine: 'underline' },
  calDot: { width: 5, height: 5, borderRadius: 3, marginTop: 2 },
  calDaySelected: { borderColor: '#111827', borderWidth: 2 },
  calDayConflict: { borderColor: '#dc2626', borderWidth: 2, borderStyle: 'dashed' },
  calConflictNote: { fontSize: 12, color: '#dc2626', marginTop: 8 },
  calHint: { fontSize: 12, color: '#9ca3af', marginTop: 10, lineHeight: 17 },
  legendRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5 },
  legendSwatch: { width: 16, height: 16, borderRadius: 4, marginRight: 10 },
  legendText: { flex: 1, fontSize: 14, color: '#374151' },
  legendCount: { fontSize: 13, color: '#6b7280', fontWeight: '600' },

  table: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 8, overflow: 'hidden' },
  tableRow: { flexDirection: 'row' },
  tableRowAlt: { backgroundColor: '#f9fafb' },
  tableHeader: { backgroundColor: '#f3f4f6' },
  tableCell: { flex: 1, padding: 8, fontSize: 13, color: '#374151', textAlign: 'center' },
  tableCellHeader: { fontWeight: '600', color: '#111827' },

  entryCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
    borderLeftWidth: 4,
    borderLeftColor: '#2563eb',
  },
  entryCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  entryCardTitle: { fontSize: 15, fontWeight: '600', color: '#111827', flex: 1 },
  deleteBtn: { fontSize: 20 },
  deleteBtnDisabled: { opacity: 0.3 },

  selectBtn: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
    marginBottom: 12,
  },
  selectBtnText: { fontSize: 14, color: '#111827' },
  selectBtnPlaceholder: { fontSize: 14, color: '#9ca3af' },
  selectArrow: { fontSize: 18, color: '#9ca3af' },

  durationBadge: {
    backgroundColor: '#eff6ff',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignSelf: 'flex-start',
    marginTop: 4,
    marginBottom: 8,
  },
  durationText: { fontSize: 13, color: '#1d4ed8', fontWeight: '500' },

  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  switchLabel: { fontSize: 14, color: '#374151' },

  footer: {
    backgroundColor: '#f3f4f6',
    borderRadius: 10,
    padding: 16,
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: 4,
  },
  footerText: { fontSize: 15, fontWeight: '600', color: '#374151' },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  modalBox: { backgroundColor: '#fff', borderRadius: 16, width: '100%', overflow: 'hidden', paddingBottom: 8 },
  modalTitle: { fontSize: 17, fontWeight: '700', color: '#111827', padding: 16, borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
  modalEmpty: { fontSize: 14, color: '#9ca3af', padding: 16 },
  modalOption: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  modalOptionText: { fontSize: 16, color: '#111827' },
  modalCancel: { paddingHorizontal: 16, paddingVertical: 14, marginTop: 4 },
  modalCancelText: { fontSize: 16, color: '#dc2626', fontWeight: '600', textAlign: 'center' },
});
