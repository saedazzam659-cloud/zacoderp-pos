// Central catalogue of every Arabic phrase the voice assistant should
// recognise, plus its target route or generic verb. The same map is fed to
// the Anthropic intent parser as the canonical "menu" so the model can pick
// from a known list instead of hallucinating routes.
//
// Two kinds of entries:
//
//  1. Route entries — `{ route: "/sales", phrases: ["المبيعات", ...] }`
//     The widget navigates the user to that path.
//
//  2. Verb entries — `{ verb: "save", phrases: ["احفظ", ...] }`
//     The widget triggers the corresponding browser action:
//        - save    → click `[data-voice="save"]`
//        - cancel  → click `[data-voice="cancel"]` then ESC
//        - new     → click `[data-voice="new"]`
//        - back    → window.history.back()
//        - home    → navigate to "/"
//        - logout  → POST /api/auth/logout then redirect to /login
//        - search  → focus first `[data-voice="search"]` or `<input type="search">`
//        - reload  → window.location.reload()
//
// Adding a new screen? Add one entry below — that's it. Both the offline
// matcher and the AI prompt automatically pick it up.

export interface VoiceRouteEntry {
  kind: "route";
  route: string;
  label: string;          // short Arabic label for toast/UI
  phrases: string[];      // Arabic variants the user might say
}

export interface VoiceVerbEntry {
  kind: "verb";
  verb: "save" | "cancel" | "new" | "back" | "home" | "logout" | "search" | "reload";
  label: string;
  phrases: string[];
}

export type VoiceEntry = VoiceRouteEntry | VoiceVerbEntry;

