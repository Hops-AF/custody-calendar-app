import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, Switch, FlatList, Pressable,
  Modal, Alert, StyleSheet, StatusBar, Platform, Share, AppState,
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { IconButton, PersonBadge, ChildSelector, DetailLine, SectionHeading, Field as TextInput, theme } from './family-ui';
const { monthWeeks, textOnColor, dayDetails, dayShareText } = require('./calendar-ui');
const {
  daysInclusive,
  computeCustodySummary,
  getCalendarDayState,
  resolveLocation,
  buildCustodyBlocks,
  buildICS,
  buildKidPage,
  getKidView,
} = require('./custody-engine');

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
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function displayDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return new Date(parseInt(y), parseInt(m) - 1, parseInt(d))
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function timePickerValue(value) {
  const date = new Date();
  date.setSeconds(0, 0);
  if (!value) return date;
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return date;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3]?.toUpperCase();
  if (meridiem === 'PM' && hours < 12) hours += 12;
  if (meridiem === 'AM' && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return date;
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function formatTime(date) {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// Local-time-safe date helpers (avoid UTC shift from toISOString)
function pad2(n) { return String(n).padStart(2, '0'); }

function localTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function useToday() {
  const [today, setToday] = useState(localTodayStr);
  useEffect(() => {
    const refresh = () => setToday(localTodayStr());
    const timer = setInterval(refresh, 60000);
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') refresh(); });
    return () => { clearInterval(timer); subscription.remove(); };
  }, []);
  return today;
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
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
          beginDate: formatDateStr(actualStart),
          endDate: formatDateStr(actualEnd),
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
        beginDate: formatDateStr(actualStart),
        endDate: formatDateStr(actualEnd),
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

const APP_TABS = [
  { id: 'calendar', label: 'Calendar', icon: 'calendar-outline', activeIcon: 'calendar' },
  { id: 'kid', label: 'My Days', icon: 'sunny-outline', activeIcon: 'sunny' },
  { id: 'entries', label: 'Entries', icon: 'list-outline', activeIcon: 'list' },
  { id: 'reports', label: 'Reports', icon: 'pie-chart-outline', activeIcon: 'pie-chart' },
  { id: 'settings', label: 'Settings', icon: 'settings-outline', activeIcon: 'settings' },
];

function BottomTabBar({ value, onChange }) {
  return (
    <View style={styles.bottomBar} accessibilityRole="tablist">
      {APP_TABS.map((tab) => {
        const active = value === tab.id;
        return (
          <TouchableOpacity
            key={tab.id}
            style={styles.bottomTab}
            onPress={() => onChange(tab.id)}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected: active }}
          >
            <View style={[styles.tabIconFrame, active && styles.tabIconFrameActive]}>
              <Ionicons name={active ? tab.activeIcon : tab.icon} size={22} color={active ? theme.accent : theme.muted} />
            </View>
            <Text style={[styles.bottomTabLabel, active && styles.bottomTabLabelActive]}>{tab.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function NativePickerSheet({ picker, title, onChange, onCancel, onConfirm }) {
  if (!picker) return null;

  if (Platform.OS !== 'ios') {
    return (
      <DateTimePicker
        value={picker.draft}
        mode={picker.mode}
        display="default"
        onChange={(event, selected) => {
          if (event.type === 'dismissed' || !selected) onCancel();
          else onConfirm(selected);
        }}
      />
    );
  }

  return (
    <Modal visible transparent animationType="slide" presentationStyle="overFullScreen" onRequestClose={onCancel}>
      <View style={styles.pickerOverlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} accessibilityLabel="Cancel picker" />
        <SafeAreaView style={styles.pickerSheet} edges={['bottom']}>
          <View style={styles.pickerToolbar}>
            <TouchableOpacity onPress={onCancel} accessibilityRole="button">
              <Text style={styles.pickerCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.pickerTitle}>{title}</Text>
            <TouchableOpacity onPress={() => onConfirm(picker.draft)} accessibilityRole="button">
              <Text style={styles.pickerDone}>Done</Text>
            </TouchableOpacity>
          </View>
          <DateTimePicker
            value={picker.draft}
            mode={picker.mode}
            display="spinner"
            onChange={(_event, selected) => selected && onChange(selected)}
            style={styles.pickerControl}
          />
        </SafeAreaView>
      </View>
    </Modal>
  );
}

// ── CalendarView ──────────────────────────────────────────────────────────────

function CalendarView({ entries, parents, parentColors, parentLocations, children, childColors, onCreateEntry, onOpenEntry, today }) {
  const [viewYear, setViewYear] = useState(() => toDate(today).getFullYear());
  const [viewMonth, setViewMonth] = useState(() => toDate(today).getMonth());
  const [selectedDate, setSelectedDate] = useState(today);
  const [rangeMode, setRangeMode] = useState(false);
  const [pendingStart, setPendingStart] = useState(null);
  const [pendingRange, setPendingRange] = useState(null);
  const [childFilter, setChildFilter] = useState(null);
  const [pendingParent, setPendingParent] = useState(null);
  const [pendingHoliday, setPendingHoliday] = useState(false);
  const [pendingHolidayName, setPendingHolidayName] = useState('');
  const activeChild = children.includes(childFilter) ? childFilter : null;
  const colorFor = (name) => colorForName(name, parents, parentColors);
  const weeks = useMemo(() => monthWeeks(viewYear, viewMonth), [viewYear, viewMonth]);
  const dayStates = useMemo(() => Object.fromEntries(weeks.flat().filter(Boolean).map((date) =>
    [date, getCalendarDayState(date, entries, children, activeChild)])), [weeks, entries, children, activeChild]);
  const details = useMemo(() => dayDetails({
    date: selectedDate, entries, parents, children, childFilter: activeChild, parentLocations,
  }), [selectedDate, entries, parents, children, activeChild, parentLocations]);
  const monthTally = {};
  Object.values(dayStates).forEach((state) => state.childStates.forEach((child) => {
    if (child.type === 'single') monthTally[child.parent] = (monthTally[child.parent] || 0) + 1;
  }));

  const resetRange = () => {
    setPendingStart(null); setPendingRange(null); setPendingParent(null);
    setPendingHoliday(false); setPendingHolidayName('');
  };
  const changeMonth = (offset) => {
    const date = new Date(viewYear, viewMonth + offset, 1);
    setViewYear(date.getFullYear()); setViewMonth(date.getMonth());
  };
  const selectDate = (date) => {
    if (!rangeMode) { setSelectedDate(date); return; }
    if (!pendingStart || pendingRange) {
      resetRange(); setPendingStart(date); return;
    }
    setPendingRange({ start: date < pendingStart ? date : pendingStart, end: date < pendingStart ? pendingStart : date });
  };
  const shareDay = async () => {
    try { await Share.share({ message: dayShareText(selectedDate, details) }); }
    catch { Alert.alert('Could not share', 'Please try again.'); }
  };

  return (
    <View>
      <SectionHeading title="Family calendar" subtitle={rangeMode ? 'New date range' : 'Daily plans'}>
        <IconButton icon={rangeMode ? 'close' : 'add'} label={rangeMode ? 'Cancel date range' : 'Add date range'}
          active={rangeMode} onPress={() => { resetRange(); setRangeMode(!rangeMode); }} />
      </SectionHeading>
      <ChildSelector children={children} value={activeChild} includeAll colors={(c) => colorForName(c, children, childColors)}
        onChange={(c) => { setChildFilter(c); resetRange(); }} />
      <View style={styles.calendarSurface}>
        <View style={styles.calNav}>
          <Text style={styles.calNavTitle}>{MONTH_NAMES[viewMonth]} <Text style={styles.calYear}>{viewYear}</Text></Text>
          <View style={styles.toolRow}>
            <IconButton icon="today-outline" label="Go to today" onPress={() => {
              setViewYear(toDate(today).getFullYear()); setViewMonth(toDate(today).getMonth()); setSelectedDate(today);
            }} />
            <IconButton icon="chevron-back" label="Previous month" onPress={() => changeMonth(-1)} />
            <IconButton icon="chevron-forward" label="Next month" onPress={() => changeMonth(1)} />
          </View>
        </View>
        {rangeMode && <View style={styles.rangeStatus} accessibilityLiveRegion="polite">
          <Ionicons name="calendar-outline" size={18} color={theme.accent} />
          <Text style={styles.rangeStatusText}>{pendingRange ? 'Dates selected' : pendingStart ? 'Select end date' : 'Select start date'}</Text>
          {pendingStart && <IconButton icon="refresh-outline" label="Restart date selection" onPress={resetRange} />}
        </View>}
        <View style={styles.calWeekRow}>
          {DAY_NAMES.map((day) => <Text key={day} style={styles.calWeekday}>{day}</Text>)}
        </View>
        {weeks.map((week, row) => <View key={row} style={styles.calendarWeek}>
          {week.map((date, column) => {
            if (!date) return <View key={'blank-' + column} style={styles.calCell} />;
            const state = dayStates[date];
            const color = state.type === 'single' ? colorFor(state.parent) : '#e7eae8';
            const selected = rangeMode
              ? date === pendingStart || Boolean(pendingRange && date >= pendingRange.start && date <= pendingRange.end)
              : date === selectedDate;
            const foreground = textOnColor(color);
            return <Pressable key={date} onPress={() => selectDate(date)} style={styles.calCell}
              accessibilityRole="button" accessibilityState={{ selected }}
              accessibilityLabel={displayDate(date) + (date === today ? ', today' : '') + ', ' +
                (state.type === 'conflict' ? 'Schedule needs review' : state.type === 'split' ? 'Different plans by child' : state.parent || 'No explicit entry')}
            >
              {({ pressed }) => <View style={[styles.calDay, { backgroundColor: color }, selected && styles.calDaySelected, pressed && { opacity: 0.65 }]}>
                {state.type === 'split' && <View style={styles.calSplitFill}>{state.childStates.map((c, i) =>
                  <View key={i} style={{ flex: 1, backgroundColor: c.parent ? colorFor(c.parent) : '#e7eae8' }} />
                )}</View>}
                <Text style={[styles.calDayNum, { color: foreground }, state.type === 'split' && styles.splitNumber]}>{Number(date.slice(-2))}</Text>
                {date === today && <View style={[styles.todayDot, { backgroundColor: state.type === 'split' ? '#182421' : foreground }]} />}
                {state.type === 'conflict' && <Ionicons name="alert-circle" size={13} color="#b42318" style={styles.dayMarker} />}
                {state.isException && state.type !== 'conflict' && <Ionicons name="star" size={9} color={foreground} style={styles.dayMarker} />}
                {selected && <View style={styles.selectedTick}><Ionicons name="checkmark" size={10} color="#fff" /></View>}
              </View>}
            </Pressable>;
          })}
        </View>)}
        <View style={styles.calendarLegend}>
          {parents.map((parent) => <View key={parent} style={styles.legendItem}>
            <View style={[styles.legendSwatch, { backgroundColor: colorFor(parent) }]} />
            <Text style={styles.legendCaption}>{parent}</Text>
          </View>)}
          <View style={styles.legendItem}><View style={[styles.legendSwatch, { backgroundColor: '#e7eae8' }]} /><Text style={styles.legendCaption}>No entry</Text></View>
        </View>
      </View>

      {rangeMode ? <View style={styles.sectionBand}>
        <SectionHeading title={pendingRange ? 'New custody period' : 'Date range'}
          subtitle={pendingRange ? displayDate(pendingRange.start) + ' - ' + displayDate(pendingRange.end) : pendingStart ? 'From ' + displayDate(pendingStart) : 'No dates selected'} />
        {pendingRange && <>
          <Text style={styles.windowInfo}>{daysInclusive(pendingRange.start, pendingRange.end)} days · {activeChild || 'All children'}</Text>
          {!parents.length && <Text style={styles.kidEmpty}>No parents added. Household details are in Settings.</Text>}
          <View style={styles.parentChoices}>{parents.map((parent) => <Pressable key={parent}
            onPress={() => setPendingParent(parent)} accessibilityRole="radio" accessibilityState={{ checked: parent === pendingParent }}
            style={[styles.parentChoice, parent === pendingParent && styles.parentChoiceSelected]}>
            <PersonBadge name={parent} color={colorFor(parent)} small />
            <Text style={styles.parentChoiceText}>{parent}</Text>
            <Ionicons name={parent === pendingParent ? 'radio-button-on' : 'radio-button-off'} size={21} color={theme.accent} />
          </Pressable>)}</View>
          <View style={styles.switchRow}><Text style={styles.switchLabel}>Holiday / exception</Text><Switch value={pendingHoliday} onValueChange={setPendingHoliday} trackColor={{ true: theme.accent }} /></View>
          {pendingHoliday && <TextInput style={styles.input} value={pendingHolidayName} onChangeText={setPendingHolidayName} placeholder="Holiday name (optional)" />}
          <Pressable disabled={!parents.includes(pendingParent)} accessibilityRole="button" accessibilityState={{ disabled: !parents.includes(pendingParent) }}
            onPress={() => {
              onCreateEntry(pendingRange.start, pendingRange.end, pendingParent, activeChild, pendingHoliday, pendingHolidayName);
              setSelectedDate(pendingRange.start); resetRange(); setRangeMode(false);
            }} style={({ pressed }) => [styles.saveRangeButton, !parents.includes(pendingParent) && styles.btnDisabled, pressed && { opacity: 0.7 }]}>
            <Ionicons name="checkmark" size={19} color="#fff" /><Text style={styles.btnText}>Save period</Text>
          </Pressable>
        </>}
      </View> : <View style={styles.sectionBand}>
        <SectionHeading title={selectedDate === today ? 'Today' : displayDate(selectedDate)}
          subtitle={selectedDate === today ? displayDate(selectedDate) : 'Daily plan'}>
          <IconButton icon="share-outline" label="Share daily plan" onPress={shareDay} />
        </SectionHeading>
        {details.map((d, index) => <View key={d.child || index} style={styles.dayDetail}>
          <View style={styles.personLine}>
            <PersonBadge name={d.parent || '?'} color={d.type === 'conflict' ? '#fbe7de' : d.parent ? colorFor(d.parent) : '#e7eae8'} />
            <View style={{ flex: 1 }}><Text style={styles.detailChild}>{d.child || 'Family'}</Text>
              <Text style={styles.detailParent}>{d.type === 'conflict' ? 'Schedule needs review' : d.parent ? 'With ' + d.parent : 'Not scheduled'}</Text>
            </View>
            {d.entry?.id && <IconButton icon="create-outline" label={'Edit entry for ' + (d.child || 'family')} onPress={() => onOpenEntry(d.entry.id)} />}
          </View>
          <Text style={[styles.sourceLabel, d.type === 'conflict' && { color: '#974219' }]}>{d.source}</Text>
          {d.type === 'conflict' ? <>
            <Text style={styles.screenSub}>More than one parent is listed for this date.</Text>
            {d.entries.map((entry) => <Pressable key={entry.id} accessibilityRole="button" onPress={() => onOpenEntry(entry.id)} style={styles.conflictEntry}>
              <Text style={styles.parentChoiceText}>{entry.parent}</Text><Ionicons name="chevron-forward" size={18} color={theme.muted} />
            </Pressable>)}
          </> : <>
            <DetailLine icon="time-outline" text={'Exchange: ' + (d.entry?.exchangeTime || 'Time not set')} />
            <DetailLine icon="location-outline" text={'Meet at: ' + (d.entry?.exchangePlace || 'Place not set')} />
            {d.location ? <DetailLine icon="home-outline" text={d.location} /> : null}
          </>}
        </View>)}
      </View>}
      <View style={styles.sectionBand}>
        <SectionHeading title="Recorded this month" subtitle={activeChild || (children.length > 1 ? 'Child-days across all children' : 'Custody days')} />
        {parents.map((parent) => <View key={parent} style={styles.legendRow}>
          <View style={[styles.legendSwatch, { backgroundColor: colorFor(parent) }]} />
          <Text style={styles.legendText}>{parent}</Text><Text style={styles.legendCount}>{monthTally[parent] || 0}</Text>
        </View>)}
        <Text style={styles.calHint}>Explicit entries only. Reports also count primary-parent defaults.</Text>
      </View>
    </View>
  );
}

// ── KidView ───────────────────────────────────────────────────────────────────

// A read-only, plain-language view for the kids: where they are today, when
// they switch next, and what the next two weeks look like.
function KidView({ entries, parents, parentColors, parentLocations, parentPhones, children, childColors, today }) {
  const [child, setChild] = useState(children[0] || null);
  const activeChild = children.includes(child) ? child : (children[0] || null);
  const view = useMemo(() => getKidView({ entries, parents, children, child: activeChild, today, daysAhead: 14 }),
    [entries, parents, children, activeChild, today]);
  const colorFor = (parent) => colorForName(parent, parents, parentColors);
  const shortDate = (date) => toDate(date)?.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) || '';
  const currentColor = view.current ? colorFor(view.current.parent) : '#e7eae8';
  const currentLocation = view.current ? resolveLocation(view.current.entry, parentLocations) || parentLocations[view.current.parent] : '';
  const phone = view.current ? parentPhones[view.current.parent] : '';
  const ink = textOnColor(currentColor);

  return <View>
    <SectionHeading title="My days" subtitle={toDate(today).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} />
    <ChildSelector children={children} value={activeChild} onChange={setChild} colors={(c) => colorForName(c, children, childColors)} />
    <View style={[styles.kidTodayBand, { borderLeftColor: currentColor }]}>
      <View style={styles.personLine}>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.kidHome, { backgroundColor: currentColor }]}><Ionicons name="home-outline" size={30} color={ink} /></View>
        <View style={{ flex: 1 }}><Text style={styles.detailChild}>Today{activeChild ? ' for ' + activeChild : ''}</Text>
          <Text style={styles.kidTodayWho}>{view.current ? 'With ' + view.current.parent : 'Plan not available'}</Text>
        </View>
      </View>
      {!view.current && <Text style={styles.kidEmpty}>A parent can check today's plan.</Text>}
      {currentLocation ? <DetailLine icon="location-outline" text={currentLocation} /> : null}
      {phone ? <DetailLine icon="call-outline" text={phone} /> : null}
      {view.current && view.next && <DetailLine icon="calendar-outline" text={'Through ' + shortDate(view.current.end)} />}
      {view.current?.isException && <DetailLine icon="star-outline" text="Special schedule" />}
    </View>

    <View style={styles.sectionBand}>
      <SectionHeading title="Coming up" />
      {view.next ? <>
        <View style={styles.personLine}>
          <PersonBadge name={view.next.parent} color={colorFor(view.next.parent)} />
          <View style={{ flex: 1 }}><Text style={styles.detailChild}>{view.daysUntilChange === 1 ? 'Tomorrow' : 'In ' + view.daysUntilChange + ' days'}</Text>
            <Text style={styles.kidNextWho}>Time with {view.next.parent}</Text>
          </View>
        </View>
        <DetailLine icon="calendar-outline" text={displayDate(view.next.start)} />
        <DetailLine icon="time-outline" text={view.next.entry?.exchangeTime || 'Time not added yet'} />
        <DetailLine icon="location-outline" text={view.next.entry?.exchangePlace || 'Meeting place not added yet'} />
      </> : <Text style={styles.kidEmpty}>No change of home listed in the next two weeks.</Text>}
    </View>

    <View style={styles.sectionBand}>
      <SectionHeading title="Next two weeks" />
      {!view.upcoming.length && <Text style={styles.kidEmpty}>Your upcoming plan will appear here.</Text>}
      {view.upcoming.map((block, i) => <View key={block.start + '-' + i} style={styles.kidRow}>
        <View style={styles.timelineRail}><View style={[styles.timelineDot, { backgroundColor: colorFor(block.parent) }]} /></View>
        <View style={{ flex: 1 }}><Text style={styles.kidRowWho}>{block.parent}</Text>
          <Text style={styles.kidRowWhen}>{shortDate(block.start)}{block.start !== block.end ? ' - ' + shortDate(block.end) : ''}</Text>
        </View>
        <Ionicons name={block.isException ? 'star-outline' : 'home-outline'} size={18} color={theme.muted} />
      </View>)}
    </View>
  </View>;
}

// ── SetupWizard ───────────────────────────────────────────────────────────────

function SetupWizard({ initialData, onComplete, onCancel }) {
  const curYear = new Date().getFullYear();
  const [step, setStep] = useState(0);
  const [dParents, setDParents] = useState(initialData.parents || []);
  const [dChildren, setDChildren] = useState(initialData.children || []);
  const [pName, setPName] = useState('');
  const [cName, setCName] = useState('');
  const [assignments, setAssignments] = useState(initialData.scheduleAssignments || []);

  const [sPreset, setSPreset] = useState('eow');
  const [sStart, setSStart] = useState(`${curYear}-01-01`);
  const [sEnd, setSEnd] = useState(`${curYear}-12-31`);
  const [sSecondary, setSSecondary] = useState('');
  const [sP1, setSP1] = useState('');
  const [sP2, setSP2] = useState('');
  const [sEOWDay, setSEOWDay] = useState('fri');
  const [sMidweek, setSMidweek] = useState(3);
  const [sChildren, setSChildren] = useState([]);
  const [datePicker, setDatePicker] = useState(null); // { field, mode, draft }

  useEffect(() => {
    setSChildren((selected) => selected.length ? selected.filter((child) => dChildren.includes(child)) : dChildren);
    setAssignments((current) => current
      .map((assignment) => ({ ...assignment, children: assignment.children.filter((child) => dChildren.includes(child)) }))
      .filter((assignment) => assignment.children.length));
  }, [dChildren]);
  useEffect(() => {
    if (dParents.length) {
      setSSecondary((value) => dParents.includes(value) && value !== dParents[0] ? value : (dParents[1] || ''));
      setSP1((value) => dParents.includes(value) ? value : dParents[0]);
      setSP2((value) => dParents.includes(value) && value !== dParents[0] ? value : (dParents[1] || ''));
    }
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
  const assignmentIsValid = (assignment) => {
    if (!assignment.start || !assignment.end || assignment.start > assignment.end || !assignment.children.length) return false;
    if (assignment.preset === 'eow' || assignment.preset === 'eow-midweek') {
      return dParents.includes(assignment.secondary) && assignment.secondary !== dParents[0];
    }
    return dParents.includes(assignment.p1) && dParents.includes(assignment.p2) && assignment.p1 !== assignment.p2;
  };

  const assignmentError = (() => {
    if (!sStart || !sEnd) return 'Set a start and end date.';
    if (sStart > sEnd) return 'The end date must be on or after the start date.';
    if (sChildren.length === 0) return 'Select at least one child.';
    if (dParents.length < 2) return 'Add two parents before creating a shared schedule.';
    if ((sPreset === 'eow' || sPreset === 'eow-midweek') && (!sSecondary || sSecondary === dParents[0])) {
      return 'Choose a non-primary parent for weekends.';
    }
    if ((sPreset === 'joint-weekly' || sPreset === '2-2-3') && (!sP1 || !sP2 || sP1 === sP2)) {
      return 'Choose two different parents.';
    }
    return '';
  })();

  const addAssignment = () => {
    if (assignmentError) { Alert.alert('Schedule needs attention', assignmentError); return; }
    let extra;
    if (sPreset === 'eow' || sPreset === 'eow-midweek') {
      extra = { secondary: sSecondary };
    } else {
      extra = { p1: sP1, p2: sP2 };
    }
    setAssignments([...assignments, { id: generateId(), preset: sPreset, start: sStart, end: sEnd, eowDay: sEOWDay, midweek: sMidweek, children: [...sChildren], ...extra }]);
    setSChildren(dChildren);
  };

  const finish = () => {
    if (assignments.some((assignment) => !assignmentIsValid(assignment))) {
      Alert.alert('Review schedules', 'One or more schedules no longer match the selected parents or dates. Remove and recreate the highlighted schedule before continuing.');
      return;
    }
    const parentColors = {};
    dParents.forEach((parent) => { parentColors[parent] = initialData.parentColors?.[parent] || nextColor(parentColors); });
    const childColors = {};
    dChildren.forEach((child) => { childColors[child] = initialData.childColors?.[child] || nextColor(childColors); });
    let generatedEntries = [];
    assignments.forEach((a) => {
      let gen = [];
      if (a.preset === 'eow') gen = generateEOWSchedule(a.secondary, a.start, a.end, a.children, a.eowDay);
      else if (a.preset === 'eow-midweek') gen = generateEOWMidweek(a.secondary, a.start, a.end, a.children, a.eowDay, a.midweek);
      else if (a.preset === 'joint-weekly') gen = generateJointWeeklySchedule(a.p1, a.p2, a.start, a.end, a.children);
      else if (a.preset === '2-2-3') gen = generate223(a.p1, a.p2, a.start, a.end, a.children);
      generatedEntries = generatedEntries.concat(gen.map((entry) => ({ ...entry, scheduleId: a.id })));
    });
    const manualEntries = (initialData.entries || [])
      .filter((entry) => !entry.scheduleId)
      .filter((entry) => entry.parent || entry.beginDate || entry.endDate || entry.note)
      .filter((entry) => !entry.parent || dParents.includes(entry.parent))
      .map((entry) => ({
        ...entry,
        childrenPresent: Object.fromEntries(dChildren.map((child) => [child, Boolean(entry.childrenPresent?.[child])])),
      }));
    let entries = [...manualEntries, ...generatedEntries];
    if (entries.length === 0) {
      const cp = {}; dChildren.forEach((c) => { cp[c] = true; });
      entries = [{ id: generateId(), parent: '', beginDate: '', endDate: '', childrenPresent: cp, note: '' }];
    }
    onComplete({
      parents: dParents,
      parentColors,
      children: dChildren,
      childColors,
      entries,
      scheduleAssignments: assignments,
    });
  };

  const openWizardDatePicker = (field) => {
    const current = field === 'start' ? sStart : sEnd;
    setDatePicker({ field, mode: 'date', draft: toDate(current) || new Date() });
  };

  const confirmWizardDate = (d) => {
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
      <View style={styles.wizardOverlay}>
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
                  <View key={a.id} style={[styles.assignRow, !assignmentIsValid(a) && styles.assignRowInvalid]}>
                    <Text style={[styles.assignText, !assignmentIsValid(a) && styles.inlineError]}>{presetLabel(a.preset)} · {a.children.join(', ')}{assignmentIsValid(a) ? '' : ' · needs attention'}</Text>
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
                    <TouchableOpacity style={[styles.dateBtn, { flex: 1 }]} onPress={() => openWizardDatePicker('start')}>
                      <Text style={styles.dateBtnText}>{displayDate(sStart)}</Text>
                    </TouchableOpacity>
                    <Text style={styles.dateSep}>→</Text>
                    <TouchableOpacity style={[styles.dateBtn, { flex: 1 }]} onPress={() => openWizardDatePicker('end')}>
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

                  {assignmentError ? <Text style={styles.inlineError}>{assignmentError}</Text> : null}
                  <TouchableOpacity
                    style={[styles.btnSuccess, { marginTop: 12, alignSelf: 'flex-start' }, assignmentError && styles.btnDisabled]}
                    onPress={addAssignment}
                    disabled={Boolean(assignmentError)}
                  >
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
                <Text style={[styles.wizSub, { marginTop: 12 }]}>Manual entries are preserved. Recurring entries are regenerated from these saved schedule definitions.</Text>
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
          <NativePickerSheet
            picker={datePicker}
            title={datePicker?.field === 'start' ? 'Start date' : 'End date'}
            onChange={(draft) => setDatePicker((current) => ({ ...current, draft }))}
            onCancel={() => setDatePicker(null)}
            onConfirm={confirmWizardDate}
          />
        </View>
      </View>
  );
}

function EntriesScreen({ entries, parents, parentColors, children, parentLocations, today, onAdd, onSelect }) {
  const [period, setPeriod] = useState('upcoming');
  const visibleEntries = useMemo(() => entries.filter((entry) => period === 'all' || !entry.endDate || entry.endDate >= today)
    .slice().sort((a, b) => (a.beginDate || '').localeCompare(b.beginDate || '')), [entries, period, today]);
  const totalDays = visibleEntries.reduce((sum, entry) => sum + (daysInclusive(entry.beginDate, entry.endDate) || 0), 0);
  const renderEntry = ({ item }) => {
    const days = daysInclusive(item.beginDate, item.endDate);
    const includedChildren = children.filter((child) => item.childrenPresent?.[child]);
    const location = resolveLocation(item, parentLocations);
    const incomplete = !item.parent || days === null || includedChildren.length === 0;
    return (
      <TouchableOpacity
        style={[styles.entrySummary, item.isException && styles.entrySummaryHoliday]}
        onPress={() => onSelect(item.id)}
        activeOpacity={0.72}
        accessibilityRole="button"
        accessibilityLabel={`Edit ${item.parent || 'unassigned'} custody entry, ${item.beginDate && item.endDate ? `${displayDate(item.beginDate)} to ${displayDate(item.endDate)}` : 'dates not set'}`}
      >
        <View style={[styles.entrySummaryStripe, { backgroundColor: item.parent ? colorForName(item.parent, parents, parentColors) : '#9ca3af' }]} />
        <View style={styles.entrySummaryBody}>
          <View style={styles.entrySummaryTop}>
            <View style={{ flex: 1 }}>
              <Text style={styles.entrySummaryTitle}>
                {item.beginDate && item.endDate ? `${displayDate(item.beginDate)} - ${displayDate(item.endDate)}` : 'New custody entry'}
              </Text>
              <Text style={[styles.entrySummaryParent, incomplete && styles.entrySummaryWarning]}>
                {incomplete ? 'Needs details' : item.parent}
              </Text>
            </View>
            {item.isException && <View style={styles.holidayBadge}><Text style={styles.holidayBadgeText}>Holiday</Text></View>}
            <Ionicons name="chevron-forward" size={20} color="#9ca3af" />
          </View>
          <Text style={styles.entrySummaryMeta} numberOfLines={1}>
            {days === null ? 'Dates not set' : `${days} custody ${days === 1 ? 'day' : 'days'}`}
            {includedChildren.length ? `  |  ${includedChildren.join(', ')}` : '  |  No children selected'}
          </Text>
          {(location || item.exchangeTime || item.exchangePlace) ? (
            <Text style={styles.entrySummaryDetail} numberOfLines={1}>
              {[location, item.exchangeTime, item.exchangePlace].filter(Boolean).join('  |  ')}
            </Text>
          ) : null}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <FlatList
      data={visibleEntries}
      renderItem={renderEntry}
      keyExtractor={(item) => item.id}
      style={styles.screenList}
      contentContainerStyle={styles.listContent}
      keyboardShouldPersistTaps="handled"
      initialNumToRender={10}
      windowSize={7}
      ListHeaderComponent={(
        <View>
        <View style={styles.screenIntroRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.screenTitle}>Custody entries</Text>
            <Text style={styles.screenSub}>{visibleEntries.length} {period === 'all' ? 'recorded' : 'current and upcoming'} {visibleEntries.length === 1 ? 'period' : 'periods'}</Text>
          </View>
          <TouchableOpacity style={styles.iconPrimaryButton} onPress={onAdd} accessibilityRole="button" accessibilityLabel="Add custody entry">
            <Ionicons name="add" size={24} color="#fff" />
          </TouchableOpacity>
        </View>
        <View style={styles.segment} accessibilityRole="tablist">
          {['upcoming', 'all'].map((value) => <Pressable key={value} onPress={() => setPeriod(value)}
            accessibilityRole="tab" accessibilityState={{ selected: period === value }}
            style={[styles.segmentBtn, period === value && styles.segmentBtnActive]}>
            <Text style={[styles.segmentText, period === value && styles.segmentTextActive]}>{value === 'all' ? 'All entries' : 'Upcoming'}</Text>
          </Pressable>)}
        </View>
        </View>
      )}
      ListEmptyComponent={(
        <View style={styles.emptyState}>
          <Ionicons name="calendar-clear-outline" size={34} color="#9ca3af" />
          <Text style={styles.emptyStateTitle}>{period === 'upcoming' ? 'No upcoming entries' : 'No custody entries'}</Text>
          <TouchableOpacity style={styles.btnPrimary} onPress={onAdd}>
            <Text style={styles.btnText}>Add entry</Text>
          </TouchableOpacity>
        </View>
      )}
      ListFooterComponent={visibleEntries.length ? (
        <View style={styles.listFooter}>
          <Text style={styles.listFooterText}>Listed entry-days</Text>
          <Text style={styles.listFooterValue}>{totalDays}</Text>
        </View>
      ) : null}
    />
  );
}

function EntryEditor({ entry, parents, children, parentLocations, onClose, onDelete, onUpdate, onOpenParent, onOpenDate, onOpenTime }) {
  if (!entry) return null;
  const days = daysInclusive(entry.beginDate, entry.endDate);

  const confirmDelete = () => {
    Alert.alert('Delete entry', 'Delete this custody entry? This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => onDelete(entry.id) },
    ]);
  };

  return (
      <SafeAreaView style={styles.editorSafeArea} edges={['top', 'bottom', 'left', 'right']}>
        <View style={styles.editorHeader}>
          <View style={styles.editorHeaderSide} />
          <Text style={styles.editorHeaderTitle}>Custody entry</Text>
          <TouchableOpacity style={styles.editorHeaderSide} onPress={onClose} accessibilityRole="button">
            <Text style={styles.editorDone}>Done</Text>
          </TouchableOpacity>
        </View>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={styles.editorContent} keyboardShouldPersistTaps="handled">
            {entry.scheduleId ? (
              <View style={styles.managedNotice}>
                <Ionicons name="repeat" size={17} color="#1d4ed8" />
                <Text style={styles.managedNoticeText}>Part of a generated schedule. Rebuilding that schedule may replace edits.</Text>
              </View>
            ) : null}

            <View style={styles.editorSection}>
              <View style={styles.switchRow}>
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={styles.editorFieldTitle}>Holiday or exception</Text>
                  <Text style={styles.editorFieldHelp}>Overrides a recurring schedule on these dates.</Text>
                </View>
                <Switch
                  value={Boolean(entry.isException)}
                  onValueChange={(value) => onUpdate(entry.id, 'isException', value)}
                  accessibilityLabel="Holiday or exception"
                  trackColor={{ false: '#d1d5db', true: theme.accent }}
                />
              </View>
            </View>

            <View style={styles.editorSection}>
              <Text style={styles.fieldLabel}>Parent</Text>
              <TouchableOpacity style={styles.selectBtn} onPress={() => onOpenParent(entry.id)} accessibilityRole="button">
                <Text style={entry.parent ? styles.selectBtnText : styles.selectBtnPlaceholder}>{entry.parent || 'Select parent'}</Text>
                <Ionicons name="chevron-forward" size={18} color="#9ca3af" />
              </TouchableOpacity>

              <Text style={styles.fieldLabel}>Date range</Text>
              <View style={styles.dateRow}>
                <TouchableOpacity style={[styles.dateBtn, { flex: 1 }]} onPress={() => onOpenDate(entry.id, 'beginDate', entry.beginDate)} accessibilityRole="button">
                  <Text style={entry.beginDate ? styles.dateBtnText : styles.dateBtnPlaceholder}>{entry.beginDate ? displayDate(entry.beginDate) : 'Start date'}</Text>
                </TouchableOpacity>
                <Ionicons name="arrow-forward" size={16} color="#6b7280" style={{ alignSelf: 'center' }} />
                <TouchableOpacity style={[styles.dateBtn, { flex: 1 }]} onPress={() => onOpenDate(entry.id, 'endDate', entry.endDate)} accessibilityRole="button">
                  <Text style={entry.endDate ? styles.dateBtnText : styles.dateBtnPlaceholder}>{entry.endDate ? displayDate(entry.endDate) : 'End date'}</Text>
                </TouchableOpacity>
              </View>
              {days !== null ? <Text style={styles.editorDuration}>{days} custody {days === 1 ? 'day' : 'days'}</Text> : null}
            </View>

            {children.length ? (
              <View style={styles.editorSection}>
                <Text style={styles.fieldLabel}>Children</Text>
                {children.map((child) => (
                  <View key={child} style={styles.editorToggleRow}>
                    <Text style={styles.switchLabel}>{child}</Text>
                    <Switch
                      value={Boolean(entry.childrenPresent?.[child])}
                      onValueChange={(value) => onUpdate(entry.id, 'childrenPresent', { ...entry.childrenPresent, [child]: value })}
                      accessibilityLabel={'Include ' + child}
                      trackColor={{ false: '#d1d5db', true: theme.accent }}
                    />
                  </View>
                ))}
              </View>
            ) : null}

            <View style={styles.editorSection}>
              <Text style={styles.fieldLabel}>Where</Text>
              <TextInput
                style={styles.input}
                value={entry.location || ''}
                onChangeText={(value) => onUpdate(entry.id, 'location', value)}
                placeholder={entry.parent && parentLocations[entry.parent] ? parentLocations[entry.parent] : "Location (defaults to parent's home)"}
                autoCapitalize="words"
              />

              <Text style={[styles.fieldLabel, { marginTop: 16 }]}>Exchange</Text>
              <View style={styles.toolRow}>
              <TouchableOpacity style={[styles.selectBtn, { flex: 1 }]} onPress={() => onOpenTime(entry.id, entry.exchangeTime)} accessibilityRole="button" accessibilityLabel={'Exchange time, ' + (entry.exchangeTime || 'not set')}>
                <View style={styles.pickerRowLabel}>
                  <Ionicons name="time-outline" size={19} color="#6b7280" />
                  <Text style={entry.exchangeTime ? styles.selectBtnText : styles.selectBtnPlaceholder}>{entry.exchangeTime || 'Exchange time'}</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color="#9ca3af" />
              </TouchableOpacity>
              {entry.exchangeTime ? (
                <IconButton icon="close-circle-outline" label="Clear exchange time"
                  onPress={() => onUpdate(entry.id, 'exchangeTime', '')}
                />
              ) : null}
              </View>
              <TextInput
                style={styles.input}
                value={entry.exchangePlace || ''}
                onChangeText={(value) => onUpdate(entry.id, 'exchangePlace', value)}
                placeholder="Exchange place (for example, school)"
                autoCapitalize="words"
              />

              <Text style={[styles.fieldLabel, { marginTop: 16 }]}>Parent note</Text>
              <TextInput
                style={[styles.input, styles.notesInput]}
                value={entry.note || ''}
                onChangeText={(value) => onUpdate(entry.id, 'note', value)}
                placeholder="Optional parent note"
                multiline
                textAlignVertical="top"
              />
            </View>

            <TouchableOpacity style={styles.deleteEntryButton} onPress={confirmDelete} accessibilityRole="button">
              <Ionicons name="trash-outline" size={19} color="#dc2626" />
              <Text style={styles.deleteEntryText}>Delete entry</Text>
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const currentDay = useToday();
  const [parents, setParents] = useState([]);
  const [children, setChildren] = useState([]);
  const [parentColors, setParentColors] = useState({});
  const [childColors, setChildColors] = useState({});
  const [parentLocations, setParentLocations] = useState({}); // parent -> home address
  const [parentPhones, setParentPhones] = useState({});       // parent -> contact number
  const [colorPicker, setColorPicker] = useState(null); // { type: 'parent'|'child', name }
  const [entries, setEntries] = useState([
    { id: generateId(), parent: '', beginDate: '', endDate: '', childrenPresent: {}, note: '' },
  ]);
  const [scheduleAssignments, setScheduleAssignments] = useState([]);
  const [newParentName, setNewParentName] = useState('');
  const [newChildName, setNewChildName] = useState('');
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
  const [viewMode, setViewMode] = useState('calendar');
  const [showWizard, setShowWizard] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState(null);
  const [datePicker, setDatePicker] = useState(null); // { context, field, mode, draft }
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
        if (data.parentLocations) setParentLocations(data.parentLocations);
        if (data.parentPhones) setParentPhones(data.parentPhones);
        if (data.childColors) setChildColors(data.childColors);
        if (data.entries) setEntries(data.entries);
        if (data.scheduleAssignments) setScheduleAssignments(data.scheduleAssignments);
        if (data.reportingMode) setReportingMode(data.reportingMode);
        if (data.customStart) setCustomStart(data.customStart);
        if (data.customEnd) setCustomEnd(data.customEnd);
        if (data.quarterYear) setQuarterYear(data.quarterYear);
        if (data.quarter) setQuarter(data.quarter);
        if (data.preset) setPreset(data.preset);
        if (data.analysisChild) setAnalysisChild(data.analysisChild);
        if (data.viewMode) setViewMode(data.viewMode === 'list' ? 'entries' : data.viewMode);
      }
      // Auto-open the setup wizard on a fresh install (no parents saved yet).
      if (!data || !data.parents || data.parents.length === 0) setShowWizard(true);
      setLoaded(true);
    });
  }, []);

  const completeWizard = ({ parents: wp, parentColors: wpc, children: wc, childColors: wcc, entries: we, scheduleAssignments: wa }) => {
    setParents(wp);
    setParentColors(wpc);
    setChildren(wc);
    setChildColors(wcc);
    setEntries(we);
    setScheduleAssignments(wa);
    setShowWizard(false);
    setViewMode('calendar');
  };

  useEffect(() => {
    if (!loaded) return;
    saveData({ parents, children, parentColors, childColors, parentLocations, parentPhones, entries, scheduleAssignments, reportingMode, customStart, customEnd, quarterYear, quarter, preset, analysisChild, viewMode });
  }, [loaded, parents, children, parentColors, childColors, parentLocations, parentPhones, entries, scheduleAssignments, reportingMode, customStart, customEnd, quarterYear, quarter, preset, analysisChild, viewMode]);

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
          const nl = { ...parentLocations }; delete nl[parent]; setParentLocations(nl);
          const np = { ...parentPhones }; delete np[parent]; setParentPhones(np);
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
    const entry = { id: generateId(), parent: '', beginDate: '', endDate: '', childrenPresent: cp, note: '' };
    setEntries([...entries, entry]);
    setEditingEntryId(entry.id);
    setViewMode('entries');
  };

  const createEntryFromCalendar = (start, end, parent, childFilter, isException, name) => {
    const cp = {};
    children.forEach((c) => { cp[c] = childFilter ? c === childFilter : true; });
    setEntries([...entries, {
      id: generateId(),
      parent,
      beginDate: start,
      endDate: end,
      childrenPresent: cp,
      note: name || '',
      isException: Boolean(isException),
    }]);
  };

  const removeRow = (id) => {
    setEntries(entries.filter((e) => e.id !== id));
    if (editingEntryId === id) setEditingEntryId(null);
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
          setScheduleAssignments([]);
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
            setParentLocations({});
            setParentPhones({});
            setEntries([{ id: generateId(), parent: '', beginDate: '', endDate: '', childrenPresent: {}, note: '' }]);
            setScheduleAssignments([]);
            setReportingMode('custom');
            setCustomStart('');
            setCustomEnd('');
            setAnalysisChild('all');
            setViewMode('calendar');
            setShowWizard(true);
          },
        },
      ]
    );
  };

  const runScheduleGenerator = () => {
    let newEntries = [];
    if (!scheduleStart || !scheduleEnd || scheduleStart > scheduleEnd) {
      Alert.alert('Invalid date range', 'Set an end date on or after the start date.');
      return;
    }
    if (parents.length < 2) {
      Alert.alert('Two parents required', 'Add two parents before generating a shared schedule.');
      return;
    }
    if (schedulePattern === 'eow' || schedulePattern === 'eow-midweek') {
      if (!scheduleSecondaryParent || scheduleSecondaryParent === parents[0]) {
        Alert.alert('Choose the other parent', 'The weekend parent must be different from the primary parent.');
        return;
      }
      newEntries = schedulePattern === 'eow'
        ? generateEOWSchedule(scheduleSecondaryParent, scheduleStart, scheduleEnd, children, scheduleEOWDay)
        : generateEOWMidweek(scheduleSecondaryParent, scheduleStart, scheduleEnd, children, scheduleEOWDay, scheduleMidweekDow);
    } else {
      if (!scheduleJointParent1 || !scheduleJointParent2 || scheduleJointParent1 === scheduleJointParent2) {
        Alert.alert('Choose two parents', 'The schedule requires two different parents.');
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
    const assignment = {
      id: generateId(),
      preset: schedulePattern,
      start: scheduleStart,
      end: scheduleEnd,
      children: [...children],
      eowDay: scheduleEOWDay,
      midweek: scheduleMidweekDow,
      ...(schedulePattern === 'eow' || schedulePattern === 'eow-midweek'
        ? { secondary: scheduleSecondaryParent }
        : { p1: scheduleJointParent1, p2: scheduleJointParent2 }),
    };
    const taggedEntries = newEntries.map((entry) => ({ ...entry, scheduleId: assignment.id }));
    Alert.alert(
      'Generated ' + newEntries.length + ' entries',
      'Replace existing entries or add to them?',
      [
        { text: 'Cancel' },
        { text: 'Add to Existing', onPress: () => { setEntries([...entries, ...taggedEntries]); setScheduleAssignments([...scheduleAssignments, assignment]); setShowScheduleGen(false); } },
        { text: 'Replace All', style: 'destructive', onPress: () => { setEntries(taggedEntries); setScheduleAssignments([assignment]); setShowScheduleGen(false); } },
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

  const summaryResult = useMemo(() => computeCustodySummary({
    entries,
    parents,
    children,
    start: reportingWindow.start,
    end: reportingWindow.end,
    childFilter: analysisChild,
  }), [entries, reportingWindow, analysisChild, children, parents]);
  const windowSummary = summaryResult.rows;

  const footerTotals = useMemo(() => {
    let totalDays = 0;
    entries.forEach((e) => {
      const d = daysInclusive(e.beginDate, e.endDate);
      if (d !== null) totalDays += d;
    });
    return { totalDays };
  }, [entries]);

  // ── export ───────────────────────────────────────────────────────────────────

  const exportCSV = async () => {
    try {
      const esc = (v) => {
        const s = v === null || v === undefined ? '' : String(v);
        return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csvRow = (arr) => arr.map(esc).join(',');

      const headers = ['Parent', 'Begin Date', 'End Date', 'Custody Days', 'Type', 'Where', 'Exchange Time', 'Exchange Place', ...children, 'Note'];
      const rows = entries.map((e) => [
        e.parent, e.beginDate, e.endDate,
        daysInclusive(e.beginDate, e.endDate) ?? '',
        e.isException ? 'Holiday' : 'Schedule',
        resolveLocation(e, parentLocations),
        e.exchangeTime || '',
        e.exchangePlace || '',
        ...children.map((c) => (e.childrenPresent[c] ? 'Yes' : 'No')),
        e.note,
      ]);

      const childLabel = analysisChild === 'all' ? 'All Children' : analysisChild;
      const windowLabel = reportingWindow.start && reportingWindow.end
        ? `${reportingWindow.start} to ${reportingWindow.end} (${childLabel})`
        : '(no window set)';

      const summaryHeaders = ['Parent', 'Custody Days', '% Custody Days'];
      const summaryRows = windowSummary.map((item) => [item.parent, item.custodyDays, `${item.percentage}%`]);

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

  // Share the schedule as a calendar file the kids can add to Apple/Google Calendar.
  const exportICS = async () => {
    try {
      if (parents.length === 0) {
        Alert.alert('Nothing to export', 'Add parents and a schedule first.');
        return;
      }
      // Use the reporting window when it is set, otherwise the next 12 months.
      let start = reportingWindow.start;
      let end = reportingWindow.end;
      if (!start || !end) {
        start = localTodayStr();
        const in12 = toDate(start);
        in12.setFullYear(in12.getFullYear() + 1);
        end = formatDateStr(in12);
      }

      const singleChild = analysisChild !== 'all';
      const blocks = buildCustodyBlocks({
        entries, parents, children, start, end,
        childFilter: analysisChild,
      });
      if (blocks.length === 0) {
        Alert.alert('Nothing to export', 'No custody days fall in this date range.');
        return;
      }

      const who = singleChild ? analysisChild : (children.length ? children.join(' & ') : 'Custody');
      const ics = buildICS({
        blocks,
        parentLocations,
        calendarName: `${who} — Custody Schedule`,
        singleChild,
      });

      const safe = who.replace(/[^A-Za-z0-9]+/g, '_');
      const path = FileSystem.documentDirectory + `Custody_${safe}_${start}_to_${end}.ics`;
      await FileSystem.writeAsStringAsync(path, ics, { encoding: FileSystem.EncodingType.UTF8 });
      await Sharing.shareAsync(path, {
        mimeType: 'text/calendar',
        UTI: 'com.apple.ical.ics',
        dialogTitle: 'Share custody calendar',
      });
    } catch (e) {
      Alert.alert('Export Failed', e.message);
    }
  };

  // Send the kids a standalone page they can open on their own phone.
  const exportKidPage = async () => {
    try {
      if (parents.length === 0) {
        Alert.alert('Nothing to share', 'Add parents and a schedule first.');
        return;
      }
      const from = localTodayStr();
      const to = reportingWindow.end && reportingWindow.end > from
        ? reportingWindow.end
        : (() => { const d = toDate(from); d.setFullYear(d.getFullYear() + 1); return formatDateStr(d); })();

      const html = buildKidPage({
        entries, parents, children, parentColors, parentLocations, parentPhones,
        validFrom: from, validTo: to, generatedOn: from,
      });

      const safe = (children.length ? children.join('_') : 'Schedule').replace(/[^A-Za-z0-9]+/g, '_');
      const path = FileSystem.documentDirectory + `${safe}_Schedule.html`;
      await FileSystem.writeAsStringAsync(path, html, { encoding: FileSystem.EncodingType.UTF8 });
      await Sharing.shareAsync(path, {
        mimeType: 'text/html',
        UTI: 'public.html',
        dialogTitle: 'Send schedule to the kids',
      });
    } catch (e) {
      Alert.alert('Share Failed', e.message);
    }
  };

  // ── date picker ──────────────────────────────────────────────────────────────

  const openDatePicker = (context, field, currentStr) => {
    const draft = currentStr ? toDate(currentStr) : new Date();
    setDatePicker({ context, field, mode: 'date', draft: draft || new Date() });
  };

  const openTimePicker = (entryId, currentValue) => {
    setDatePicker({ context: entryId, field: 'exchangeTime', mode: 'time', draft: timePickerValue(currentValue) });
  };

  const confirmPicker = (selectedDate) => {
    const { context, field } = datePicker;
    const value = datePicker.mode === 'time' ? formatTime(selectedDate) : formatDateStr(selectedDate);
    if (context === 'reporting') {
      if (field === 'customStart') setCustomStart(value);
      else setCustomEnd(value);
    } else if (context === 'sched') {
      if (field === 'scheduleStart') setScheduleStart(value);
      else setScheduleEnd(value);
    } else {
      updateEntry(context, field, value);
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

  const editingEntry = entries.find((entry) => entry.id === editingEntryId) || null;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right', 'bottom']}>
      <StatusBar barStyle="dark-content" backgroundColor="#f9fafb" />
      {showWizard && (
        <SetupWizard
          initialData={{ parents, children, parentColors, childColors, entries, scheduleAssignments }}
          onComplete={completeWizard}
          onCancel={() => setShowWizard(false)}
        />
      )}
      <View
        style={{ flex: 1 }}
        accessibilityElementsHidden={Boolean(editingEntry || showWizard || showScheduleGen)}
        importantForAccessibility={(editingEntry || showWizard || showScheduleGen) ? 'no-hide-descendants' : 'auto'}
      >
      <View style={styles.appHeader}>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.brandMark}><Ionicons name="calendar-outline" size={23} color={theme.accent} /></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Custody Calendar</Text>
          <Text style={styles.headerSub}>On this device</Text>
        </View>
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {viewMode === 'entries' ? (
          <EntriesScreen
            entries={entries}
            parents={parents}
            parentColors={parentColors}
            children={children}
            parentLocations={parentLocations}
            today={currentDay}
            onAdd={addRow}
            onSelect={setEditingEntryId}
          />
        ) : (
        <ScrollView key={viewMode} style={styles.scroll} contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">

          {viewMode === 'kid' ? (
            <KidView
              today={currentDay}
              entries={entries}
              parents={parents}
              parentColors={parentColors}
              parentLocations={parentLocations}
              parentPhones={parentPhones}
              children={children}
              childColors={childColors}
            />
          ) : viewMode === 'calendar' ? (
            <CalendarView today={currentDay} entries={entries} parents={parents} parentColors={parentColors} parentLocations={parentLocations} children={children} childColors={childColors} onCreateEntry={createEntryFromCalendar} onOpenEntry={setEditingEntryId} />
          ) : viewMode === 'settings' ? (
          <>
          <View style={styles.screenIntro}>
            <Text style={styles.screenTitle}>Settings</Text>
          </View>

          <View style={styles.card}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Household</Text>
              <TouchableOpacity style={{ minHeight: 44, justifyContent: 'center' }} onPress={() => setShowWizard(true)} accessibilityRole="button">
                <Text style={styles.toggleBtn}>Guided edit</Text>
              </TouchableOpacity>
            </View>
              <View>
                {/* Parents */}
                <Text style={styles.fieldLabel}>Parents</Text>
                <View style={styles.tagRow}>
                  {parents.map((p, i) => (
                    <View key={p} style={styles.tag}>
                      <TouchableOpacity style={styles.colorButton} onPress={() => setColorPicker({ type: 'parent', name: p })} accessibilityRole="button" accessibilityLabel={`Change color for ${p}`}>
                        <PersonBadge name={p} color={colorForName(p, parents, parentColors)} />
                      </TouchableOpacity>
                      <Text style={styles.tagText}>{p}{i === 0 ? ' (Primary)' : ''}</Text>
                      {i !== 0 && (
                        <IconButton icon="star-outline" label={`Make ${p} the primary parent`} onPress={() => setPrimary(p)} />
                      )}
                      <IconButton icon="remove-circle-outline" label={`Remove ${p}`} onPress={() => removeParent(p)} disabled={parents.length === 1} />
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
                  <IconButton icon="add" label="Add parent" active onPress={addParent} />
                </View>

                {/* Where each parent lives — used as the default location for their days */}
                {parents.length > 0 && (
                  <View style={{ marginTop: 14 }}>
                    <Text style={styles.fieldLabel}>Home & contact</Text>
                    <Text style={styles.calHint}>Included in My Days and shared child schedules.</Text>
                    {parents.map((p) => (
                      <View key={p} style={styles.detailBlock}>
                        <View style={styles.detailHeader}>
                          <View style={[styles.tagSwatch, { backgroundColor: colorForName(p, parents, parentColors) }]} />
                          <Text style={styles.detailName}>{p}</Text>
                        </View>
                        <TextInput
                          style={[styles.input, { marginBottom: 6 }]}
                          value={parentLocations[p] || ''}
                          onChangeText={(v) => setParentLocations({ ...parentLocations, [p]: v })}
                          placeholder="Home address"
                          autoCapitalize="words"
                        />
                        <TextInput
                          style={styles.input}
                          value={parentPhones[p] || ''}
                          onChangeText={(v) => setParentPhones({ ...parentPhones, [p]: v })}
                          placeholder="Phone (optional)"
                          keyboardType="phone-pad"
                        />
                      </View>
                    ))}
                  </View>
                )}

                {/* Children */}
                <Text style={[styles.fieldLabel, { marginTop: 16 }]}>Children</Text>
                <View style={styles.tagRow}>
                  {children.map((c) => (
                    <View key={c} style={styles.tag}>
                      <TouchableOpacity style={styles.colorButton} onPress={() => setColorPicker({ type: 'child', name: c })} accessibilityRole="button" accessibilityLabel={`Change color for ${c}`}>
                        <PersonBadge name={c} color={colorForName(c, children, childColors)} />
                      </TouchableOpacity>
                      <Text style={styles.tagText}>{c}</Text>
                      <IconButton icon="remove-circle-outline" label={`Remove ${c}`} onPress={() => removeChild(c)} disabled={children.length === 1} />
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
                  <IconButton icon="add" label="Add child" active onPress={addChild} />
                </View>

              </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Schedules</Text>
            <Text style={styles.settingsHelp}>{scheduleAssignments.length ? `${scheduleAssignments.length} saved recurring ${scheduleAssignments.length === 1 ? 'schedule' : 'schedules'}.` : 'Create a recurring schedule or continue entering dates manually.'}</Text>
            <TouchableOpacity style={styles.settingsAction} onPress={() => setShowScheduleGen(true)} accessibilityRole="button">
              <View style={styles.settingsActionIcon}><Ionicons name="repeat" size={20} color="#2563eb" /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.settingsActionTitle}>Generate schedule</Text>
                <Text style={styles.settingsActionSub}>Every other weekend, alternating weeks, or 2-2-3</Text>
              </View>
              <Ionicons name="chevron-forward" size={19} color="#9ca3af" />
            </TouchableOpacity>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Share and backup</Text>
            {[
              { label: 'Share calendar', sub: 'Export an Apple or Google calendar file', icon: 'calendar-outline', action: exportICS },
              { label: 'Send Kid View', sub: 'Share a self-contained schedule page', icon: 'happy-outline', action: exportKidPage },
              { label: 'Export CSV', sub: 'Back up entries and report totals', icon: 'download-outline', action: exportCSV },
            ].map((item) => (
              <TouchableOpacity key={item.label} style={styles.settingsAction} onPress={item.action} accessibilityRole="button">
                <View style={styles.settingsActionIcon}><Ionicons name={item.icon} size={20} color="#2563eb" /></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.settingsActionTitle}>{item.label}</Text>
                  <Text style={styles.settingsActionSub}>{item.sub}</Text>
                </View>
                <Ionicons name="chevron-forward" size={19} color="#9ca3af" />
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Data</Text>
            <Text style={styles.settingsHelp}>Your custody data is saved locally on this device.</Text>
            <TouchableOpacity style={styles.destructiveRow} onPress={clearAll} accessibilityRole="button">
              <Ionicons name="trash-outline" size={19} color="#dc2626" />
              <Text style={styles.destructiveRowText}>Clear custody entries</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.destructiveRow} onPress={resetAll} accessibilityRole="button">
              <Ionicons name="refresh-outline" size={19} color="#dc2626" />
              <Text style={styles.destructiveRowText}>Reset all app data</Text>
            </TouchableOpacity>
          </View>
          </>
          ) : viewMode === 'reports' ? (
          <>
          <View style={styles.screenIntro}>
            <Text style={styles.screenTitle}>Reports</Text>
            <Text style={styles.screenSub}>Recorded schedule and primary-parent defaults</Text>
          </View>

          <View style={styles.card}>
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
                <Text style={[styles.fieldLabel, { marginTop: 12 }]}>Children</Text>
                <ChildSelector children={children} includeAll value={analysisChild === 'all' ? null : analysisChild}
                  onChange={(child) => setAnalysisChild(child || 'all')} colors={(child) => colorForName(child, children, childColors)} />

                <Text style={styles.windowInfo}>
                  {reportingWindow.start && reportingWindow.end ? displayDate(reportingWindow.start) + ' - ' + displayDate(reportingWindow.end) : 'No reporting period selected'}
                </Text>
                {reportingWindow.start && reportingWindow.end && <Text style={styles.windowInfo}>{analysisChild === 'all' ? 'Counted child-days' : 'Counted custody days'}: {summaryResult.totalUnits}</Text>}
                {summaryResult.conflictDays > 0 && (
                  <Text style={styles.calConflictNote}>{summaryResult.conflictDays} conflicting child-day(s) excluded from this report.</Text>
                )}

                {windowSummary.length > 0 && (
                  <View style={{ marginTop: 12 }}>
                    <Text style={styles.fieldLabel}>Summary by Parent</Text>
                    {windowSummary.map((item) => (
                      <View key={item.parent} style={styles.reportRow} accessible
                        accessibilityLabel={`${item.parent}, ${item.custodyDays} ${analysisChild === 'all' ? 'child-days' : 'days'}, ${item.percentage} percent`}>
                        <View style={styles.personLine}>
                          <PersonBadge name={item.parent} color={colorForName(item.parent, parents, parentColors)} small />
                          <Text style={styles.parentChoiceText}>{item.parent}</Text>
                          <Text style={styles.reportValue}>{item.percentage}%</Text>
                        </View>
                        <Text style={styles.reportDays}>{item.custodyDays} {analysisChild === 'all' ? 'child-days' : 'days'}</Text>
                        <View style={styles.reportTrack}><View style={{ height: '100%', width: `${Math.min(100, Math.max(0, Number(item.percentage) || 0))}%`, backgroundColor: colorForName(item.parent, parents, parentColors) }} /></View>
                      </View>
                    ))}
                  </View>
                )}
              </View>
          </View>

          </>
          ) : null}

        </ScrollView>
        )}
      </KeyboardAvoidingView>
      <BottomTabBar value={viewMode} onChange={setViewMode} />
      </View>

      <EntryEditor
        entry={editingEntry}
        parents={parents}
        children={children}
        parentLocations={parentLocations}
        onClose={() => setEditingEntryId(null)}
        onDelete={removeRow}
        onUpdate={updateEntry}
        onOpenParent={setParentPickerEntryId}
        onOpenDate={openDatePicker}
        onOpenTime={openTimePicker}
      />

      <NativePickerSheet
        picker={datePicker}
        title={datePicker?.mode === 'time' ? 'Exchange time' : datePicker?.field?.toLowerCase().includes('start') || datePicker?.field === 'beginDate' ? 'Start date' : 'End date'}
        onChange={(draft) => setDatePicker((current) => ({ ...current, draft }))}
        onCancel={() => setDatePicker(null)}
        onConfirm={confirmPicker}
      />

      {/* Parent Picker Modal */}
      <Modal
        visible={parentPickerEntryId !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setParentPickerEntryId(null)}
      >
        <View style={styles.pickerOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setParentPickerEntryId(null)} accessibilityLabel="Cancel parent selection" />
          <SafeAreaView edges={['bottom']} style={styles.pickerSheet}>
          <View style={{ padding: 20 }}>
            <SectionHeading title="Parent">
              <IconButton icon="close" label="Close parent selection" onPress={() => setParentPickerEntryId(null)} />
            </SectionHeading>
            {parents.length === 0 && (
              <Text style={styles.modalEmpty}>No parents added. Household details are in Settings.</Text>
            )}
            <ScrollView style={{ maxHeight: 300 }}>
            {parents.map((p) => (
              <TouchableOpacity
                key={p}
                accessibilityRole="radio"
                accessibilityState={{ checked: entries.find((e) => e.id === parentPickerEntryId)?.parent === p }}
                accessibilityLabel={p}
                style={[styles.parentChoice, { marginBottom: 8 }]}
                onPress={() => {
                  updateEntry(parentPickerEntryId, 'parent', p);
                  setParentPickerEntryId(null);
                }}
              >
                <PersonBadge name={p} color={colorForName(p, parents, parentColors)} />
                <Text style={styles.parentChoiceText}>{p}</Text>
                <Ionicons name={entries.find((e) => e.id === parentPickerEntryId)?.parent === p ? 'radio-button-on' : 'radio-button-off'} size={22} color={theme.accent} />
              </TouchableOpacity>
            ))}
            </ScrollView>
          </View>
          </SafeAreaView>
        </View>
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
                    accessibilityRole="button"
                    accessibilityLabel={`Color ${c}`}
                    accessibilityState={{ selected: current === c }}
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

      {showScheduleGen && (
        <View style={styles.wizardOverlay}>
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
      </View>
      )}

    </SafeAreaView>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  reportRow: { paddingVertical: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line },
  reportValue: { fontSize: 20, fontWeight: '700', color: theme.ink },
  reportDays: { fontSize: 13, color: theme.muted, marginVertical: 10 },
  reportTrack: { height: 6, backgroundColor: '#e7eae8', borderRadius: 3, overflow: 'hidden' },
  calendarSurface: { paddingBottom: 20 },
  sectionBand: { paddingVertical: 24, borderTopWidth: 1, borderTopColor: theme.line },
  calYear: { fontWeight: '400', color: theme.muted },
  toolRow: { flexDirection: 'row', gap: 6 },
  calendarWeek: { flexDirection: 'row' },
  todayDot: { width: 4, height: 4, borderRadius: 2, position: 'absolute', bottom: 4 },
  splitNumber: { backgroundColor: '#fff', color: theme.ink, paddingHorizontal: 4, borderRadius: 3, overflow: 'hidden' },
  selectedTick: { position: 'absolute', right: -1, bottom: -1, width: 14, height: 14, backgroundColor: theme.ink, borderTopLeftRadius: 4, alignItems: 'center', justifyContent: 'center' },
  dayMarker: { position: 'absolute', top: 1, right: 1 },
  calendarLegend: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 16 },
  legendItem: { flexDirection: 'row', alignItems: 'center' },
  legendCaption: { fontSize: 12, color: theme.muted },
  rangeStatus: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 10, marginBottom: 12, backgroundColor: theme.soft, borderRadius: 8 },
  rangeStatusText: { flex: 1, fontSize: 14, color: theme.accent, fontWeight: '600' },
  parentChoices: { gap: 8, marginVertical: 16 },
  parentChoice: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, minHeight: 54, borderRadius: 8, borderWidth: 1, borderColor: theme.line },
  parentChoiceSelected: { backgroundColor: theme.soft, borderColor: theme.accent },
  parentChoiceText: { flex: 1, fontSize: 15, color: theme.ink },
  saveRangeButton: { minHeight: 48, borderRadius: 8, backgroundColor: theme.accent, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', marginTop: 16 },
  dayDetail: { paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line },
  personLine: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  detailChild: { fontSize: 13, color: theme.muted },
  detailParent: { fontSize: 17, fontWeight: '700', color: theme.ink, marginTop: 3 },
  sourceLabel: { fontSize: 12, fontWeight: '600', color: theme.accent, marginTop: 12 },
  conflictEntry: { flexDirection: 'row', minHeight: 44, alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line },
  kidTodayBand: { paddingVertical: 20, paddingHorizontal: 18, borderLeftWidth: 4, backgroundColor: theme.canvas, marginBottom: 8 },
  kidHome: { width: 60, height: 60, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  timelineRail: { width: 24, alignItems: 'center', alignSelf: 'stretch', justifyContent: 'center', marginRight: 10, borderLeftWidth: 1, borderLeftColor: theme.line },
  timelineDot: { width: 10, height: 10, borderRadius: 5 },
  safeArea: { flex: 1, backgroundColor: theme.paper },
  scroll: { flex: 1 },
  container: { padding: 20, paddingBottom: 32, width: '100%', maxWidth: 760, alignSelf: 'center' },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { fontSize: 16, color: '#6b7280' },

  appHeader: {
    minHeight: 68,
    paddingHorizontal: 20,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.paper,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
  },
  headerTitle: { fontSize: 20, fontWeight: '700', color: theme.ink },
  brandMark: { width: 42, height: 42, borderRadius: 8, backgroundColor: theme.soft, alignItems: 'center', justifyContent: 'center' },
  headerSub: { fontSize: 13, color: '#6b7280', marginTop: 1 },
  bottomBar: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: '#fff',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#d1d5db',
    paddingTop: 6,
  },
  bottomTab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2, minWidth: 0 },
  bottomTabLabel: { fontSize: 11, color: theme.muted, fontWeight: '500', textAlign: 'center' },
  bottomTabLabelActive: { color: theme.accent, fontWeight: '700' },
  tabIconFrame: { width: 48, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  tabIconFrameActive: { backgroundColor: theme.soft },
  screenIntro: { marginBottom: 14 },
  screenIntroRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 18 },
  screenTitle: { fontSize: 20, fontWeight: '700', color: '#111827' },
  screenSub: { fontSize: 13, color: '#6b7280', marginTop: 3, lineHeight: 18 },
  iconPrimaryButton: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: theme.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },

  card: {
    paddingVertical: 20,
    borderBottomWidth: 1,
    borderBottomColor: theme.line,
    marginBottom: 12,
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
    letterSpacing: 0,
    marginBottom: 6,
  },

  tagRow: { gap: 8, marginBottom: 12 },
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 60,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.line,
  },
  tagText: { flex: 1, fontSize: 15, color: theme.ink },
  colorButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  tagSwatch: { width: 14, height: 14, borderRadius: 4, marginRight: 6, borderWidth: 1, borderColor: 'rgba(0,0,0,0.15)' },
  detailBlock: { backgroundColor: '#f9fafb', borderRadius: 8, padding: 10, marginTop: 8 },
  detailHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  detailName: { fontSize: 14, fontWeight: '600', color: '#111827' },
  tagStar: { fontSize: 15, color: '#6b7280', marginRight: 4 },
  tagX: { fontSize: 18, color: '#dc2626', lineHeight: 20 },
  swatchGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, padding: 16 },
  swatchChoice: { width: 44, height: 44, borderRadius: 8, borderWidth: 2, borderColor: '#e5e7eb' },
  swatchChoiceSelected: { borderColor: '#111827', borderWidth: 3 },
  wizTitle: { fontSize: 20, fontWeight: '700', color: '#111827', marginBottom: 6 },
  wizSub: { fontSize: 13, color: '#6b7280', marginBottom: 14, lineHeight: 18 },
  wizRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f3f4f6', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8 },
  wizRowText: { flex: 1, fontSize: 15, color: '#111827' },
  wizReview: { fontSize: 14, color: '#374151', marginBottom: 6, lineHeight: 20 },
  assignRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#eff6ff', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 6 },
  assignRowInvalid: { backgroundColor: '#fef2f2', borderWidth: 1, borderColor: '#fecaca' },
  assignText: { flex: 1, fontSize: 13, color: '#1d4ed8' },
  tagXDisabled: { color: '#d1d5db' },

  inputRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: {
    minHeight: 48,
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
  btnPrimary: { backgroundColor: theme.accent, minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8 },
  btnSuccess: { backgroundColor: theme.accent, minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8 },
  btnDanger: { backgroundColor: '#b42318', minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8 },
  btnDisabled: { opacity: 0.45 },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  inlineError: { color: '#b91c1c', fontSize: 12, marginTop: 8, lineHeight: 17 },

  screenList: { flex: 1 },
  listContent: { padding: 20, paddingBottom: 28, flexGrow: 1, width: '100%', maxWidth: 760, alignSelf: 'center' },
  entrySummary: {
    minHeight: 94,
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderRadius: 8,
    marginBottom: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  entrySummaryHoliday: { backgroundColor: '#fffbeb', borderColor: '#fde68a' },
  entrySummaryStripe: { width: 5 },
  entrySummaryBody: { flex: 1, paddingHorizontal: 13, paddingVertical: 12 },
  entrySummaryTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  entrySummaryTitle: { fontSize: 15, fontWeight: '700', color: '#111827' },
  entrySummaryParent: { fontSize: 13, color: '#4b5563', marginTop: 2 },
  entrySummaryWarning: { color: '#b45309', fontWeight: '600' },
  entrySummaryMeta: { fontSize: 12, color: '#6b7280', marginTop: 8 },
  entrySummaryDetail: { fontSize: 12, color: '#6b7280', marginTop: 4 },
  holidayBadge: { backgroundColor: '#fef3c7', borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3 },
  holidayBadgeText: { color: '#92400e', fontSize: 10, fontWeight: '700' },
  emptyState: { flex: 1, minHeight: 320, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, gap: 10 },
  emptyStateTitle: { fontSize: 17, fontWeight: '700', color: '#111827' },
  emptyStateText: { fontSize: 13, lineHeight: 19, color: '#6b7280', textAlign: 'center', marginBottom: 4 },
  listFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderRadius: 8,
    backgroundColor: '#f3f4f6',
    marginTop: 4,
  },
  listFooterText: { fontSize: 13, color: '#4b5563', fontWeight: '600' },
  listFooterValue: { fontSize: 16, color: '#111827', fontWeight: '700' },

  editorSafeArea: { ...StyleSheet.absoluteFillObject, zIndex: 20, backgroundColor: '#f9fafb' },
  editorHeader: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#d1d5db',
    backgroundColor: '#fff',
  },
  editorHeaderSide: { minWidth: 52, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' },
  editorHeaderTitle: { fontSize: 16, fontWeight: '700', color: '#111827' },
  editorDone: { fontSize: 16, color: theme.accent, fontWeight: '700' },
  editorContent: { padding: 20, paddingBottom: 36, width: '100%', maxWidth: 760, alignSelf: 'center' },
  editorSection: { paddingVertical: 16, marginBottom: 12, borderBottomWidth: 1, borderBottomColor: theme.line },
  editorFieldTitle: { fontSize: 15, color: '#111827', fontWeight: '600' },
  editorFieldHelp: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  editorDuration: { fontSize: 12, color: '#1d4ed8', fontWeight: '600', marginTop: 3 },
  editorToggleRow: { minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e5e7eb' },
  managedNotice: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', backgroundColor: '#eff6ff', borderRadius: 8, padding: 12, marginBottom: 12 },
  managedNoticeText: { flex: 1, fontSize: 12, lineHeight: 17, color: '#1e40af' },
  pickerRowLabel: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  notesInput: { minHeight: 88, paddingTop: 10 },
  deleteEntryButton: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 8, borderWidth: 1, borderColor: '#fecaca', backgroundColor: '#fff' },
  deleteEntryText: { fontSize: 14, color: '#dc2626', fontWeight: '600' },

  pickerOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.32)' },
  pickerSheet: { backgroundColor: '#fff', borderTopLeftRadius: 8, borderTopRightRadius: 8, overflow: 'hidden' },
  pickerToolbar: { minHeight: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#d1d5db' },
  pickerTitle: { fontSize: 15, fontWeight: '700', color: '#111827' },
  pickerCancel: { fontSize: 16, color: '#6b7280' },
  pickerDone: { fontSize: 16, color: '#2563eb', fontWeight: '700' },
  pickerControl: { width: '100%', height: 210 },

  settingsHelp: { fontSize: 13, color: '#6b7280', lineHeight: 18, marginTop: 5, marginBottom: 8 },
  settingsAction: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e5e7eb' },
  settingsActionIcon: { width: 34, height: 34, borderRadius: 8, backgroundColor: '#eff6ff', alignItems: 'center', justifyContent: 'center' },
  settingsActionTitle: { fontSize: 14, fontWeight: '600', color: '#111827' },
  settingsActionSub: { fontSize: 11, color: '#6b7280', marginTop: 2 },
  destructiveRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#fee2e2' },
  destructiveRowText: { fontSize: 14, color: '#dc2626', fontWeight: '600' },

  tabRow: { flexDirection: 'row', gap: 6, marginBottom: 12 },
  tab: {
    flex: 1,
    minHeight: 44,
    justifyContent: 'center',
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d1d5db',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  tabActive: { backgroundColor: theme.accent, borderColor: theme.accent },
  tabText: { fontSize: 13, color: '#6b7280', fontWeight: '500' },
  tabTextActive: { color: '#fff' },

  dateRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  dateBtn: {
    minHeight: 48,
    justifyContent: 'center',
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
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#fff',
  },
  chipActive: { backgroundColor: theme.accent, borderColor: theme.accent },
  chipText: { fontSize: 13, color: '#374151' },
  chipTextActive: { color: '#fff', fontWeight: '600' },

  windowInfo: { fontSize: 13, color: '#6b7280', marginTop: 6 },

  // Kid view
  kidTodayCard: {
    borderRadius: 16,
    padding: 22,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    elevation: 3,
  },
  kidTodayLabel: { color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: '700', letterSpacing: 0, marginBottom: 4 },
  kidTodayWho: { color: theme.ink, fontSize: 24, fontWeight: '700', marginTop: 4 },
  kidTodayMeta: { color: 'rgba(255,255,255,0.95)', fontSize: 15, marginTop: 3 },
  kidNextWho: { fontSize: 20, fontWeight: '700', color: '#111827', marginTop: 2 },
  kidNextWhen: { fontSize: 15, color: '#374151', marginTop: 3 },
  kidNextMeta: { fontSize: 15, color: '#4b5563', marginTop: 6 },
  kidEmpty: { fontSize: 15, color: '#6b7280', lineHeight: 21 },
  kidRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9 },
  kidRowBar: { width: 6, height: 34, borderRadius: 3, marginRight: 12 },
  kidRowWho: { fontSize: 16, fontWeight: '600', color: '#111827' },
  kidRowWhen: { fontSize: 13, color: '#6b7280', marginTop: 1 },

  // View toggle (segmented control)
  segment: { flexDirection: 'row', backgroundColor: '#e5e7eb', borderRadius: 10, padding: 3, marginBottom: 12 },
  segmentBtn: { flex: 1, minHeight: 44, paddingVertical: 8, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
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
  calNav: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 },
  calNavBtn: { paddingHorizontal: 16, paddingVertical: 4 },
  calNavArrow: { fontSize: 26, color: '#2563eb', fontWeight: '600' },
  calNavTitle: { fontSize: 18, fontWeight: '700', color: theme.ink },
  calWeekRow: { flexDirection: 'row', marginBottom: 4 },
  calWeekday: { flex: 1, textAlign: 'center', fontSize: 12, fontWeight: '600', color: theme.muted, paddingBottom: 6 },
  calGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  calCell: { flex: 1, minWidth: 0, aspectRatio: 1, padding: 2 },
  calDay: { flex: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  calDayNum: { fontSize: 14, fontWeight: '600' },
  calDayNumOverlay: { zIndex: 2, textShadowColor: 'rgba(0,0,0,0.55)', textShadowRadius: 2, textShadowOffset: { width: 0, height: 1 } },
  calSplitFill: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', borderRadius: 6, overflow: 'hidden' },
  calHolidayMark: { position: 'absolute', top: 0, right: 1, fontSize: 9, zIndex: 3 },
  calDayToday: { fontWeight: '800', textDecorationLine: 'underline' },
  calDaySelected: { borderColor: '#182421', borderWidth: 2 },
  calDayConflict: { borderColor: '#dc2626', borderWidth: 2, borderStyle: 'dashed' },
  calConflictNote: { fontSize: 12, color: '#dc2626', marginTop: 8 },
  calSplitNote: { fontSize: 12, color: '#4f46e5', marginTop: 8 },
  calHint: { fontSize: 12, color: theme.muted, marginTop: 10, lineHeight: 18 },
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
  entryCardHoliday: { borderLeftColor: '#d97706', backgroundColor: '#fffbeb' },
  entryCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  entryCardTitle: { fontSize: 15, fontWeight: '600', color: '#111827', flex: 1 },
  deleteBtn: { fontSize: 20 },
  deleteBtnDisabled: { opacity: 0.3 },

  selectBtn: {
    minHeight: 48,
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
  selectBtnText: { fontSize: 15, color: theme.ink, flexShrink: 1 },
  selectBtnPlaceholder: { fontSize: 15, color: theme.muted, flexShrink: 1 },
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
  switchLabel: { fontSize: 15, color: theme.ink, flex: 1, paddingRight: 12 },

  footer: {
    backgroundColor: '#f3f4f6',
    borderRadius: 10,
    padding: 16,
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: 4,
  },
  footerText: { fontSize: 15, fontWeight: '600', color: '#374151' },

  wizardOverlay: { ...StyleSheet.absoluteFillObject, zIndex: 30, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  modalBox: { backgroundColor: '#fff', borderRadius: 8, width: '100%', maxWidth: 600, overflow: 'hidden', paddingBottom: 8 },
  modalTitle: { fontSize: 17, fontWeight: '700', color: '#111827', padding: 16, borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
  modalEmpty: { fontSize: 14, color: '#9ca3af', padding: 16 },
  modalOption: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  modalOptionText: { fontSize: 16, color: '#111827' },
  modalCancel: { paddingHorizontal: 16, paddingVertical: 14, marginTop: 4 },
  modalCancelText: { fontSize: 16, color: '#dc2626', fontWeight: '600', textAlign: 'center' },
});
