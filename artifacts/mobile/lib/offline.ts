import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * وضع الأوف لاين — offline-first layer.
 *
 * عند التفعيل: يُنزّل التطبيق كامل بيانات الشركة (أصناف، عملاء، خزن، بنوك،
 * فروع، مخازن، عملات، فواتير، مرتجعات، سندات) ويخزنها في AsyncStorage.
 * عند انقطاع النت:
 *   - قراءات GET تُخدم من النسخة المحلية.
 *   - إنشاء الفواتير/السندات/العملاء يدخل «صندوق الصادر» (outbox).
 * عند عودة النت: syncOutbox() يرسل العمليات المعلقة بالترتيب.
 *
 * العزل: كل مفاتيح الكاش والصادر تتضمن نطاق الخادم (domain) والمسار الكامل
 * بما فيه companyId — فلا تختلط بيانات شركة/سيرفر بأخرى على نفس الجهاز.
 */

const ENABLED_KEY = 'zacod_offline_enabled';
const CACHE_PREFIX = 'zacod_offline_cache:'; // + <domain>:<full path incl. query>
const OUTBOX_PREFIX = 'zacod_offline_outbox:'; // + <domain>
const LAST_SYNC_PREFIX = 'zacod_offline_last_download:'; // + <domain>

// المسارات المخزنة محلياً (تُطابَق بالبادئة بعد إزالة الـ query)
const CACHED_GETS = [
  '/api/inventory/items',
  '/api/inventory/units',
  '/api/inventory/item-groups',
  '/api/inventory/warehouses',
  '/api/customers',
  '/api/cash-boxes',
  '/api/bank-accounts',
  '/api/org/branches',
  '/api/currencies',
  '/api/sales/sales-invoices',
  '/api/sales/sales-returns',
  '/api/receipt-vouchers',
];

// المسارات المسموح إدخالها في صندوق الصادر عند انقطاع النت
const QUEUEABLE_POSTS = [
  '/api/sales/sales-invoices',
  '/api/receipt-vouchers',
  '/api/customers',
];

let enabledCache: boolean | null = null;

export async function isOfflineEnabled(): Promise<boolean> {
  if (enabledCache !== null) return enabledCache;
  enabledCache = (await AsyncStorage.getItem(ENABLED_KEY)) === '1';
  return enabledCache;
}

export async function setOfflineEnabled(on: boolean): Promise<void> {
  enabledCache = on;
  if (on) await AsyncStorage.setItem(ENABLED_KEY, '1');
  else {
    await AsyncStorage.removeItem(ENABLED_KEY);
    // إيقاف الوضع لا يمسح الصادر المعلق — فقط النسخ المخزنة
    const keys = await AsyncStorage.getAllKeys();
    await AsyncStorage.multiRemove(keys.filter((k) => k.startsWith(CACHE_PREFIX) || k.startsWith(LAST_SYNC_PREFIX)));
  }
}

/** مسح كل بيانات الأوف لاين (يُستدعى عند تسجيل الخروج — أمان تعدد المستخدمين) */
export async function clearAllOfflineData(): Promise<void> {
  enabledCache = false;
  const keys = await AsyncStorage.getAllKeys();
  await AsyncStorage.multiRemove(
    keys.filter((k) => k === ENABLED_KEY || k.startsWith(CACHE_PREFIX) || k.startsWith(OUTBOX_PREFIX) || k.startsWith(LAST_SYNC_PREFIX)),
  );
}

const isCacheablePath = (path: string): boolean => {
  const clean = path.split('?')[0].replace(/\/+$/, '');
  // مطابقة تامة للقوائم فقط (وليس /:id) حتى لا نعيد قائمة بدل مستند
  return CACHED_GETS.includes(clean);
};

