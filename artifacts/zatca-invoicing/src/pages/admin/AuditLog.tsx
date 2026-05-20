import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useSearch } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { CsvExportInspectorBody } from "@/components/admin/CsvExportInspectorBody";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Loader2,
  ScrollText,
  ShieldAlert,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Scissors,
  Copy,
  Check,
  Link2,
  FileCode2,
  X,
  Download,
  Trash2,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const ACTION_CLS: Record<string, string> = {
  create: "bg-emerald-50 text-emerald-700 border-emerald-200",
  edit:   "bg-blue-50 text-blue-700 border-blue-200",
  delete: "bg-rose-50 text-rose-700 border-rose-200",
  post:   "bg-violet-50 text-violet-700 border-violet-200",
  export: "bg-amber-50 text-amber-800 border-amber-200",
  view:   "bg-gray-50 text-gray-700 border-gray-200",
  login:  "bg-sky-50 text-sky-700 border-sky-200",
  denied: "bg-rose-100 text-rose-800 border-rose-300",
};

const ACTION_KEYS = ["view", "create", "edit", "delete", "post", "export", "login", "logout", "denied"];

interface AuditRow {
  id: number;
  userId: number | null;
  username: string | null;
  role: string | null;
  companyId: number | null;
  module: string;
  action: string;
  method: string | null;
  path: string | null;
  entityType: string | null;
  entityId: string | null;
  statusCode: number | null;
  ip: string | null;
  userAgent: string | null;
  metadata: any;
  createdAt: string;
  // Login-location enrichment (audit-log.ts /api/audit-log). Populated
  // only for module=auth + action=login rows from the matching
  // auto-checkin visit within ±10min of createdAt; null for everything else.
  loginPlace?: string | null;
  loginAddress?: string | null;
  loginLat?: number | null;
  loginLng?: number | null;
  loginAccuracy?: number | null;
  loginZoneName?: string | null;
}

