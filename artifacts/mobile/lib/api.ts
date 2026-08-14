import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * API access for the Zacod ERP backend.
 *
 * The mobile bundle runs OUTSIDE the Replit proxy, so all calls use an
 * absolute base URL. Default = the domain injected at build time
 * (EXPO_PUBLIC_DOMAIN). The user can override it from "المزيد ← إعدادات
 * الخادم" (stored in AsyncStorage) — this is what makes the app work with
 * agent servers / custom company domains.
 */

const DOMAIN_KEY = 'zacod_server_domain';
const TOKEN_KEY = 'zacod_token';

let cachedDomain: string | null = null;
let cachedToken: string | null = null;

export function defaultDomain(): string {
  return (process.env.EXPO_PUBLIC_DOMAIN ?? '').replace(/^https?:\/\//, '');
}

export async function getDomain(): Promise<string> {
  if (cachedDomain) return cachedDomain;
  const stored = await AsyncStorage.getItem(DOMAIN_KEY);
  cachedDomain = (stored && stored.trim()) || defaultDomain();
  return cachedDomain;
}

export async function setDomain(domain: string): Promise<void> {
  const clean = domain.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  cachedDomain = clean || defaultDomain();
  if (clean) await AsyncStorage.setItem(DOMAIN_KEY, clean);
  else await AsyncStorage.removeItem(DOMAIN_KEY);
}

export async function getToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  cachedToken = await AsyncStorage.getItem(TOKEN_KEY);
  return cachedToken;
}

export async function setToken(token: string | null): Promise<void> {
  cachedToken = token;
  if (token) await AsyncStorage.setItem(TOKEN_KEY, token);
  else await AsyncStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const domain = await getDomain();
  const token = await getToken();
  // x-app-channel lets the server route mobile documents onto their own
  // numbering series (sales_invoice_mobile / receipt_voucher_mobile) when
  // the company configured one in مسلسل الحركات.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-app-channel': 'mobile',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`https://${domain}${path}`, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError('تعذّر الاتصال بالخادم — تأكد من الإنترنت', 0);
  }

  let data: any = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }

  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/login')) {
      // stale/invalid token — clear it so the next app entry returns to login
      await setToken(null);
    }
    const msg =
      (data && (data.error || data.message)) ||
      (res.status === 401 ? 'انتهت الجلسة — سجّل الدخول مجدداً' : `خطأ من الخادم (${res.status})`);
    throw new ApiError(String(msg), res.status);
  }
  return data as T;
}
