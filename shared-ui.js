import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as Crypto from 'expo-crypto';
import { Ionicons } from '@expo/vector-icons';
import { Field, IconButton, SectionHeading, theme } from './family-ui';
import { sharedConfigured } from './shared-client';
import { useSharedWorkspace } from './use-shared-workspace';
const { publicEntry, sharedPlan, requestSummary, sharedError } = require('./shared-model');

function Button({ title, icon, onPress, disabled, destructive = false }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [s.button, destructive && s.dangerButton, disabled && { opacity: 0.4 }, pressed && { opacity: 0.65 }]}>
    <Ionicons name={icon} size={19} color={destructive ? '#9b2c23' : theme.accent} /><Text style={[s.buttonText, destructive && { color: '#9b2c23' }]}>{title}</Text>
  </Pressable>;
}
function Choices({ names, value, onChange, multiple = false }) {
  return <View style={s.choices}>{names.map((name) => {
    const checked = multiple ? Boolean(value[name]) : value === name;
    return <Pressable key={name} accessibilityRole={multiple ? 'checkbox' : 'radio'} accessibilityState={{ checked }} onPress={() => onChange(name)} style={[s.choice, checked && s.choiceActive]}>
      <Ionicons name={checked ? 'checkmark-circle' : 'ellipse-outline'} size={21} color={theme.accent} /><Text style={s.body}>{name}</Text>
    </Pressable>;
  })}</View>;
}
function EntryDetails({ entry }) {
  if (!entry) return <Text style={s.meta}>No period</Text>;
  return <View style={s.details}>
    <Text style={s.strong}>{entry.parent}</Text>
    <Text style={s.body}>{entry.beginDate} to {entry.endDate}</Text>
    <Text style={s.body}>{Object.keys(entry.childrenPresent).filter((c) => entry.childrenPresent[c]).join(', ')}</Text>
    <Text style={s.meta}>Exchange: {entry.exchangeTime || 'Time not set'} · {entry.exchangePlace || 'Place not set'}</Text>
    {entry.isException && <Text style={s.meta}>Holiday / exception</Text>}
  </View>;
}
function PlanPreview({ plan, Calendar, today }) {
  return <Calendar {...plan} parentLocations={{}} today={today} readOnly />;
}
function confirm(title, message, action, label = 'Continue', destructive = false) {
  Alert.alert(title, message, [{ text: 'Cancel', style: 'cancel' }, { text: label, style: destructive ? 'destructive' : 'default', onPress: action }]);
}
function newId() { return Crypto.randomUUID(); }