// Compact location pill used in the audit-log table (login rows only).
// Mirrors LoginLocationCell in SecurityCenter.tsx; kept local to avoid
// pulling that file in just for this small renderer. Visual tiers:
//   • zone → emerald, • place/address → indigo, • coords-only → slate.
// A "🗺" link opens Google Maps in a new tab so the reviewer can verify
// the GPS pin matches what the user reported.
function AuditLoginLocation(props: {
  place: string | null | undefined;
  address: string | null | undefined;
  lat: number | null | undefined;
  lng: number | null | undefined;
  accuracy: number | null | undefined;
  zoneName: string | null | undefined;
}) {
  const { place, address, lat, lng, accuracy, zoneName } = props;
  const hasCoords = typeof lat === "number" && typeof lng === "number";
  if (!zoneName && !place && !address && !hasCoords) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const primary = zoneName ?? place ?? address ?? `${lat!.toFixed(5)}, ${lng!.toFixed(5)}`;
  const tier = zoneName ? "zone" : (place || address) ? "place" : "coords";
  const cls =
    tier === "zone"  ? "from-emerald-50 to-teal-50 border-emerald-200 text-emerald-800" :
    tier === "place" ? "from-indigo-50 to-sky-50 border-indigo-200 text-indigo-800"   :
                       "from-slate-50 to-gray-50 border-slate-200 text-slate-700";
  const dotCls =
    tier === "zone"  ? "bg-emerald-500" :
    tier === "place" ? "bg-indigo-500"  :
                       "bg-slate-400";
  const tt: string[] = [];
  if (zoneName) tt.push(`النطاق: ${zoneName}`);
  if (place)    tt.push(`المكان: ${place}`);
  if (address)  tt.push(`العنوان: ${address}`);
  if (hasCoords) tt.push(`الإحداثيات: ${lat!.toFixed(6)}, ${lng!.toFixed(6)}`);
  if (typeof accuracy === "number") tt.push(`دقة GPS: ±${Math.round(accuracy)} م`);
  return (
    <div className="inline-flex flex-col gap-0.5 max-w-[220px]">
      <span
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-gradient-to-l border text-xs ${cls}`}
        title={tt.join("\n")}
      >
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotCls}`} aria-hidden />
        <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 21s-7-7.5-7-12a7 7 0 1114 0c0 4.5-7 12-7 12z" />
          <circle cx="12" cy="9" r="2.5" />
        </svg>
        <span className="font-medium truncate" dir="auto">{primary}</span>
      </span>
      {hasCoords && (
        <a
          href={`https://www.google.com/maps?q=${lat},${lng}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 text-[10px] font-mono text-sky-600 hover:text-sky-800 hover:underline px-2"
          title="افتح في خرائط Google"
        >
          🗺 خريطة <span className="text-slate-400">({lat!.toFixed(4)}, {lng!.toFixed(4)})</span>
        </a>
      )}
    </div>
  );
}

const PAGE_SIZE = 50;

// ─── API → UI friendly-path translator ───────────────────────────────────────
// The audit log records raw API requests (e.g. `PUT /api/sales/sales-invoices/141`),
// but managers reviewing user activity shouldn't have to understand REST or
// JSON to follow what happened. `friendlyPath` translates a (method, path)
// pair into:
//   • `label`  — short Arabic noun for what was touched (e.g. "فاتورة مبيعات #141")
//   • `href`   — the matching UI route (e.g. "/sales/invoices/141") when one
//                exists, so the cell becomes a clickable link the reviewer
//                can jump to. Falls back to the listing page for collection
//                operations (POST without an id, GET list, etc.).
//   • `mutation` — true for write methods (POST/PUT/PATCH/DELETE) so the
//                  caller can style links differently from read views.
// When no pattern matches we return `null` and the caller falls back to the
// raw `method path` rendering — the goal is "friendly when possible, never
// hides the truth".
type FriendlyPath = { label: string; href: string | null; mutation: boolean };

function friendlyPath(method: string | null, path: string | null): FriendlyPath | null {
  if (!path) return null;
  // Strip query string before matching so `/api/x?foo=bar` is treated as `/api/x`.
  const p = path.split("?")[0] ?? path;
  const m = (method || "GET").toUpperCase();
  const isWrite = m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";

  // Each entry: regex matching the API path → builder returning label + UI route.
  // `id` (group 1) is appended to the label as `#id` and to the UI href when present.
  // Ordering matters — put more specific patterns first.
  const rules: Array<{
    re: RegExp;
    noun: string;        // Arabic noun ("فاتورة مبيعات", "قيد محاسبي", …)
    list: string | null; // UI listing route (used when no id captured)
    detail?: (id: string) => string; // UI detail/edit route builder
  }> = [
    // ── Auth ──
    { re: /^\/api\/auth\/login$/,  noun: "تسجيل دخول",  list: null },
    { re: /^\/api\/auth\/logout$/, noun: "تسجيل خروج", list: null },

    // ── Sales ──
    { re: /^\/api\/sales\/sales-invoices(?:\/(\d+))?/, noun: "فاتورة مبيعات",
      list: "/sales/invoices", detail: id => `/sales/invoices/${id}` },
    { re: /^\/api\/invoices(?:\/(\d+))?/,              noun: "فاتورة مبيعات",
      list: "/sales/invoices", detail: id => `/sales/invoices/${id}` },
    { re: /^\/api\/quotations(?:\/(\d+))?/,            noun: "عرض سعر",
      list: "/sales/quotations", detail: id => `/sales/quotations/${id}` },
    { re: /^\/api\/sales-orders(?:\/(\d+))?/,          noun: "أمر بيع",
      list: "/sales/orders", detail: id => `/sales/orders/${id}` },
    { re: /^\/api\/sales-returns(?:\/(\d+))?/,         noun: "مرتجع مبيعات",
      list: "/sales/returns" },
    { re: /^\/api\/customers(?:\/(\d+))?/,             noun: "عميل",
      list: "/customers", detail: id => `/customers/${id}` },

    // ── Purchasing ──
    { re: /^\/api\/purchase-invoices(?:\/(\d+))?/, noun: "فاتورة مشتريات",
      list: "/purchasing/invoices", detail: id => `/purchasing/invoices/${id}` },
    { re: /^\/api\/purchase-orders(?:\/(\d+))?/,   noun: "أمر شراء",
      list: "/purchasing/orders",   detail: id => `/purchasing/orders/${id}` },
    { re: /^\/api\/purchase-returns(?:\/(\d+))?/,  noun: "مرتجع مشتريات",
      list: "/purchasing/returns" },
    { re: /^\/api\/suppliers(?:\/(\d+))?/,         noun: "مورد",
      list: "/suppliers" },
    { re: /^\/api\/supplier-settlements(?:\/(\d+))?/, noun: "تسوية مورد",
      list: "/purchasing/settlements" },

    // ── Inventory / Goods movement ──
    { re: /^\/api\/goods-receipts(?:\/(\d+))?/,    noun: "إذن استلام",
      list: "/inventory/goods-receipts" },
    { re: /^\/api\/goods-deliveries(?:\/(\d+))?/,  noun: "إذن تسليم",
      list: "/inventory/goods-deliveries" },
    { re: /^\/api\/(?:inventory\/)?items(?:\/(\d+))?/, noun: "صنف",
      list: "/inventory/items" },
    { re: /^\/api\/inventory\/warehouses(?:\/(\d+))?/, noun: "مستودع",
      list: "/inventory/warehouses" },
    { re: /^\/api\/stock-transfers(?:\/(\d+))?/,   noun: "تحويل مخزني",
      list: "/inventory/transfers" },
    { re: /^\/api\/stock-adjustments(?:\/(\d+))?/, noun: "تسوية مخزون",
      list: "/inventory/adjustments" },
    { re: /^\/api\/stock-counts(?:\/(\d+))?/,      noun: "جرد",
      list: "/inventory/counts" },
    { re: /^\/api\/offers\/match$/,                noun: "مطابقة عروض",
      list: "/inventory/offers" },
    { re: /^\/api\/offers(?:\/(\d+))?/,            noun: "عرض ترويجي",
      list: "/inventory/offers" },

    // ── Accounting & vouchers ──
    { re: /^\/api\/journal-entries(?:\/(\d+))?/,   noun: "قيد محاسبي",
      list: "/accounting/journals", detail: id => `/accounting/journals/${id}` },
    { re: /^\/api\/receipt-vouchers(?:\/(\d+))?/,  noun: "سند قبض",
      list: "/cash/receipt-vouchers", detail: id => `/cash/receipt-vouchers/${id}` },
    { re: /^\/api\/payment-vouchers(?:\/(\d+))?/,  noun: "سند صرف",
      list: "/cash/payment-vouchers", detail: id => `/cash/payment-vouchers/${id}` },
    { re: /^\/api\/cash-boxes(?:\/(\d+))?/,        noun: "صندوق نقدية",
      list: "/cash/boxes" },
    { re: /^\/api\/bank-accounts(?:\/(\d+))?/,     noun: "حساب بنكي",
      list: "/cash/banks" },
    { re: /^\/api\/accounts(?:\/(\d+))?/,          noun: "حساب",
      list: "/accounting/accounts" },
    { re: /^\/api\/cost-centers(?:\/(\d+))?/,      noun: "مركز تكلفة",
      list: "/accounting/cost-centers" },
    { re: /^\/api\/fiscal\/periods(?:\/(\d+))?/,   noun: "فترة مالية",
      list: "/accounting/fiscal-periods" },

    // ── Production ──
    { re: /^\/api\/production\/orders(?:\/(\d+))?/, noun: "أمر إنتاج",
      list: "/production/orders", detail: id => `/production/orders/${id}` },
    { re: /^\/api\/production\/bom-templates(?:\/(\d+))?/, noun: "قالب مكونات (BOM)",
      list: "/production/bom-templates", detail: id => `/production/bom-templates/${id}` },

    // ── HR ──
    { re: /^\/api\/hr\/employees(?:\/(\d+))?/,  noun: "موظف",
      list: "/hr/employees" },
    { re: /^\/api\/hr\/payroll(?:\/(\d+))?/,    noun: "مسير رواتب",
      list: "/hr/payroll" },
    { re: /^\/api\/hr\/attendance(?:\/(\d+))?/, noun: "حضور وانصراف",
      list: "/hr/attendance" },
    { re: /^\/api\/hr\/loans(?:\/(\d+))?/,      noun: "سلفة موظف",
      list: "/hr/loans" },

    // ── User tracking ──
    { re: /^\/api\/user-tracking\/zones(?:\/(\d+))?/, noun: "نطاق متابعة",
      list: "/user-tracking" },
    { re: /^\/api\/user-tracking/,                    noun: "متابعة المستخدمين",
      list: "/user-tracking" },

    // ── ZATCA ──
    { re: /^\/api\/zatca\b/, noun: "تكامل زاتكا", list: "/zatca" },
  ];

  for (const r of rules) {
    const match = p.match(r.re);
    if (!match) continue;
    const id = match[1];
    const href = id && r.detail ? r.detail(id) : r.list;
    const label = id ? `${r.noun} #${id}` : r.noun;
    return { label, href, mutation: isWrite };
  }
  return null;
}

export default function AuditLog() {
  const { token } = useAuth();
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`adminPages.auditLog.${k}`, opts) as string;
  const trAction = (a: string) => t(`adminPages.auditLog.actions.${a}`, { defaultValue: a }) as string;
  const locale = isRtl ? "ar-SA" : "en-US";
  const headers = { Authorization: `Bearer ${token}` };

  const [module, setModule] = useState<string>("__all");
  const [action, setAction] = useState<string>("__all");
  const [q,      setQ]      = useState("");
  const [from,   setFrom]   = useState("");
  const [to,     setTo]     = useState("");
  const [page,   setPage]   = useState(0);

  useEffect(() => { setPage(0); }, [module, action, q, from, to]);

  // ── Shareable permalinks (task #126) ───────────────────────────────────
  // The currently-open details dialog is encoded as `?entry=N` in the URL
  // so any audit row can be linked to directly. The URL is the single
  // source of truth for which row is selected:
  //   • Clicking a row from a closed dialog pushes `?entry=N` so the
  //     browser back button closes the dialog (task #132 — matches the
  //     web convention for modal overlays opened via URL state).
  //   • Switching from one open row to another replaces the current
  //     history entry so a session of clicks doesn't pollute history.
  //   • Closing the dialog via the UI pops the pushed entry (if any) so
  //     forward/back stays sane; if the dialog was opened directly via
  //     a permalink (no entry of ours to pop) we just drop the param.
  //   • Pressing the browser back button while the dialog is open lets
  //     popstate flow naturally — the URL changes, `entryId` recomputes
  //     to null, and the Dialog closes itself.
  //   • Loading the page with `?entry=N` already present opens the dialog
  //     immediately — even if that entry isn't on the current filter page.
  // When the entry isn't in the loaded rows we fall back to a single-entry
  // fetch (`GET /api/audit-log/:id`) so the dialog still opens with full
  // details. The entry-fetch query is only enabled while we don't already
  // have the row in the listing, which keeps the network chatter minimal.
  const search$ = useSearch();
  const [, setLocation] = useLocation();

  const entryId = useMemo(() => {
    const v = new URLSearchParams(search$).get("entry");
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [search$]);

  // Tracks whether the currently-open dialog corresponds to a history
  // entry *we* pushed (vs. a permalink the user landed on directly). On
  // UI close we pop our entry when this is true so back/forward stays
  // intuitive; when the user closes via the browser back button this
  // gets reset by the effect below so a subsequent open re-pushes
  // correctly.
  const pushedDialogEntryRef = useRef(false);
  useEffect(() => {
    if (entryId == null) pushedDialogEntryRef.current = false;
  }, [entryId]);

  const setSelectedId = useCallback(
    (id: number | null) => {
      if (id == null) {
        // Closing via the UI. If we own a pushed history entry, pop it
        // so back/forward behaves like the user expects (one back from
        // the listing leaves the page). The popstate will clear `entry`
        // from the URL and the dialog will close via the URL-derived
        // `entryId`.
        if (pushedDialogEntryRef.current && typeof window !== "undefined") {
          pushedDialogEntryRef.current = false;
          window.history.back();
          return;
        }
        // No pushed entry to pop (permalink landing): just drop the
        // `entry` param in place.
        const params = new URLSearchParams(search$);
        params.delete("entry");
        const qs = params.toString();
        setLocation(qs ? `/admin/audit-log?${qs}` : "/admin/audit-log", { replace: true });
        return;
      }

      const params = new URLSearchParams(search$);
      params.set("entry", String(id));
      const qs = params.toString();
      const url = qs ? `/admin/audit-log?${qs}` : "/admin/audit-log";

      if (entryId == null) {
        // Opening the dialog from a closed state — push so the browser
        // back button closes it instead of leaving the page.
        pushedDialogEntryRef.current = true;
        setLocation(url);
      } else {
        // Switching between rows while the dialog is already open —
        // replace so consecutive clicks don't grow history.
        setLocation(url, { replace: true });
      }
    },
    [search$, setLocation, entryId],
  );

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (module !== "__all") p.set("module", module);
    if (action !== "__all") p.set("action", action);
    if (q.trim())            p.set("q", q.trim());
    if (from)                p.set("from", new Date(from).toISOString());
    if (to)                  p.set("to",   new Date(to + "T23:59:59").toISOString());
    p.set("limit",  String(PAGE_SIZE));
    p.set("offset", String(page * PAGE_SIZE));
    return p.toString();
  }, [module, action, q, from, to, page]);

  const { data, isLoading, error, refetch, isFetching } = useQuery<{ rows: AuditRow[]; total: number }>({
    queryKey: ["audit-log", params],
    queryFn: async () => {
      const r = await fetch(`${API}/api/audit-log?${params}`, { headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });

  const { data: modules = [] } = useQuery<string[]>({
    queryKey: ["audit-log-modules"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/audit-log/modules`, { headers });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const total = data?.total ?? 0;
  const rows  = data?.rows  ?? [];
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  const PrevIcon = isRtl ? ChevronRight : ChevronLeft;
  const NextIcon = isRtl ? ChevronLeft : ChevronRight;

  // Resolve the entry that the URL currently points at. Prefer the row from
  // the loaded listing so we don't re-fetch when the user simply clicked a
  // visible row; fall back to the single-entry endpoint when the entry is
  // outside the current filter / page (the permalink case). Errors here
  // (404 cross-tenant, 404 missing, 500) are surfaced inside the dialog so
  // the rest of the listing keeps working.
  const inListEntry = useMemo(
    () => (entryId != null ? rows.find(r => r.id === entryId) ?? null : null),
    [entryId, rows],
  );

  const {
    data: standaloneEntry,
    isLoading: standaloneLoading,
    error: standaloneError,
  } = useQuery<AuditRow>({
    queryKey: ["audit-log-entry", entryId],
    enabled: entryId != null && !inListEntry,
    queryFn: async () => {
      const r = await fetch(`${API}/api/audit-log/${entryId}`, { headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    retry: false,
  });

  const selectedRow = inListEntry ?? standaloneEntry ?? null;

  // Row-level permalink builder (task #131). Mirrors the dialog's
  // `buildShareLink` so the inline copy icon on each row produces the same
  // URL a reviewer would copy from the open details dialog. Origin and
  // pathname are taken from the live `window.location` so the link reflects
  // whatever domain the reviewer is currently on (development vs deployed).
  // Renders to an empty string in non-browser contexts so SSR doesn't crash;
  // the click handler treats an empty value as a copy failure.
  const buildShareLinkForId = useCallback((id: number) => {
    if (typeof window === "undefined") return "";
    const { origin, pathname } = window.location;
    return `${origin}${pathname}?entry=${id}`;
  }, []);

  // Per-row tooltip / aria-label for the share-link copy button (task #154).
  // Surfaces the audited entity so a reviewer hovering the icon sees
  // exactly what they're about to share — e.g. "Copy link to invoice #45"
  // / "نسخ رابط فاتورة #45" — matching the friendly entity reference the
  // bulk Markdown copy already renders (task #148). Falls back to the
  // generic "Copy link to this entry" label when the row has no
  // `entityType` so we never show an awkward "Copy link to" with a
  // missing noun. The translation registry behind `entityTypes.*` is the
  // same one used by the Markdown variant, so adding a new entity type
  // there automatically improves both surfaces.
  const shareLinkLabelForRow = useCallback(
    (row: AuditRow) => {
      if (!row.entityType) return tr("copyShareLink");
      const entityLabel = tr(`entityTypes.${row.entityType}`, {
        defaultValue: row.entityType,
      });
      const entity = row.entityId
        ? `${entityLabel} #${row.entityId}`
        : entityLabel;
      return tr("copyShareLinkWithEntity", { entity });
    },
    [tr],
  );

  // ── Bulk-select share links (task #143, Markdown variant task #145) ──
  // Reviewers triaging long audit lists frequently want to drop a batch
  // of permalinks into a chat or ticket. Per-row checkboxes plus toolbar
  // actions let them do that in one click instead of copying each link
  // individually. State is intentionally a Map keyed by row `id`, NOT
  // by visible row index, so the selection survives:
  //   • paginating to a different page (the Map keeps prior IDs)
  //   • re-filtering the listing (we keep the IDs even if a row is no
  //     longer visible — the eventual permalink still resolves the
  //     entry via `?entry=N`)
  //   • refetching (the rows array reference changes but IDs persist)
  //
  // Beyond bare IDs we also stash a small per-row summary (`createdAt`,
  // `action`, and the audited `entityType` / `entityId`) at selection
  // time so the Markdown copy variant (task #145) can render a
  // meaningful link label —
  // `Audit #123 — view invoice #45 at 2026-04-28 10:15:42` — without
  // needing to re-fetch rows that have since paged out of view. The
  // entity reference (task #148) is what tells a reviewer scanning a
  // pasted list which record each row is about (invoice, customer,
  // payment, etc.) without clicking into every link. Plain-text copy
  // ignores the summary entirely, so an entry whose summary somehow
  // went missing still copies as a working link.
  //
  // We expose a header checkbox that selects/deselects only the rows
  // currently visible on the page (the typical "select-all" pattern in
  // table UIs); clearing the entire selection is offered explicitly via
  // the toolbar so a reviewer never gets stuck with stale picks from
  // pages they've moved away from.
  type SelectedRowMeta = {
    createdAt: string;
    action: string;
    entityType: string | null;
    entityId: string | null;
  };
  const [selectedRows, setSelectedRows] = useState<Map<number, SelectedRowMeta>>(new Map());
  const selectedCount = selectedRows.size;

  const toggleRowSelected = useCallback((row: AuditRow, checked: boolean) => {
    setSelectedRows(prev => {
      const next = new Map(prev);
      if (checked) {
        next.set(row.id, {
          createdAt:  row.createdAt,
          action:     row.action,
          entityType: row.entityType,
          entityId:   row.entityId,
        });
      } else {
        next.delete(row.id);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedRows(new Map());
  }, []);

  // Header checkbox state — based on currently-visible rows only. Empty
  // page → unchecked & disabled; some-but-not-all selected →
  // "indeterminate"; all selected → checked.
  const visibleSelectedCount = useMemo(
    () => rows.reduce((acc, r) => acc + (selectedRows.has(r.id) ? 1 : 0), 0),
    [rows, selectedRows],
  );
  const headerCheckboxState: boolean | "indeterminate" =
    rows.length > 0 && visibleSelectedCount === rows.length
      ? true
      : visibleSelectedCount > 0
        ? "indeterminate"
        : false;

  const togglePageSelection = useCallback(
    (checked: boolean | "indeterminate") => {
      // Radix may emit "indeterminate" when toggling a tri-state; treat
      // that as "select all visible" since the user clicked to leave the
      // mixed state, which is the common UX expectation.
      const shouldSelect = checked !== false;
      setSelectedRows(prev => {
        const next = new Map(prev);
        if (shouldSelect) {
          for (const r of rows) {
            next.set(r.id, {
              createdAt:  r.createdAt,
              action:     r.action,
              entityType: r.entityType,
              entityId:   r.entityId,
            });
          }
        } else {
          for (const r of rows) next.delete(r.id);
        }
        return next;
      });
    },
    [rows],
  );

  // Escape characters that would break the `[label](url)` Markdown link
  // syntax when the label appears between brackets. Backslash needs to
  // come first so we don't double-escape characters we just inserted.
  // The action label originates from translations and only ever contains
  // safe characters today, but we still defend against future writers
  // (e.g. someone adding a localized label that happens to contain a
  // bracket) so the pasted output stays valid Markdown.
  const escapeMarkdownLinkLabel = useCallback((s: string) => {
    return s.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  }, []);

  // Downloads the selected audit rows as a CSV file. Mirrors the existing
  // CSV-download mutations on /admin/ai-fix: fetches the body via the
  // Authorization-bearing fetch (a plain `<a download>` can't carry the
  // header), turns the blob into an object URL, and synthetically clicks
  // a hidden anchor to trigger the browser's download UI. The endpoint
  // POSTs the id list in the body so a few hundred selections never push
  // the URL past the proxy's length limit, and the server logs the
  // export to the audit log itself with the chosen ids in metadata so
  // the batch is reproducible.
  //
  // We deliberately preserve the selection on success — reviewers
  // sometimes want both the links AND the CSV for the same batch
  // (different audiences receive each), so silently clearing would be
  // hostile. The "Clear selection" button is right next to the action
  // for the explicit case.
  const [downloadingCsv, setDownloadingCsv] = useState(false);
  const downloadSelectedCsv = useCallback(async () => {
    if (selectedRows.size === 0 || downloadingCsv) return;
    const ids = [...selectedRows.keys()].sort((a, b) => a - b);
    setDownloadingCsv(true);
    try {
      const r = await fetch(`${API}/api/audit-log/export`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!r.ok) {
        const msg = await r.json().catch(() => ({} as any));
        throw new Error(msg?.error || tr("downloadFailureDescription"));
      }
      const blob = await r.blob();
      const cd = r.headers.get("Content-Disposition") ?? "";
      const m = cd.match(/filename="?([^";]+)"?/i);
      const filename = m?.[1] ? decodeURIComponent(m[1]) : `audit-log-selection-${Date.now()}.csv`;
      const rowCount = Number(r.headers.get("X-Csv-Row-Count") ?? ids.length) || ids.length;
      if (typeof document !== "undefined") {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Free the blob URL after the click has had a chance to start.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      toast({
        title: tr("downloadSuccessTitle"),
        description: tr("downloadSuccessToast", {
          count: rowCount,
          formattedCount: rowCount.toLocaleString(locale),
        }),
      });
    } catch (e: any) {
      toast({
        title: tr("downloadFailureTitle"),
        description: e?.message || tr("downloadFailureDescription"),
        variant: "destructive",
      });
    } finally {
      setDownloadingCsv(false);
    }
  }, [selectedRows, downloadingCsv, headers, tr, toast, locale]);

  // ─── Filter-driven bulk delete (toolbar) ─────────────────────────
  // The toolbar button next to "Refresh" lets a reviewer wipe the rows
  // matching the CURRENT filter set (date range, module, action, search,
  // etc.). It is the cleanup companion to the per-row checkbox flow:
  // checkboxes are for surgical work, this is for "clean by criteria".
  //
  // Flow: open a confirmation dialog showing the current `total` so the
  // operator sees exactly how many rows are about to disappear, then
  // call DELETE /api/audit-log with the same query string we use for
  // the listing (the `params` memo, minus the paging fields the server
  // ignores anyway). On success we invalidate the listing query to
  // refetch a now-shorter page and clear any per-row selection that
  // would have referenced just-deleted ids.
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletingByFilter, setDeletingByFilter] = useState(false);
  const deleteByFilter = useCallback(async () => {
    if (deletingByFilter) return;
    setDeletingByFilter(true);
    try {
      // Strip paging fields — the server ignores them on DELETE but it's
      // clearer to send only the filters the operator actually picked.
      const filterParams = new URLSearchParams(params);
      filterParams.delete("limit");
      filterParams.delete("offset");
      const r = await fetch(`${API}/api/audit-log?${filterParams.toString()}`, {
        method:  "DELETE",
        headers,
      });
      if (!r.ok) {
        const msg = await r.json().catch(() => ({} as any));
        throw new Error(msg?.error || tr("deleteFailureDescription"));
      }
      const body = await r.json().catch(() => ({ deleted: 0 }));
      const deleted = Number(body?.deleted ?? 0);
      toast({
        title: tr("deleteSuccessTitle"),
        description: tr("deleteSuccessToast", {
          count: deleted,
          formattedCount: deleted.toLocaleString(locale),
        }),
      });
      setSelectedRows(new Map());
      setPage(0);
      await refetch();
    } catch (e: any) {
      toast({
        title: tr("deleteFailureTitle"),
        description: e?.message || tr("deleteFailureDescription"),
        variant: "destructive",
      });
    } finally {
      setDeletingByFilter(false);
      setShowDeleteConfirm(false);
    }
  }, [deletingByFilter, params, headers, tr, toast, locale, refetch]);

  // Shared write-to-clipboard helper used by both the bulk copy paths
  // and the per-row Markdown secondary action (task #156). Prefers the
  // async Clipboard API and falls back to a hidden textarea +
  // execCommand for the same reason CopyIconButton does — insecure
  // contexts during local development would otherwise silently fail.
  const copyTextToClipboard = useCallback(async (text: string): Promise<boolean> => {
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === "function"
      ) {
        await navigator.clipboard.writeText(text);
        return true;
      } else if (typeof document !== "undefined") {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "absolute";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      }
    } catch {
      return false;
    }
    return false;
  }, []);

  // Shared Markdown list-item builder for a single audited row (task #156).
  // Extracted from the bulk-copy loop so the per-row right-click action
  // and the bulk Markdown action emit identical output for the same
  // entry — same label, same escaping, same URL. Returns null when the
  // permalink can't be built (non-browser context) so callers can
  // surface the failure as a toast.
  //
  // Builds an "Audit #N — action [entity] at timestamp" label so the
  // link is meaningful before being clicked. When the row has an
  // `entityType` (and optionally `entityId`) we splice in a friendly
  // reference such as "invoice #45" / "فاتورة #45" (task #148). Falls
  // back to the entity-less label when we don't have an entityType,
  // and to just "Audit #N" if we somehow lost the per-row summary
  // entirely; the URL itself is always present so the link resolves
  // regardless of label fidelity.
  const buildMarkdownLineForId = useCallback(
    (id: number, meta: SelectedRowMeta | null) => {
      const url = buildShareLinkForId(id);
      if (!url) return null;
      let labelText: string;
      if (!meta) {
        labelText = tr("copyMarkdownLinkLabelMinimal", { id });
      } else {
        const timestamp = new Date(meta.createdAt).toLocaleString(locale, { hour12: false });
        const action    = trAction(meta.action);
        if (meta.entityType) {
          // Resolve the raw enum to a translated friendly label
          // (`entityTypes.invoice` → "invoice" / "فاتورة"), falling
          // back to the raw machine value when no localisation is
          // registered yet — keeps the label forward-compatible with
          // future entity types without silently dropping the info.
          const entityLabel = tr(`entityTypes.${meta.entityType}`, {
            defaultValue: meta.entityType,
          });
          const entity = meta.entityId
            ? `${entityLabel} #${meta.entityId}`
            : entityLabel;
          labelText = tr("copyMarkdownLinkLabelWithEntity", {
            id,
            action,
            entity,
            timestamp,
          });
        } else {
          labelText = tr("copyMarkdownLinkLabel", { id, action, timestamp });
        }
      }
      return `- [${escapeMarkdownLinkLabel(labelText)}](${url})`;
    },
    [buildShareLinkForId, tr, trAction, locale, escapeMarkdownLinkLabel],
  );

  // Copies the list of permalinks for every selected row to the
  // clipboard in either plain-text (one link per line) or Markdown
  // (`- [label](url)` list-item) format. We sort the IDs ascending so
  // the pasted output is deterministic regardless of the order the
  // reviewer happened to tick them — easier to scan in a chat/ticket
  // and matches the natural order audit IDs are issued in.
  //
  // Both formats share the same selection, sorting, clipboard fallback,
  // and toast feedback so the only thing that varies is the rendered
  // body and the success toast description. The Markdown variant
  // delegates per-line rendering to `buildMarkdownLineForId` so the
  // single-row right-click action (task #156) emits byte-identical
  // output.
  const copySelectedLinks = useCallback(async (format: "plain" | "markdown") => {
    if (selectedRows.size === 0) return;
    const ids = [...selectedRows.keys()].sort((a, b) => a - b);
    const lines = ids
      .map(id => {
        if (format === "plain") {
          const url = buildShareLinkForId(id);
          return url || null;
        }
        return buildMarkdownLineForId(id, selectedRows.get(id) ?? null);
      })
      .filter((v): v is string => v != null && v.length > 0);

    const text = lines.join("\n");

    if (!text) {
      toast({
        title: tr("copyFailureTitle"),
        description: tr("copyFailureDescription"),
        variant: "destructive",
      });
      return;
    }

    const ok = await copyTextToClipboard(text);

    if (ok) {
      const toastKey =
        format === "markdown" ? "copySelectedLinksMarkdownToast" : "copySelectedLinksToast";
      toast({
        title: tr("copySuccessTitle"),
        description: tr(toastKey, {
          count: lines.length,
          formattedCount: lines.length.toLocaleString(locale),
        }),
      });
    } else {
      toast({
        title: tr("copyFailureTitle"),
        description: tr("copyFailureDescription"),
        variant: "destructive",
      });
    }
  }, [selectedRows, buildShareLinkForId, buildMarkdownLineForId, copyTextToClipboard, toast, tr, locale]);

  // Single-row Markdown copy (task #156). Triggered as a secondary
  // action on the per-row share-link icon (right-click context menu)
  // so a reviewer who wants the bulk Markdown variant for one row no
  // longer has to tick its checkbox + use the bulk action — they get
  // the same `- [Audit #N — action entity at timestamp](url)` line
  // straight to the clipboard from the row itself. Reuses
  // `buildMarkdownLineForId` so the rendered output is identical to
  // the bulk variant for the same row.
  const copyRowAsMarkdownLink = useCallback(
    async (row: AuditRow) => {
      const line = buildMarkdownLineForId(row.id, {
        createdAt:  row.createdAt,
        action:     row.action,
        entityType: row.entityType,
        entityId:   row.entityId,
      });
      if (!line) {
        toast({
          title: tr("copyFailureTitle"),
          description: tr("copyFailureDescription"),
          variant: "destructive",
        });
        return;
      }
      const ok = await copyTextToClipboard(line);
      if (ok) {
        toast({
          title: tr("copySuccessTitle"),
          description: tr("copyShareLinkMarkdownToast"),
        });
      } else {
        toast({
          title: tr("copyFailureTitle"),
          description: tr("copyFailureDescription"),
          variant: "destructive",
        });
      }
    },
    [buildMarkdownLineForId, copyTextToClipboard, toast, tr],
  );

  return (
    <div dir={isRtl ? "rtl" : "ltr"} className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ScrollText className="h-5 w-5 text-primary" />
            {tr("title")}
          </CardTitle>
          <CardDescription>
            {tr("subtitle")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-6 gap-2">
            <div className="md:col-span-2">
              <label className="text-xs text-muted-foreground mb-1 block">{tr("searchLabel")}</label>
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("searchPh")} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{tr("moduleLabel")}</label>
              <Select value={module} onValueChange={setModule}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all">{tr("all")}</SelectItem>
                  {modules.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{tr("actionLabel")}</label>
              <Select value={action} onValueChange={setAction}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all">{tr("all")}</SelectItem>
                  {ACTION_KEYS.map(v => (
                    <SelectItem key={v} value={v}>{trAction(v)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{tr("fromLabel")}</label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{tr("toLabel")}</label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground">
              {tr("totalLabel")} <span className="font-mono font-semibold text-foreground">{total.toLocaleString(locale)}</span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
                <RefreshCw className={`h-3.5 w-3.5 ${isRtl ? "ml-1" : "mr-1"} ${isFetching ? "animate-spin" : ""}`} />
                {tr("refresh")}
              </Button>
              {/* Filter-driven bulk delete: wipes EVERY row that matches
                  the current filter state. Disabled when there's nothing
                  to delete OR while another delete is in flight. The big
                  destructive cue (red border + Trash2 icon) prevents
                  click-by-mistake; the modal confirmation behind it
                  shows the exact count before any DB write. */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowDeleteConfirm(true)}
                disabled={total === 0 || deletingByFilter || isFetching}
                className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                data-testid="audit-toolbar-delete-by-filter"
              >
                <Trash2 className={`h-3.5 w-3.5 ${isRtl ? "ml-1" : "mr-1"}`} />
                {tr("deleteByFilter")}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Bulk-select toolbar (task #143). Conditionally rendered so it
          stays out of the way until the reviewer actually picks rows.
          Lives above the table so it's visible regardless of how far
          the listing has scrolled, and the count is always reflected
          inside the action label so a screenshot or screen reader
          conveys the same intent. */}
      {selectedCount > 0 && (
        <div
          dir={isRtl ? "rtl" : "ltr"}
          data-testid="audit-bulk-toolbar"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2"
        >
          <div className="text-xs text-foreground/80">
            {tr("selectedCount", { count: selectedCount.toLocaleString(locale) })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Plain-text and Markdown copy actions live side-by-side
                (task #145). Both operate on the same selection — only
                the rendered output changes — so the reviewer can pick
                whichever paste target fits the destination (a chat box
                where Markdown auto-renders vs. a plain text field).
                The button order keeps the existing plain-text action
                in its original position so muscle memory still works. */}
            <Button
              type="button"
              size="sm"
              onClick={() => copySelectedLinks("plain")}
              data-testid="audit-bulk-copy-share-links"
            >
              <Link2 className={`h-3.5 w-3.5 ${isRtl ? "ml-1" : "mr-1"}`} />
              {tr("copySelectedLinks", { count: selectedCount.toLocaleString(locale) })}
            </Button>
            {/* Bulk CSV download (task #146). Sits next to the copy-links
                action because both feed off the same selection — reviewers
                often want either the permalinks (for chat/ticket) or the
                row contents (for spreadsheet triage), not both at once.
                The button stays disabled while the download is in flight
                so a fast double-click can't fire two duplicate audit
                rows. */}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={downloadSelectedCsv}
              disabled={downloadingCsv}
              data-testid="audit-bulk-download-csv"
            >
              {downloadingCsv ? (
                <Loader2 className={`h-3.5 w-3.5 animate-spin ${isRtl ? "ml-1" : "mr-1"}`} />
              ) : (
                <Download className={`h-3.5 w-3.5 ${isRtl ? "ml-1" : "mr-1"}`} />
              )}
              {tr("downloadSelectedCsv", { count: selectedCount.toLocaleString(locale) })}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => copySelectedLinks("markdown")}
              data-testid="audit-bulk-copy-share-links-markdown"
            >
              <FileCode2 className={`h-3.5 w-3.5 ${isRtl ? "ml-1" : "mr-1"}`} />
              {tr("copySelectedLinksMarkdown", { count: selectedCount.toLocaleString(locale) })}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearSelection}
              data-testid="audit-bulk-clear-selection"
            >
              <X className={`h-3.5 w-3.5 ${isRtl ? "ml-1" : "mr-1"}`} />
              {tr("clearSelection")}
            </Button>
          </div>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-12 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
          ) : error ? (
            <div className="p-8 text-center text-rose-600 flex flex-col items-center gap-2">
              <ShieldAlert className="h-8 w-8" />
              <span>{tr("loadFailed")}</span>
              <span className="text-xs text-muted-foreground">{(error as any)?.message}</span>
            </div>
          ) : rows.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground">{tr("noRows")}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 border-b">
                  <tr className={`${isRtl ? "text-right" : "text-left"} text-xs text-muted-foreground`}>
                    {/* Bulk-select header column (task #143). Toggles
                        every visible row at once and reflects the
                        page's mixed/all/none state via the indeterminate
                        flag. The cell stops propagation so the click
                        never bubbles into the surrounding row click
                        handlers (rows themselves are buttons). */}
                    <th className="px-3 py-2 font-medium w-10">
                      <Checkbox
                        checked={headerCheckboxState}
                        onCheckedChange={togglePageSelection}
                        aria-label={tr("selectAllOnPage")}
                        data-testid="audit-bulk-select-all"
                      />
                    </th>
                    <th className="px-3 py-2 font-medium">{tr("colTime")}</th>
                    <th className="px-3 py-2 font-medium">{tr("colUser")}</th>
                    <th className="px-3 py-2 font-medium">{tr("colAction")}</th>
                    <th className="px-3 py-2 font-medium">{tr("colModule")}</th>
                    {/* Entity column (task #153). Renders the friendly
                        translated label from the shared
                        `adminPages.auditLog.entityTypes` dictionary the
                        Markdown bulk-copy already uses, so reviewers
                        scanning the table no longer see raw enums like
                        `payment_voucher` instead of "payment voucher" /
                        "سند صرف". */}
                    <th className="px-3 py-2 font-medium">{tr("colEntity")}</th>
                    <th className="px-3 py-2 font-medium">{tr("colPath")}</th>
                    <th className="px-3 py-2 font-medium">{tr("colStatus")}</th>
                    <th className="px-3 py-2 font-medium">{tr("colIp")}</th>
                    <th className="px-3 py-2 font-medium" title="المكان الفعلي الذي سجّل المستخدم الدخول منه (يُحدَّد تلقائيًا من GPS وقت تسجيل الدخول)">
                      موقع الدخول
                    </th>
                    {/* Row-level share-link column (task #131) — header text
                        is screen-reader only since the icon column is
                        intentionally compact. */}
                    <th className="px-3 py-2 font-medium w-10">
                      <span className="sr-only">{tr("copyShareLink")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const cls = ACTION_CLS[r.action] ?? "bg-gray-50 text-gray-700 border-gray-200";
                    const label = trAction(r.action);
                    const tt = new Date(r.createdAt);
                    const ok = (r.statusCode ?? 0) >= 200 && (r.statusCode ?? 0) < 400;
                    // Truncation badge — task #115. The maintenance CSV exports
                    // (entityType maintenance_error_summary / maintenance_recent_recoveries,
                    // task #111) record `truncated`/`rowCap`/`totalAvailable` in
                    // metadata when the 1000-row cap clips the file. Surface that
                    // at a glance so a reviewer doesn't have to drill into the
                    // raw JSON to spot a clipped export. Numeric guards keep
                    // unrelated metadata shapes (or future flag-only callers)
                    // safe — we only render the count subtitle when both numbers
                    // are present.
                    const meta = (r.metadata ?? {}) as Record<string, unknown>;
                    const isTruncated = meta.truncated === true;
                    const rowCap = typeof meta.rowCap === "number" ? meta.rowCap : null;
                    const totalAvailable =
                      typeof meta.totalAvailable === "number" ? meta.totalAvailable : null;
                    // Computed once so both the copy button and the hover
                    // preview tooltip (task #144) display the exact same
                    // permalink — keeps "what you see is what you copy".
                    const shareLink = buildShareLinkForId(r.id);
                    return (
                      <tr
                        key={r.id}
                        data-testid="audit-row"
                        data-selected={selectedRows.has(r.id) ? "true" : undefined}
                        className={`border-b last:border-0 hover:bg-muted/30 cursor-pointer focus:outline-none focus:bg-muted/40 ${selectedRows.has(r.id) ? "bg-primary/5" : ""}`}
                        tabIndex={0}
                        role="button"
                        aria-label={tr("openDetails")}
                        onClick={() => setSelectedId(r.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSelectedId(r.id);
                          }
                        }}
                      >
                        {/* Per-row selection checkbox (task #143). The
                            wrapping cell stops click/key events from
                            bubbling so toggling the box never opens the
                            details dialog (the row's own onClick /
                            onKeyDown handlers do that). */}
                        <td
                          className="px-3 py-2 w-10"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <Checkbox
                            checked={selectedRows.has(r.id)}
                            onCheckedChange={(v) => toggleRowSelected(r, v === true)}
                            aria-label={tr("selectRow")}
                            data-testid={`audit-row-select-${r.id}`}
                          />
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-xs font-mono">
                          {tt.toLocaleString(locale, { hour12: false })}
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-medium">{r.username ?? "—"}</div>
                          {r.role && <div className="text-[10px] text-muted-foreground">{r.role}</div>}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap items-center gap-1">
                            <Badge variant="outline" className={`${cls} font-normal`}>{label}</Badge>
                            {isTruncated && (
                              <Badge
                                variant="outline"
                                data-testid="audit-truncated-badge"
                                title={
                                  rowCap != null && totalAvailable != null
                                    ? tr("truncatedTooltip", {
                                        cap: rowCap.toLocaleString(locale),
                                        total: totalAvailable.toLocaleString(locale),
                                      })
                                    : tr("truncatedLabel")
                                }
                                className="bg-amber-50 text-amber-800 border-amber-300 font-normal gap-1"
                              >
                                <Scissors className="h-3 w-3" />
                                <span>{tr("truncatedLabel")}</span>
                                {rowCap != null && totalAvailable != null && (
                                  <span className="font-mono text-[10px] opacity-80">
                                    {tr("truncatedCount", {
                                      cap: rowCap.toLocaleString(locale),
                                      total: totalAvailable.toLocaleString(locale),
                                    })}
                                  </span>
                                )}
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-xs font-mono">{r.module}</td>
                        {/* Entity cell (task #153). Resolves the raw enum
                            to the same translated friendly label the
                            Markdown bulk-copy uses (`entityTypes.invoice`
                            → "invoice" / "فاتورة"), falling back to the
                            raw machine value when no localisation is
                            registered yet — keeps the column
                            forward-compatible with future entity types
                            without silently dropping info. The raw enum
                            is kept inline as a small muted monospace
                            hint (mirroring the user-row's "(role)"
                            secondary label), but the hint collapses
                            when the friendly label is identical to the
                            raw enum (e.g. `invoice` → "invoice" in
                            English) to avoid noisy "invoice (invoice)"
                            output. Whole-cell `title` keeps the raw
                            enum discoverable on hover even when the
                            inline hint is collapsed. */}
                        <td
                          className="px-3 py-2 text-xs"
                          data-testid="audit-row-entity"
                          title={r.entityType ?? undefined}
                        >
                          {r.entityType ? (() => {
                            const friendly = tr(`entityTypes.${r.entityType}`, {
                              defaultValue: r.entityType,
                            });
                            const showRaw = friendly !== r.entityType;
                            return (
                              <>
                                <span>{friendly}</span>
                                {showRaw && (
                                  <span className="font-mono text-[10px] text-muted-foreground ms-1">
                                    ({r.entityType})
                                  </span>
                                )}
                              </>
                            );
                          })() : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td
                          className="px-3 py-2 text-xs max-w-[300px] truncate"
                          title={`${r.method ?? ""} ${r.path ?? ""}`}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          {(() => {
                            const fp = friendlyPath(r.method, r.path);
                            if (!fp) {
                              // Unknown pattern → fall back to the raw method/path so
                              // we never hide what actually happened on the server.
                              return (
                                <span className="font-mono text-muted-foreground">
                                  <span className="text-foreground/70">{r.method}</span> {r.path ?? "—"}
                                </span>
                              );
                            }
                            const cls = fp.mutation
                              ? "text-blue-700 hover:text-blue-900 hover:underline font-medium"
                              : "text-slate-700 hover:text-slate-900 hover:underline";
                            return fp.href ? (
                              <Link href={fp.href} className={cls}>{fp.label}</Link>
                            ) : (
                              <span className="text-slate-700 font-medium">{fp.label}</span>
                            );
                          })()}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {r.statusCode != null && (
                            <span className={`font-mono ${ok ? "text-emerald-600" : "text-rose-600"}`}>{r.statusCode}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{r.ip ?? "—"}</td>
                        <td
                          className="px-3 py-2"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <AuditLoginLocation
                            place={r.loginPlace}
                            address={r.loginAddress}
                            lat={r.loginLat}
                            lng={r.loginLng}
                            accuracy={r.loginAccuracy}
                            zoneName={r.loginZoneName}
                          />
                        </td>
                        {/* Inline share-link copy (task #131). The wrapping
                            cell stops click/key events from bubbling so the
                            row's own onClick / onKeyDown — which open the
                            details dialog — don't fire when the reviewer
                            just wants the permalink. The button itself
                            reuses the existing CopyIconButton so the toast,
                            check-mark feedback, and clipboard fallback are
                            identical to the in-dialog share button.
                            Hover/focus surfaces a quick preview of the
                            entry (id / action / module / timestamp / link)
                            so reviewers can spot-check before pasting
                            without opening the dialog (task #144). */}
                        <td
                          className="px-3 py-2 w-10"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          {/* Hover/focus preview from task #144 wraps the
                              row's existing share-link copy button so a
                              reviewer can spot-check id / action / module /
                              timestamp / link before pasting. The inner
                              CopyIconButton keeps the entity-aware tooltip /
                              aria-label from task #154 so the button itself
                              still announces what entity is being shared
                              (e.g. "Copy link to invoice #45") for screen
                              readers and the post-copy toast — the rich
                              hover preview is purely additive. */}
                          <Tooltip>
                            <TooltipTrigger asChild>
                              {/* The span is the focus/hover target for
                                  Radix; the inner button keeps its own
                                  click-to-copy behavior untouched.
                                  `inline-flex` keeps the trigger box
                                  collapsed around the icon button.
                                  Right-click triggers the secondary
                                  Markdown copy (task #156): we suppress
                                  the browser's native context menu and
                                  emit the same `- [Audit #N — action
                                  entity at timestamp](url)` line the
                                  bulk Markdown action would produce
                                  for this row. The primary left-click
                                  on the inner button still copies the
                                  bare URL, so existing flows and tests
                                  are unchanged. */}
                              <span
                                className="inline-flex"
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  void copyRowAsMarkdownLink(r);
                                }}
                                data-testid={`audit-row-share-link-context-${r.id}`}
                              >
                                <CopyIconButton
                                  value={shareLink}
                                  label={shareLinkLabelForRow(r)}
                                  tr={tr}
                                  testId={`audit-row-copy-share-link-${r.id}`}
                                  icon={Link2}
                                />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent
                              side="top"
                              align={isRtl ? "end" : "start"}
                              className="max-w-xs bg-background text-foreground border shadow-md p-2"
                              data-testid={`audit-row-share-link-preview-${r.id}`}
                            >
                              <div
                                dir={isRtl ? "rtl" : "ltr"}
                                className={`space-y-1 text-xs ${isRtl ? "text-right" : "text-left"}`}
                              >
                                <div className="font-medium text-foreground/90">
                                  {tr("sharePreviewTitle")}
                                </div>
                                <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                                  <dt className="text-muted-foreground">{tr("sharePreviewId")}</dt>
                                  <dd className="font-mono">{r.id}</dd>
                                  <dt className="text-muted-foreground">{tr("sharePreviewAction")}</dt>
                                  <dd>{label}</dd>
                                  <dt className="text-muted-foreground">{tr("sharePreviewModule")}</dt>
                                  <dd className="font-mono break-all">{r.module}</dd>
                                  <dt className="text-muted-foreground">{tr("sharePreviewTime")}</dt>
                                  <dd className="font-mono">{tt.toLocaleString(locale, { hour12: false })}</dd>
                                  <dt className="text-muted-foreground">{tr("sharePreviewLink")}</dt>
                                  <dd className="font-mono break-all">{shareLink}</dd>
                                </dl>
                                {/* Discoverability hint for the
                                    right-click secondary action
                                    (task #156). Sits at the bottom of
                                    the existing rich preview so a
                                    reviewer hovering the share-link
                                    icon learns about the Markdown copy
                                    shortcut without us cluttering the
                                    table header or adding a second
                                    visible button. */}
                                <div
                                  className="mt-1 pt-1 border-t border-border/60 text-[10px] text-muted-foreground"
                                  data-testid={`audit-row-share-link-markdown-hint-${r.id}`}
                                >
                                  {tr("copyShareLinkMarkdownHint")}
                                </div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between px-4 py-3 border-t bg-muted/20">
              <div className="text-xs text-muted-foreground">
                {tr("pageOf", { page: (page + 1).toLocaleString(locale), total: (lastPage + 1).toLocaleString(locale) })}
              </div>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>
                  <PrevIcon className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(lastPage, p + 1))} disabled={page >= lastPage}>
                  <NextIcon className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <AuditDetailsDialog
        open={entryId != null}
        row={selectedRow}
        loading={entryId != null && !inListEntry && standaloneLoading}
        error={standaloneError as Error | null}
        entryId={entryId}
        onClose={() => setSelectedId(null)}
        isRtl={isRtl}
        locale={locale}
        tr={tr}
        trAction={trAction}
        shareLinkLabelForRow={shareLinkLabelForRow}
      />

      {/* Confirm-before-delete dialog for the toolbar bulk-delete action.
          Mounted at the page root so it overlays the listing card. The
          row count shown is the live `total` from the listing query, so
          the operator sees the same number they'd see in the toolbar
          before committing. */}
      <Dialog open={showDeleteConfirm} onOpenChange={(v) => { if (!v) setShowDeleteConfirm(false); }}>
        <DialogContent dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader className={isRtl ? "text-right sm:text-right" : undefined}>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="h-5 w-5" />
              {tr("deleteConfirmTitle")}
            </DialogTitle>
            <DialogDescription>
              {total > 0
                ? tr("deleteConfirmDesc", { count: total, formattedCount: total.toLocaleString(locale) })
                : tr("deleteConfirmZero")}
            </DialogDescription>
          </DialogHeader>
          <div className={`flex gap-2 ${isRtl ? "justify-start" : "justify-end"} pt-2`}>
            <Button
              variant="outline"
              onClick={() => setShowDeleteConfirm(false)}
              disabled={deletingByFilter}
              data-testid="audit-delete-confirm-cancel"
            >
              {tr("deleteCancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={deleteByFilter}
              disabled={deletingByFilter || total === 0}
              data-testid="audit-delete-confirm-submit"
            >
              {deletingByFilter ? (
                <Loader2 className={`h-4 w-4 animate-spin ${isRtl ? "ml-2" : "mr-2"}`} />
              ) : (
                <Trash2 className={`h-4 w-4 ${isRtl ? "ml-2" : "mr-2"}`} />
              )}
              {tr("deleteConfirm")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AuditDetailsDialog({
  open,
  row,
  loading,
  error,
  entryId,
  onClose,
  isRtl,
  locale,
  tr,
  trAction,
  shareLinkLabelForRow,
}: {
  open: boolean;
  row: AuditRow | null;
  loading: boolean;
  error: Error | null;
  entryId: number | null;
  onClose: () => void;
  isRtl: boolean;
  locale: string;
  tr: (k: string, opts?: any) => string;
  trAction: (a: string) => string;
  shareLinkLabelForRow: (row: AuditRow) => string;
}) {
  // Metadata can be any JSON shape — usually an object for our writers, but
  // we don't want to silently drop primitives (string/number/array) if a
  // future caller stores one. Treat "no metadata" as null/undefined or an
  // empty object/array; everything else gets pretty-printed via
  // JSON.stringify so the reviewer sees the raw payload regardless of shape.
  const rawMeta = row?.metadata;
  const isEmptyMeta =
    rawMeta == null ||
    (typeof rawMeta === "object" &&
      !Array.isArray(rawMeta) &&
      Object.keys(rawMeta as Record<string, unknown>).length === 0) ||
    (Array.isArray(rawMeta) && rawMeta.length === 0);
  const prettyMeta = !isEmptyMeta ? JSON.stringify(rawMeta, null, 2) : null;

  const ok = row?.statusCode != null && row.statusCode >= 200 && row.statusCode < 400;

  // Build the copyable request path string (method + path) so the inline
  // copy button next to the field grabs the same text the user sees.
  const pathCopyValue = row
    ? [row.method, row.path].filter((v) => v != null && v !== "").join(" ").trim()
    : "";

  // Permanent share link to this entry. We rebuild it from `window.location`
  // so it always reflects the live origin (development domain, deployed
  // domain, etc.) and includes the artifact's base path. Only the `entry`
  // query param is preserved — other listing filters are intentionally
  // dropped so the link reliably opens the same entry regardless of who
  // clicks it. Computed lazily inside the click handler so SSR / non-browser
  // contexts don't break component rendering.
  const buildShareLink = () => {
    if (entryId == null || typeof window === "undefined") return "";
    const { origin, pathname } = window.location;
    return `${origin}${pathname}?entry=${entryId}`;
  };
  // Computed once per render so the visible URL, the clipboard payload,
  // and the hover-preview row all show the exact same string.
  const shareLink = buildShareLink();

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        dir={isRtl ? "rtl" : "ltr"}
        data-testid="audit-details-dialog"
        className="max-w-2xl max-h-[85vh] overflow-y-auto"
      >
        <DialogHeader className={isRtl ? "text-right sm:text-right" : undefined}>
          <DialogTitle className="flex items-center gap-2">
            <ScrollText className="h-5 w-5 text-primary" />
            {tr("detailsTitle")}
          </DialogTitle>
          <DialogDescription>
            {row ? (
              <span className="font-mono text-xs">
                {new Date(row.createdAt).toLocaleString(locale, { hour12: false })}
                {" · "}
                {trAction(row.action)}
                {row.module ? ` · ${row.module}` : ""}
              </span>
            ) : loading ? (
              <span className="text-xs text-muted-foreground">{tr("loadingEntry")}</span>
            ) : error ? (
              <span className="text-xs text-rose-600">{tr("loadEntryFailed")}</span>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {/* Loading / error states for the permalink fetch — we never block
            the listing UI, just the dialog body. */}
        {!row && loading && (
          <div className="py-8 flex justify-center" data-testid="audit-details-loading">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        )}
        {!row && !loading && error && (
          <div
            className="py-8 text-center text-rose-600 flex flex-col items-center gap-2"
            data-testid="audit-details-error"
          >
            <ShieldAlert className="h-8 w-8" />
            <span className="text-sm">{tr("loadEntryFailed")}</span>
            {entryId != null && (
              <span className="text-xs text-muted-foreground font-mono">#{entryId}</span>
            )}
          </div>
        )}

        {row && (
          <div className="space-y-4 text-sm">
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
              <DetailField label={tr("detailsUser")}>
                <span className="font-medium">{row.username ?? "—"}</span>
                {row.role && (
                  <span className="text-[10px] text-muted-foreground ms-1">({row.role})</span>
                )}
              </DetailField>
              <DetailField label={tr("detailsIp")}>
                <span className="font-mono text-xs">{row.ip ?? "—"}</span>
              </DetailField>
              <DetailField label={tr("detailsEntityType")}>
                {row.entityType ? (() => {
                  // Resolve the raw enum to the same translated friendly
                  // label the Markdown bulk-copy uses (task #148 dictionary
                  // at `adminPages.auditLog.entityTypes`), falling back to
                  // the raw machine value when no localisation is
                  // registered yet — keeps the field forward-compatible
                  // with future entity types without silently dropping
                  // info. The raw enum is still surfaced inline (in
                  // muted monospace, matching the role hint on the user
                  // field above) so power users debugging a fresh
                  // entityType can still see it. We collapse the
                  // secondary line when the friendly label is identical
                  // to the raw enum (e.g. `invoice` → "invoice" in
                  // English) to avoid noisy "invoice (invoice)" output.
                  const friendly = tr(`entityTypes.${row.entityType}`, {
                    defaultValue: row.entityType,
                  });
                  const showRaw = friendly !== row.entityType;
                  return (
                    <>
                      <span>{friendly}</span>
                      {showRaw && (
                        <span className="font-mono text-[10px] text-muted-foreground ms-1">
                          ({row.entityType})
                        </span>
                      )}
                    </>
                  );
                })() : (
                  <span className="font-mono text-xs">—</span>
                )}
              </DetailField>
              <DetailField label={tr("detailsEntityId")}>
                <div className="flex items-start gap-1.5">
                  <span className="font-mono text-xs break-all flex-1">{row.entityId ?? "—"}</span>
                  {row.entityId && (
                    <CopyIconButton
                      value={row.entityId}
                      label={tr("copyEntityId")}
                      tr={tr}
                      testId="audit-details-copy-entity-id"
                    />
                  )}
                </div>
              </DetailField>
              <DetailField label={tr("detailsStatusCode")}>
                {row.statusCode != null ? (
                  <span
                    data-testid="audit-details-status"
                    className={`font-mono text-xs ${ok ? "text-emerald-600" : "text-rose-600"}`}
                  >
                    {row.statusCode}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </DetailField>
              <DetailField label={tr("detailsPath")}>
                <div className="flex flex-col gap-1.5 flex-1">
                  {(() => {
                    const fp = friendlyPath(row.method, row.path);
                    if (!fp) return null;
                    return (
                      <div className="text-sm">
                        {fp.href ? (
                          <Link href={fp.href} className="text-blue-700 hover:text-blue-900 hover:underline font-medium">
                            {fp.label}
                          </Link>
                        ) : (
                          <span className="text-slate-700 font-medium">{fp.label}</span>
                        )}
                      </div>
                    );
                  })()}
                  <div className="flex items-start gap-1.5">
                    <span className="font-mono text-xs break-all flex-1 text-muted-foreground">
                      {row.method ? <span className="text-foreground/70">{row.method} </span> : null}
                      {row.path ?? "—"}
                    </span>
                    {pathCopyValue && (
                      <CopyIconButton
                        value={pathCopyValue}
                        label={tr("copyPath")}
                        tr={tr}
                        testId="audit-details-copy-path"
                      />
                    )}
                  </div>
                </div>
              </DetailField>
              <DetailField label={tr("detailsUserAgent")} fullWidth>
                <div className="flex items-start gap-1.5">
                  <span
                    data-testid="audit-details-user-agent"
                    className="font-mono text-xs break-all text-muted-foreground flex-1"
                  >
                    {row.userAgent ?? "—"}
                  </span>
                  {row.userAgent && (
                    <CopyIconButton
                      value={row.userAgent}
                      label={tr("copyUserAgent")}
                      tr={tr}
                      testId="audit-details-copy-user-agent"
                    />
                  )}
                </div>
              </DetailField>
            </dl>

            {row.action === "export_csv" ? (
              <CsvExportInspectorBody
                metadata={row.metadata}
                language={locale.startsWith("ar") ? "ar" : "en"}
                numberLocale={locale}
                showInlineTitle
                testIdPrefix="audit-details-export"
                rootTestId="audit-details-export-inspector"
              />
            ) : (
              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="text-xs font-medium text-muted-foreground">
                    {tr("detailsMetadata")}
                  </div>
                  {prettyMeta && (
                    <CopyIconButton
                      value={prettyMeta}
                      label={tr("copyMetadata")}
                      tr={tr}
                      testId="audit-details-copy-metadata"
                      showText
                    />
                  )}
                </div>
                {prettyMeta ? (
                  <pre
                    dir="ltr"
                    data-testid="audit-details-metadata"
                    className="text-xs font-mono bg-muted/40 border rounded p-3 overflow-x-auto whitespace-pre-wrap break-all max-h-80 overflow-y-auto"
                  >
                    {prettyMeta}
                  </pre>
                ) : (
                  <div className="text-xs text-muted-foreground italic">
                    {tr("detailsMetadataEmpty")}
                  </div>
                )}
              </div>
            )}

            {/* Permanent share link (task #126) — shows the full URL so the
                reviewer can spot-check it visually before sharing, with an
                inline copy button that puts the same string on the
                clipboard. The whole row is selectable text too, so a
                manual copy is always possible if the clipboard API is
                blocked. The copy button gets the same hover/focus preview
                tooltip as the row-level share-link button (task #155) so
                reviewers who opened the dialog from a permalink can also
                hover-confirm the entry before pasting. */}
            <div data-testid="audit-details-share">
              <div className="text-xs font-medium text-muted-foreground mb-1">
                {tr("detailsShareLink")}
              </div>
              <div className="flex items-start gap-1.5 bg-muted/40 border rounded p-2">
                <Link2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                <span
                  dir="ltr"
                  data-testid="audit-details-share-link"
                  className="font-mono text-xs break-all flex-1 select-all"
                >
                  {shareLink}
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* Span is the focus/hover target for Radix; the
                        inner button keeps its own click-to-copy behavior
                        untouched. `inline-flex` keeps the trigger box
                        collapsed around the icon button. */}
                    <span className="inline-flex">
                      <CopyIconButton
                        value={shareLink}
                        label={shareLinkLabelForRow(row)}
                        tr={tr}
                        testId="audit-details-copy-share-link"
                        showText
                      />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    align={isRtl ? "end" : "start"}
                    className="max-w-xs bg-background text-foreground border shadow-md p-2"
                    data-testid="audit-details-share-link-preview"
                  >
                    <div
                      dir={isRtl ? "rtl" : "ltr"}
                      className={`space-y-1 text-xs ${isRtl ? "text-right" : "text-left"}`}
                    >
                      <div className="font-medium text-foreground/90">
                        {tr("sharePreviewTitle")}
                      </div>
                      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                        <dt className="text-muted-foreground">{tr("sharePreviewId")}</dt>
                        <dd className="font-mono">{row.id}</dd>
                        <dt className="text-muted-foreground">{tr("sharePreviewAction")}</dt>
                        <dd>{trAction(row.action)}</dd>
                        <dt className="text-muted-foreground">{tr("sharePreviewModule")}</dt>
                        <dd className="font-mono break-all">{row.module}</dd>
                        <dt className="text-muted-foreground">{tr("sharePreviewTime")}</dt>
                        <dd className="font-mono">
                          {new Date(row.createdAt).toLocaleString(locale, { hour12: false })}
                        </dd>
                        <dt className="text-muted-foreground">{tr("sharePreviewLink")}</dt>
                        <dd className="font-mono break-all">{shareLink}</dd>
                      </dl>
                    </div>
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DetailField({
  label,
  children,
  fullWidth = false,
}: {
  label: string;
  children: React.ReactNode;
  fullWidth?: boolean;
}) {
  return (
    <div className={fullWidth ? "sm:col-span-2" : undefined}>
      <dt className="text-xs font-medium text-muted-foreground mb-0.5">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// Small reusable copy-to-clipboard button used inside the audit details
// dialog (metadata JSON, entityId, userAgent, request path) and on each
// audit row (share-link icon, task #131). It briefly swaps the icon to a
// check after a successful copy and surfaces a toast either way so the
// reviewer always gets confirmation.
//
// `showText` renders a textual "Copy" label next to the icon (used on the
// metadata panel header where there's room); the inline buttons next to
// long fields stay icon-only to keep the layout compact.
//
// `icon` overrides the default copy glyph (e.g. the row-level share-link
// button uses Link2 to match the task's "link/share icon" wording). The
// success-state `Check` is intentionally always the same so the visual
// confirmation is consistent regardless of which icon initiated the copy.
//
// The component uses logical sizing/flex so it aligns correctly in both
// LTR and RTL — the parent container's `dir` attribute already mirrors
// the row.
function CopyIconButton({
  value,
  label,
  tr,
  testId,
  showText = false,
  icon: Icon = Copy,
}: {
  value: string;
  label: string;
  tr: (k: string, opts?: any) => string;
  testId?: string;
  showText?: boolean;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = async () => {
    // Prefer the async Clipboard API; fall back to a hidden textarea +
    // execCommand for older / insecure-context browsers so the button still
    // works during local development over plain HTTP.
    let ok = false;
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === "function"
      ) {
        await navigator.clipboard.writeText(value);
        ok = true;
      } else if (typeof document !== "undefined") {
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.setAttribute("readonly", "");
        ta.style.position = "absolute";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      }
    } catch {
      ok = false;
    }

    if (ok) {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
      toast({
        title: tr("copySuccessTitle"),
        description: label,
      });
    } else {
      toast({
        title: tr("copyFailureTitle"),
        description: tr("copyFailureDescription"),
        variant: "destructive",
      });
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={handleCopy}
      aria-label={label}
      title={label}
      data-testid={testId}
      className={`h-7 ${showText ? "px-2" : "w-7 p-0"} shrink-0`}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-600" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      {showText && (
        <span className="ms-1 text-xs">
          {copied ? tr("copiedLabel") : tr("copyLabel")}
        </span>
      )}
    </Button>
  );
}
