import 'react-native-url-polyfill/auto';
import { createClient, processLock } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
const { createSecureSessionStore } = require('./secure-session-store');

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
export const sharedConfigured = Boolean(url && key && /^https:\/\//.test(url) && !url.includes('YOUR_PROJECT'));
const storage = createSecureSessionStore({
  getItemAsync: SecureStore.getItemAsync,
  setItemAsync: (name, value) => SecureStore.setItemAsync(name, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  deleteItemAsync: SecureStore.deleteItemAsync,
}, () => `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export const sharedClient = sharedConfigured ? createClient(url, key, {
  auth: { storage: Platform.OS === 'web' ? undefined : storage, persistSession: Platform.OS !== 'web', autoRefreshToken: true, detectSessionInUrl: false, lock: processLock },
}) : null;
