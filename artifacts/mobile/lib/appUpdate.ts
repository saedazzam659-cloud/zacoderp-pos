import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { api } from './api';

/**
 * Forced-update gate — mirrors the "افتح التطبيق → حدّث أولاً" pattern.
 * The server row (mobile_app_releases, managed from إدارة أجهزة POS ←
 * الإصدارات) carries minVersion + latestVersion + downloadUrl per
 * platform. If the installed version < minVersion the app blocks until
 * the user updates. Any network/endpoint failure FAILS OPEN (app works
 * normally) — an update gate must never brick the app offline.
 */

export type MobileAppRelease = {
  platform: string;
  latestVersion: string;
  minVersion: string;
  downloadUrl: string;
};

export function currentAppVersion(): string {
  return Constants.expoConfig?.version ?? '1.0.0';
}

/** numeric dotted compare: -1 | 0 | 1 (non-numeric segments treated as 0) */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((s) => parseInt(s, 10) || 0);
  const pb = b.split('.').map((s) => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export type UpdateCheck =
  | { required: false }
  | { required: true; latestVersion: string; downloadUrl: string };

export async function checkForcedUpdate(): Promise<UpdateCheck> {
  try {
    const rows = await api<MobileAppRelease[]>('/api/public/download/mobile-apps');
    const mine = Array.isArray(rows)
      ? rows.find((r) => r.platform === (Platform.OS === 'ios' ? 'ios' : 'android'))
      : undefined;
    if (!mine || !mine.minVersion || !mine.downloadUrl) return { required: false };
    if (compareVersions(currentAppVersion(), mine.minVersion) < 0) {
      return { required: true, latestVersion: mine.latestVersion, downloadUrl: mine.downloadUrl };
    }
    return { required: false };
  } catch {
    // fail-open: offline / server unreachable must never block the app
    return { required: false };
  }
}
