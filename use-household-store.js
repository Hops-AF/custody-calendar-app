import { useState, useRef, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
const { createRepository, newDocument, changeDocument, restoreHistory, replacementDocument, storageFailureMessage } = require('./local-store');

export function useHouseholdStore() {
  const repo = useRef(null);
  if (!repo.current) repo.current = createRepository(AsyncStorage);
  const [document, setDocument] = useState(newDocument);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const locked = useRef(false);
  const current = useRef(document);
  current.current = document;
  const sequence = useRef(0);
  const id = useRef(0);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const value = await repo.current.load();
      setDocument(value); setSavedAt(value.updatedAt); setLoaded(true);
    } catch (error) {
      setLoadError(storageFailureMessage(error, 'load'));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const persist = useCallback(async (value) => {
    const version = ++sequence.current;
    setSaving(true);
    try {
      await repo.current.save(value);
      if (version === sequence.current) { setSaveError(null); setSavedAt(value.updatedAt); }
      return true;
    } catch (error) {
      if (version === sequence.current) setSaveError(storageFailureMessage(error));
      return false;
    } finally { if (version === sequence.current) setSaving(false); }
  }, []);
  useEffect(() => { if (loaded) persist(document); }, [document, loaded, persist]);

  const update = useCallback((patch, options = {}) => {
    if (!loaded || locked.current) return;
    const metadata = { ...options, now: new Date(), id: `${Date.now()}-${++id.current}` };
    try {
      const next = changeDocument(current.current, patch, metadata);
      current.current = next;
      setDocument(next);
    } catch (error) { setSaveError(error.message); }
  }, [loaded]);
  const setField = useCallback((key, value, options) => update((data) => ({ [key]: typeof value === 'function' ? value(data[key]) : value }), options), [update]);

  const replace = useCallback(async (next, label = 'Restored backup', importHistory = false) => {
    if (locked.current) throw new Error('Another recovery is in progress.');
    locked.current = true; setRestoring(true);
    try {
      const value = loaded ? replacementDocument(current.current, next, label, importHistory) : next;
      if (!(await persist(value))) throw new Error('Could not save the restored data. Your current data has not been replaced.');
      current.current = value;
      setDocument(value); setLoadError(null); setLoaded(true);
    } finally { locked.current = false; setRestoring(false); }
  }, [loaded, persist]);

  const restore = useCallback((recordId) => {
    const value = restoreHistory(current.current, recordId, { id: `${Date.now()}-${++id.current}` });
    return replace(value, value.history[0].label);
  }, [replace]);

  return { document, data: document.data, history: document.history, loaded, loadError, saveError, savedAt, saving, restoring,
    load, update, setField, replace, restore, recovery: () => repo.current.recovery(), retrySave: () => persist(current.current) };
}
