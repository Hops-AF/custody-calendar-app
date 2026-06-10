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

// Which parent has custody on the calendar day `dateStr`? An entry [begin,end]
// covers every day from begin to end inclusive. Days not covered by any entry
// are unassigned (shown gray on the calendar).
function getDayOwner(dateStr, entries, childFilter) {
  const owners = [];
  for (const e of entries) {
    if (!e.beginDate || !e.endDate || !e.parent) continue;
    if (childFilter && !(e.childrenPresent && e.childrenPresent[childFilter])) continue;
    if (dateStr >= e.beginDate && dateStr <= e.endDate) owners.push(e.parent);
  }
  const distinct = [...new Set(owners)];
  if (distinct.length === 0) return { parent: null, conflict: false };
  if (distinct.length === 1) return { parent: distinct[0], conflict: false };
  return { parent: distinct[0], conflict: true };
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

const COLOR_CHOICES = [
  '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#db2777', '#0d9488',
  '#dc2626', '#ca8a04', '#4f46e5', '#0891b2', '#65a30d', '#e11d48',
];

// Resolve a stored color for a name, falling back to a palette color by position.
function colorForName(name, list, overrides) {
  if (overrides && overrides[name]) return overrides[name];
  const i = list.indexOf(name);
  return i >= 0 ? COLOR_CHOICES[i % COLOR_CHOICES.length] : '#9ca3af';
}

// Pick the first palette color not already used.
function nextColor(overrides) {
  const used = Object.values(overrides || {});
  return COLOR_CHOICES.find((c) => !used.includes(c)) || COLOR_CHOICES[Object.keys(overrides || {}).length % COLOR_CHOICES.length];
}

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

// ~70/30: every other weekend for the secondary parent plus one midweek
// overnight (single day) each week.
function generateEOWMidweek(secondaryParent, startDateStr, endDateStr, childrenList, weekendStartDay, midweekDow) {
  const entries = generateEOWSchedule(secondaryParent, startDateStr, endDateStr, childrenList, weekendStartDay);
  const start = new Date(startDateStr + 'T00:00:00.000');
  const end = new Date(endDateStr + 'T00:00:00.000');
  let current = new Date(start);
  while (current.getDay() !== midweekDow) current.setDate(current.getDate() + 1);
  while (current <= end) {
    const cp = {};
    childrenList.forEach((c) => { cp[c] = true; });
    const ds = `${current.getFullYear()}-${pad2(current.getMonth() + 1)}-${pad2(current.getDate())}`;
    entries.push({ id: generateId(), parent: secondaryParent, beginDate: ds, endDate: ds, childrenPresent: cp, note: 'Midweek' });
    current.setDate(current.getDate() + 7);
  }
  return entries;
}

// 50/50 "2-2-3" rotation between two parents over a 14-day cycle.
function generate223(parent1, parent2, startDateStr, endDateStr, childrenList) {
  const entries = [];
  const start = new Date(startDateStr + 'T00:00:00.000');
  const end = new Date(endDateStr + 'T00:00:00.000');
  const blocks = [
    [0, 1, parent1], [2, 3, parent2], [4, 6, parent1],
    [7, 8, parent2], [9, 10, parent1], [11, 13, parent2],
  ];
  const fmt = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  let cycle = new Date(start);
  while (cycle.getDay() !== 1) cycle.setDate(cycle.getDate() + 1); // first Monday
  while (cycle <= end) {
    for (const [o0, o1, parent] of blocks) {
      const b = new Date(cycle); b.setDate(b.getDate() + o0);
      const e = new Date(cycle); e.setDate(e.getDate() + o1);
      if (e < start || b > end) continue;
      const ab = b < start ? new Date(start) : b;
      const ae = e > end ? new Date(end) : e;
      const cp = {};
      childrenList.forEach((c) => { cp[c] = true; });
      entries.push({ id: generateId(), parent, beginDate: fmt(ab), endDate: fmt(ae), childrenPresent: cp, note: '2-2-3' });
    }
    cycle.setDate(cycle.getDate() + 14);
  }
  return entries;
}

// ── CalendarView ──────────────────────────────────────────────────────────────

function CalendarView({ entries, parents, parentColors, children, childColors, onCreateEntry }) {
  const now = new Date();
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth());
  const [pendingStart, setPendingStart] = useState(null);
  const [pendingRange, setPendingRange] = useState(null); // {start, end} awaiting parent
  const [childFilter, setChildFilter] = useState(null); // null = all children

  const todayStr = localTodayStr();

  const colorFor = (parent) => colorForName(parent, parents, parentColors);

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDow = new Date(viewYear, viewMonth, 1).getDay();

  const resetSelection = () => { setPendingStart(null); setPendingRange(null); };
  const prevMonth = () => {
    resetSelection();
    if (viewMonth === 0) { setViewMonth(11); setViewYear((y) => y - 1); }
    else setViewMonth((m) => m - 1);
  };
  const nextMonth = () => {
    resetSelection();
    if (viewMonth === 11) { setViewMonth(0); setViewYear((y) => y + 1); }
    else setViewMonth((m) => m + 1);
  };

  const handleDayClick = (ds) => {
    if (pendingRange) { setPendingRange(null); setPendingStart(ds); return; }
    if (!pendingStart) { setPendingStart(ds); return; }
    const start = ds < pendingStart ? ds : pendingStart;
    const end = ds < pendingStart ? pendingStart : ds;
    setPendingRange({ start, end });
    setPendingStart(null);
  };

  // Days-per-parent tally for the displayed month
  const monthTally = {};
  let hasConflict = false;
  for (let day = 1; day <= daysInMonth; day++) {
    const ds = `${viewYear}-${pad2(viewMonth + 1)}-${pad2(day)}`;
    const owner = getDayOwner(ds, entries, childFilter);
    if (owner.conflict) hasConflict = true;
    if (owner.parent) monthTally[owner.parent] = (monthTally[owner.parent] || 0) + 1;
  }

  const isSelEdge = (ds) => ds === pendingStart || (pendingRange && (ds === pendingRange.start || ds === pendingRange.end));
  const inPendingRange = (ds) => pendingRange && ds >= pendingRange.start && ds <= pendingRange.end;

  const hint = pendingRange ? 'Choose which parent has custody for this range.'
    : pendingStart ? 'Now tap the END date (or the same day for one day).'
    : 'Tap the START date, then the END date, to add custody.';

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

        <Text style={styles.calSelectHint}>{hint}</Text>

        {children && children.length > 1 && (
          <View style={[styles.chipRow, { justifyContent: 'center', marginBottom: 10 }]}>
            <TouchableOpacity
              style={[styles.chip, childFilter === null && { backgroundColor: '#111827', borderColor: '#111827' }]}
              onPress={() => setChildFilter(null)}
            >
              <Text style={[styles.chipText, childFilter === null && styles.chipTextActive]}>All children</Text>
            </TouchableOpacity>
            {children.map((c) => {
              const active = childFilter === c;
              const cc = colorForName(c, children, childColors);
              return (
                <TouchableOpacity
                  key={c}
                  style={[styles.chip, active && { backgroundColor: cc, borderColor: cc }]}
                  onPress={() => setChildFilter(c)}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>{c}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        <View style={styles.calWeekRow}>
          {DAY_NAMES.map((d) => <Text key={d} style={styles.calWeekday}>{d}</Text>)}
        </View>

        <View style={styles.calGrid}>
          {Array.from({ length: firstDow }).map((_, i) => <View key={'blank' + i} style={styles.calCell} />)}
          {Array.from({ length: daysInMonth }).map((_, i) => {
            const day = i + 1;
            const ds = `${viewYear}-${pad2(viewMonth + 1)}-${pad2(day)}`;
            const owner = getDayOwner(ds, entries, childFilter);
            const col = owner.parent ? colorFor(owner.parent) : null;
            const isToday = ds === todayStr;
            const selEdge = isSelEdge(ds);
            const inRange = inPendingRange(ds);
            const borderStyle = selEdge
              ? { borderColor: '#2563eb', borderWidth: 3 }
              : inRange
                ? { borderColor: '#93c5fd', borderWidth: 2 }
                : owner.conflict
                  ? { borderColor: '#dc2626', borderWidth: 2, borderStyle: 'dashed' }
                  : null;
            return (
              <TouchableOpacity key={day} style={styles.calCell} activeOpacity={0.6} onPress={() => handleDayClick(ds)}>
                <View style={[
                  styles.calDay,
                  { backgroundColor: col || '#e5e7eb' },
                  borderStyle,
                ]}>
                  <Text style={[styles.calDayNum, { color: col ? '#fff' : '#9ca3af' }, isToday && styles.calDayToday]}>{day}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Range assignment panel */}
      {pendingRange && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>New custody period</Text>
          <Text style={styles.windowInfo}>
            {displayDate(pendingRange.start)} – {displayDate(pendingRange.end)}
            {'  ·  '}{daysInclusive(pendingRange.start, pendingRange.end)} days, {nightsInclusive(pendingRange.start, pendingRange.end)} nights
          </Text>
          {parents.length === 0 ? (
            <Text style={styles.modalEmpty}>Add parents in the Entries tab first, then you can assign custody.</Text>
          ) : (
            <View>
              <Text style={[styles.fieldLabel, { marginTop: 12 }]}>Assign to</Text>
              <View style={styles.chipRow}>
                {parents.map((p, idx) => {
                  const col = colorFor(p);
                  return (
                    <TouchableOpacity
                      key={p}
                      style={{ backgroundColor: col, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8 }}
                      onPress={() => { onCreateEntry(pendingRange.start, pendingRange.end, p, childFilter); resetSelection(); }}
                    >
                      <Text style={styles.btnText}>{p}{idx === 0 ? ' (Primary)' : ''}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          )}
          <TouchableOpacity style={[styles.btnDanger, { marginTop: 14, alignSelf: 'flex-start' }]} onPress={resetSelection}>
            <Text style={styles.btnText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Legend + month tally */}
      <View style={styles.card}>
        <Text style={styles.fieldLabel}>Legend · days this month</Text>
        {parents.length === 0 && (
          <Text style={styles.modalEmpty}>Add parents in the Entries tab to color the calendar.</Text>
        )}
        {parents.map((p, idx) => {
          const col = colorFor(p);
          return (
            <View key={p} style={styles.legendRow}>
              <View style={[styles.legendSwatch, { backgroundColor: col }]} />
              <Text style={styles.legendText}>{p}{idx === 0 ? ' (Primary)' : ''}</Text>
              <Text style={styles.legendCount}>{monthTally[p] || 0} days</Text>
            </View>
          );
        })}
        <View style={styles.legendRow}>
          <View style={[styles.legendSwatch, { backgroundColor: '#e5e7eb' }]} />
          <Text style={styles.legendText}>No custody entry</Text>
        </View>
        {hasConflict && (
          <Text style={styles.calConflictNote}>⚠ Some days have conflicting entries (outlined in red).</Text>
        )}
        <Text style={styles.calHint}>
          Each day is colored by the parent who has custody. Days with no custody entry are gray.
        </Text>
      </View>
    </View>
  );
}

// ── SetupWizard ───────────────────────────────────────────────────────────────

function SetupWizard({ onComplete, onCancel }) {
  const curYear = new Date().getFullYear();
  const [step, setStep] = useState(0);
  const [dParents, setDParents] = useState([]);
  const [dChildren, setDChildren] = useState([]);
  const [pName, setPName] = useState('');
  const [cName, setCName] = useState('');
  const [assignments, setAssignments] = useState([]);

  const [sPreset, setSPreset] = useState('eow');
  const [sStart, setSStart] = useState(`${curYear}-01-01`);
  const [sEnd, setSEnd] = useState(`${curYear}-12-31`);
  const [sSecondary, setSSecondary] = useState('');
  const [sP1, setSP1] = useState('');
  const [sP2, setSP2] = useState('');
  const [sEOWDay, setSEOWDay] = useState('fri');
  const [sMidweek, setSMidweek] = useState(3);
  const [sChildren, setSChildren] = useState([]);
  const [datePicker, setDatePicker] = useState(null); // { field }

  useEffect(() => { setSChildren(dChildren); }, [dChildren]);
  useEffect(() => {
    if (dParents.length) { setSSecondary(dParents[1] || dParents[0]); setSP1(dParents[0]); setSP2(dParents[1] || dParents[0]); }
  }, [dParents]);

  const presetLabel = (p) => ({
    'eow': 'Every other weekend (~80/20)',
    'eow-midweek': 'EOW + midweek (~70/30)',
    'joint-weekly': 'Alternating weeks (50/50)',
    '2-2-3': '2-2-3 rotation (50/50)',
  }[p] || p);

  const addParentW = () => { const n = pName.trim(); if (n && !dParents.includes(n)) { setDParents([...dParents, n]); setPName(''); } };
  const addChildW = () => { const n = cName.trim(); if (n && !dChildren.includes(n)) { setDChildren([...dChildren, n]); setCName(''); } };
  const makePrimaryW = (p) => setDParents([p, ...dParents.filter((x) => x !== p)]);
  const toggleSChild = (c) => setSChildren(sChildren.includes(c) ? sChildren.filter((x) => x !== c) : [...sChildren, c]);

  const addAssignment = () => {
    if (!sStart || !sEnd) { Alert.alert('Missing dates', 'Please set a date range.'); return; }
    if (sChildren.length === 0) { Alert.alert('No children', 'Select at least one child for this schedule.'); return; }
    let extra;
    if (sPreset === 'eow' || sPreset === 'eow-midweek') {
      if (!sSecondary) { Alert.alert('Missing parent', 'Select the parent who gets the weekends.'); return; }
      extra = { secondary: sSecondary };
    } else {
      if (!sP1 || !sP2) { Alert.alert('Missing parents', 'Select both parents.'); return; }
      extra = { p1: sP1, p2: sP2 };
    }
    setAssignments([...assignments, { id: generateId(), preset: sPreset, start: sStart, end: sEnd, eowDay: sEOWDay, midweek: sMidweek, children: [...sChildren], ...extra }]);
    setSChildren(dChildren);
  };

  const finish = () => {
    const parentColors = {}; dParents.forEach((p) => { parentColors[p] = nextColor(parentColors); });
    const childColors = {}; dChildren.forEach((c) => { childColors[c] = nextColor(childColors); });
    let entries = [];
    assignments.forEach((a) => {
      let gen = [];
      if (a.preset === 'eow') gen = generateEOWSchedule(a.secondary, a.start, a.end, a.children, a.eowDay);
      else if (a.preset === 'eow-midweek') gen = generateEOWMidweek(a.secondary, a.start, a.end, a.children, a.eowDay, a.midweek);
      else if (a.preset === 'joint-weekly') gen = generateJointWeeklySchedule(a.p1, a.p2, a.start, a.end, a.children);
      else if (a.preset === '2-2-3') gen = generate223(a.p1, a.p2, a.start, a.end, a.children);
      entries = entries.concat(gen);
    });
    if (entries.length === 0) {
      const cp = {}; dChildren.forEach((c) => { cp[c] = true; });
      entries = [{ id: generateId(), parent: '', beginDate: '', endDate: '', childrenPresent: cp, note: '' }];
    }
    onComplete({ parents: dParents, parentColors, children: dChildren, childColors, entries });
  };

  const onDate = (_e, d) => {
    if (!d) { setDatePicker(null); return; }
    const ds = formatDateStr(d);
    if (datePicker.field === 'start') setSStart(ds); else setSEnd(ds);
    setDatePicker(null);
  };

  const canNext = step === 0 ? dParents.length >= 1 : step === 1 ? dChildren.length >= 1 : true;
  const ParentChips = ({ value, onPick }) => (
    <View style={styles.chipRow}>
      {dParents.map((p) => (
        <TouchableOpacity key={p} style={[styles.chip, value === p && styles.chipActive]} onPress={() => onPick(p)}>
          <Text style={[styles.chipText, value === p && styles.chipTextActive]}>{p}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onCancel}>
      <View style={styles.modalOverlay}>
        <View style={[styles.modalBox, { maxHeight: '92%' }]}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16 }}>
            {/* progress */}
            <View style={{ flexDirection: 'row', gap: 6, marginBottom: 16 }}>
              {['Parents', 'Children', 'Schedules', 'Review'].map((label, i) => (
                <View key={label} style={{ flex: 1 }}>
                  <View style={{ height: 6, borderRadius: 3, backgroundColor: i <= step ? '#2563eb' : '#e5e7eb', marginBottom: 4 }} />
                  <Text style={{ fontSize: 10, textAlign: 'center', color: i === step ? '#111827' : '#9ca3af', fontWeight: i === step ? '700' : '400' }}>{label}</Text>
                </View>
              ))}
            </View>

            {step === 0 && (
              <View>
                <Text style={styles.wizTitle}>Who are the parents?</Text>
                <Text style={styles.wizSub}>Add each parent. The first is the “primary” — the default custodian used for reporting. Tap ☆ to change who is primary.</Text>
                {dParents.map((p, i) => (
                  <View key={p} style={styles.wizRow}>
                    <Text style={styles.wizRowText}>{p}{i === 0 ? '  (Primary)' : ''}</Text>
                    {i !== 0 && <TouchableOpacity onPress={() => makePrimaryW(p)}><Text style={styles.tagStar}>☆</Text></TouchableOpacity>}
                    <TouchableOpacity onPress={() => setDParents(dParents.filter((x) => x !== p))}><Text style={styles.tagX}>×</Text></TouchableOpacity>
                  </View>
                ))}
                <View style={styles.inputRow}>
                  <TextInput style={[styles.input, { flex: 1 }]} value={pName} onChangeText={setPName} placeholder="Parent name" onSubmitEditing={addParentW} returnKeyType="done" autoCapitalize="words" />
                  <TouchableOpacity style={styles.btnPrimary} onPress={addParentW}><Text style={styles.btnText}>Add</Text></TouchableOpacity>
                </View>
              </View>
            )}

            {step === 1 && (
              <View>
                <Text style={styles.wizTitle}>Who are the children?</Text>
                <Text style={styles.wizSub}>Add each child. Next you can give different children different schedules.</Text>
                {dChildren.map((c) => (
                  <View key={c} style={styles.wizRow}>
                    <Text style={styles.wizRowText}>{c}</Text>
                    <TouchableOpacity onPress={() => setDChildren(dChildren.filter((x) => x !== c))}><Text style={styles.tagX}>×</Text></TouchableOpacity>
                  </View>
                ))}
                <View style={styles.inputRow}>
                  <TextInput style={[styles.input, { flex: 1 }]} value={cName} onChangeText={setCName} placeholder="Child name" onSubmitEditing={addChildW} returnKeyType="done" autoCapitalize="words" />
                  <TouchableOpacity style={styles.btnPrimary} onPress={addChildW}><Text style={styles.btnText}>Add</Text></TouchableOpacity>
                </View>
              </View>
            )}

            {step === 2 && (
              <View>
                <Text style={styles.wizTitle}>Set up schedules</Text>
                <Text style={styles.wizSub}>Pick a schedule and which children it covers. Different kids can have different plans — add more than one. You can also skip and fill in the calendar by hand.</Text>

                {assignments.map((a) => (
                  <View key={a.id} style={styles.assignRow}>
                    <Text style={styles.assignText}>{presetLabel(a.preset)} · {a.children.join(', ')}</Text>
                    <TouchableOpacity onPress={() => setAssignments(assignments.filter((x) => x.id !== a.id))}><Text style={styles.tagX}>×</Text></TouchableOpacity>
                  </View>
                ))}

                <View style={[styles.card, { padding: 12, marginTop: 8 }]}>
                  <Text style={styles.fieldLabel}>Pattern</Text>
                  <View style={styles.chipRow}>
                    {['eow', 'eow-midweek', 'joint-weekly', '2-2-3'].map((v) => (
                      <TouchableOpacity key={v} style={[styles.chip, sPreset === v && styles.chipActive]} onPress={() => setSPreset(v)}>
                        <Text style={[styles.chipText, sPreset === v && styles.chipTextActive]}>{presetLabel(v)}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  <Text style={[styles.fieldLabel, { marginTop: 10 }]}>Date Range</Text>
                  <View style={styles.dateRow}>
                    <TouchableOpacity style={[styles.dateBtn, { flex: 1 }]} onPress={() => setDatePicker({ field: 'start' })}>
                      <Text style={styles.dateBtnText}>{displayDate(sStart)}</Text>
                    </TouchableOpacity>
                    <Text style={styles.dateSep}>→</Text>
                    <TouchableOpacity style={[styles.dateBtn, { flex: 1 }]} onPress={() => setDatePicker({ field: 'end' })}>
                      <Text style={styles.dateBtnText}>{displayDate(sEnd)}</Text>
                    </TouchableOpacity>
                  </View>

                  {(sPreset === 'eow' || sPreset === 'eow-midweek') && (
                    <View>
                      <Text style={[styles.fieldLabel, { marginTop: 10 }]}>Parent who gets the weekends</Text>
                      <ParentChips value={sSecondary} onPick={setSSecondary} />
                      <Text style={[styles.fieldLabel, { marginTop: 8 }]}>Weekend starts on</Text>
                      <View style={styles.chipRow}>
                        {[{ v: 'fri', l: 'Friday' }, { v: 'sat', l: 'Saturday' }].map((o) => (
                          <TouchableOpacity key={o.v} style={[styles.chip, sEOWDay === o.v && styles.chipActive]} onPress={() => setSEOWDay(o.v)}>
                            <Text style={[styles.chipText, sEOWDay === o.v && styles.chipTextActive]}>{o.l}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                      {sPreset === 'eow-midweek' && (
                        <View>
                          <Text style={[styles.fieldLabel, { marginTop: 8 }]}>Midweek overnight</Text>
                          <View style={styles.chipRow}>
                            {[{ d: 1, l: 'Mon' }, { d: 2, l: 'Tue' }, { d: 3, l: 'Wed' }, { d: 4, l: 'Thu' }].map((o) => (
                              <TouchableOpacity key={o.d} style={[styles.chip, sMidweek === o.d && styles.chipActive]} onPress={() => setSMidweek(o.d)}>
                                <Text style={[styles.chipText, sMidweek === o.d && styles.chipTextActive]}>{o.l}</Text>
                              </TouchableOpacity>
                            ))}
                          </View>
                        </View>
                      )}
                    </View>
                  )}

                  {(sPreset === 'joint-weekly' || sPreset === '2-2-3') && (
                    <View>
                      <Text style={[styles.fieldLabel, { marginTop: 10 }]}>{sPreset === '2-2-3' ? 'First parent (starts cycle)' : 'Parent — Week 1'}</Text>
                      <ParentChips value={sP1} onPick={setSP1} />
                      <Text style={[styles.fieldLabel, { marginTop: 8 }]}>{sPreset === '2-2-3' ? 'Second parent' : 'Parent — Week 2'}</Text>
                      <ParentChips value={sP2} onPick={setSP2} />
                    </View>
                  )}

                  <Text style={[styles.fieldLabel, { marginTop: 10 }]}>Applies to children</Text>
                  <View style={styles.chipRow}>
                    {dChildren.map((c) => {
                      const on = sChildren.includes(c);
                      return (
                        <TouchableOpacity key={c} style={[styles.chip, on && styles.chipActive]} onPress={() => toggleSChild(c)}>
                          <Text style={[styles.chipText, on && styles.chipTextActive]}>{on ? '✓ ' : ''}{c}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  <TouchableOpacity style={[styles.btnSuccess, { marginTop: 12, alignSelf: 'flex-start' }]} onPress={addAssignment}>
                    <Text style={styles.btnText}>+ Add this schedule</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {step === 3 && (
              <View>
                <Text style={styles.wizTitle}>Review</Text>
                <Text style={styles.wizReview}><Text style={{ fontWeight: '700' }}>Parents: </Text>{dParents.map((p, i) => p + (i === 0 ? ' (Primary)' : '')).join(', ') || '—'}</Text>
                <Text style={styles.wizReview}><Text style={{ fontWeight: '700' }}>Children: </Text>{dChildren.join(', ') || '—'}</Text>
                <Text style={[styles.wizReview, { fontWeight: '700' }]}>Schedules:</Text>
                {assignments.length === 0 ? (
                  <Text style={styles.wizSub}>None — you'll start with a blank calendar to fill in manually.</Text>
                ) : assignments.map((a) => (
                  <Text key={a.id} style={styles.wizReview}>• {presetLabel(a.preset)} for {a.children.join(', ')}</Text>
                ))}
                <Text style={[styles.wizSub, { marginTop: 12 }]}>Creating will set up your calendar. You can still edit everything afterward.</Text>
              </View>
            )}

            {/* nav */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 20 }}>
              <TouchableOpacity style={{ backgroundColor: '#6b7280', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8 }} onPress={step === 0 ? onCancel : () => setStep(step - 1)}>
                <Text style={styles.btnText}>{step === 0 ? 'Cancel' : 'Back'}</Text>
              </TouchableOpacity>
              {step < 3 ? (
                <TouchableOpacity style={[styles.btnPrimary, !canNext && { opacity: 0.5 }]} disabled={!canNext} onPress={() => setStep(step + 1)}>
                  <Text style={styles.btnText}>Next</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity style={styles.btnSuccess} onPress={finish}>
                  <Text style={styles.btnText}>Create Calendar</Text>
                </TouchableOpacity>
              )}
            </View>
          </ScrollView>
          {datePicker && (
            <DateTimePicker
              value={toDate(datePicker.field === 'start' ? sStart : sEnd) || new Date()}
              mode="date"
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              onChange={onDate}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [parents, setParents] = useState([]);
  const [children, setChildren] = useState([]);
  const [parentColors, setParentColors] = useState({});
  const [childColors, setChildColors] = useState({});
  const [colorPicker, setColorPicker] = useState(null); // { type: 'parent'|'child', name }
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
  const [showWizard, setShowWizard] = useState(false);
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
  const [scheduleMidweekDow, setScheduleMidweekDow] = useState(3); // Wednesday
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
        if (data.parentColors) setParentColors(data.parentColors);
        if (data.childColors) setChildColors(data.childColors);
        if (data.entries) setEntries(data.entries);
        if (data.reportingMode) setReportingMode(data.reportingMode);
        if (data.customStart) setCustomStart(data.customStart);
        if (data.customEnd) setCustomEnd(data.customEnd);
        if (data.quarterYear) setQuarterYear(data.quarterYear);
        if (data.quarter) setQuarter(data.quarter);
        if (data.preset) setPreset(data.preset);
        if (data.analysisChild) setAnalysisChild(data.analysisChild);
      }
      // Auto-open the setup wizard on a fresh install (no parents saved yet).
      if (!data || !data.parents || data.parents.length === 0) setShowWizard(true);
      setLoaded(true);
    });
  }, []);

  const completeWizard = ({ parents: wp, parentColors: wpc, children: wc, childColors: wcc, entries: we }) => {
    setParents(wp);
    setParentColors(wpc);
    setChildren(wc);
    setChildColors(wcc);
    setEntries(we);
    setShowWizard(false);
    setViewMode('calendar');
  };

  useEffect(() => {
    if (!loaded) return;
    saveData({ parents, children, parentColors, childColors, entries, reportingMode, customStart, customEnd, quarterYear, quarter, preset, analysisChild });
  }, [loaded, parents, children, parentColors, childColors, entries, reportingMode, customStart, customEnd, quarterYear, quarter, preset, analysisChild]);

  // ── config ───────────────────────────────────────────────────────────────────

  const addParent = () => {
    const name = newParentName.trim();
    if (!name || parents.includes(name)) return;
    setParents([...parents, name]);
    setParentColors({ ...parentColors, [name]: nextColor(parentColors) });
    setNewParentName('');
  };

  const removeParent = (parent) => {
    if (parents.length <= 1) return;
    Alert.alert('Remove Parent', `Remove "${parent}"?`, [
      { text: 'Cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: () => {
          setParents(parents.filter((p) => p !== parent));
          const nc = { ...parentColors }; delete nc[parent]; setParentColors(nc);
        },
      },
    ]);
  };

  const setPrimary = (parent) => {
    setParents([parent, ...parents.filter((p) => p !== parent)]);
  };

  const setColor = (type, name, color) => {
    if (type === 'parent') setParentColors({ ...parentColors, [name]: color });
    else setChildColors({ ...childColors, [name]: color });
    setColorPicker(null);
  };

  const addChild = () => {
    const name = newChildName.trim();
    if (!name || children.includes(name)) return;
    setChildren([...children, name]);
    setChildColors({ ...childColors, [name]: nextColor(childColors) });
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
          const nc = { ...childColors }; delete nc[child]; setChildColors(nc);
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

  const createEntryFromCalendar = (start, end, parent, childFilter) => {
    const cp = {};
    children.forEach((c) => { cp[c] = childFilter ? c === childFilter : true; });
    setEntries([...entries, { id: generateId(), parent, beginDate: start, endDate: end, childrenPresent: cp, note: '' }]);
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

  const resetAll = () => {
    Alert.alert(
      'Reset all data',
      'This erases all parents, children, colors, and entries, and reopens the setup wizard. This cannot be undone.',
      [
        { text: 'Cancel' },
        {
          text: 'Reset', style: 'destructive', onPress: async () => {
            try { await AsyncStorage.removeItem(STORAGE_KEY); } catch (e) {}
            setParents([]);
            setChildren([]);
            setParentColors({});
            setChildColors({});
            setEntries([{ id: generateId(), parent: '', beginDate: '', endDate: '', childrenPresent: {}, note: '' }]);
            setReportingMode('custom');
            setCustomStart('');
            setCustomEnd('');
            setAnalysisChild('all');
            setViewMode('list');
            setShowWizard(true);
          },
        },
      ]
    );
  };

  const runScheduleGenerator = () => {
    let newEntries = [];
    if (schedulePattern === 'eow' || schedulePattern === 'eow-midweek') {
      if (!scheduleSecondaryParent || !scheduleStart || !scheduleEnd) {
        Alert.alert('Missing Info', 'Please select a parent and set a date range.');
        return;
      }
      newEntries = schedulePattern === 'eow'
        ? generateEOWSchedule(scheduleSecondaryParent, scheduleStart, scheduleEnd, children, scheduleEOWDay)
        : generateEOWMidweek(scheduleSecondaryParent, scheduleStart, scheduleEnd, children, scheduleEOWDay, scheduleMidweekDow);
    } else {
      if (!scheduleJointParent1 || !scheduleJointParent2 || !scheduleStart || !scheduleEnd) {
        Alert.alert('Missing Info', 'Please select both parents and set a date range.');
        return;
      }
      newEntries = schedulePattern === '2-2-3'
        ? generate223(scheduleJointParent1, scheduleJointParent2, scheduleStart, scheduleEnd, children)
        : generateJointWeeklySchedule(scheduleJointParent1, scheduleJointParent2, scheduleStart, scheduleEnd, children);
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
      {showWizard && <SetupWizard onComplete={completeWizard} onCancel={() => setShowWizard(false)} />}
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
            <CalendarView entries={entries} parents={parents} parentColors={parentColors} children={children} childColors={childColors} onCreateEntry={createEntryFromCalendar} />
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
                      <TouchableOpacity onPress={() => setColorPicker({ type: 'parent', name: p })}>
                        <View style={[styles.tagSwatch, { backgroundColor: colorForName(p, parents, parentColors) }]} />
                      </TouchableOpacity>
                      <Text style={styles.tagText}>{p}{i === 0 ? ' (Primary)' : ''}</Text>
                      {i !== 0 && (
                        <TouchableOpacity onPress={() => setPrimary(p)}>
                          <Text style={styles.tagStar}>☆</Text>
                        </TouchableOpacity>
                      )}
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
                      <TouchableOpacity onPress={() => setColorPicker({ type: 'child', name: c })}>
                        <View style={[styles.tagSwatch, { backgroundColor: colorForName(c, children, childColors) }]} />
                      </TouchableOpacity>
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

                <TouchableOpacity style={[styles.btnDanger, { marginTop: 20, alignSelf: 'flex-start' }]} onPress={resetAll}>
                  <Text style={styles.btnText}>Reset all data</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          {/* Actions */}
          <View style={styles.actionRow}>
            <TouchableOpacity style={{ backgroundColor: '#6b7280', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8 }} onPress={() => setShowWizard(true)}>
              <Text style={styles.btnText}>🧭 Setup</Text>
            </TouchableOpacity>
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

      {/* Color Picker Modal */}
      <Modal
        visible={colorPicker !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setColorPicker(null)}
      >
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setColorPicker(null)}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Color for {colorPicker?.name}</Text>
            <View style={styles.swatchGrid}>
              {COLOR_CHOICES.map((c) => {
                const current = colorPicker
                  ? colorForName(colorPicker.name, colorPicker.type === 'parent' ? parents : children, colorPicker.type === 'parent' ? parentColors : childColors)
                  : null;
                return (
                  <TouchableOpacity
                    key={c}
                    onPress={() => setColor(colorPicker.type, colorPicker.name, c)}
                    style={[styles.swatchChoice, { backgroundColor: c }, current === c && styles.swatchChoiceSelected]}
                  />
                );
              })}
            </View>
            <TouchableOpacity style={styles.modalCancel} onPress={() => setColorPicker(null)}>
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
                {[
                  { v: 'eow', label: 'Every other weekend (~80/20)' },
                  { v: 'eow-midweek', label: 'EOW + midweek (~70/30)' },
                  { v: 'joint-weekly', label: 'Alternating weeks (50/50)' },
                  { v: '2-2-3', label: '2-2-3 rotation (50/50)' },
                ].map((opt) => (
                  <TouchableOpacity
                    key={opt.v}
                    style={[styles.chip, schedulePattern === opt.v && styles.chipActive]}
                    onPress={() => setSchedulePattern(opt.v)}
                  >
                    <Text style={[styles.chipText, schedulePattern === opt.v && styles.chipTextActive]}>{opt.label}</Text>
                  </TouchableOpacity>
                ))}
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

              {/* EOW / EOW+midweek options */}
              {(schedulePattern === 'eow' || schedulePattern === 'eow-midweek') && (
                <View style={{ marginHorizontal: 16 }}>
                  <Text style={[styles.fieldLabel, { marginTop: 12 }]}>Non-primary parent (gets the weekends)</Text>
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
                  {schedulePattern === 'eow-midweek' && (
                    <View>
                      <Text style={[styles.fieldLabel, { marginTop: 8 }]}>Midweek Overnight</Text>
                      <View style={styles.chipRow}>
                        {[{ d: 1, l: 'Mon' }, { d: 2, l: 'Tue' }, { d: 3, l: 'Wed' }, { d: 4, l: 'Thu' }].map((o) => (
                          <TouchableOpacity key={o.d} style={[styles.chip, scheduleMidweekDow === o.d && styles.chipActive]} onPress={() => setScheduleMidweekDow(o.d)}>
                            <Text style={[styles.chipText, scheduleMidweekDow === o.d && styles.chipTextActive]}>{o.l}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </View>
                  )}
                </View>
              )}

              {/* Joint weekly / 2-2-3 options */}
              {(schedulePattern === 'joint-weekly' || schedulePattern === '2-2-3') && (
                <View style={{ marginHorizontal: 16 }}>
                  <Text style={[styles.fieldLabel, { marginTop: 12 }]}>{schedulePattern === '2-2-3' ? 'First parent (starts cycle)' : 'Parent — Week 1'}</Text>
                  <TouchableOpacity style={styles.selectBtn} onPress={() => setScheduleParentPickerTarget('joint1')}>
                    <Text style={scheduleJointParent1 ? styles.selectBtnText : styles.selectBtnPlaceholder}>
                      {scheduleJointParent1 || 'Select parent…'}
                    </Text>
                    <Text style={styles.selectArrow}>›</Text>
                  </TouchableOpacity>
                  <Text style={[styles.fieldLabel, { marginTop: 8 }]}>{schedulePattern === '2-2-3' ? 'Second parent' : 'Parent — Week 2'}</Text>
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
  tagSwatch: { width: 14, height: 14, borderRadius: 4, marginRight: 6, borderWidth: 1, borderColor: 'rgba(0,0,0,0.15)' },
  tagStar: { fontSize: 15, color: '#6b7280', marginRight: 4 },
  tagX: { fontSize: 18, color: '#dc2626', lineHeight: 20 },
  swatchGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, padding: 16 },
  swatchChoice: { width: 36, height: 36, borderRadius: 18, borderWidth: 2, borderColor: '#e5e7eb' },
  swatchChoiceSelected: { borderColor: '#111827', borderWidth: 3 },
  wizTitle: { fontSize: 20, fontWeight: '700', color: '#111827', marginBottom: 6 },
  wizSub: { fontSize: 13, color: '#6b7280', marginBottom: 14, lineHeight: 18 },
  wizRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f3f4f6', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8 },
  wizRowText: { flex: 1, fontSize: 15, color: '#111827' },
  wizReview: { fontSize: 14, color: '#374151', marginBottom: 6, lineHeight: 20 },
  assignRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#eff6ff', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 6 },
  assignText: { flex: 1, fontSize: 13, color: '#1d4ed8' },
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
  calDay: { flex: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  calDayNum: { fontSize: 14, fontWeight: '600' },
  calDayToday: { fontWeight: '800', textDecorationLine: 'underline' },
  calDaySelected: { borderColor: '#111827', borderWidth: 3 },
  calDayConflict: { borderColor: '#dc2626', borderWidth: 2, borderStyle: 'dashed' },
  calConflictNote: { fontSize: 12, color: '#dc2626', marginTop: 8 },
  calHint: { fontSize: 12, color: '#9ca3af', marginTop: 10, lineHeight: 17 },
  calSelectHint: { fontSize: 12, color: '#2563eb', textAlign: 'center', marginBottom: 10 },
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