// المفتاح = النطاق + المسار النظيف + companyId فقط.
// نطبّع الـ query إلى companyId وحده حتى تتطابق طلبات نفس القائمة رغم اختلاف
// بقية البارامترات (مثل includeHidden=1 في شاشة الفاتورة) — كان اختلافها يسبب
// عدم ظهور الأصناف في وضع الأوف لاين. عزل الشركات محفوظ لأن companyId جزء من المفتاح.
const cacheKeyFor = (scope: string, path: string): string | null => {
  if (!isCacheablePath(path)) return null;
  const [rawPath, rawQuery = ''] = path.split('?');
  const clean = rawPath.replace(/\/+$/, '');
  // نحذف فقط البارامترات «التجميلية» التي لا تغيّر دلالة الاستجابة
  // (includeHidden) ونرتّب الباقي — حتى تتطابق طلبات نفس القائمة مع اختلاف
  // includeHidden دون أن تتداخل قوائم مفلترة مختلفة (مثل salesInvoiceId) في
  // سجل تخزين واحد. companyId يبقى ضمن المفتاح فيُحفظ عزل الشركات.
  const kept = rawQuery
    .split('&')
    .filter((p) => p && !p.startsWith('includeHidden='))
    .sort();
  return `${CACHE_PREFIX}${scope}:${clean}?${kept.join('&')}`;
};

export async function cachePut(scope: string, path: string, data: unknown): Promise<void> {
  const key = cacheKeyFor(scope, path);
  if (!key) return;
  try { await AsyncStorage.setItem(key, JSON.stringify(data ?? null)); } catch { /* التخزين ممتلئ — نتجاهل */ }
}

export async function cacheGet(scope: string, path: string): Promise<{ hit: boolean; data: unknown }> {
  const key = cacheKeyFor(scope, path);
  if (!key) return { hit: false, data: null };
  const raw = await AsyncStorage.getItem(key);
  if (raw == null) return { hit: false, data: null };
  try { return { hit: true, data: JSON.parse(raw) }; } catch { return { hit: false, data: null }; }
}

// ─── التنزيل الكامل الأولي ───────────────────────────────────────────────
// الكاش يتحدث تلقائياً داخل api() عند نجاح أي GET — هنا نكتفي بطلب القوائم.
export async function downloadAll(
  scope: string,
  companyId: number,
  fetcher: <T>(path: string) => Promise<T>,
): Promise<{ ok: number; failed: string[] }> {
  const failed: string[] = [];
  let ok = 0;
  for (const base of CACHED_GETS) {
    try {
      // الأصناف تُنزَّل شاملة المخفية من POS — الويب/الموبايل يطلبها بهذا الشكل
      const extra = base === '/api/inventory/items' ? '&includeHidden=1' : '';
      await fetcher(`${base}?companyId=${companyId}${extra}`);
      ok++;
    } catch {
      failed.push(base);
    }
  }
  await AsyncStorage.setItem(LAST_SYNC_PREFIX + scope, new Date().toISOString());
  return { ok, failed };
}

export async function lastDownloadAt(scope: string): Promise<string | null> {
  return AsyncStorage.getItem(LAST_SYNC_PREFIX + scope);
}

// ─── صندوق الصادر ─────────────────────────────────────────────────────────
export interface OutboxEntry {
  id: string; // معرف محلي فريد — يُرسل أيضاً ضمن الجسم (offlineOpId)
  path: string;
  method: string;
  body: unknown;
  createdAt: string;
  tries: number;
  failed?: boolean; // فشل دائم بعد 5 محاولات — يبقى للمراجعة اليدوية
  lastError?: string;
}

export function isQueueablePost(path: string, method: string): boolean {
  if (method !== 'POST') return false;
  const clean = path.split('?')[0].replace(/\/+$/, '');
  return QUEUEABLE_POSTS.includes(clean);
}

