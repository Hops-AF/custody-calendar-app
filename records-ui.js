import React, { useEffect, useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Field, IconButton, PersonBadge, SectionHeading, theme } from './family-ui';
const { parseDate } = require('./custody-engine');
const {
  HOLIDAYS, MAX_DAYS_BEFORE, MAX_DAYS_AFTER, MAX_YEAR_SPAN,
  holidayRange, ruleParentForYear, holidayRuleError, newHolidayRule, holidayRuleOverlaps,
} = require('./holiday-rules');
const {
  TYPE_LABELS, MAX_MINUTES_LATE, deviationError, deviationsOnDate, getActualChildDay,
  childNames, describeDeviation, computeDeviationReport,
} = require('./deviation-log');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const TYPE_ICONS = { late: 'time-outline', missed: 'close-circle-outline', swap: 'swap-horizontal-outline' };
const TYPE_HELP = {
  late: 'The exchange happened, but late.',
  missed: 'Scheduled time did not happen.',
  swap: 'Both parents agreed to change these days.',
};
const LATE_PRESETS = [10, 15, 30, 45, 60, 90, 120];

function fmt(dateStr, options) {
  const date = parseDate(dateStr);
  return date ? date.toLocaleDateString('en-US', options) : '';
}
const dayLabel = (dateStr) => fmt(dateStr, { weekday: 'short', month: 'short', day: 'numeric' });
const fullLabel = (dateStr) => fmt(dateStr, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
function rangeLabel(start, end) {
  return start === end ? fullLabel(start) : `${dayLabel(start)} - ${fullLabel(end)}`;
}
function shiftDate(dateStr, days) {
  const date = parseDate(dateStr);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// ── shared pieces ────────────────────────────────────────────────────────────

function Stepper({ label, value, onChange, min, max, text }) {
  return (
    <View style={s.stepperRow}>
      <Text style={s.stepperLabel}>{label}</Text>
      <IconButton icon="remove" label={`Decrease ${label}`} disabled={value <= min} onPress={() => onChange(value - 1)} />
      <Text style={s.stepperValue} accessibilityLiveRegion="polite">{text || value}</Text>
      <IconButton icon="add" label={`Increase ${label}`} disabled={value >= max} onPress={() => onChange(value + 1)} />
    </View>
  );
}

function Choice({ label, selected, onPress, color, sub }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="radio" accessibilityState={{ checked: selected }} accessibilityLabel={label}
      style={({ pressed }) => [s.choice, selected && s.choiceSelected, pressed && { opacity: 0.7 }]}>
      {color ? <PersonBadge name={label} color={color} small /> : null}
      <View style={{ flex: 1 }}>
        <Text style={s.choiceText}>{label}</Text>
        {sub ? <Text style={s.help}>{sub}</Text> : null}
      </View>
      <Ionicons name={selected ? 'radio-button-on' : 'radio-button-off'} size={21} color={theme.accent} />
    </Pressable>
  );
}

function ChildToggles({ children, value, onChange }) {
  if (children.length < 2) return null;
  return (
    <View style={s.section}>
      <Text style={s.label}>Children</Text>
      {children.map((child) => (
        <View key={child} style={s.toggleRow}>
          <Text style={s.choiceText}>{child}</Text>
          <Switch value={Boolean(value[child])} onValueChange={(on) => onChange({ ...value, [child]: on })}
            accessibilityLabel={'Include ' + child} trackColor={{ false: '#d1d5db', true: theme.accent }} />
        </View>
      ))}
    </View>
  );
}

function Screen({ title, onClose, closeLabel, children }) {
  // Insets come from the app's provider, so the header is placed correctly on
  // the first frame instead of jumping once the modal has measured itself.
  const insets = useSafeAreaInsets();
  return (
    <View style={[s.screen, { paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }]}>
      <View style={s.header}>
        <IconButton icon="close" label={closeLabel} onPress={onClose} />
        <Text style={s.headerTitle}>{title}</Text>
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">{children}</ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function PrimaryButton({ label, icon = 'checkmark', disabled, onPress }) {
  return (
    <Pressable disabled={disabled} onPress={onPress} accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled) }}
      style={({ pressed }) => [s.primary, disabled && { opacity: 0.45 }, pressed && { opacity: 0.7 }]}>
      <Ionicons name={icon} size={19} color="#fff" /><Text style={s.primaryText}>{label}</Text>
    </Pressable>
  );
}

