import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
const { planReminders, createReminderScheduler } = require('./reminder-plan');

Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }) });
const synchronize = createReminderScheduler(Notifications);
const TEST_IDENTIFIER = 'custody-reminder-test';
function allowed(permission) {
  return permission.granted || permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
}

export function useReminders(data, loaded, onOpen) {
  const [status, setStatus] = useState({ count: 0, error: null, permission: null, working: false });
  const [refresh, setRefresh] = useState(0);
  const latest = useRef(onOpen); latest.current = onOpen;
  const sequence = useRef(0);
  const plan = useMemo(() => data.reminderSettings.enabled ? planReminders(data) : { notifications: [], missingTimes: 0, conflicts: 0, total: 0 }, [data.entries, data.parents, data.children, data.reminderSettings, refresh]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') setRefresh((v) => v + 1); });
    const timer = setInterval(() => setRefresh((v) => v + 1), 60000);
    return () => { subscription.remove(); clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const open = (response) => {
      const detail = response?.notification.request.content.data;
      if (detail?.kind === 'custody-exchange') {
        latest.current?.(detail.date);
        Notifications.clearLastNotificationResponseAsync().catch(() => {});
      }
    };
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    Notifications.getLastNotificationResponseAsync().then(open).catch(() => {});
    return () => subscription.remove();
  }, [loaded]);

  useEffect(() => {
    if (!loaded) return;
    const version = ++sequence.current;
    const run = async () => {
      setStatus((s) => ({ ...s, working: true }));
      try {
        const permission = await Notifications.getPermissionsAsync();
        if (version !== sequence.current) return;
        if (!data.reminderSettings.enabled) await Notifications.cancelScheduledNotificationAsync(TEST_IDENTIFIER);
        const count = await synchronize(data.reminderSettings.enabled && allowed(permission) ? plan.notifications : []);
        if (version === sequence.current) setStatus({ count, permission: allowed(permission), error: null, working: false });
      } catch (e) {
        if (version === sequence.current) setStatus((s) => ({ ...s, working: false, error: e.message }));
      }
    };
    run();
  }, [loaded, plan, data.reminderSettings.enabled]);

  const requestPermission = async () => {
    if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('custody-exchanges', { name: 'Exchange reminders', importance: Notifications.AndroidImportance.DEFAULT });
    const permission = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } });
    setRefresh((v) => v + 1);
    return allowed(permission);
  };
  const test = async () => {
    const permission = await Notifications.getPermissionsAsync();
    if (!allowed(permission)) throw new Error('Allow notifications in device Settings first.');
    await Notifications.scheduleNotificationAsync({
      identifier: TEST_IDENTIFIER, content: { title: 'Reminder test', body: 'Exchange reminders are ready on this device.', data: { kind: 'custody-exchange' } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 5, channelId: 'custody-exchanges' },
    });
  };
  return { ...status, ...plan, requestPermission, test, refresh: () => setRefresh((v) => v + 1) };
}