async function readOutbox(scope: string): Promise<OutboxEntry[]> {
  const raw = await AsyncStorage.getItem(OUTBOX_PREFIX + scope);
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

async function writeOutbox(scope: string, entries: OutboxEntry[]): Promise<void> {
  await AsyncStorage.setItem(OUTBOX_PREFIX + scope, JSON.stringify(entries));
}

export async function enqueue(scope: string, path: string, method: string, body: unknown): Promise<OutboxEntry> {
  const id = `ob-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  // يُضاف معرف العملية للجسم — يفيد التتبع وأي إلغاء تكرار مستقبلي بالخادم
  const bodyWithOp = body && typeof body === 'object' ? { ...(body as object), offlineOpId: id } : body;
  const entry: OutboxEntry = { id, path, method, body: bodyWithOp, createdAt: new Date().toISOString(), tries: 0 };
  const list = await readOutbox(scope);
  list.push(entry);
  await writeOutbox(scope, list);
  return entry;
}

/**
 * العمليات المعلقة (غير الفاشلة) لمسار معيّن — تُدمج في شاشات القوائم حتى
 * تظهر الإضافات التي تمت أوف لاين فوراً بدل أن «تختفي» حتى عودة الاتصال.
 */
export async function pendingOutboxFor(scope: string, basePath: string): Promise<OutboxEntry[]> {
  const list = await readOutbox(scope);
  return list.filter((e) => {
    if (e.failed) return false;
    const clean = e.path.split('?')[0].replace(/\/+$/, '');
    return clean === basePath;
  });
}

export async function outboxCounts(scope: string): Promise<{ pending: number; failed: number }> {
  const list = await readOutbox(scope);
  const failed = list.filter((e) => e.failed).length;
  return { pending: list.length - failed, failed };
}

/** حذف العمليات الفاشلة نهائياً (قرار يدوي من المستخدم فقط) */
export async function discardFailed(scope: string): Promise<void> {
  const list = await readOutbox(scope);
  await writeOutbox(scope, list.filter((e) => !e.failed));
}

let syncInFlight = false;

/**
 * إرسال العمليات المعلقة بالترتيب (الأقدم أولاً). يتوقف عند أول فشل شبكة؛
 * أخطاء السيرفر (4xx/5xx) تُسجَّل وبعد 5 محاولات تُعلَّم «فاشلة» وتبقى
 * محفوظة للمراجعة — لا تُحذف أي عملية مالية تلقائياً أبداً.
 */
export async function syncOutbox(
  scope: string,
  fetcher: <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>,
): Promise<{ sent: number; remaining: number; failed: number }> {
  const counts = async () => {
    const c = await outboxCounts(scope);
    return c;
  };
  if (syncInFlight) { const c = await counts(); return { sent: 0, remaining: c.pending, failed: c.failed }; }
  syncInFlight = true;
  let sent = 0;
  try {
    const list = await readOutbox(scope);
    const keep: OutboxEntry[] = [];
    let networkDown = false;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.failed || networkDown) { keep.push(e); continue; }
      try {
        await fetcher(e.path, { method: e.method, body: e.body });
        sent++;
      } catch (err: any) {
        if (err?.status === 0) {
          // انقطاع شبكة — أبقِ الكل وحاول لاحقاً
          networkDown = true;
          keep.push(e);
        } else {
          const tries = (e.tries ?? 0) + 1;
          keep.push({ ...e, tries, failed: tries >= 5, lastError: String(err?.message ?? err) });
        }
      }
    }
    // دمج قبل الحفظ: قد تُضاف عمليات جديدة أثناء المزامنة (خصوصاً مع مهلة 12ث)
    // — الكتابة المباشرة لقائمة keep كانت ستمحوها. نعيد القراءة ونضم أي إدخال
    // جديد لم يكن ضمن اللقطة الأصلية حتى لا تُفقد أي عملية مالية أبداً.
    const snapshotIds = new Set(list.map((e) => e.id));
    const fresh = await readOutbox(scope);
    const merged = [...keep, ...fresh.filter((e) => !snapshotIds.has(e.id))];
    await writeOutbox(scope, merged);
    const failed = merged.filter((k) => k.failed).length;
    return { sent, remaining: merged.length - failed, failed };
  } finally {
    syncInFlight = false;
  }
}