function DeleteButton({ label, onPress }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [s.destructive, pressed && { opacity: 0.7 }]}>
      <Ionicons name="trash-outline" size={19} color="#b42318" /><Text style={s.destructiveText}>{label}</Text>
    </Pressable>
  );
}

// ── holiday rules ────────────────────────────────────────────────────────────

function ruleSummary(rule) {
  return rule.evenParent === rule.oddParent
    ? `Every year: ${rule.evenParent}`
    : `Even years: ${rule.evenParent} · Odd years: ${rule.oddParent}`;
}

function HolidayRuleEditor({ initial, isNew, data, colorFor, onSave, onDelete, onCancel }) {
  const [rule, setRule] = useState(initial);
  const set = (patch) => setRule((current) => ({ ...current, ...patch }));
  const { parents, children } = data;
  const custom = rule.holiday === 'custom';
  const error = holidayRuleError(rule) || (rule.children.length === 0 && children.length ? 'Include at least one child.' : '');
  const overlaps = useMemo(() => (error ? [] : holidayRuleOverlaps(data, rule)), [data, rule, error]);
  const preview = [];
  for (let year = rule.fromYear; year <= rule.toYear && preview.length < 4; year += 1) {
    const range = holidayRange(rule, year);
    if (range) preview.push({ year, range, parent: ruleParentForYear(rule, year) });
  }
  const included = Object.fromEntries(children.map((child) => [child, rule.children.includes(child)]));
  const daysInMonth = custom ? new Date(2024, rule.month, 0).getDate() : 31;

  return (
    <Screen title={isNew ? 'New holiday rule' : 'Edit holiday rule'} onClose={onCancel} closeLabel="Cancel holiday rule">
      <View style={s.section}>
        <Text style={s.label}>Holiday</Text>
        {custom
          ? <Field style={s.input} value={rule.name} onChangeText={(name) => set({ name })} placeholder="Name, such as Sam's birthday" maxLength={100} />
          : <Text style={s.bigText}>{rule.name}</Text>}
        {custom ? <>
          <Stepper label="Month" value={rule.month} min={1} max={12} text={MONTHS[rule.month - 1]}
            onChange={(month) => set({ month, day: Math.min(rule.day, new Date(2024, month, 0).getDate()) })} />
          <Stepper label="Day" value={rule.day} min={1} max={daysInMonth} onChange={(day) => set({ day })} />
        </> : null}
      </View>

      <View style={s.section}>
        <Text style={s.label}>How long</Text>
        <Stepper label="Starts" value={rule.daysBefore} min={0} max={MAX_DAYS_BEFORE} onChange={(daysBefore) => set({ daysBefore })}
          text={rule.daysBefore === 0 ? 'On the day' : plural(rule.daysBefore, 'day') + ' before'} />
        <Stepper label="Ends" value={rule.daysAfter} min={0} max={MAX_DAYS_AFTER} onChange={(daysAfter) => set({ daysAfter })}
          text={rule.daysAfter === 0 ? 'On the day' : plural(rule.daysAfter, 'day') + ' after'} />
        <Text style={s.help}>Set this to match your order. Exchange times can be added to each year from the calendar.</Text>
      </View>

      {parents.length === 0 ? <Text style={s.help}>No parents added. Household details are in Settings.</Text> : <>
        <View style={s.section}>
          <Text style={s.label}>Even years (2026, 2028...)</Text>
          <View accessibilityRole="radiogroup" style={s.choices}>{parents.map((parent) =>
            <Choice key={parent} label={parent} color={colorFor(parent)} selected={rule.evenParent === parent} onPress={() => set({ evenParent: parent })} />)}</View>
        </View>
        <View style={s.section}>
          <Text style={s.label}>Odd years (2027, 2029...)</Text>
          <View accessibilityRole="radiogroup" style={s.choices}>{parents.map((parent) =>
            <Choice key={parent} label={parent} color={colorFor(parent)} selected={rule.oddParent === parent} onPress={() => set({ oddParent: parent })} />)}</View>
          <Text style={s.help}>Choose the same parent twice for a holiday that does not alternate.</Text>
        </View>
      </>}

      <ChildToggles children={children} value={included}
        onChange={(next) => set({ children: children.filter((child) => next[child]) })} />

      <View style={s.section}>
        <Text style={s.label}>Years</Text>
        <Stepper label="First year" value={rule.fromYear} min={1900} max={rule.toYear} onChange={(fromYear) => set({ fromYear })} />
        <Stepper label="Last year" value={rule.toYear} min={rule.fromYear} max={rule.fromYear + MAX_YEAR_SPAN - 1} onChange={(toYear) => set({ toYear })} />
      </View>

      {!error && preview.length ? <View style={s.section}>
        <Text style={s.label}>Preview</Text>
        {preview.map((item) => <View key={item.year} style={s.previewRow}>
          <PersonBadge name={item.parent} color={colorFor(item.parent)} small />
          <View style={{ flex: 1 }}>
            <Text style={s.choiceText}>{item.parent}</Text>
            <Text style={s.help}>{rangeLabel(item.range.start, item.range.end)}</Text>
          </View>
        </View>)}
      </View> : null}

      {overlaps.length ? <View style={s.warning} accessibilityRole="alert">
        <Ionicons name="alert-circle-outline" size={18} color={theme.warning} />
        <Text style={s.warningText}>
          Overlaps {overlaps[0].with} in {[...new Set(overlaps.map((o) => o.year))].join(', ')} with a different parent. Those days will show as needing review.
        </Text>
      </View> : null}
      {error ? <Text style={s.error}>{error}</Text> : null}
      {!isNew ? <Text style={s.help}>Saving rebuilds this holiday for every year, replacing edits made to those days.</Text> : null}

      <PrimaryButton label={isNew ? 'Add holiday rule' : 'Save holiday rule'} disabled={Boolean(error)} onPress={() => onSave(rule)} />
      {!isNew ? <DeleteButton label="Delete rule and its holiday days" onPress={() => Alert.alert('Delete holiday rule?',
        `${rule.name} will be removed from every year. You can undo this from local change history.`, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: () => onDelete(rule.id) },
        ])} /> : null}
    </Screen>
  );
}

