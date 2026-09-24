import AsyncStorage from '@react-native-async-storage/async-storage';
import { cacheGet, cachePut, enqueue, isOfflineEnabled, isQueueablePost, offlineOperationsBusy, allOutboxCounts } from './offline';

const DOMAIN_KEY = 'zacod_server_domain';
const TOKEN_KEY = 'zacod_token';
const TOKEN_DOMAIN_KEY = 'zacod_token_domain';
const CENTRAL_DOMAIN = 'zacoderp.com';
let cachedDomain: string | null = null;
let cachedToken: string | null = null;
let tokenLoaded = false;
let generation = 0;
let switching = false;
const active = new Set<AbortController>();
let onSessionExpired: (() => void) | null = null;
let writes: Promise<unknown> = Promise.resolve();
const serialize = (work: () => Promise<void>): Promise<void> => {
  const next = writes.then(work, work);
  writes = next.catch(() => {});
  return next;
};

export function defaultDomain(): string {
  const configured = process.env.EXPO_PUBLIC_DOMAIN?.trim();
  if (!configured) return CENTRAL_DOMAIN;
  try { return normalizeDomain(configured); }
  catch { throw new Error('نطاق الخادم المضمّن في البناء غير صالح'); }
}

/** Only HTTPS website hosts are supported; a pasted website path is intentionally discarded. */
export function normalizeDomain(input: string): string {
  const value = input.trim();
  if (!value) return defaultDomain();
  if (/[\s\\]/.test(value) || /^(?!https?:\/\/)[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    throw new Error('أدخل نطاق خادم صحيحاً بدون مسافات أو بيانات دخول');
  }
  if (/^http:\/\//i.test(value)) throw new Error('الخادم يجب أن يستخدم HTTPS');
  const url = new URL(/^https:\/\//i.test(value) ? value : `https://${value}`);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) {
    throw new Error('أدخل نطاق HTTPS صحيحاً بدون منفذ أو بيانات دخول');
  }
  return host;
}

export async function getDomain(): Promise<string> {
  if (cachedDomain !== null) return cachedDomain;
  const stored = await AsyncStorage.getItem(DOMAIN_KEY);
  if (cachedDomain !== null) return cachedDomain;
  try { cachedDomain = normalizeDomain(stored ?? ''); }
  catch { throw new Error('نطاق الخادم المحفوظ غير صالح — صححه من إعدادات الخادم'); }
  return cachedDomain;
}

export function sessionGeneration(): number { return generation; }
export function isCurrentSession(snapshot: number): boolean { return !switching && snapshot === generation; }
export function registerSessionExpired(listener: (() => void) | null): void { onSessionExpired = listener; }

export async function getToken(): Promise<string | null> {
  const domain = await getDomain();
  if (tokenLoaded) return cachedToken;
  const snapshot = generation;
  const [token, bound] = await Promise.all([
    AsyncStorage.getItem(TOKEN_KEY), AsyncStorage.getItem(TOKEN_DOMAIN_KEY),
  ]);
  if (snapshot !== generation) return cachedToken;
  // Legacy unbound sessions are valid ONLY on the original central server,
  // never on a preview or branded build's injected default.
  cachedToken = token && (bound === domain || (!bound && domain === CENTRAL_DOMAIN)) ? token : null;
  tokenLoaded = true;
  return cachedToken;
}

export async function setToken(token: string | null, expected = generation): Promise<boolean> {
  if (!isCurrentSession(expected)) return false;
  const domain = await getDomain();
  if (!isCurrentSession(expected)) return false;
  generation++;
  cachedToken = token;
  tokenLoaded = true;
  const issued = generation;
  await serialize(async () => {
    if (issued !== generation) return;
    if (token) await AsyncStorage.multiSet([[TOKEN_KEY, token], [TOKEN_DOMAIN_KEY, domain]]);
    else await AsyncStorage.multiRemove([TOKEN_KEY, TOKEN_DOMAIN_KEY]);
  });
  return issued === generation;
}

/** Invalidate every request before changing servers or ending a session. */
export function invalidateRequests(): void {
  generation++;
  for (const controller of active) controller.abort();
  active.clear();
  cachedToken = null;
  tokenLoaded = true;
}

/** Called only after a successful public probe and an empty outbox check. */
export async function setDomain(domain: string): Promise<void> {
  const clean = normalizeDomain(domain);
  if (clean === cachedDomain) return;
  // An invalid value saved by an older app version can still be repaired here.
  try { await getDomain(); } catch { /* explicitly validated replacement below */ }
  const counts = await allOutboxCounts();
  if (offlineOperationsBusy() || counts.pending || counts.failed) {
    throw new Error('زامن الصادر وراجع العمليات الفاشلة على الخادم الحالي قبل تبديل الخادم.');
  }
  if (clean === cachedDomain) return;
  switching = true;
  invalidateRequests();
  try {
    await serialize(async () => {
      await AsyncStorage.multiRemove([TOKEN_KEY, TOKEN_DOMAIN_KEY]);
      if (clean === defaultDomain()) await AsyncStorage.removeItem(DOMAIN_KEY);
      else await AsyncStorage.setItem(DOMAIN_KEY, clean);
    });
    cachedDomain = clean;
  } finally {
    switching = false;
  }
}

/** Public, unauthenticated endpoint. Never use /api/health (it requires auth). */
export async function probeDomain(domain: string): Promise<void> {
  const host = normalizeDomain(domain);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`https://${host}/api/branding`, {
      headers: { 'x-app-channel': 'mobile' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`تعذّر التحقق من الخادم (${response.status})`);
    const branding = await response.json();
    if (!branding || typeof branding.isAgentDomain !== 'boolean') {
      throw new Error('استجابة الخادم غير صالحة');
    }
  } catch (e: any) {
    throw new Error(e?.name === 'AbortError' ? 'انتهت مهلة الاتصال بالخادم' : e?.message ?? 'تعذّر الاتصال بالخادم');
  } finally { clearTimeout(timer); }
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

// Never put the bearer itself into an AsyncStorage key.
function cacheScope(domain: string, token: string): string {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i++) hash = Math.imul(hash ^ token.charCodeAt(i), 16777619);
  return `${domain}:${(hash >>> 0).toString(16)}`;
}

export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const snapshot = generation;
  const domain = await getDomain();
  const token = await getToken();
  const current = () => isCurrentSession(snapshot);
  if (!current()) throw new ApiError('تغيّر الخادم أو انتهت الجلسة — أعد المحاولة', 0);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-app-channel': 'mobile' };
  if (token && !path.startsWith('/api/auth/login')) headers.Authorization = `Bearer ${token}`;
  const method = init?.method ?? 'GET';
  const ctrl = new AbortController();
  active.add(ctrl);
  let res: Response;
  try {
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    try {
      res = await fetch(`https://${domain}${path}`, {
        method, headers,
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: ctrl.signal,
      });
    } finally { clearTimeout(timer); }
  } catch {
    if (!current()) throw new ApiError('تغيّر الخادم أو انتهت الجلسة — أعد المحاولة', 0);
    if (await isOfflineEnabled()) {
      if (!current()) throw new ApiError('تغيّر الخادم أو انتهت الجلسة — أعد المحاولة', 0);
      if (method === 'GET' && token) {
        const c = await cacheGet(cacheScope(domain, token), path);
        if (current() && c.hit) return c.data as T;
      } else if (token && isQueueablePost(path, method)) {
        const entry = await enqueue(domain, path, method, init?.body);
        if (current()) return { id: null, offline: true, queuedId: entry.id, message: 'حُفظت العملية محلياً وستُزامن عند عودة الاتصال' } as T;
      }
    }
    throw new ApiError('تعذّر الاتصال بالخادم — تأكد من الإنترنت', 0);
  } finally { active.delete(ctrl); }
  if (!current()) throw new ApiError('تغيّر الخادم أو انتهت الجلسة — أعد المحاولة', 0);
  const text = await res.text();
  if (!current()) throw new ApiError('تغيّر الخادم أو انتهت الجلسة — أعد المحاولة', 0);
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* invalid JSON handled below */ }
  if (!res.ok) {
    if (method === 'GET' && res.status >= 500 && token && await isOfflineEnabled()) {
      const c = await cacheGet(cacheScope(domain, token), path);
      if (current() && c.hit) return c.data as T;
    }
    if (res.status === 401 && !path.startsWith('/api/auth/login') && token && current()) {
      if (await setToken(null, snapshot)) onSessionExpired?.();
    }
    throw new ApiError(String(data?.error || data?.message ||
      (res.status === 401 ? 'انتهت الجلسة — سجّل الدخول مجدداً' : `خطأ من الخادم (${res.status})`)), res.status);
  }
  if (method === 'GET' && token && await isOfflineEnabled() && current()) {
    await cachePut(cacheScope(domain, token), path, data);
  }
  if (!current()) throw new ApiError('تغيّر الخادم أو انتهت الجلسة — أعد المحاولة', 0);
  return data as T;
}