// ─── Routes ───────────────────────────────────────────────────────────────────
export const VOICE_ROUTES: VoiceRouteEntry[] = [
  // Dashboard / home
  { kind: "route", route: "/",                       label: "الرئيسية",                  phrases: ["الرئيسية", "الصفحة الرئيسية", "لوحة التحكم", "الواجهة"] },
  { kind: "route", route: "/control-panel",          label: "لوحة التحكم",               phrases: ["لوحة التحكم الكاملة"] },

  // ZATCA & e-invoicing
  { kind: "route", route: "/zatca",                  label: "ربط زاتكا",                 phrases: ["ربط زاتكا", "زاتكا", "الفاتورة الإلكترونية", "ربط ZATCA"] },
  { kind: "route", route: "/invoices",               label: "الفواتير الإلكترونية",      phrases: ["الفواتير الإلكترونية", "الفواتير المرسلة"] },

  // Sales
  { kind: "route", route: "/sales",                  label: "المبيعات",                  phrases: ["المبيعات", "شاشة المبيعات", "صفحة المبيعات"] },
  { kind: "route", route: "/sales/invoices",         label: "فواتير المبيعات",           phrases: ["فواتير المبيعات", "قائمة فواتير المبيعات", "كل فواتير المبيعات"] },
  { kind: "route", route: "/sales/invoices/new",     label: "فاتورة مبيعات جديدة",       phrases: ["فاتورة مبيعات جديدة", "فاتورة جديدة", "إنشاء فاتورة", "أضف فاتورة", "افتح فاتورة جديدة", "افتح فاتورة"] },
  { kind: "route", route: "/sales/quotations",       label: "عروض الأسعار",              phrases: ["عروض الأسعار", "عروض السعر"] },
  { kind: "route", route: "/sales/returns",          label: "مرتجعات المبيعات",          phrases: ["مرتجعات المبيعات", "مرتجع مبيعات"] },
  { kind: "route", route: "/customers",              label: "العملاء",                   phrases: ["العملاء", "قائمة العملاء", "عميل جديد", "إدارة العملاء"] },

  // Purchasing
  { kind: "route", route: "/purchasing",             label: "المشتريات",                 phrases: ["المشتريات", "شاشة المشتريات"] },
  { kind: "route", route: "/purchasing/invoices",    label: "فواتير المشتريات",          phrases: ["فواتير المشتريات"] },
  { kind: "route", route: "/purchasing/invoices/new", label: "فاتورة مشتريات جديدة",     phrases: ["فاتورة مشتريات جديدة", "إضافة فاتورة مشتريات"] },
  { kind: "route", route: "/suppliers",              label: "الموردون",                  phrases: ["الموردون", "الموردين", "قائمة الموردين"] },

  // Inventory
  { kind: "route", route: "/inventory",              label: "المخزون",                   phrases: ["المخزون", "شاشة المخزون", "إدارة المخزون"] },
  { kind: "route", route: "/inventory/items",        label: "الأصناف",                   phrases: ["الأصناف", "الأصناف والمنتجات", "المنتجات", "صنف جديد"] },
  { kind: "route", route: "/inventory/warehouses",   label: "المستودعات",                phrases: ["المستودعات", "المخازن"] },

  // Cash / banks
  { kind: "route", route: "/cash",                   label: "الخزينة",                   phrases: ["الخزينة", "الخزائن", "النقدية", "البنوك"] },
  { kind: "route", route: "/cash/receipts",          label: "سندات القبض",               phrases: ["سندات القبض", "سند قبض"] },
  { kind: "route", route: "/cash/payments",          label: "سندات الصرف",               phrases: ["سندات الصرف", "سند صرف"] },

  // Accounting
  { kind: "route", route: "/accounting",             label: "المحاسبة",                  phrases: ["المحاسبة", "النظام المحاسبي"] },
  { kind: "route", route: "/accounting/journals",    label: "القيود اليومية",            phrases: ["القيود", "القيود اليومية", "اليومية", "قيد جديد"] },
  { kind: "route", route: "/accounting/accounts",    label: "شجرة الحسابات",             phrases: ["شجرة الحسابات", "الحسابات"] },
  { kind: "route", route: "/accounting/reports",     label: "التقارير المحاسبية",        phrases: ["التقارير المحاسبية", "تقارير المحاسبة"] },
  { kind: "route", route: "/vat-declaration",        label: "إقرار ضريبة القيمة المضافة", phrases: ["إقرار الضريبة", "إقرار القيمة المضافة", "ضريبة القيمة المضافة"] },

  // HR
  { kind: "route", route: "/hr",                     label: "الموارد البشرية",           phrases: ["الموارد البشرية", "الموظفون", "شؤون الموظفين"] },

  // Settings & admin
  { kind: "route", route: "/general-settings",       label: "الإعدادات العامة",          phrases: ["الإعدادات", "الإعدادات العامة", "إعدادات النظام"] },
  { kind: "route", route: "/users",                  label: "المستخدمون",                phrases: ["المستخدمون", "إدارة المستخدمين", "صلاحيات المستخدمين"] },
  { kind: "route", route: "/work-sessions",          label: "جلسات العمل",               phrases: ["جلسات العمل", "الجلسات", "سجل الجلسات"] },
  { kind: "route", route: "/voice-assistant/settings", label: "إعدادات المساعد الصوتي",  phrases: ["إعدادات المساعد الصوتي", "إعدادات المايك", "إعدادات الصوت"] },
];