export function HolidayRulesScreen({ visible, data, colorFor, year, newId, onSave, onDelete, onClose }) {
  const [draft, setDraft] = useState(null); // { rule, isNew }
  useEffect(() => { if (!visible) setDraft(null); }, [visible]);
  const rules = data.holidayRules || [];
  const used = new Set(rules.map((rule) => rule.holiday));
  const start = (holiday) => setDraft({
    isNew: true,
    rule: newHolidayRule({ id: newId(), holiday, parents: data.parents, children: data.children, year }),
  });

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={draft ? () => setDraft(null) : onClose}>
      {!visible ? null : draft ? (
        <HolidayRuleEditor key={draft.rule.id} initial={draft.rule} isNew={draft.isNew} data={data} colorFor={colorFor}
          onCancel={() => setDraft(null)}
          onSave={(rule) => { if (onSave(rule)) setDraft(null); }}
          onDelete={(id) => { onDelete(id); setDraft(null); }} />
      ) : (
        <Screen title="Holiday rules" onClose={onClose} closeLabel="Close holiday rules">
          <Text style={s.intro}>A rule adds the holiday every year and overrides the regular schedule on those days.</Text>

          {rules.length ? <View style={s.section}>
            <Text style={s.label}>Your rules</Text>
            {rules.map((rule) => {
              const next = [year, year + 1].map((y) => ({ y, range: holidayRange(rule, y) })).find((item) => item.range && item.y >= rule.fromYear && item.y <= rule.toYear);
              return (
                <Pressable key={rule.id} onPress={() => setDraft({ rule, isNew: false })} accessibilityRole="button"
                  accessibilityLabel={`Edit ${rule.name}. ${ruleSummary(rule)}`} style={({ pressed }) => [s.listRow, pressed && { opacity: 0.7 }]}>
                  <View style={s.listIcon}><Ionicons name="star-outline" size={19} color={theme.accent} /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.choiceText}>{rule.name}</Text>
                    <Text style={s.help}>{ruleSummary(rule)}</Text>
                    <Text style={s.help}>{next ? `${rangeLabel(next.range.start, next.range.end)} · ` : ''}{rule.fromYear}-{rule.toYear}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={theme.muted} />
                </Pressable>
              );
            })}
          </View> : null}

          <View style={s.section}>
            <Text style={s.label}>Add a holiday</Text>
            <View style={s.chips}>
              {HOLIDAYS.filter((holiday) => !used.has(holiday.key)).map((holiday) => (
                <Pressable key={holiday.key} onPress={() => start(holiday.key)} accessibilityRole="button" accessibilityLabel={'Add ' + holiday.name}
                  style={({ pressed }) => [s.chip, pressed && { opacity: 0.7 }]}>
                  <Ionicons name="add" size={15} color={theme.accent} /><Text style={s.chipText}>{holiday.name}</Text>
                </Pressable>
              ))}
              <Pressable onPress={() => start('custom')} accessibilityRole="button" accessibilityLabel="Add another date"
                style={({ pressed }) => [s.chip, pressed && { opacity: 0.7 }]}>
                <Ionicons name="add" size={15} color={theme.accent} /><Text style={s.chipText}>Other date (birthday...)</Text>
              </Pressable>
            </View>
            <Text style={s.help}>School breaks fall on different dates each year. Add those from the calendar as a holiday period.</Text>
          </View>
        </Screen>
      )}
    </Modal>
  );
}