export function SharedWorkspaceScreen({ localData, Calendar, today, onClose }) {
  const cloud = useSharedWorkspace();
  const [email, setEmail] = useState(''), [code, setCode] = useState(''), [codeSent, setCodeSent] = useState(false);
  const [title, setTitle] = useState('Family schedule'), [parent, setParent] = useState('');
  const [inviteEmail, setInviteEmail] = useState(''), [invitation, setInvitation] = useState(null);
  const [joinCode, setJoinCode] = useState('');
  const [tab, setTab] = useState('calendar');
  const [draft, setDraft] = useState(null), [review, setReview] = useState(null), [createPreview, setCreatePreview] = useState(null);
  const [picker, setPicker] = useState(null);
  const { bundle, session, busy } = cloud;
  const w = bundle?.workspace;
  const me = bundle?.members.find((m) => m.user_id === session?.user.id);
  const pending = bundle?.requests.filter((r) => r.status === 'pending') || [];
  const attempt = async (fn) => { try { await fn(); } catch (e) { Alert.alert('Could not complete action', sharedError(e)); } };
  useEffect(() => { setDraft(null); setReview(null); setInvitation(null); setPicker(null); }, [session?.user.id, cloud.selected]);
  useEffect(() => { if (!bundle) { setDraft(null); setReview(null); setInvitation(null); } }, [bundle]);
  const decide = (request, decision) => confirm(
    decision === 'accepted' ? 'Accept this schedule?' : decision === 'declined' ? 'Decline this request?' : 'Withdraw this request?',
    decision === 'accepted' ? 'This updates the shared plan for both parents. Other pending requests based on the old plan become outdated.' : 'The current shared schedule will not change.',
    () => attempt(async () => { await cloud.rpc('decide_change', { request_id: request.id, decision }); setReview(null); }),
    decision === 'accepted' ? 'Accept' : decision === 'declined' ? 'Decline' : 'Withdraw');
  const openDraft = (entry, kind = 'upsert') => { setPicker(null); setDraft({ entry: publicEntry(entry), kind, message: '', requestId: newId(), baseRevision: w.revision, workspace: w.id }); };
  const updateDraft = (field, value) => setDraft((d) => ({ ...d, entry: { ...d.entry, [field]: value } }));
  const submitDraft = () => attempt(async () => {
    await cloud.rpc('propose_change', { workspace: draft.workspace, request_id: draft.requestId, base_revision: draft.baseRevision,
      kind: draft.kind, entry: draft.kind === 'delete' ? null : publicEntry(draft.entry), entry_id: draft.entry.id, message: draft.message });
    setDraft(null); setTab('requests');
  });
  const logout = () => attempt(async () => { await cloud.signOut(); setCodeSent(false); setCode(''); setCreatePreview(null); });

  return <SafeAreaView style={s.screen}>
    <View style={s.header}><IconButton icon="arrow-back" label="Return to personal calendar" onPress={onClose} /><View style={{ flex: 1 }}>
      <Text style={s.title}>Shared family</Text><Text style={s.meta}>{session?.user.email || 'Personal calendar stays separate'}</Text>
    </View>{session && <IconButton icon="refresh" label="Refresh shared workspace" disabled={busy} onPress={cloud.refresh} />}</View>
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      {!sharedConfigured ? <View style={s.band}>
        <Ionicons name="people-outline" size={32} color={theme.accent} />
        <Text style={s.title}>Shared service not connected</Text>
        <Text style={s.body}>Your personal calendar remains available. Accounts and shared schedules will be available once this app is connected to its secure service.</Text>
        <Text style={s.meta}>No family information has been uploaded.</Text>
      </View> : !cloud.ready ? <ActivityIndicator accessibilityLabel="Loading sign-in" /> : <>
      {cloud.error ? <View style={s.warning} accessibilityRole="alert"><Text style={s.body}>{cloud.error}</Text><Button title="Retry connection" icon="refresh" onPress={cloud.refresh} disabled={busy} /></View> : null}
      {busy && <ActivityIndicator accessibilityLabel="Waiting for server confirmation" />}
      {!session ? <View style={s.band}>
        <SectionHeading title="Sign in or create an account" />
        <Text style={s.label}>Email</Text>
        <Field accessibilityLabel="Account email" value={email} onChangeText={(v) => { setEmail(v); setCodeSent(false); }} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" textContentType="emailAddress" style={s.input} editable={!busy} />
        <Button title={codeSent ? 'Send another code' : 'Email a sign-in code'} icon="mail-outline" disabled={busy || !email.trim()} onPress={() => attempt(async () => { await cloud.sendCode(email.trim().toLowerCase()); setCodeSent(true); })} />
        {codeSent && <><Text style={s.label}>Code from your email</Text><Field accessibilityLabel="Email verification code" style={s.input} value={code} onChangeText={setCode} keyboardType="number-pad" textContentType="oneTimeCode" maxLength={12} />
          <Button title="Verify and sign in" icon="log-in-outline" disabled={busy || code.trim().length < 6} onPress={() => attempt(() => cloud.verifyCode(email.trim().toLowerCase(), code.trim()))} /></>}
        <Text style={s.meta}>Signing in does not share your personal calendar. No password is needed.</Text>
      </View> : <>
      {cloud.workspaces.length > 1 && <Choices names={cloud.workspaces.map((f) => f.title + ' · ' + f.id.slice(0, 6))} value={w ? w.title + ' · ' + w.id.slice(0, 6) : ''}
        onChange={(label) => cloud.select(cloud.workspaces.find((f) => label === f.title + ' · ' + f.id.slice(0, 6)).id)} />}
      {w ? <>
        <SectionHeading title={w.title} subtitle={w.revision ? `Agreed plan · revision ${w.revision}` : 'No agreed schedule yet'} />
        <Text style={s.meta}>{cloud.checkedAt ? 'Checked ' + cloud.checkedAt.toLocaleTimeString() : 'Waiting for a fresh connection'}</Text>
        <View style={s.tabs}>{[['calendar','Calendar'],['requests',`Requests (${pending.length})`],['access','Access']].map(([id,label]) =>
          <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected: tab === id }} onPress={() => setTab(id)} style={[s.tab, tab === id && s.tabActive]}><Text style={s.tabText}>{label}</Text></Pressable>)}</View>
        {tab === 'calendar' && (w.revision > 0 ? <>
          <Calendar {...w.plan} parentLocations={{}} today={today} saveLabel="Review request" holidayNameEnabled={false} onCreateEntry={(start,end,name,child,exception) => openDraft({ id: newId(), parent: name, beginDate: start, endDate: end, isException: exception, childrenPresent: Object.fromEntries(w.plan.children.map((c) => [c, !child || child === c])) })}
            onOpenEntry={(id) => openDraft(w.plan.entries.find((e) => e.id === id))} />
          <Text style={s.meta}>Shared reminders are not enabled. Personal-calendar reminders use only your local plan.</Text>
        </> : <View style={s.band}><Text style={s.body}>The starting schedule is waiting for both parents. Review it under Requests.</Text>
          {!pending.length && <Button title="Propose starting schedule" icon="calendar-outline" disabled={busy} onPress={() => attempt(async () => { const plan = sharedPlan(localData); setCreatePreview({ plan, existing: w.id }); })} />}</View>)}
        {tab === 'requests' && <>
          <Text style={s.meta}>Pending requests do not change the agreed plan. No response is not approval.</Text>
          {!pending.length && <Text style={s.body}>No pending requests.</Text>}
          {bundle.requests.map((r) => <Pressable key={r.id} accessibilityRole="button" onPress={() => setReview(r)} style={s.request}>
            <View style={s.row}><Text style={s.strong}>{requestSummary(r)}</Text><Ionicons name="chevron-forward" size={18} color={theme.muted} /></View>
            <Text style={s.meta}>{r.author_name} · {r.status} · {new Date(r.created_at).toLocaleDateString()}</Text>
          </Pressable>)}
          <SectionHeading title="Shared history" subtitle="Latest 100 events" />
          {bundle.events.map((event) => <View key={event.id} style={s.event}><Text style={s.body}>{event.action}</Text><Text style={s.meta}>{event.actor_name} · {new Date(event.created_at).toLocaleString()}</Text></View>)}
        </>}
        {tab === 'access' && <>
          <Text style={s.meta}>Only these two parent accounts can view this workspace. Private notes, phone numbers, home addresses, and local history are not shared.</Text>
          {bundle.members.map((m) => <View key={m.user_id} style={s.member}><Text style={s.strong}>{m.parent_name}{m.user_id === session.user.id ? ' (you)' : ''}</Text><Text style={s.meta}>{m.role === 'owner' ? 'Workspace owner' : 'Co-parent'}</Text>
            {m.role !== 'owner' && (me?.role === 'owner' || m.user_id === session.user.id) && <Button title={m.user_id === session.user.id ? 'Leave workspace' : 'Remove access'} icon="person-remove-outline" destructive disabled={busy}
              onPress={() => confirm('Remove workspace access?', 'Future server access will stop. Previously viewed, exported, or captured information cannot be recalled.', () => attempt(() => cloud.rpc('remove_family_access', { workspace: w.id, member_id: m.user_id })), 'Remove', true)} />}</View>)}
          {me?.role === 'owner' && <>
            {bundle.members.length === 1 && <View style={s.band}><Text style={s.label}>Co-parent email</Text><Field accessibilityLabel="Co-parent invitation email" style={s.input} value={inviteEmail} onChangeText={setInviteEmail} autoCapitalize="none" keyboardType="email-address" />
              <Button title="Create invitation" icon="person-add-outline" disabled={busy || !inviteEmail.trim()} onPress={() => attempt(async () => { const address = inviteEmail.trim().toLowerCase(); const token = await cloud.rpc('invite_parent', { workspace: w.id, email: address }); setInvitation({ token, email: address }); })} />
              {invitation ? <><Text selectable style={s.code}>{invitation.token}</Text><Text style={s.meta}>Valid for seven days, only for {invitation.email}.</Text><Button title="Share invitation" icon="share-outline" onPress={() => attempt(() => Share.share({ message: `Join our Custody Calendar shared family with ${invitation.email}. In Shared family, sign in and enter this invitation code:\n\n${invitation.token}\n\nExpires in seven days. Joining does not accept the starting schedule.` }))} /></> : null}
            </View>}
            <Button title="Revoke outstanding invitations" icon="close-circle-outline" disabled={busy} onPress={() => attempt(async () => { await cloud.rpc('revoke_family_invitations', { workspace: w.id }); setInvitation(null); Alert.alert('Invitations revoked'); })} />
            <Button title="Delete shared workspace" icon="trash-outline" destructive disabled={busy} onPress={() => confirm('Delete shared workspace?', 'This permanently removes this shared schedule, invitations, requests, and history for both parents. Personal calendars and exported copies are unchanged.', () => attempt(() => cloud.rpc('delete_family', { workspace: w.id })), 'Delete workspace', true)} />
          </>}
        </>}
      </> : !cloud.error && <Text style={s.body}>No shared family yet.</Text>}
      {!w || tab === 'access' ? <>
        <View style={s.band}><SectionHeading title="Join a family" /><Text style={s.label}>Invitation code</Text><Field accessibilityLabel="Invitation code" style={s.input} autoCapitalize="none" autoCorrect={false} value={joinCode} onChangeText={setJoinCode} />
          <Button title="Join invited family" icon="enter-outline" disabled={busy || !joinCode.trim()} onPress={() => attempt(async () => { const id = await cloud.rpc('join_family', { token: joinCode.trim() }); setJoinCode(''); cloud.select(id); setTab('requests'); })} /></View>
        <View style={s.band}><SectionHeading title="Start a shared family" /><Text style={s.label}>Workspace name</Text><Field accessibilityLabel="Workspace name" style={s.input} value={title} onChangeText={setTitle} maxLength={100} />
          <Text style={s.label}>I am</Text><Choices names={localData.parents} value={parent} onChange={setParent} />
          <Button title="Review what will be shared" icon="eye-outline" disabled={busy || !localData.parents.includes(parent) || !title.trim()} onPress={() => attempt(async () => setCreatePreview({ plan: sharedPlan(localData), id: newId() }))} />
        </View>
      </> : null}
      <View style={s.band}><Button title="Sign out" icon="log-out-outline" disabled={busy} onPress={logout} />
        <Button title="Delete account" icon="trash-outline" destructive disabled={busy} onPress={() => confirm('Permanently delete your account?', 'Your account and access will be removed. Sole-member workspaces are deleted. A shared workspace remains with the other parent, including shared history and your name in its schedule. Your personal calendar and exported copies remain on this device. Sign in again first if more than 15 minutes have passed.', () => attempt(cloud.deleteAccount), 'Delete account', true)} />
      </View>
      </>}
      </>}
    </ScrollView></KeyboardAvoidingView>

    <Modal visible={Boolean(createPreview)} animationType="slide" onRequestClose={() => setCreatePreview(null)}>
      <SafeAreaView style={s.screen}><View style={s.header}><IconButton icon="close" label="Cancel sharing preview" disabled={busy} onPress={() => setCreatePreview(null)} /><Text style={s.title}>Sharing preview</Text></View>
      <ScrollView contentContainerStyle={s.content}>{createPreview && <>
        <Text style={s.body}>This uploads parent and child names, colors, custody dates, and exchange times and places. Private notes, home addresses, phone numbers, backups, and history remain on your device.</Text>
        <Text style={s.meta}>Your personal calendar stays separate. The other parent must accept this starting schedule.</Text>
        <PlanPreview plan={createPreview.plan} Calendar={Calendar} today={today} />
        <Button title={createPreview.existing ? 'Submit starting schedule' : 'Create shared workspace'} icon="cloud-upload-outline" disabled={busy} onPress={() => attempt(async () => {
          const id = createPreview.existing ? (await cloud.rpc('propose_starting_plan', { workspace: createPreview.existing, plan: createPreview.plan }), createPreview.existing)
            : await cloud.rpc('create_family', { title: title.trim(), plan: createPreview.plan, parent_name: parent, workspace_id: createPreview.id });
          setCreatePreview(null); cloud.select(id); setTab(createPreview.existing ? 'requests' : 'access');
        })} />
      </>}</ScrollView></SafeAreaView>
    </Modal>

    <Modal visible={Boolean(review)} animationType="slide" onRequestClose={() => setReview(null)}>
      <SafeAreaView style={s.screen}><View style={s.header}><IconButton icon="close" label="Close request" onPress={() => setReview(null)} /><Text style={s.title}>Schedule request</Text></View>
        <ScrollView contentContainerStyle={s.content}>{review && <>
          <Text style={s.strong}>{requestSummary(review)}</Text><Text style={s.meta}>From {review.author_name} · {review.status}</Text>
          {review.initial_plan ? <PlanPreview plan={review.initial_plan} Calendar={Calendar} today={today} /> : <>
            <Text style={s.label}>Before</Text><EntryDetails entry={review.before_entry} /><Text style={s.label}>Proposed</Text><EntryDetails entry={review.after_entry} />
          </>}
          {review.message ? <><Text style={s.label}>Shared reason</Text><Text style={s.body}>{review.message}</Text></> : null}
          {review.status === 'pending' && (review.author_id !== session?.user.id ? <>
            <Button title="Accept change" icon="checkmark-circle-outline" disabled={busy} onPress={() => decide(review,'accepted')} />
            <Button title="Decline change" icon="close-circle-outline" disabled={busy} onPress={() => decide(review,'declined')} />
            {review.kind !== 'initial' && <Button title="Suggest an alternative" icon="swap-horizontal-outline" disabled={busy} onPress={() => { openDraft(review.after_entry || review.before_entry); setReview(null); }} />}
          </> : review.kind !== 'initial' && <Button title="Withdraw request" icon="arrow-undo-outline" disabled={busy} onPress={() => decide(review,'withdrawn')} />)}
        </>}</ScrollView>
      </SafeAreaView>
    </Modal>

    <Modal visible={Boolean(draft)} animationType="slide" onRequestClose={() => setDraft(null)}>
      <SafeAreaView style={s.screen}><View style={s.header}><IconButton icon="close" label="Cancel proposed change" disabled={busy} onPress={() => setDraft(null)} /><Text style={s.title}>Propose a change</Text></View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">{draft && w && <>
        <Text style={s.meta}>Not applied until the other parent accepts.</Text>
        {draft.kind === 'delete' ? <><Text style={s.label}>Remove this period</Text><EntryDetails entry={draft.entry} /></> : <>
          <Text style={s.label}>Parent</Text><Choices names={w.plan.parents} value={draft.entry.parent} onChange={(name) => updateDraft('parent',name)} />
          <Text style={s.label}>Children</Text><Choices names={w.plan.children} multiple value={draft.entry.childrenPresent} onChange={(name) => updateDraft('childrenPresent', { ...draft.entry.childrenPresent, [name]: !draft.entry.childrenPresent[name] })} />
          {['beginDate','endDate'].map((field) => <Button key={field} title={`${field === 'beginDate' ? 'Start' : 'End'}: ${draft.entry[field]}`} icon="calendar-outline" onPress={() => setPicker(field)} />)}
          {picker && <DateTimePicker value={new Date(draft.entry[picker] + 'T12:00:00')} mode="date" display="inline" onChange={(_e,date) => { if (date) updateDraft(picker,`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`); setPicker(null); }} />}
          <Text style={s.label}>Exchange time</Text><Field accessibilityLabel="Proposed exchange time" style={s.input} value={draft.entry.exchangeTime || ''} placeholder="e.g. 5:00 PM" maxLength={300} onChangeText={(v) => updateDraft('exchangeTime',v)} />
          <Text style={s.label}>Exchange place</Text><Field accessibilityLabel="Proposed exchange place" style={s.input} value={draft.entry.exchangePlace || ''} maxLength={300} onChangeText={(v) => updateDraft('exchangePlace',v)} />
          <Choices names={['Holiday / exception']} multiple value={{ 'Holiday / exception': draft.entry.isException }} onChange={() => updateDraft('isException', !draft.entry.isException)} />
        </>}
        <Text style={s.label}>Reason shared with the other parent</Text><Field accessibilityLabel="Shared reason for change" style={[s.input,{ minHeight: 90 }]} value={draft.message} multiline maxLength={1000} onChangeText={(v) => setDraft((d) => ({ ...d,message:v }))} />
        {draft.baseRevision !== w.revision ? <Text style={s.warning}>The plan changed while this draft was open. Close it and review the current schedule.</Text> : <Button title="Send request" icon="send-outline" disabled={busy} onPress={submitDraft} />}
        {draft.kind !== 'delete' && w.plan.entries.some((e) => e.id === draft.entry.id) && <Button title="Request removal instead" icon="trash-outline" destructive disabled={busy} onPress={() => setDraft((d) => ({ ...d,kind:'delete',entry:w.plan.entries.find((e) => e.id === d.entry.id) }))} />}
      </>}</ScrollView></KeyboardAvoidingView></SafeAreaView>
    </Modal>
  </SafeAreaView>;
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.paper },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderBottomWidth: 1, borderColor: theme.line },
  title: { fontSize: 21, fontWeight: '700', color: theme.ink, flexShrink: 1 },
  content: { padding: 20, paddingBottom: 40, gap: 12 },
  band: { paddingVertical: 20, borderTopWidth: 1, borderColor: theme.line, gap: 12 },
  body: { fontSize: 15, color: theme.ink, lineHeight: 23, flexShrink: 1 },
  strong: { fontSize: 16, fontWeight: '600', color: theme.ink, flex: 1 },
  meta: { fontSize: 13, lineHeight: 20, color: theme.muted },
  label: { fontSize: 14, fontWeight: '600', color: theme.ink, marginTop: 12 },
  input: { minHeight: 48, borderWidth: 1, borderColor: theme.line, borderRadius: 6, padding: 12, color: theme.ink, fontSize: 16 },
  button: { minHeight: 48, padding: 12, borderRadius: 6, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: theme.soft },
  buttonText: { fontSize: 15, fontWeight: '600', color: theme.accent, flex: 1 },
  dangerButton: { backgroundColor: '#fff0ed' },
  choices: { gap: 8 },
  choice: { minHeight: 48, flexDirection: 'row', gap: 10, alignItems: 'center', padding: 10, borderWidth: 1, borderColor: theme.line, borderRadius: 6 },
  choiceActive: { backgroundColor: theme.soft, borderColor: theme.accent },
  tabs: { flexDirection: 'row', borderBottomWidth: 1, borderColor: theme.line, marginVertical: 12 },
  tab: { flex: 1, minHeight: 48, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 3, borderBottomWidth: 2, borderColor: 'transparent' },
  tabActive: { borderColor: theme.accent, backgroundColor: theme.soft },
  tabText: { fontSize: 14, fontWeight: '600', color: theme.ink, textAlign: 'center' },
  request: { paddingVertical: 16, borderBottomWidth: 1, borderColor: theme.line, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  event: { borderLeftWidth: 2, borderColor: theme.line, paddingLeft: 12, paddingVertical: 10 },
  member: { borderBottomWidth: 1, borderColor: theme.line, paddingVertical: 16, gap: 8 },
  details: { gap: 6, paddingVertical: 8 },
  warning: { padding: 14, backgroundColor: '#fff1d9', borderRadius: 6, color: theme.ink, lineHeight: 22 },
  code: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, color: theme.ink, lineHeight: 20 },
});