// ─── Verbs ────────────────────────────────────────────────────────────────────
export const VOICE_VERBS: VoiceVerbEntry[] = [
  { kind: "verb", verb: "save",   label: "حفظ",   phrases: ["احفظ", "حفظ", "خزن", "اعتمد"] },
  { kind: "verb", verb: "cancel", label: "إلغاء", phrases: ["الغ", "إلغاء", "خروج", "اخرج", "اغلق", "أغلق", "اقفل النافذة"] },
  { kind: "verb", verb: "new",    label: "جديد",  phrases: ["جديد", "أضف جديد", "إضافة جديد", "زر جديد"] },
  { kind: "verb", verb: "back",   label: "رجوع",  phrases: ["رجوع", "ارجع", "السابق", "للوراء"] },
  { kind: "verb", verb: "home",   label: "الرئيسية", phrases: ["الرئيسية فقط", "ارجع للرئيسية", "الصفحة الأولى"] },
  { kind: "verb", verb: "logout", label: "تسجيل خروج", phrases: ["تسجيل خروج", "خروج من النظام", "سجل خروج", "اقفل النظام"] },
  { kind: "verb", verb: "search", label: "بحث",   phrases: ["بحث", "ابحث", "افتح البحث", "ابحث عن"] },
  { kind: "verb", verb: "reload", label: "تحديث", phrases: ["حدث الصفحة", "اعد تحميل", "ريفرش", "تحديث"] },
];

export const VOICE_ENTRIES: VoiceEntry[] = [...VOICE_ROUTES, ...VOICE_VERBS];

// ─── Offline matcher ─────────────────────────────────────────────────────────
//
// Try to resolve the transcript against the static catalogue without bothering
// the AI. Saves a round-trip on common commands and works even when the
// network is slow.
//
// Algorithm: normalise both sides (lowercase, strip Arabic diacritics, collapse
// whitespace, drop common filler verbs like "افتح/اذهب الى/انتقل الى"), then
// look for a phrase that is included in the transcript or that the transcript
// equals after normalisation.
const FILLERS = [
  "من فضلك", "لو سمحت", "رجاء", "رجاءً",
  "افتح لي", "افتح", "اذهب الى", "اذهب إلى", "انتقل الى", "انتقل إلى",
  "روح الى", "روح إلى", "ودني", "خذني الى", "خذني إلى",
  "اعرض", "ورني", "ورنى", "اعطني", "أرني", "أعطني",
  "صفحة", "شاشة", "قائمة",
];

function normalise(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    // Remove Arabic diacritics (tashkeel)
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    // Normalise alif variants → bare alif
    .replace(/[\u0622\u0623\u0625]/g, "\u0627")
    // Normalise yaa / alif maqsura
    .replace(/\u0649/g, "\u064A")
    // Normalise taa marbuta → haa
    .replace(/\u0629/g, "\u0647")
    .replace(/\s+/g, " ")
    .trim();
}

function stripFillers(s: string): string {
  let out = s;
  for (const f of FILLERS) {
    const n = normalise(f);
    out = out.replaceAll(n, " ");
  }
  return out.replace(/\s+/g, " ").trim();
}

export interface MatchResult {
  entry: VoiceEntry;
  matchedPhrase: string;
  exact: boolean;
}

export function matchOffline(transcript: string): MatchResult | null {
  const tNorm  = normalise(transcript);
  const tCore  = stripFillers(tNorm);
  if (!tNorm) return null;

  let best: MatchResult | null = null;

  for (const entry of VOICE_ENTRIES) {
    for (const phrase of entry.phrases) {
      const p = normalise(phrase);
      if (!p) continue;
      // Exact (after fillers) wins immediately.
      if (tCore === p || tNorm === p) {
        return { entry, matchedPhrase: phrase, exact: true };
      }
      // Otherwise prefer longest containment match.
      if (tNorm.includes(p) || tCore.includes(p)) {
        if (!best || p.length > normalise(best.matchedPhrase).length) {
          best = { entry, matchedPhrase: phrase, exact: false };
        }
      }
    }
  }
  return best;
}

// ─── Types shared with the API ───────────────────────────────────────────────
//
// What /parse-command returns. The widget consumes this to perform the action.
export interface ParsedCommand {
  kind:        "navigate" | "verb" | "unknown";
  route?:      string;
  verb?:       VoiceVerbEntry["verb"];
  label?:      string;          // short Arabic feedback ("فتح المبيعات")
  confidence?: number;          // 0..100
  source:      "offline" | "ai";
  reason?:     string;          // human-readable when kind === "unknown"
}