// ── planned vs. actual ───────────────────────────────────────────────────────

// A new record for the editor, starting from the selected calendar date.
export function newDeviation({ id, date, children, type = 'late' }) {
  return {
    id, type, date, endDate: date,
    children: Object.fromEntries(children.map((child) => [child, true])),
    minutesLate: 15, lateParent: '', actualParent: '', note: '', loggedAt: new Date().toISOString(),
  };
}

// Keep only the fields that belong to the chosen type.
function finishDeviation(d) {
  const base = { id: d.id, type: d.type, date: d.date, children: d.children, note: d.note.trim(), loggedAt: d.loggedAt };
  return d.type === 'late'
    ? { ...base, endDate: d.date, minutesLate: d.minutesLate, lateParent: d.lateParent || '' }
    : { ...base, endDate: d.endDate, actualParent: d.actualParent };
}

function DeviationForm({ initial, isNew, data, colorFor, today, onSave, onDelete, onCancel }) {
  const [draft, setDraft] = useState(initial);
  const [minutesText, setMinutesText] = useState(String(initial.minutesLate || ''));
  const set = (patch) => setDraft((current) => ({ ...current, ...patch }));
  const { parents, children } = data;
  const record = finishDeviation(draft);
  const selected = children.filter((child) => draft.children[child]);
  const plan = (children.length ? children : [null]).map((child) => ({
    child, day: getActualChildDay(draft.date, { entries: data.entries, parents, deviations: [] }, child),
  }));

  let error = deviationError(record);
  if (!error && children.length && selected.length === 0) error = 'Include at least one child.';
  if (!error && draft.type !== 'late') {
    const impact = computeDeviationReport({ entries: data.entries, parents, children, deviations: [record], start: record.date, end: record.endDate });
    if (impact.changedDays === 0) error = `That matches the plan: ${record.actualParent} was already scheduled then, so there is nothing to log.`;
  }
  const days = Math.round((parseDate(draft.endDate) - parseDate(draft.date)) / 86400000) + 1;

  return (
    <Screen title={isNew ? 'Log what happened' : 'Edit log entry'} onClose={onCancel} closeLabel="Cancel log entry">
      <Text style={s.bigText}>{fullLabel(draft.date)}</Text>
      <View style={s.section}>
        <Text style={s.label}>The plan</Text>
        {plan.map(({ child, day }) => <Text key={child || 'family'} style={s.planLine}>
          {child ? child + ': ' : ''}{day.conflict ? 'Schedule needs review' : day.planned ? 'with ' + day.planned : 'Not scheduled'}
        </Text>)}
      </View>

      <View style={s.section}>
        <Text style={s.label}>What happened</Text>
        <View accessibilityRole="radiogroup" style={s.choices}>{Object.keys(TYPE_LABELS).map((type) =>
          <Choice key={type} label={TYPE_LABELS[type]} sub={TYPE_HELP[type]} selected={draft.type === type} onPress={() => set({ type })} />)}</View>
      </View>

      <ChildToggles children={children} value={draft.children} onChange={(value) => set({ children: value })} />

      {draft.type === 'late' ? <>
        <View style={s.section}>
          <Text style={s.label}>Minutes late</Text>
          <View style={s.chips}>{LATE_PRESETS.map((minutes) => (
            <Pressable key={minutes} onPress={() => { set({ minutesLate: minutes }); setMinutesText(String(minutes)); }}
              accessibilityRole="button" accessibilityState={{ selected: draft.minutesLate === minutes }} accessibilityLabel={minutes + ' minutes'}
              style={({ pressed }) => [s.chip, draft.minutesLate === minutes && s.chipSelected, pressed && { opacity: 0.7 }]}>
              <Text style={[s.chipText, draft.minutesLate === minutes && s.chipTextSelected]}>{minutes}</Text>
            </Pressable>
          ))}</View>
          <Field style={s.input} value={minutesText} keyboardType="number-pad" maxLength={4} placeholder="Other number of minutes"
            accessibilityLabel="Minutes late"
            onChangeText={(text) => {
              const digits = text.replace(/\D/g, '');
              setMinutesText(digits);
              set({ minutesLate: digits ? Math.min(Number(digits), MAX_MINUTES_LATE + 1) : 0 });
            }} />
        </View>
        {parents.length ? <View style={s.section}>
          <Text style={s.label}>Who was late</Text>
          <View accessibilityRole="radiogroup" style={s.choices}>
            {parents.map((parent) => <Choice key={parent} label={parent} color={colorFor(parent)} selected={draft.lateParent === parent} onPress={() => set({ lateParent: parent })} />)}
            <Choice label="Not recorded" selected={!draft.lateParent} onPress={() => set({ lateParent: '' })} />
          </View>
        </View> : null}
      </> : <>
        <View style={s.section}>
          <Text style={s.label}>Through</Text>
          <Stepper label={plural(days, 'day')} value={days} min={1} max={60} text={dayLabel(draft.endDate)}
            onChange={(count) => set({ endDate: shiftDate(draft.date, count - 1) })} />
        </View>
        <View style={s.section}>
          <Text style={s.label}>Who the children were actually with</Text>
          {parents.length ? <View accessibilityRole="radiogroup" style={s.choices}>{parents.map((parent) =>
            <Choice key={parent} label={parent} color={colorFor(parent)} selected={draft.actualParent === parent} onPress={() => set({ actualParent: parent })} />)}</View>
            : <Text style={s.help}>No parents added. Household details are in Settings.</Text>}
        </View>
      </>}

      <View style={s.section}>
        <Text style={s.label}>Note</Text>
        <Field style={[s.input, s.note]} value={draft.note} onChangeText={(note) => set({ note })} multiline textAlignVertical="top"
          maxLength={2000} placeholder="What happened, in plain facts" />
        <Text style={s.help}>Kept on this device with your private notes. Not shared or shown in My Days.</Text>
      </View>

      {draft.date > today ? <Text style={s.help}>This date has not happened yet.</Text> : null}
      {error && (draft.type === 'late' || draft.actualParent) ? <Text style={s.error}>{error}</Text> : null}
      <PrimaryButton label={isNew ? 'Save to log' : 'Save changes'} disabled={Boolean(error)} onPress={() => onSave(record)} />
      {!isNew ? <DeleteButton label="Delete log entry" onPress={() => Alert.alert('Delete log entry?',
        'You can undo this from local change history.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: () => onDelete(draft.id) },
        ])} /> : null}
    </Screen>
  );
}

