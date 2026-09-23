import React, { useState } from 'react';
import { View, Text, Pressable, Switch, Alert, Linking, StyleSheet, ScrollView, Modal, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { SectionHeading, DetailLine, theme } from './family-ui';
const { createBackup, parseBackup, MAX_BACKUP_BYTES, HISTORY_LIMIT } = require('./local-store');

function Action({ icon, title, subtitle, onPress, disabled }) {
  return <Pressable disabled={disabled} accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled: Boolean(disabled) }}
    onPress={onPress} style={({ pressed }) => [s.action, (pressed || disabled) && { opacity: 0.5 }]}>
    <Ionicons name={icon} size={21} color={theme.accent} />
    <View style={{ flex: 1 }}><Text style={s.title}>{title}</Text>{subtitle ? <Text style={s.help}>{subtitle}</Text> : null}</View>
    <Ionicons name="chevron-forward" size={18} color={theme.muted} />
  </Pressable>;
}

async function chooseBackup() {
  const result = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/plain'], copyToCacheDirectory: true, multiple: false });
  if (result.canceled) return null;
  const file = result.assets[0];
  try {
    const info = await FileSystem.getInfoAsync(file.uri);
    if (!info.exists || info.size > MAX_BACKUP_BYTES) throw new Error('Choose a backup smaller than 4 MB.');
    return parseBackup(await FileSystem.readAsStringAsync(file.uri));
  } finally {
    if (file.uri.startsWith(FileSystem.cacheDirectory)) await FileSystem.deleteAsync(file.uri, { idempotent: true }).catch(() => {});
  }
}

