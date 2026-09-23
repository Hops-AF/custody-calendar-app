import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { sharedClient as client } from './shared-client';
const { sharedError } = require('./shared-model');

export function useSharedWorkspace() {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(!client);
  const [workspaces, setWorkspaces] = useState([]);
  const [selected, setSelected] = useState(null);
  const [bundle, setBundle] = useState(null);
  const [error, setError] = useState('');
  const [checkedAt, setCheckedAt] = useState(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0), identity = useRef(null), inFlight = useRef(false), operation = useRef(false);
  const active = useRef(selected); active.current = selected;
  const clear = useCallback(() => {
    generation.current++; inFlight.current = false;
    setBundle(null); setWorkspaces([]); setSelected(null); setCheckedAt(null); setError('');
  }, []);
  useEffect(() => {
    if (!client) return;
    let mounted = true, observedAuth = false;
    const setAuth = (next) => {
      if (!mounted) return;
      if (identity.current !== (next?.user.id || null)) { clear(); identity.current = next?.user.id || null; }
      setSession(next); setReady(true);
    };
    client.auth.getSession().then(({ data, error: e }) => { if (e) throw e; if (!observedAuth) setAuth(data.session); }).catch((e) => { if (mounted && !observedAuth) { setError(sharedError(e)); setReady(true); } });
    const { data } = client.auth.onAuthStateChange((_event, next) => { observedAuth = true; setAuth(next); });
    return () => { mounted = false; generation.current++; data.subscription.unsubscribe(); };
  }, [clear]);

  const refresh = useCallback(async () => {
    if (!client || !identity.current || inFlight.current) return;
    const ticket = generation.current, account = identity.current;
    const current = () => generation.current === ticket && identity.current === account;
    inFlight.current = true;
    try {
      const { data: families, error: e } = await client.from('family_workspaces').select('id,title,created_at').order('created_at');
      if (e) throw e;
      if (!current()) return;
      setWorkspaces(families);
      const w = families.find((f) => f.id === active.current) || families[0];
      if (!w) { setSelected(null); setBundle(null); setCheckedAt(new Date()); setError(''); return; }
      if (active.current !== w.id) setSelected(w.id);
      const { data: state, error: stateError } = await client.rpc('family_state', { workspace: w.id });
      if (stateError) throw stateError;
      if (!current()) return;
      // Recheck membership after the multi-read, including revocation during synchronization.
      if (!state?.members.some((m) => m.user_id === account)) { setBundle(null); throw new Error('Workspace access is no longer available.'); }
      setBundle(state);
      setCheckedAt(new Date()); setError('');
    } catch (e) { if (current()) { setBundle(null); setCheckedAt(null); setError(sharedError(e)); } }
    finally { if (current()) inFlight.current = false; }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => { if (AppState.currentState === 'active') refresh(); }, 30000);
    const sub = AppState.addEventListener('change', (state) => {
      if (!client) return;
      if (state === 'active') { client.auth.startAutoRefresh(); refresh(); } else client.auth.stopAutoRefresh();
    });
    if (client && AppState.currentState === 'active') client.auth.startAutoRefresh();
    return () => { clearInterval(timer); sub.remove(); client?.auth.stopAutoRefresh(); };
  }, [session?.user.id, selected, refresh]);

  const run = async (fn) => {
    if (operation.current) throw new Error('Please wait for the current action to finish.');
    operation.current = true; setBusy(true); setError('');
    try { return await fn(); }
    catch (e) { setError(sharedError(e)); throw e; }
    finally { operation.current = false; setBusy(false); }
  };
  const rpc = (name, args) => run(async () => {
    const { data, error: e } = await client.rpc(name, args);
    if (e) throw e;
    generation.current++; inFlight.current = false;
    await refresh(); return data;
  });
  return {
    session, ready, workspaces, bundle, selected, error, checkedAt, busy, refresh, rpc,
    select: (id) => { generation.current++; inFlight.current = false; setBundle(null); setSelected(id); active.current = id; },
    sendCode: (email) => run(async () => { const { error: e } = await client.auth.signInWithOtp({ email }); if (e) throw e; }),
    verifyCode: (email, token) => run(async () => { const { error: e } = await client.auth.verifyOtp({ email, token, type: 'email' }); if (e) throw e; }),
    signOut: () => run(async () => {
      clear();
      const { error: e } = await client.auth.signOut({ scope: 'local' });
      if (e) throw e;
    }),
    deleteAccount: () => run(async () => {
      const { error: e } = await client.rpc('delete_custody_account');
      if (e) throw e;
      clear();
      await client.auth.signOut({ scope: 'local' });
    }),
  };
}