// `target` is { record, isNew } or null.
export function DeviationEditor({ target, data, colorFor, today, onSave, onDelete, onClose }) {
  return (
    <Modal visible={Boolean(target)} animationType="slide" onRequestClose={onClose}>
      {target ? <DeviationForm key={target.record.id} initial={target.record} isNew={target.isNew} data={data} colorFor={colorFor} today={today}
        onCancel={onClose} onSave={onSave} onDelete={onDelete} /> : null}
    </Modal>
  );
}

function DeviationRow({ deviation, detail, onOpen }) {
  const names = childNames(deviation);
  const when = deviation.date === deviation.endDate ? dayLabel(deviation.date) : `${dayLabel(deviation.date)} - ${dayLabel(deviation.endDate)}`;
  return (
    <Pressable onPress={() => onOpen(deviation)} accessibilityRole="button"
      accessibilityLabel={`${describeDeviation(deviation)}, ${when}. Edit`} style={({ pressed }) => [s.listRow, pressed && { opacity: 0.7 }]}>
      <View style={s.listIcon}><Ionicons name={TYPE_ICONS[deviation.type]} size={19} color={theme.accent} /></View>
      <View style={{ flex: 1 }}>
        <Text style={s.choiceText}>{describeDeviation(deviation)}</Text>
        <Text style={s.help}>{[when, names.join(', '), detail].filter(Boolean).join(' · ')}</Text>
        {deviation.note ? <Text style={s.help} numberOfLines={2}>{deviation.note}</Text> : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={theme.muted} />
    </Pressable>
  );
}

// Shown under the daily plan on the calendar.
export function DayLog({ date, deviations, child, onLog, onOpen }) {
  const logged = deviationsOnDate(date, deviations, child);
  return (
    <View style={s.dayLog}>
      {logged.length ? <Text style={s.label}>Logged for this day</Text> : null}
      {logged.map((deviation) => <DeviationRow key={deviation.id} deviation={deviation} onOpen={onOpen} />)}
      <Pressable onPress={() => onLog(date)} accessibilityRole="button" style={({ pressed }) => [s.secondary, pressed && { opacity: 0.7 }]}>
        <Ionicons name="create-outline" size={18} color={theme.accent} />
        <Text style={s.secondaryText}>{logged.length ? 'Log something else' : 'Log what happened'}</Text>
      </Pressable>
    </View>
  );
}

const signed = (value) => (value > 0 ? '+' + value : value < 0 ? '−' + Math.abs(value) : '0');

// The planned-vs-actual section of the Reports tab.
export function DeviationReport({ report, unit, colorFor, onOpen }) {
  const { counts } = report;
  const total = counts.late + counts.missed + counts.swap;
  return (
    <View>
      <SectionHeading title="Planned vs. actual" subtitle={total ? plural(total, 'logged change') + ' in this period' : 'Nothing logged in this period'} />
      {report.rows.length ? <View accessibilityRole="summary">
        <View style={s.tableRow}>
          <Text style={[s.tableHead, { flex: 1 }]}>Parent</Text>
          <Text style={[s.tableHead, s.tableNumber]}>Planned</Text>
          <Text style={[s.tableHead, s.tableNumber]}>Actual</Text>
          <Text style={[s.tableHead, s.tableNumber]}>Change</Text>
        </View>
        {report.rows.map((row) => (
          <View key={row.parent} style={s.tableRow} accessible
            accessibilityLabel={`${row.parent}: planned ${row.plannedDays} ${unit}, ${row.plannedPercentage} percent. Actual ${row.actualDays} ${unit}, ${row.actualPercentage} percent. Change ${signed(row.difference)}.`}>
            <View style={s.tableName}><PersonBadge name={row.parent} color={colorFor(row.parent)} small /><Text style={s.choiceText} numberOfLines={1}>{row.parent}</Text></View>
            <View style={s.tableNumber}><Text style={s.tableValue}>{row.plannedDays}</Text><Text style={s.tableSub}>{row.plannedPercentage}%</Text></View>
            <View style={s.tableNumber}><Text style={s.tableValue}>{row.actualDays}</Text><Text style={s.tableSub}>{row.actualPercentage}%</Text></View>
            <View style={s.tableNumber}><Text style={[s.tableValue, row.difference !== 0 && { color: theme.warning }]}>{signed(row.difference)}</Text></View>
          </View>
        ))}
      </View> : null}

      {total ? <View style={{ marginTop: 14 }}>
        {report.changedDays ? <Text style={s.fact}>{report.changedDays} {unit} went differently from the plan.</Text> : null}
        {counts.missed ? <Text style={s.fact}>Missed time: {counts.missed}</Text> : null}
        {counts.swap ? <Text style={s.fact}>Agreed swaps: {counts.swap}</Text> : null}
        {counts.late ? <Text style={s.fact}>Late exchanges: {counts.late} ({plural(report.minutesLate, 'minute')} in total)</Text> : null}
        {Object.keys(report.lateByParent).map((parent) => <Text key={parent} style={s.help}>
          {parent}: late {plural(report.lateByParent[parent].count, 'time')}, {plural(report.lateByParent[parent].minutes, 'minute')}
        </Text>)}
      </View> : null}

      {report.items.length ? <View style={{ marginTop: 14 }}>
        <Text style={s.label}>Logged changes</Text>
        {report.items.map((item) => <DeviationRow key={item.deviation.id} deviation={item.deviation} onOpen={onOpen}
          detail={item.deviation.type === 'late' ? '' : item.changedDays ? `${item.changedDays} ${unit} changed` : 'No change to the count'} />)}
      </View> : null}

      <Text style={[s.help, { marginTop: 12 }]}>
        Days with nothing logged count as going to plan. Log changes from a day on the calendar. This is your own record on this device, not one the other parent has confirmed.
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.canvas },
  header: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 6, backgroundColor: theme.paper, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: '700', color: theme.ink },
  content: { padding: 20, paddingBottom: 40, width: '100%', maxWidth: 760, alignSelf: 'center' },
  intro: { fontSize: 14, lineHeight: 21, color: theme.muted, marginBottom: 8 },
  section: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line },
  label: { fontSize: 11, fontWeight: '600', color: theme.muted, textTransform: 'uppercase', marginBottom: 8 },
  bigText: { fontSize: 19, fontWeight: '700', color: theme.ink },
  help: { fontSize: 13, lineHeight: 19, color: theme.muted, marginTop: 4 },
  planLine: { fontSize: 15, lineHeight: 22, color: theme.ink },
  error: { fontSize: 13, lineHeight: 19, color: '#b42318', marginTop: 12 },
  input: { minHeight: 48, borderWidth: 1, borderColor: '#d1d5db', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9, fontSize: 15, color: theme.ink, backgroundColor: theme.paper, marginTop: 4 },
  note: { minHeight: 96 },
  choices: { gap: 8 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, minHeight: 54, borderRadius: 8, borderWidth: 1, borderColor: theme.line, backgroundColor: theme.paper },
  choiceSelected: { backgroundColor: theme.soft, borderColor: theme.accent },
  choiceText: { fontSize: 15, color: theme.ink, flexShrink: 1 },
  toggleRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stepperRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepperLabel: { width: 84, fontSize: 14, color: theme.muted },
  stepperValue: { flex: 1, textAlign: 'center', fontSize: 15, fontWeight: '600', color: theme.ink },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 13, borderRadius: 8, borderWidth: 1, borderColor: theme.line, backgroundColor: theme.paper },
  chipSelected: { backgroundColor: theme.accent, borderColor: theme.accent },
  chipText: { fontSize: 14, color: theme.ink },
  chipTextSelected: { color: '#fff', fontWeight: '700' },
  listRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line },
  listIcon: { width: 34, height: 34, borderRadius: 8, backgroundColor: theme.soft, alignItems: 'center', justifyContent: 'center' },
  previewRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  warning: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', padding: 12, marginTop: 14, borderRadius: 8, backgroundColor: '#fbe7de' },
  warningText: { flex: 1, fontSize: 13, lineHeight: 19, color: theme.warning },
  primary: { minHeight: 48, borderRadius: 8, backgroundColor: theme.accent, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', marginTop: 18 },
  primaryText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  secondary: { minHeight: 46, borderRadius: 8, borderWidth: 1, borderColor: theme.accent, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  secondaryText: { color: theme.accent, fontWeight: '600', fontSize: 14 },
  destructive: { minHeight: 48, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  destructiveText: { color: '#b42318', fontWeight: '600', fontSize: 14 },
  dayLog: { marginTop: 16 },
  tableRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line },
  tableHead: { fontSize: 11, fontWeight: '600', color: theme.muted, textTransform: 'uppercase' },
  tableName: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  tableNumber: { width: 66, alignItems: 'flex-end', textAlign: 'right' },
  tableValue: { fontSize: 16, fontWeight: '700', color: theme.ink },
  tableSub: { fontSize: 12, color: theme.muted },
  fact: { fontSize: 14, lineHeight: 22, color: theme.ink },
});