function previewRestore(backup, store, onRestored, fail) {
  const d = backup.document.data;
  Alert.alert('Restore this backup?',
    `${new Date(backup.exportedAt).toLocaleString()}\n${d.parents.length} parents, ${d.children.length} children, ${d.entries.length} entries, ${d.scheduleAssignments.length} schedules.\n\nThis replaces your household and settings. Your current household remains recoverable. Reminders will be off until you enable them on this device.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Restore', onPress: async () => {
        try {
          await store.replace({ ...backup.document, data: { ...d, reminderSettings: { ...d.reminderSettings, enabled: false } } }, 'Restored backup', true);
          onRestored?.();
        } catch (e) { fail(e); }
      } },
    ]);
}

export function ReliabilityPanel({ store, reminders, onRestored }) {
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [preparedAt, setPreparedAt] = useState(null);
  const fail = (e) => Alert.alert('Action not completed', e.message);
  const run = async (action) => { setBusy(true); try { await action(); } catch (e) { fail(e); } finally { setBusy(false); } };
  const settings = store.data.reminderSettings;
  const setSettings = (patch) => store.update({ reminderSettings: { ...settings, ...patch } });
  const exportBackup = async () => {
    if (!(await Sharing.isAvailableAsync())) throw new Error('File sharing is not available on this device.');
    const path = FileSystem.cacheDirectory + `Custody_Backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    try {
      await FileSystem.writeAsStringAsync(path, createBackup(store.document), { encoding: FileSystem.EncodingType.UTF8 });
      await Sharing.shareAsync(path, { mimeType: 'application/json', UTI: 'public.json', dialogTitle: 'Save complete backup' });
      setPreparedAt(new Date());
    } finally { await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {}); }
  };
  const recover = async () => {
    const copy = await store.recovery();
    Alert.alert('Recover previous save?', `${copy.data.entries.length} entries are available in the last good save. Your current household remains in undo history.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Recover', onPress: () => store.replace(copy, 'Recovered previous save').then(() => onRestored?.()).catch(fail) },
    ]);
  };
  return <>
    <View style={s.section}>
      <SectionHeading title="Backup & recovery" />
      <Text style={s.help}>Backup files include private notes and contact details. Store them somewhere you trust. They are not encrypted by this app.</Text>
      <Action icon="download-outline" title="Save complete backup" subtitle="Household, schedules, settings and local history" disabled={busy} onPress={() => run(exportBackup)} />
      <Action icon="folder-open-outline" title="Restore backup file" subtitle="Preview a complete JSON backup before replacing data" disabled={busy} onPress={() => run(async () => {
        const backup = await chooseBackup(); if (backup) previewRestore(backup, store, onRestored, fail);
      })} />
      {preparedAt && <Text style={s.help}>Backup prepared {preparedAt.toLocaleTimeString()}. The app cannot confirm whether you saved the file outside this device.</Text>}
      <Action icon="shield-checkmark-outline" title="Recover previous save" subtitle="Local safety copy, not an external backup" disabled={busy} onPress={() => run(recover)} />
    </View>
    <View style={s.section}>
      <SectionHeading title="Local change history" subtitle={`${store.history.length} retained changes`} />
      <Text style={s.help}>Up to {HISTORY_LIMIT} recent changes, subject to storage space. Local records are editable and are not an independently verified audit trail.</Text>
      <Action icon="time-outline" title={showHistory ? 'Hide history' : 'Review changes'} disabled={!store.history.length} onPress={() => setShowHistory(!showHistory)} />
      {showHistory && store.history.map((record) => <Action key={record.id} icon="arrow-undo-outline" title={record.label}
        subtitle={new Date(record.at).toLocaleString()} disabled={busy} onPress={() => {
          Alert.alert('Restore this snapshot?', `Return the household to just before "${record.label}"? Newer changes will be replaced. The current household becomes another recovery point.`, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Restore snapshot', onPress: () => run(async () => { await store.restore(record.id); onRestored?.(); }) },
          ]);
        }} />)}
    </View>
    <View style={s.section}>
      <SectionHeading title="Exchange reminders" />
      <View style={s.toggle}><Text style={s.title}>Remind me on this device</Text><Switch accessibilityLabel="Enable exchange reminders" value={settings.enabled}
        disabled={busy} trackColor={{ true: theme.accent }} onValueChange={(enabled) => run(async () => {
          if (enabled && !(await reminders.requestPermission())) { Alert.alert('Notifications not allowed', 'You can allow notifications in device Settings.'); return; }
          setSettings({ enabled });
        })} /></View>
      {settings.enabled && <>
        <Text style={s.label}>Before the exchange</Text>
        <View style={s.choices}>{[[15, '15 min'], [60, '1 hour'], [1440, '1 day']].map(([value, title]) => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: settings.leadMinutes === value }}
          onPress={() => setSettings({ leadMinutes: value })} style={[s.choice, settings.leadMinutes === value && s.selected]}><Text style={s.choiceText}>{title}</Text></Pressable>)}</View>
        <View style={s.toggle}><Text style={s.title}>Show names and meeting place</Text><Switch accessibilityLabel="Show family details in notifications" value={settings.showDetails} trackColor={{ true: theme.accent }} onValueChange={(showDetails) => setSettings({ showDetails })} /></View>
        <Text style={s.help}>{reminders.working ? 'Updating reminders…' : `${reminders.count} reminders scheduled on this device.`}</Text>
        <Text style={s.help}>The next 48 reminders within 90 days are kept on-device. Open the app regularly to extend them. Exchange times use this device's time zone.</Text>
        {reminders.missingTimes > 0 && <DetailLine icon="time-outline" text={`${reminders.missingTimes} upcoming handoffs have no valid exchange time and cannot be scheduled.`} />}
        {reminders.conflicts > 0 && <DetailLine icon="alert-circle-outline" text="Overlapping custody entries are excluded from reminders." />}
        {reminders.permission === false && <Action icon="settings-outline" title="Allow notifications in Settings" onPress={() => Linking.openSettings().catch(fail)} />}
        <Action icon="notifications-outline" title="Send test reminder" subtitle="A generic notification in five seconds" disabled={busy || !reminders.permission} onPress={() => run(reminders.test)} />
      </>}
      {!settings.enabled && <Text style={s.help}>Reminders are off. Your schedule is not sent to a notification server.</Text>}
      {reminders.error && <><Text style={s.error}>Reminders may be out of date: {reminders.error}</Text><Action icon="refresh-outline" title="Retry reminders" onPress={reminders.refresh} /></>}
    </View>
  </>;
}

export function RecoveryScreen({ store }) {
  const [busy, setBusy] = useState(false);
  const fail = (e) => Alert.alert('Recovery not completed', e.message);
  const run = async (fn) => { setBusy(true); try { await fn(); } catch (e) { fail(e); } finally { setBusy(false); } };
  return <SafeAreaView style={s.recovery}><ScrollView contentContainerStyle={s.recoveryContent}>
    <Ionicons name="shield-outline" size={36} color={theme.accent} />
    <Text style={s.recoveryTitle}>Your saved data needs attention</Text>
    <Text style={s.help}>The app has not reset or overwritten your household.</Text>
    <Text style={s.error}>{store.loadError}</Text>
    <Action icon="refresh-outline" title="Try loading again" disabled={busy} onPress={() => run(store.load)} />
    <Action icon="arrow-undo-outline" title="Use recovery copy" disabled={busy} onPress={() => run(async () => {
      const value = await store.recovery();
      Alert.alert('Use recovery copy?', `${value.data.entries.length} entries are available in the last good save.`, [
        { text: 'Cancel' }, { text: 'Recover', onPress: () => run(() => store.replace(value, 'Recovered local data')) },
      ]);
    })} />
    <Action icon="folder-open-outline" title="Restore a backup file" disabled={busy} onPress={() => run(async () => {
      const backup = await chooseBackup(); if (backup) previewRestore(backup, store, null, fail);
    })} />
  </ScrollView><RestoreProgress visible={store.restoring} /></SafeAreaView>;
}

export function SaveWarning({ store }) {
  if (!store.saveError) return null;
  return <View style={s.saveWarning} accessibilityLiveRegion="assertive">
    <Text style={[s.error, { flex: 1 }]}>{store.saveError} Changes may not survive closing the app.</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Retry saving" onPress={store.retrySave} style={s.retry}>
      <Ionicons name="refresh-outline" size={23} color="#a22e20" />
    </Pressable>
  </View>;
}

export function RestoreProgress({ visible }) {
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={() => {}}>
    <View style={s.progressOverlay}><View style={s.progress} accessibilityViewIsModal>
      <ActivityIndicator color={theme.accent} /><Text style={s.title}>Saving restored household...</Text>
    </View></View>
  </Modal>;
}

const s = StyleSheet.create({
  section: { paddingVertical: 20, borderBottomWidth: 1, borderBottomColor: theme.line },
  action: { minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line },
  title: { fontSize: 15, fontWeight: '600', color: theme.ink, flexShrink: 1 },
  help: { fontSize: 13, lineHeight: 19, color: theme.muted, marginTop: 6 },
  error: { fontSize: 13, lineHeight: 19, color: '#a22e20', marginVertical: 10 },
  toggle: { minHeight: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14 },
  label: { fontSize: 13, color: theme.muted, marginTop: 10, marginBottom: 8 },
  choices: { flexDirection: 'row', gap: 8 },
  choice: { minHeight: 44, flex: 1, borderWidth: 1, borderColor: theme.line, borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
  selected: { backgroundColor: theme.soft, borderColor: theme.accent },
  choiceText: { fontSize: 14, color: theme.ink },
  recovery: { flex: 1, backgroundColor: theme.paper },
  recoveryContent: { flexGrow: 1, padding: 24, justifyContent: 'center' },
  recoveryTitle: { fontSize: 23, fontWeight: '700', color: theme.ink, marginTop: 18 },
  saveWarning: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, backgroundColor: '#fff0ed' },
  retry: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  progressOverlay: { flex: 1, backgroundColor: '#00000055', justifyContent: 'center', padding: 28 },
  progress: { backgroundColor: theme.paper, padding: 24, borderRadius: 8, gap: 16, alignItems: 'center' },
});
