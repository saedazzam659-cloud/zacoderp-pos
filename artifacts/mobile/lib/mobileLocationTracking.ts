import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { getMobileTrackingStatus, recordMobileLocation } from '@workspace/api-client-react';
import { getToken } from '@/lib/api';

export const MOBILE_LOCATION_TASK = 'zacod-mobile-live-location-v1';

if (!TaskManager.isTaskDefined(MOBILE_LOCATION_TASK)) {
  TaskManager.defineTask(MOBILE_LOCATION_TASK, async ({ data, error }) => {
    if (error || !data) return;
    const locations = (data as { locations?: Location.LocationObject[] }).locations ?? [];
    const token = await getToken();
    if (!token) return;
    const status = await getMobileTrackingStatus().catch(() => null);
    if (status && !status.enabled) {
      await stopMobileLocationTracking();
      return;
    }
    for (const location of locations) {
      try {
        await recordMobileLocation({
          lat: location.coords.latitude,
          lng: location.coords.longitude,
          accuracy: location.coords.accuracy,
        });
      } catch { /* the next OS location batch retries naturally */ }
    }
  });
}

export async function mobileTrackingEnabled(): Promise<boolean> {
  const result = await getMobileTrackingStatus();
  return result.enabled === true;
}

export async function startMobileLocationTracking(): Promise<void> {
  if (!(await Location.hasServicesEnabledAsync())) throw new Error('فعّل خدمة الموقع (GPS) من إعدادات الهاتف.');
  const foreground = await Location.getForegroundPermissionsAsync();
  if (!foreground.granted) throw new Error('يلزم السماح للتطبيق باستخدام موقعك أثناء العمل.');
  const background = await Location.getBackgroundPermissionsAsync();
  if (!background.granted) throw new Error('يلزم السماح بالوصول إلى الموقع في الخلفية لاستمرار التتبع أثناء العمل.');
  const alreadyStarted = await Location.hasStartedLocationUpdatesAsync(MOBILE_LOCATION_TASK);
  if (alreadyStarted) return;
  await Location.startLocationUpdatesAsync(MOBILE_LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 60_000,
    distanceInterval: 75,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'الرقابة المباشرة مفعّلة',
      notificationBody: 'يُشارك موقعك مع مديرك خلال جلسة العمل فقط.',
      notificationColor: '#167d69',
    },
  });
}

export async function stopMobileLocationTracking(): Promise<void> {
  try {
    if (await Location.hasStartedLocationUpdatesAsync(MOBILE_LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(MOBILE_LOCATION_TASK);
    }
  } catch { /* task may already have been stopped by the operating system */ }
}
