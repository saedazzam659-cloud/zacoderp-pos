// Post-activation shell — Windows-desktop redesign.
//
// New layout:
//   • Left-side vertical navigation rail (Outlook/Teams/VS Code style)
//   • Top utility bar with company badge + sync indicator + mode chip
//   • Main content area that hosts the active page (sales / returns /
//     customers / items / uom / pending / dashboard)
//
// The doPull action now calls pullAndPersist (sync.ts) which writes the
// fetched customers + items into the local store. This was the missing
// step that caused "تم السحب: 5 عميل، 184 صنف" to show on the dashboard
// while the sales screen kept reporting "لا توجد أصناف".

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { createApi, type SyncStatus } from "../lib/api";
import { useCurrencySymbol, getCountryIso, setCountryIso, countryByIso, ARAB_COUNTRIES } from "../lib/currency";
import { SearchCombobox } from "./_adminUi";
import { TAURI_MODE, type CashierContext } from "../lib/tauri-shim";
import PeripheralsSettings from "./PeripheralsSettings";
import SalesScreen from "./SalesScreen";
import RegisterScreen from "./RegisterScreen";
import PendingInvoices from "./PendingInvoices";
import ParkedCarts from "./ParkedCarts";
import ReturnsScreen from "./ReturnsScreen";
import DailyReportPage from "./DailyReport";
import CustomersAdmin from "./CustomersAdmin";
import ItemsAdmin from "./ItemsAdmin";
import UomAdmin from "./UomAdmin";
import UpdatesScreen from "./UpdatesScreen";
import StandaloneUsersAdmin from "./StandaloneUsersAdmin";
import SuppliersAdmin from "./SuppliersAdmin";
import CashBoxesAdmin from "./CashBoxesAdmin";
import BanksAdmin from "./BanksAdmin";
import CurrenciesAdmin from "./CurrenciesAdmin";
import ExchangeRatesAdmin from "./ExchangeRatesAdmin";
import TreasuryTransfersAdmin from "./TreasuryTransfersAdmin";
import ChartOfAccounts from "./ChartOfAccounts";
import JournalEntries from "./JournalEntries";
import CostCentersAdmin from "./CostCentersAdmin";
import BranchesAdmin from "./BranchesAdmin";
import TaxesAdmin from "./TaxesAdmin";
import AccountStatementReport from "./AccountStatementReport";
import IncomeStatementReport from "./IncomeStatementReport";
import BalanceSheetReport from "./BalanceSheetReport";
import TrialBalanceReport from "./TrialBalanceReport";
import PurchasesAdmin from "./PurchasesAdmin";
import SalesInvoicesAdmin from "./SalesInvoicesAdmin";
import QuotationsAdmin from "./QuotationsAdmin";
import SalesOrdersAdmin from "./SalesOrdersAdmin";
import DailySalesReport from "./DailySalesReport";
import SalesByPeriodReport from "./SalesByPeriodReport";
import SalesByItemReport from "./SalesByItemReport";
import SalesByCustomerReport from "./SalesByCustomerReport";
import DailyDetailedSalesReport from "./DailyDetailedSalesReport";
import SalesByPaymentMethodReport from "./SalesByPaymentMethodReport";
import SalesReturnsReport from "./SalesReturnsReport";
import TopCustomersReport from "./TopCustomersReport";
import SalespersonsAdmin from "./SalespersonsAdmin";
import SalesReturnsAdmin from "./SalesReturnsAdmin";
import WarehousesAdmin from "./WarehousesAdmin";
import StocktakesAdmin from "./StocktakesAdmin";
import StockAdjustmentsAdmin from "./StockAdjustmentsAdmin";
import StockMovementsReport from "./StockMovementsReport";
import StockTransfersAdmin from "./StockTransfersAdmin";
import PurchaseReturnsAdmin from "./PurchaseReturnsAdmin";
import FinancialTransactionsAdmin from "./FinancialTransactionsAdmin";
import UserPermissionsAdmin from "./UserPermissionsAdmin";
import NumberSeriesAdmin from "./NumberSeriesAdmin";
import SettingsGuide from "./SettingsGuide";
import ZatcaOnboarding from "./ZatcaOnboarding";
import { isZatcaCountry } from "../lib/zatcaBridge";
import {
  listUserPermissions, computeAllowed, persistAllowedToLS, clearAllowedLS,
  loadAllowedFromLS, defaultsForRole, type ScreenKey,
} from "../lib/permissions";
import { type WindowsView, type AppProfile } from "../lib/moduleRegistry";
import { isModuleEnabled, loadWindowsModuleFlags } from "../lib/windowsModules";
import { getAppProfile } from "../lib/standalone";
import ExpiryReport from "./ExpiryReport";
import StockImport from "./StockImport";
import InvoiceImport from "./InvoiceImport";
import LowStockReport, { countLowStockTracked } from "./LowStockReport";
import { listItems, bulkImportLocalItems, type CreateItemInput } from "../lib/items";
import { useTaxSettings, defaultRateForCountry } from "../lib/taxSettings";
import ScaleSettings from "./ScaleSettings";
import NetworkSettings from "./NetworkSettings";
import { countPendingInvoices } from "../lib/invoices";
import { getVertical, usesNewRegisterScreen, type Vertical } from "../lib/standalone";
import { syncPushNow, pullAndPersist, type PushSummary, type PullSummary } from "../lib/sync";
import { listParkedCarts } from "../lib/parkedCarts";
import { flushPendingSessionCloses, countPendingCloses } from "../lib/pendingSessionCloses";
import { useLatestVersion, APP_VERSION } from "../lib/updates";
import type { OfflineLicensePayload, LocalSession } from "../lib/standalone";

// Task #226 — the View union now lives in lib/moduleRegistry.ts (single source
// of truth that also carries each screen's module key + app profile). Aliased
// here as `View` so the rest of this file is unchanged.
type View = WindowsView;

/** Minimal CSV parser for the bundled starter catalogs (no quotes/escapes
 *  expected — files are repo-controlled). Returns CreateItemInput rows. */
function parseCatalogCsv(text: string): CreateItemInput[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idx = (n: string) => header.indexOf(n);
  const cCode = idx("code");
  const cAr = idx("namear");
  const cEn = idx("nameen");
  const cBc = idx("barcode");
  const cPrice = idx("saleprice");
  const cVat = idx("vatrate");
  const out: CreateItemInput[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",").map((c) => c.trim());
    const nameAr = cAr >= 0 ? cells[cAr] : "";
    const price = cPrice >= 0 ? Number(cells[cPrice]) : NaN;
    if (!nameAr || !Number.isFinite(price)) continue;
    out.push({
      code: cCode >= 0 && cells[cCode] ? cells[cCode] : null,
      nameAr,
      nameEn: cEn >= 0 && cells[cEn] ? cells[cEn] : null,
      barcode: cBc >= 0 && cells[cBc] ? cells[cBc] : null,
      salePrice: price,
      vatRate: cVat >= 0 && cells[cVat] ? Number(cells[cVat]) : 15,
    });
  }
  return out;
}

function verticalLabel(v: Vertical): string {
  switch (v) {
    case "grocery": return "بقالة";
    case "retail": return "تجزئة";
    case "restaurant": return "مطاعم";
    case "pharmacy": return "صيدلية";
    case "plumbing": return "أدوات صحية وسباكة";
    case "paints": return "دهانات وأصباغ";
    case "auto_parts": return "قطع غيار سيارات";
    case "auto_workshop": return "ورشة سيارات";
    case "mobiles": return "موبايلات وإكسسوارات";
    default: return "عام";
  }
}

type Props = {
  baseUrl: string;
  deviceToken: string;
  userToken?: string;
  cashierContext?: CashierContext | null;
  companyName?: string;
  deviceId: number;
  expiresAt?: string | null;
  onSignOut: () => void | Promise<void>;
  onLogoutCashier?: () => void | Promise<void>;
  /** Task #199: when true, render in standalone (no-cloud) mode. */
  standalone?: boolean;
  standaloneLicense?: OfflineLicensePayload;
  standaloneSession?: LocalSession;
};

// ── Sidebar groups (standalone mode) ────────────────────────────────────
// The standalone (Windows) nav has ~30 screens. Per user request they are
// organised into collapsible top-level groups that behave as an ACCORDION:
// opening one group closes any other (single `openGroup` state). Screens not
// listed in any group (sales, returns, parked, daily, customers, scale,
// expiry …) stay as flat top-level entries. A group is rendered only
// when at least one of its members is actually present in the (perm-filtered)
// nav list, so it disappears entirely for users without access.
type NavGroupDef = {
  key: string;
  icon: string;
  label: string;
  members: View[];
  // Optional sub-section labels rendered (non-clickable) before a given member.
  subHeaders?: Partial<Record<View, string>>;
};
const NAV_GROUPS: NavGroupDef[] = [
  {
    key: "pos",
    icon: "🛒",
    label: "نقاط بيع",
    members: ["sales", "returns", "parked", "daily"],
  },
  {
    key: "inventory",
    icon: "🏬",
    label: "المخازن",
    members: [
      "items", "uom", "warehouses", "stock_transfers",
      "stocktakes", "stock_adjustments", "stock_movements", "low_stock",
      "stock_import",
    ],
  },
  {
    key: "selling",
    icon: "🧾",
    label: "المبيعات والعملاء",
    members: ["customers", "salespersons", "quotations", "sales_orders", "sales_invoices", "sales_returns", "invoice_import", "report_sales_daily", "report_sales_by_period", "report_sales_by_item", "report_sales_by_customer", "report_sales_daily_detailed", "report_sales_payment_mix", "report_sales_returns", "report_sales_top_customers"],
  },
  {
    key: "purchasing",
    icon: "🛒",
    label: "المشتريات والموردون",
    members: ["suppliers", "purchases", "purchase_returns"],
  },
  {
    key: "cash_banks",
    icon: "🏦",
    label: "النقد والبنوك",
    members: ["banks", "cash_boxes", "financial_tx", "treasury_transfers"],
  },
  {
    key: "accounts",
    icon: "🧮",
    label: "الحسابات العامة",
    members: [
      "chart_of_accounts", "journal_entries", "cost_centers", "taxes",
      "report_account_statement", "report_income_statement",
      "report_balance_sheet", "report_trial_balance",
    ],
    subHeaders: { report_account_statement: "التقارير المالية" },
  },
  {
    key: "control",
    icon: "⚙️",
    label: "التحكم العام",
    members: [
      "scale", "branches", "currencies", "exchange_rates", "dashboard",
      "users", "user_permissions", "network", "number_series", "settings_guide", "zatca", "updates",
    ],
  },
];
// Reverse lookup: view id → group key (for auto-expanding the active group).
const VIEW_TO_GROUP: Partial<Record<View, string>> = Object.fromEntries(
  NAV_GROUPS.flatMap((g) => g.members.map((m) => [m, g.key])),
) as Partial<Record<View, string>>;

export default function PosShell({
  baseUrl, deviceToken, userToken, cashierContext,
  companyName, deviceId, expiresAt, onSignOut, onLogoutCashier,
  standalone = false, standaloneLicense, standaloneSession,
}: Props) {
  const api = useMemo(
    () => standalone ? null : createApi({ baseUrl, deviceToken, userToken: userToken ?? null }),
    [baseUrl, deviceToken, userToken, standalone],
  );
  // In standalone mode there is no pos_sessions row — use a synthetic session id
  // (1) so parked-carts scope still works (single virtual session per machine).
  const posSessionId = standalone ? 1 : (cashierContext?.posSessionId ?? 0);
  // Standalone topbar must NOT show any company/customer identity (per spec).
  const effectiveCompanyName = standalone
    ? undefined
    : (companyName ?? cashierContext?.companyName);
  const effectiveCashierName = standalone
    ? (standaloneSession?.displayName ?? standaloneSession?.username)
    : (cashierContext?.nameAr || cashierContext?.username);

  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [pulled, setPulled] = useState<PullSummary | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [heartbeatErr, setHeartbeatErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showPeripherals, setShowPeripherals] = useState(false);
  const [view, setView] = useState<View>("sales");
  // Drill-down target: set when a COA balance pill is clicked, consumed by
  // AccountStatementReport to preselect + auto-run for that account.
  const [stmtAccountId, setStmtAccountId] = useState<number | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [parkedCount, setParkedCount] = useState(0);
  const [pushSummary, setPushSummary] = useState<PushSummary | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  // Sidebar accordion (standalone): only ONE group open at a time. `null` =
  // all collapsed. Auto-opens the group that owns the active view so the
  // current screen is always revealed in the sidebar.
  const [openGroup, setOpenGroup] = useState<string | null>(
    () => VIEW_TO_GROUP[view] ?? null,
  );
  useEffect(() => {
    const g = VIEW_TO_GROUP[view];
    if (g) setOpenGroup(g);
  }, [view]);
  const { latest: latestRelease, isNewer: updateAvailable } = useLatestVersion(baseUrl);
  // Vertical preset (Task #200) — drives pharmacy-only nav (تقرير الصلاحية).
  // Read once on mount; switching verticals requires a re-launch.
  const [vertical, setVerticalState] = useState<Vertical>("general");
  useEffect(() => { void getVertical().then((v) => v && setVerticalState(v)); }, []);
  const isPharmacy = vertical === "pharmacy";

  // Task #207 — allowed-screens set for the current user. Admins always see
  // everything; cashiers start from ROLE_DEFAULTS.cashier and the admin can
  // grant/revoke individual screens via UserPermissionsAdmin. Cached in LS so
  // the sidebar renders immediately on reload without waiting for SQLite.
  const [allowed, setAllowed] = useState<Set<ScreenKey>>(
    () => loadAllowedFromLS() ?? defaultsForRole("admin"),
  );
  useEffect(() => {
    if (!standalone || !standaloneSession) return;
    const role = standaloneSession.role;
    let cancelled = false;
    void (async () => {
      try {
        const overrides = role === "cashier"
          ? await listUserPermissions(standaloneSession.userId)
          : [];
        if (cancelled) return;
        const next = computeAllowed(role, overrides);
        persistAllowedToLS(next);
        setAllowed(new Set(next));
      } catch {
        const fallback = computeAllowed(role, []);
        if (!cancelled) { persistAllowedToLS(fallback); setAllowed(new Set(fallback)); }
      }
    })();
    return () => { cancelled = true; };
  }, [standalone, standaloneSession]);
  const can = useCallback((k: ScreenKey) => allowed.has(k), [allowed]);

  // Task #226 — module/profile visibility gate, additive to `can()`:
  //   • profile  — the first-run "POS only vs Full ERP" choice.
  //   • flags     — the SuperAdmin-pushed per-company module map (cloud only).
  // Both are refreshed on mount; `flags` also after every pull (see pull effect).
  const [appProfile, setAppProfileState] = useState<AppProfile | null>(null);
  const [moduleFlags, setModuleFlags] = useState<Record<string, boolean>>(
    () => loadWindowsModuleFlags(),
  );
  useEffect(() => { void getAppProfile().then(setAppProfileState); }, []);
  const moduleVisible = useCallback(
    (v: View) => isModuleEnabled(v, { profile: appProfile, standalone, flags: moduleFlags }),
    [appProfile, standalone, moduleFlags],
  );
  // If the active screen becomes gated (profile change / SuperAdmin disabled the
  // module mid-session), fall back to the always-available sales register.
  useEffect(() => {
    if (!moduleVisible(view)) setView("sales");
  }, [moduleVisible, view]);

  // Low-stock count drives the sidebar badge under "أصناف تحت الحد".
  // Refreshed on view-switch (cheap) + after import/sale (no realtime needed).
  const [lowStockCount, setLowStockCount] = useState(0);
  const refreshLowStock = useCallback(async () => {
    try {
      const items = await listItems();
      setLowStockCount(await countLowStockTracked(items));
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { void refreshLowStock(); }, [view, refreshLowStock]);

  // ─── First-run catalog auto-import ────────────────────────────────
  // Triggered ONCE per device after the vertical is known. Skipped when
  // the user already has any items (cloud-pulled or self-created), and
  // pharmacy users get the EDA manual button instead (catalog is too
  // large to auto-import without consent).
  useEffect(() => {
    if (vertical === "general") return;
    const FLAG = "pos_desktop_catalog_auto_imported_v1";
    if (localStorage.getItem(FLAG)) return;
    const catalogFile: Record<string, string | undefined> = {
      grocery: "grocery_starter.csv",
      retail: "retail_starter.csv",
      restaurant: "restaurant_starter.csv",
      // pharmacy: handled by the prominent "💊 استيراد EDA" button in ItemsAdmin.
    };
    const file = catalogFile[vertical];
    if (!file) { localStorage.setItem(FLAG, new Date().toISOString()); return; }
    let cancelled = false;
    void (async () => {
      try {
        // Only auto-import into a fresh device — never on top of an existing catalog.
        const existing = await listItems();
        // listItems() falls back to a 6-row demo when empty, so treat ≤6 as "empty".
        if (existing.length > 6) {
          localStorage.setItem(FLAG, new Date().toISOString());
          return;
        }
        const baseUrl = (import.meta as any).env?.BASE_URL ?? "/";
        const res = await fetch(`${baseUrl}catalogs/${file}`);
        if (!res.ok) return; // silent — operator can import manually later
        const text = await res.text();
        const rows = parseCatalogCsv(text);
        if (rows.length === 0) return;
        const { inserted } = await bulkImportLocalItems(rows, { dedupBy: "barcode" });
        if (cancelled) return;
        localStorage.setItem(FLAG, new Date().toISOString());
        if (inserted > 0) {
          setAutoImportToast(`تم تحميل ${inserted} صنف من كتالوج «${verticalLabel(vertical)}» — يمكنك تعديلها من شاشة الأصناف`);
        }
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [vertical]);

  const [autoImportToast, setAutoImportToast] = useState<string | null>(null);

  const refreshParkedCount = useCallback(async () => {
    if (!posSessionId) { setParkedCount(0); return; }
    try { setParkedCount((await listParkedCarts(posSessionId)).length); }
    catch { /* ignore — view itself surfaces errors */ }
  }, [posSessionId]);

  // Re-count parked carts when switching views (cheap, scoped to session).
  useEffect(() => { void refreshParkedCount(); }, [view, refreshParkedCount]);

  useEffect(() => {
    if (standalone) return; // No cloud "pending invoices" queue in standalone mode.
    let cancelled = false;
    const tick = async () => {
      try { const n = await countPendingInvoices(); if (!cancelled) setPendingCount(n); }
      catch { /* ignore */ }
    };
    void tick();
    const id = setInterval(tick, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [view, standalone]);

  useEffect(() => {
    if (standalone || !api) return; // Standalone never talks to the cloud.
    const tick = async () => {
      try {
        await api.heartbeat({
          appVersion: "0.6.0",
          ...(posSessionId ? { posSessionId } : {}),
        });
        const s = await api.status();
        setStatus(s); setHeartbeatErr(null);
        if (countPendingCloses() > 0) {
          try { await flushPendingSessionCloses(api); } catch { /* logged inside */ }
        }
      } catch (e: any) { setHeartbeatErr(e?.message ?? "heartbeat failed"); }
    };
    void tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [api, posSessionId, standalone]);

  async function doPull() {
    if (standalone) return;
    setBusy("pull"); setActionErr(null);
    try {
      const r = await pullAndPersist(baseUrl, deviceToken);
      setPulled(r);
      // Task #226 — pull persists the SuperAdmin module flags; reflect them now.
      setModuleFlags(loadWindowsModuleFlags());
    } catch (e: any) { setActionErr(e?.message ?? "pull failed"); }
    finally { setBusy(null); }
  }

  async function doPush() {
    if (standalone) return;
    setBusy("push"); setActionErr(null); setPushSummary(null);
    try {
      const r = await syncPushNow(baseUrl, deviceToken);
      setPushSummary(r);
      try { setPendingCount(await countPendingInvoices()); } catch { /* ignore */ }
    } catch (e: any) { setActionErr(e?.message ?? "push failed"); }
    finally { setBusy(null); }
  }

  async function doDeactivate() {
    if (standalone || !api) {
      // In standalone mode "deactivate" means "wipe everything and pick mode again".
      await onSignOut();
      return;
    }
    if (!confirm("هل أنت متأكد من إلغاء تفعيل هذا الجهاز؟ ستحتاج لمفتاح ترخيص جديد لإعادة التفعيل.")) return;
    setBusy("deactivate"); setActionErr(null);
    try {
      await api.deactivate();
      await onSignOut();
    } catch (e: any) { setActionErr(e?.message ?? "deactivate failed"); setBusy(null); }
  }

  async function doLogoutCashier() {
    if (!onLogoutCashier) return;
    if (!confirm("هل تريد تسجيل خروج الكاشير الحالي وإغلاق الوردية؟")) return;
    setLoggingOut(true);
    try {
      // Drop the cached allowed-screens set so the next user starts fresh.
      clearAllowedLS();
      await onLogoutCashier();
    }
    catch (e: any) { setActionErr(e?.message ?? "logout failed"); setLoggingOut(false); }
  }

  // Cloud-only nav entries hidden in standalone mode:
  //   • pending (cloud upload queue), dashboard (sync controls), updates (cloud release feed)
  // Standalone gains: users (local user admin, admin role only).
  const isAdmin = standaloneSession?.role === "admin";
  const standaloneNav: Array<{ id: View; icon: string; label: string; badge?: number; perm?: ScreenKey; adminOnly?: boolean }> = [
    { id: "sales",            icon: "🛒", label: "بيع", perm: "sales" },
    { id: "returns",          icon: "↩️", label: "مرتجع", perm: "returns" },
    { id: "parked",           icon: "📌", label: "السلال المعلّقة", badge: parkedCount > 0 ? parkedCount : undefined, perm: "parked" },
    { id: "daily",            icon: "📊", label: "تقرير اليومية", perm: "daily" },
    { id: "customers",        icon: "👥", label: "العملاء", perm: "customers" },
    { id: "suppliers",        icon: "🏭", label: "الموردون", perm: "suppliers" },
    { id: "items",            icon: "📦", label: "الأصناف", perm: "items" },
    { id: "stock_import",     icon: "📥", label: "استيراد الأرصدة", perm: "stock_import" },
    { id: "low_stock",        icon: "⚠️", label: "أصناف تحت الحد", badge: lowStockCount > 0 ? lowStockCount : undefined, perm: "low_stock" },
    { id: "uom",              icon: "📐", label: "وحدات القياس", perm: "uom" },
    { id: "purchases",        icon: "🧾", label: "فواتير الشراء", perm: "purchases" },
    { id: "purchase_returns", icon: "🔁", label: "مرتجع الشراء", perm: "purchase_returns" },
    { id: "salespersons",     icon: "🧑‍💼", label: "مندوبو المبيعات", perm: "salespersons" },
    { id: "quotations",       icon: "📝", label: "عروض الأسعار", perm: "quotations" },
    { id: "sales_orders",     icon: "📋", label: "أوامر البيع", perm: "sales_orders" },
    { id: "sales_invoices",   icon: "🧾", label: "فواتير المبيعات", perm: "sales_invoices" },
    { id: "sales_returns",    icon: "🔁", label: "مرتجع المبيعات", perm: "sales_returns" },
    { id: "invoice_import",   icon: "📂", label: "استيراد الفواتير", perm: "invoice_import" },
    { id: "report_sales_daily",       icon: "📅", label: "تقرير المبيعات اليومي", perm: "report_sales_daily" },
    { id: "report_sales_by_period",   icon: "🗓️", label: "المبيعات حسب الفترة", perm: "report_sales_by_period" },
    { id: "report_sales_by_item",     icon: "📦", label: "المبيعات حسب الصنف", perm: "report_sales_by_item" },
    { id: "report_sales_by_customer", icon: "👥", label: "المبيعات حسب العميل", perm: "report_sales_by_customer" },
    { id: "report_sales_daily_detailed", icon: "📑", label: "المبيعات اليومي التفصيلي", perm: "report_sales_daily_detailed" },
    { id: "report_sales_payment_mix", icon: "💳", label: "المبيعات حسب طريقة الدفع", perm: "report_sales_payment_mix" },
    { id: "report_sales_returns", icon: "↩️", label: "مرتجعات المبيعات", perm: "report_sales_returns" },
    { id: "report_sales_top_customers", icon: "🏆", label: "أفضل العملاء", perm: "report_sales_top_customers" },
    { id: "cash_boxes",       icon: "💰", label: "الخزن", perm: "cash_boxes" },
    { id: "banks",            icon: "🏦", label: "البنوك", perm: "banks" },
    { id: "financial_tx",     icon: "💸", label: "المعاملات المالية", perm: "financial_tx" },
    { id: "treasury_transfers", icon: "🔁", label: "تحويل الخزن", perm: "treasury_transfers" },
    { id: "currencies",       icon: "🌐", label: "العملات", perm: "currencies" },
    { id: "exchange_rates",   icon: "💱", label: "أسعار الصرف", perm: "exchange_rates" },
    { id: "chart_of_accounts",icon: "🌳", label: "شجرة الحسابات", perm: "chart_of_accounts" },
    { id: "journal_entries",  icon: "📒", label: "القيود اليومية", perm: "journal_entries" },
    { id: "cost_centers",     icon: "🎯", label: "مراكز التكلفة", perm: "cost_centers" },
    { id: "taxes",            icon: "🧾", label: "الضرائب", perm: "taxes" },
    { id: "report_account_statement", icon: "📄", label: "كشف حساب", perm: "report_account_statement" },
    { id: "report_income_statement",  icon: "📈", label: "قائمة الدخل", perm: "report_income_statement" },
    { id: "report_balance_sheet",     icon: "⚖️", label: "الميزانية", perm: "report_balance_sheet" },
    { id: "report_trial_balance",     icon: "📊", label: "ميزان المراجعة بالمجاميع", perm: "report_trial_balance" },
    { id: "branches",         icon: "🏢", label: "الفروع", perm: "branches" },
    { id: "warehouses",        icon: "🏬", label: "المخازن", perm: "warehouses" },
    { id: "stocktakes",        icon: "📋", label: "الجرد", perm: "stocktakes" },
    { id: "stock_adjustments", icon: "⚖️", label: "تسوية المخزون", perm: "stock_adjustments" },
    { id: "stock_movements",   icon: "📈", label: "حركة المخزون", perm: "stock_movements" },
    { id: "stock_transfers",   icon: "🔄", label: "التحويل بين المخازن", perm: "stock_transfers" },
    { id: "scale",            icon: "⚖️", label: "الميزان", perm: "scale" },
    ...(isAdmin ? [{ id: "network" as View, icon: "🌐", label: "مشاركة الشبكة", adminOnly: true }] : []),
    ...(isPharmacy ? [{ id: "expiry" as View, icon: "⏳", label: "تقرير الصلاحية", perm: "expiry" as ScreenKey }] : []),
    ...(isAdmin
      ? [
          { id: "users" as View,            icon: "🔐", label: "المستخدمون", adminOnly: true },
          { id: "number_series" as View,    icon: "🔢", label: "أرقام المسلسلات", adminOnly: true },
          { id: "user_permissions" as View, icon: "🛡️", label: "صلاحيات المستخدمين", adminOnly: true },
        ]
      : []),
    { id: "dashboard", icon: "⚙️", label: "لوحة التحكم" },
    { id: "settings_guide", icon: "🏢", label: "دليل الإعدادات", perm: "settings_guide" },
    ...(isZatcaCountry()
      ? [{ id: "zatca" as View, icon: "🧾", label: "تسجيل زاتكا (مستقل)", perm: "zatca" as const }]
      : []),
    // Updates entry — even standalone users want to install newer app
    // versions (the device usually has occasional internet for this).
    // The Updates screen itself gracefully handles offline by showing
    // an error and a manual-download link.
    { id: "updates",   icon: "🔄", label: "التحديثات" },
  ];
  const navItemsRaw: Array<{ id: View; icon: string; label: string; badge?: number }> = standalone
    ? standaloneNav
        .filter((it) => it.adminOnly ? isAdmin : (it.perm ? (isAdmin || can(it.perm)) : true))
        .map(({ id, icon, label, badge }) => ({ id, icon, label, badge }))
    : [
    { id: "sales",     icon: "🛒", label: "بيع" },
    { id: "returns",   icon: "↩️", label: "مرتجع" },
    { id: "parked",    icon: "📌", label: "السلال المعلّقة", badge: parkedCount > 0 ? parkedCount : undefined },
    { id: "pending",   icon: "📋", label: "الفواتير غير المرفوعة", badge: pendingCount > 0 ? pendingCount : undefined },
    { id: "daily",     icon: "📊", label: "تقرير اليومية" },
    { id: "customers", icon: "👥", label: "العملاء" },
    { id: "items",     icon: "📦", label: "الأصناف" },
    { id: "stock_import", icon: "📥", label: "استيراد الأرصدة" },
    { id: "invoice_import", icon: "📂", label: "استيراد الفواتير" },
    { id: "low_stock", icon: "⚠️", label: "أصناف تحت الحد", badge: lowStockCount > 0 ? lowStockCount : undefined },
    { id: "uom",       icon: "📐", label: "وحدات القياس" },
    { id: "scale",     icon: "⚖️", label: "الميزان" },
    { id: "network",   icon: "🌐", label: "مشاركة الشبكة" },
    ...(isPharmacy ? [{ id: "expiry" as View, icon: "⏳", label: "تقرير الصلاحية" }] : []),
    { id: "dashboard", icon: "📊", label: "لوحة التحكم" },
    { id: "updates",   icon: "🔄", label: "التحديثات" },
  ];
  // Task #226 — apply the module/profile gate on top of the per-user `can()`
  // filter above. Hides ERP-only screens in the POS-only profile and any module
  // the SuperAdmin disabled for this company (cloud mode).
  const navItems = navItemsRaw.filter((it) => moduleVisible(it.id));

  return (
    <div dir="rtl" style={S.shell}>

      {/* ─── Main column ───────────────────────────────────── */}
      <div style={S.main}>
        {/* ─── Single top bar: brand + menu + controls merged into ONE row
            (the old white utility bar was removed to free a full row for the
            POS screen, per user request). ─── */}
        <nav style={S.topnav}>
          <div style={S.topnavBrand} title={`ZACOD POS v${APP_VERSION}`}>
            <span style={S.topnavBrandIcon}>Z</span>
          </div>
          <div style={S.topnavItems}>
            {(() => {
              const renderTopLeaf = (it: { id: View; icon: string; label: string; badge?: number }) => {
                const active = view === it.id;
                return (
                  <button key={it.id} onClick={() => { setView(it.id); setOpenGroup(null); }}
                    style={active ? S.topLeafActive : S.topLeaf} title={it.label}>
                    <span style={{ fontSize: 13 }}>{it.icon}</span>
                    <span>{it.label}</span>
                    {it.badge !== undefined && <span style={S.topBadge}>{it.badge}</span>}
                  </button>
                );
              };

              if (!standalone) {
                return navItems.map((it) => renderTopLeaf(it));
              }

              const byId = new Map(navItems.map((it) => [it.id, it] as const));
              const grouped = new Set<View>(NAV_GROUPS.flatMap((g) => g.members));
              const topLeaves = navItems.filter((it) => !grouped.has(it.id));
              const PRIMARY: View[] = ["sales", "returns", "parked", "pending", "daily", "customers"];
              const primaryLeaves = topLeaves.filter((it) => PRIMARY.includes(it.id));
              const trailingLeaves = topLeaves.filter((it) => !PRIMARY.includes(it.id));

              return (
                <>
                  {primaryLeaves.map((it) => renderTopLeaf(it))}
                  {primaryLeaves.length > 0 && <span style={S.topnavDivider} />}
                  {NAV_GROUPS.map((g) => {
                    const children = g.members
                      .map((m) => byId.get(m))
                      .filter((x): x is NonNullable<typeof x> => x != null);
                    if (children.length === 0) return null;
                    const isOpen = openGroup === g.key;
                    const hasActive = children.some((c) => c.id === view);
                    const badgeTotal = children.reduce((sum, c) => sum + (c.badge ?? 0), 0);
                    return (
                      <div key={g.key} style={{ position: "relative" }}>
                        <button onClick={() => setOpenGroup((prev) => (prev === g.key ? null : g.key))}
                          style={(isOpen || hasActive) ? S.topGroupActive : S.topGroup}
                          aria-expanded={isOpen} title={g.label}>
                          <span style={{ fontSize: 13 }}>{g.icon}</span>
                          <span>{g.label}</span>
                          {!isOpen && badgeTotal > 0 && <span style={S.topBadge}>{badgeTotal}</span>}
                          <span style={{ fontSize: 9, transform: isOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }}>▾</span>
                        </button>
                        {isOpen && (
                          <div style={S.dropdownPanel}>
                            {children.map((it) => {
                              const sub = g.subHeaders?.[it.id];
                              const active = view === it.id;
                              return (
                                <Fragment key={it.id}>
                                  {sub && <div style={S.dropdownSub}>{sub}</div>}
                                  <button onClick={() => { setView(it.id); setOpenGroup(null); }}
                                    style={active ? S.dropdownItemActive : S.dropdownItem}>
                                    <span style={{ fontSize: 14, width: 22, textAlign: "center" }}>{it.icon}</span>
                                    <span style={{ flex: 1 }}>{it.label}</span>
                                    {it.badge !== undefined && <span style={S.topBadge}>{it.badge}</span>}
                                  </button>
                                </Fragment>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {trailingLeaves.length > 0 && <span style={S.topnavDivider} />}
                  {trailingLeaves.map((it) => renderTopLeaf(it))}
                </>
              );
            })()}
          </div>
          {/* Right-side controls (moved here from the old white top bar) */}
          <div style={S.topnavControls}>
            <ExpiryBanner expiresAt={expiresAt ?? null} compact />
            <button onClick={() => setShowPeripherals(true)} style={S.periphBtn} title="الأجهزة الطرفية">🖨️</button>
            {cashierContext && !standalone && (
              <div style={S.cashierChip} title={`جلسة #${cashierContext.posSessionId} — مفتوحة منذ ${new Date(cashierContext.openedAt).toLocaleString("ar-SA")}`}>
                <span style={S.cashierIcon}>👤</span>
                <div style={S.cashierInfo}>
                  <div style={S.cashierName}>{cashierContext.nameAr || cashierContext.username}</div>
                  <div style={S.cashierMeta}>
                    {cashierContext.branchName ?? "—"}
                    {cashierContext.posTerminalName ? ` · ${cashierContext.posTerminalName}` : ""}
                  </div>
                </div>
              </div>
            )}
            {standalone && standaloneSession && (
              <div style={S.cashierChip} title={`مستخدم محلي — دخل في ${new Date(standaloneSession.signedInAt).toLocaleString("ar-SA")}`}>
                <span style={S.cashierIcon}>👤</span>
                <div style={S.cashierInfo}>
                  <div style={S.cashierName}>{standaloneSession.displayName || standaloneSession.username}</div>
                  <div style={S.cashierMeta}>
                    {standaloneSession.role === "admin" ? "مسؤول" : "كاشير"} · مستقل
                  </div>
                </div>
              </div>
            )}
            {!standalone && <SyncIndicator status={status} heartbeatErr={heartbeatErr} />}
            {!standalone && <div style={S.deviceChip}>جهاز #{deviceId || "—"}</div>}
            {standalone && <div style={S.deviceChip} title={standaloneLicense?.licenseKey}>🔐 ترخيص مستقل</div>}
            {onLogoutCashier && (
              <button onClick={doLogoutCashier} disabled={loggingOut} style={S.logoutBtn}
                      title={standalone ? "تسجيل خروج المستخدم" : "تسجيل خروج الكاشير وإغلاق الوردية"}>
                {loggingOut ? "..." : "🚪 خروج"}
              </button>
            )}
          </div>
        </nav>
        {openGroup && <div style={S.dropdownOverlay} onClick={() => setOpenGroup(null)} />}

        {/* New-version notification banner (Task #187). Cloud-only. */}
        {!standalone && updateAvailable && latestRelease && !updateDismissed && (
          <UpdateBanner
            version={latestRelease.version}
            onOpen={() => setView("updates")}
            onDismiss={() => setUpdateDismissed(true)}
          />
        )}

        {/* Subscription-expiry warning is now rendered inline inside the
            topbar above (compact pill). No separate row here. */}

        {autoImportToast && (
          <div style={S.autoImportBanner}>
            <span style={{ fontSize: 18 }}>📥</span>
            <span style={{ flex: 1 }}>{autoImportToast}</span>
            <button onClick={() => setAutoImportToast(null)} style={S.autoImportClose}>إغلاق</button>
          </div>
        )}

        {/* Page content */}
        <main style={S.content}>
          {view === "sales" && (
            usesNewRegisterScreen(vertical)
              ? <RegisterScreen companyName={effectiveCompanyName} posSessionId={posSessionId} cashierName={effectiveCashierName} />
              : <SalesScreen companyName={effectiveCompanyName} posSessionId={posSessionId} cashierName={effectiveCashierName} />
          )}
          {view === "returns" && <div style={S.pagePad}><ReturnsScreen companyName={effectiveCompanyName} cashierName={effectiveCashierName} /></div>}
          {!standalone && view === "pending" && <div style={S.pagePad}><PendingInvoices companyName={effectiveCompanyName} /></div>}
          {view === "parked" && (
            <div style={S.pagePad}>
              <ParkedCarts posSessionId={posSessionId} onResume={() => setView("sales")} />
            </div>
          )}
          {view === "daily" && (
            <div style={S.pagePad}>
              <DailyReportPage companyName={effectiveCompanyName} cashierName={effectiveCashierName} />
            </div>
          )}
          {view === "customers" && <div style={S.pagePad}><CustomersAdmin /></div>}
          {view === "items" && <div style={S.pagePad}><ItemsAdmin /></div>}
          {view === "stock_import" && <div style={S.pagePad}><StockImport onDone={() => void refreshLowStock()} /></div>}
          {view === "invoice_import" && <div style={S.pagePad}><InvoiceImport sellerName={effectiveCompanyName} /></div>}
          {view === "low_stock" && <div style={S.pagePad}><LowStockReport onGoToImport={() => setView("stock_import")} /></div>}
          {view === "uom" && <div style={S.pagePad}><UomAdmin /></div>}
          {view === "scale" && <div style={S.pagePad}><ScaleSettings /></div>}
          {view === "network" && <div style={S.pagePad}><NetworkSettings /></div>}
          {view === "expiry" && isPharmacy && <div style={S.pagePad}><ExpiryReport onJumpToItems={() => setView("items")} /></div>}
          {!standalone && view === "dashboard" && (
            <div style={S.pagePad}>
              <DashboardView
                deviceId={deviceId} status={status} baseUrl={baseUrl} busy={busy} pulled={pulled}
                actionErr={actionErr} heartbeatErr={heartbeatErr}
                onPull={doPull} onPush={doPush} pushSummary={pushSummary} onDeactivate={doDeactivate}
              />
            </div>
          )}
          {standalone && view === "dashboard" && (
            <div style={S.pagePad}>
              <StandaloneDashboardView
                license={standaloneLicense}
                session={standaloneSession}
                onOpenPeripherals={() => setShowPeripherals(true)}
                onOpenScale={() => setView("scale")}
                onOpenUsers={() => setView("users")}
                onWipe={onSignOut}
              />
            </div>
          )}
          {view === "updates" && (
            <div style={S.pagePad}><UpdatesScreen baseUrl={baseUrl} /></div>
          )}
          {standalone && view === "users" && standaloneSession && isAdmin && (
            <StandaloneUsersAdmin session={standaloneSession} maxUsers={standaloneLicense?.maxUsers ?? 1} />
          )}
          {/* Task #207 — accounting & operations screens (standalone only). */}
          {standalone && view === "suppliers" && (isAdmin || can("suppliers")) && (
            <div style={S.pagePad}><SuppliersAdmin /></div>
          )}
          {standalone && view === "purchases" && (isAdmin || can("purchases")) && (
            <div style={S.pagePad}><PurchasesAdmin /></div>
          )}
          {standalone && view === "purchase_returns" && (isAdmin || can("purchase_returns")) && (
            <div style={S.pagePad}><PurchaseReturnsAdmin /></div>
          )}
          {standalone && view === "salespersons" && (isAdmin || can("salespersons")) && (
            <div style={S.pagePad}><SalespersonsAdmin /></div>
          )}
          {standalone && view === "quotations" && (isAdmin || can("quotations")) && (
            <div style={S.pagePad}><QuotationsAdmin /></div>
          )}
          {standalone && view === "sales_orders" && (isAdmin || can("sales_orders")) && (
            <div style={S.pagePad}><SalesOrdersAdmin /></div>
          )}
          {standalone && view === "sales_invoices" && (isAdmin || can("sales_invoices")) && (
            <div style={S.pagePad}><SalesInvoicesAdmin /></div>
          )}
          {standalone && view === "sales_returns" && (isAdmin || can("sales_returns")) && (
            <div style={S.pagePad}><SalesReturnsAdmin /></div>
          )}
          {standalone && view === "report_sales_daily" && (isAdmin || can("report_sales_daily")) && (
            <div style={S.pagePad}><DailySalesReport /></div>
          )}
          {standalone && view === "report_sales_by_period" && (isAdmin || can("report_sales_by_period")) && (
            <div style={S.pagePad}><SalesByPeriodReport /></div>
          )}
          {standalone && view === "report_sales_by_item" && (isAdmin || can("report_sales_by_item")) && (
            <div style={S.pagePad}><SalesByItemReport /></div>
          )}
          {standalone && view === "report_sales_by_customer" && (isAdmin || can("report_sales_by_customer")) && (
            <div style={S.pagePad}><SalesByCustomerReport /></div>
          )}
          {standalone && view === "report_sales_daily_detailed" && (isAdmin || can("report_sales_daily_detailed")) && (
            <div style={S.pagePad}><DailyDetailedSalesReport /></div>
          )}
          {standalone && view === "report_sales_payment_mix" && (isAdmin || can("report_sales_payment_mix")) && (
            <div style={S.pagePad}><SalesByPaymentMethodReport /></div>
          )}
          {standalone && view === "report_sales_returns" && (isAdmin || can("report_sales_returns")) && (
            <div style={S.pagePad}><SalesReturnsReport /></div>
          )}
          {standalone && view === "report_sales_top_customers" && (isAdmin || can("report_sales_top_customers")) && (
            <div style={S.pagePad}><TopCustomersReport /></div>
          )}
          {standalone && view === "cash_boxes" && (isAdmin || can("cash_boxes")) && (
            <div style={S.pagePad}><CashBoxesAdmin /></div>
          )}
          {standalone && view === "banks" && (isAdmin || can("banks")) && (
            <div style={S.pagePad}><BanksAdmin /></div>
          )}
          {standalone && view === "financial_tx" && (isAdmin || can("financial_tx")) && (
            <div style={S.pagePad}><FinancialTransactionsAdmin /></div>
          )}
          {standalone && view === "chart_of_accounts" && (isAdmin || can("chart_of_accounts")) && (
            <div style={S.pagePad}><ChartOfAccounts onDrillToStatement={(id) => { setStmtAccountId(id); setView("report_account_statement"); }} /></div>
          )}
          {standalone && view === "journal_entries" && (isAdmin || can("journal_entries")) && (
            <div style={S.pagePad}><JournalEntries /></div>
          )}
          {standalone && view === "cost_centers" && (isAdmin || can("cost_centers")) && (
            <div style={S.pagePad}><CostCentersAdmin /></div>
          )}
          {standalone && view === "branches" && (isAdmin || can("branches")) && (
            <div style={S.pagePad}><BranchesAdmin /></div>
          )}
          {standalone && view === "report_account_statement" && (isAdmin || can("report_account_statement")) && (
            <div style={S.pagePad}><AccountStatementReport initialAccountId={stmtAccountId} onConsumed={() => setStmtAccountId(null)} /></div>
          )}
          {standalone && view === "report_income_statement" && (isAdmin || can("report_income_statement")) && (
            <div style={S.pagePad}><IncomeStatementReport /></div>
          )}
          {standalone && view === "report_balance_sheet" && (isAdmin || can("report_balance_sheet")) && (
            <div style={S.pagePad}><BalanceSheetReport /></div>
          )}
          {standalone && view === "report_trial_balance" && (isAdmin || can("report_trial_balance")) && (
            <div style={S.pagePad}><TrialBalanceReport /></div>
          )}
          {standalone && view === "user_permissions" && isAdmin && standaloneSession && (
            <div style={S.pagePad}><UserPermissionsAdmin session={standaloneSession} /></div>
          )}
          {standalone && view === "number_series" && isAdmin && (
            <div style={S.pagePad}><NumberSeriesAdmin /></div>
          )}
          {standalone && view === "taxes" && (isAdmin || can("taxes")) && (
            <div style={S.pagePad}><TaxesAdmin /></div>
          )}
          {/* Task #208 — warehouses & inventory ops (standalone only). */}
          {standalone && view === "warehouses" && (isAdmin || can("warehouses")) && (
            <div style={S.pagePad}><WarehousesAdmin /></div>
          )}
          {standalone && view === "stocktakes" && (isAdmin || can("stocktakes")) && (
            <div style={S.pagePad}><StocktakesAdmin /></div>
          )}
          {standalone && view === "stock_adjustments" && (isAdmin || can("stock_adjustments")) && (
            <div style={S.pagePad}><StockAdjustmentsAdmin /></div>
          )}
          {standalone && view === "stock_movements" && (isAdmin || can("stock_movements")) && (
            <div style={S.pagePad}><StockMovementsReport /></div>
          )}
          {standalone && view === "stock_transfers" && (isAdmin || can("stock_transfers")) && (
            <div style={S.pagePad}><StockTransfersAdmin /></div>
          )}
          {standalone && view === "currencies" && (isAdmin || can("currencies")) && (
            <div style={S.pagePad}><CurrenciesAdmin /></div>
          )}
          {standalone && view === "exchange_rates" && (isAdmin || can("exchange_rates")) && (
            <div style={S.pagePad}><ExchangeRatesAdmin /></div>
          )}
          {standalone && view === "treasury_transfers" && (isAdmin || can("treasury_transfers")) && (
            <div style={S.pagePad}><TreasuryTransfersAdmin /></div>
          )}
          {standalone && view === "settings_guide" && (isAdmin || can("settings_guide")) && (
            <div style={S.pagePad}><SettingsGuide /></div>
          )}
          {standalone && view === "zatca" && isZatcaCountry() && (isAdmin || can("zatca")) && (
            <div style={S.pagePad}><ZatcaOnboarding /></div>
          )}
        </main>
      </div>

      {showPeripherals && <PeripheralsSettings onClose={() => setShowPeripherals(false)} />}
    </div>
  );
}

function labelFor(v: View): string {
  return {
    sales: "نقطة البيع",
    taxes: "الضرائب",
    returns: "مرتجع المبيعات",
    parked: "السلال المعلّقة",
    pending: "الفواتير غير المرفوعة",
    daily: "تقرير اليومية",
    customers: "العملاء",
    items: "الأصناف",
    stock_import: "استيراد الأرصدة الافتتاحية",
    low_stock: "الأصناف تحت الحد الأدنى",
    uom: "وحدات القياس",
    expiry: "تقرير الصلاحية",
    scale: "إعدادات الميزان",
    network: "مشاركة الشبكة المحلية",
    dashboard: "لوحة التحكم",
    updates: "التحديثات",
    users: "المستخدمون المحليون",
    suppliers: "الموردون",
    purchases: "فواتير الشراء",
    purchase_returns: "مرتجع الشراء",
    salespersons: "مندوبو المبيعات",
    quotations: "عروض الأسعار",
    sales_orders: "أوامر البيع",
    sales_invoices: "فواتير المبيعات",
    sales_returns: "مرتجع المبيعات",
    invoice_import: "استيراد الفواتير من ملف",
    report_sales_daily: "تقرير المبيعات اليومي",
    report_sales_by_period: "المبيعات حسب الفترة",
    report_sales_by_item: "المبيعات حسب الصنف",
    report_sales_by_customer: "المبيعات حسب العميل",
    report_sales_daily_detailed: "المبيعات اليومي التفصيلي",
    report_sales_payment_mix: "المبيعات حسب طريقة الدفع",
    report_sales_returns: "مرتجعات المبيعات",
    report_sales_top_customers: "أفضل العملاء",
    cash_boxes: "الخزن",
    banks: "البنوك",
    financial_tx: "المعاملات المالية",
    chart_of_accounts: "شجرة الحسابات",
    journal_entries: "القيود اليومية",
    cost_centers: "مراكز التكلفة",
    branches: "الفروع",
    report_account_statement: "كشف حساب",
    report_income_statement: "قائمة الدخل",
    report_balance_sheet: "الميزانية",
    report_trial_balance: "ميزان المراجعة بالمجاميع",
    user_permissions: "صلاحيات المستخدمين",
    warehouses: "المخازن",
    stocktakes: "جرد المخازن",
    stock_adjustments: "تسوية المخزون",
    stock_movements: "حركة المخزون",
    stock_transfers: "التحويل بين المخازن",
    currencies: "العملات",
    exchange_rates: "أسعار الصرف",
    treasury_transfers: "تحويل الخزن",
    number_series: "أرقام المسلسلات",
    settings_guide: "دليل الإعدادات",
    zatca: "تسجيل زاتكا (مستقل)",
  }[v];
}

function UpdateBanner({
  version, onOpen, onDismiss,
}: { version: string; onOpen: () => void; onDismiss: () => void }) {
  return (
    <div style={S.updateBanner}>
      <span style={{ fontSize: 18 }}>⬇️</span>
      <span style={{ flex: 1 }}>
        تتوفّر نسخة جديدة <strong>v{version}</strong> — يُنصح بالتحديث للحصول على آخر الإصلاحات والتحسينات.
      </span>
      <button onClick={onOpen} style={S.updateBtn}>تنزيل الآن</button>
      <button onClick={onDismiss} style={S.updateClose} title="إخفاء حتى إعادة التشغيل">✕</button>
    </div>
  );
}

function ExpiryBanner({ expiresAt, compact = false }: { expiresAt: string | null; compact?: boolean }) {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const days = Math.ceil(ms / 86_400_000);
  if (days > 7) return null;
  const dateStr = new Date(expiresAt).toLocaleDateString("ar-SA", { year: "numeric", month: "long", day: "numeric" });
  if (compact) {
    // Compact-but-rich pill inside the topbar. Shows the full picture
    // in one glance: countdown (color-coded by urgency) + exact date
    // + direct WhatsApp/phone shortcuts. Stays a single line at ~720p.
    const urgent = days <= 3;
    const pillStyle = urgent ? S.warnPillUrgent : S.warnPill;
    return (
      <div style={pillStyle}>
        <span style={{ fontSize: 14 }}>{urgent ? "🔴" : "⚠️"}</span>
        <span style={S.pillSegMain}>
          ينتهي خلال{" "}
          <strong style={{ fontSize: 13, color: urgent ? "#991b1b" : "#78350f" }}>
            {days}
          </strong>{" "}
          {days === 1 ? "يوم" : "أيام"}
        </span>
        <span style={S.pillDivider}>·</span>
        <span style={S.pillSegDate} title="تاريخ انتهاء الاشتراك">📅 {dateStr}</span>
        <span style={S.pillDivider}>·</span>
        <span style={S.pillSegContact}>للتجديد — م/ كرم عزام</span>
        <a
          href="https://wa.me/201000903159"
          target="_blank"
          rel="noreferrer"
          style={S.pillWhatsapp}
          title="فتح واتساب — 00201000903159"
        >
          💬 واتساب
        </a>
        <a
          href="tel:01000903159"
          style={S.pillPhone}
          title="01000903159 داخل مصر · 00201000903159 خارج مصر"
        >
          📞 اتصال
        </a>
      </div>
    );
  }
  return (
    <div style={S.warnBanner}>
      <span style={{ fontSize: 18 }}>⚠️</span>
      <span style={{ flex: 1 }}>
        ينتهي اشتراك هذا الجهاز خلال <strong>{days}</strong> {days === 1 ? "يوم" : "أيام"} (بتاريخ {dateStr}) —
        للتجديد تواصل مع م/ كرم عزام:&nbsp;
        <a href="tel:01000903159" style={{ color: "#0c4a6e", fontWeight: 700, textDecoration: "underline" }}>
          01000903159
        </a>
        &nbsp;(داخل مصر) /&nbsp;
        <a href="tel:+201000903159" style={{ color: "#0c4a6e", fontWeight: 700, textDecoration: "underline" }} dir="ltr">
          00201000903159
        </a>
        &nbsp;(خارج مصر) —&nbsp;
        <a href="https://wa.me/201000903159" target="_blank" rel="noreferrer"
           style={{ color: "#15803d", fontWeight: 700, textDecoration: "underline" }}>
          واتساب 💬
        </a>
      </span>
    </div>
  );
}

function SyncIndicator({ status, heartbeatErr }: { status: SyncStatus | null; heartbeatErr: string | null }) {
  const ok = !heartbeatErr && status?.status === "active";
  return (
    <div style={ok ? S.syncOk : S.syncDown} title={status?.lastHeartbeatAt ?? "—"}>
      <span style={{
        width: 8, height: 8, borderRadius: 999,
        background: ok ? "#16a34a" : "#dc2626",
        boxShadow: `0 0 0 3px ${ok ? "rgba(22,163,74,.2)" : "rgba(220,38,38,.2)"}`,
      }} />
      {ok ? "متصل" : "غير متصل"}
    </div>
  );
}

type DashboardProps = {
  deviceId: number;
  status: SyncStatus | null;
  baseUrl: string;
  busy: string | null;
  pulled: PullSummary | null;
  actionErr: string | null;
  heartbeatErr: string | null;
  onPull: () => void;
  onPush: () => void;
  pushSummary: PushSummary | null;
  onDeactivate: () => void;
};

function DashboardView({ deviceId, status, baseUrl, busy, pulled, actionErr, heartbeatErr, onPull, onPush, pushSummary, onDeactivate }: DashboardProps) {
  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, marginBottom: 16 }}>
        <Tile icon="🪪" label="معرّف الجهاز" value={String(deviceId || "—")} />
        <Tile icon="🟢" label="الحالة" value={status?.status ?? "..."} accent={status?.status === "active" ? "#16a34a" : undefined} />
        <Tile icon="💓" label="آخر نبضة" value={status?.lastHeartbeatAt ? new Date(status.lastHeartbeatAt).toLocaleString("ar-SA") : "—"} small />
        <Tile icon="🔄" label="آخر مزامنة" value={status?.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString("ar-SA") : "—"} small />
      </div>

      <section style={S.card}>
        <h2 style={S.h2}>إجراءات المزامنة</h2>
        <div style={S.btnRow}>
          <button onClick={onPull} disabled={busy === "pull"} style={S.btnPrimary}>
            {busy === "pull" ? "جارٍ السحب..." : "⬇️ سحب البيانات (Pull)"}
          </button>
          <button onClick={onPush} disabled={busy === "push"} style={S.btnPrimary}>
            {busy === "push" ? "جارٍ الرفع..." : "⬆️ رفع الفواتير المعلّقة (Push)"}
          </button>
          <button onClick={onDeactivate} disabled={busy === "deactivate"} style={S.btnDanger}>
            {busy === "deactivate" ? "جارٍ الإلغاء..." : "إلغاء تفعيل الجهاز"}
          </button>
        </div>
        {pulled && (
          <div style={S.success}>
            ✅ تم السحب والحفظ محلياً: {pulled.customers} عميل، {pulled.items} صنف — الأصناف ستظهر فوراً في شاشة البيع
          </div>
        )}
        {pushSummary && (
          <div style={pushSummary.failed > 0
            ? { ...S.success, background: "#fffbeb", borderColor: "#fde68a", color: "#92400e" }
            : S.success}>
            {pushSummary.attempted === 0
              ? "ℹ️ لا توجد فواتير معلّقة للرفع."
              : `✅ تم رفع ${pushSummary.synced} من ${pushSummary.attempted} فاتورة` +
                (pushSummary.failed > 0 ? ` — ${pushSummary.failed} رُفضت وستُعاد المحاولة` : "")}
          </div>
        )}
        {actionErr && <div style={S.err}>⚠️ {actionErr}</div>}
        {heartbeatErr && !actionErr && (
          <div style={{ ...S.err, background: "#fffbeb", borderColor: "#fde68a", color: "#92400e" }}>
            🔌 المزامنة الخلفية: {heartbeatErr}
          </div>
        )}
      </section>

      <section style={S.card}>
        <h2 style={S.h2}>تفاصيل الاتصال</h2>
        <KV k="الخادم" v={baseUrl} mono />
        <KV k="معرّف الجهاز" v={String(deviceId || "—")} />
      </section>
    </div>
  );
}

function StandaloneDashboardView({
  license, session, onOpenPeripherals, onOpenScale, onOpenUsers, onWipe,
}: {
  license?: OfflineLicensePayload;
  session?: LocalSession;
  onOpenPeripherals: () => void;
  onOpenScale: () => void;
  onOpenUsers: () => void;
  onWipe: () => void | Promise<void>;
}) {
  const isAdmin = session?.role === "admin";
  async function confirmWipe() {
    if (!confirm("⚠️ سيتم مسح كل البيانات المحلية (الترخيص، المستخدمون، الفواتير المحفوظة). متأكد؟")) return;
    await onWipe();
  }
  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <section style={S.card}>
        <h2 style={S.h2}>الإعدادات السريعة</h2>
        <div style={S.btnRow}>
          <button onClick={onOpenPeripherals} style={S.btnPrimary}>🖨️ الأجهزة الطرفية (الطابعة)</button>
          <button onClick={onOpenScale} style={S.btnPrimary}>⚖️ إعدادات الميزان</button>
          {isAdmin && (
            <button onClick={onOpenUsers} style={S.btnPrimary}>🔐 المستخدمون</button>
          )}
        </div>
      </section>

      {isAdmin && <CountrySettingsCard />}

      {isAdmin && <TaxSettingsCard />}

      {license && (
        <section style={S.card}>
          <h2 style={S.h2}>معلومات الترخيص</h2>
          <KV k="مفتاح الترخيص" v={license.licenseKey} mono />
          <KV k="العميل" v={license.customerName ?? "—"} />
          <KV k="المجال" v={license.vertical === "pharmacy" ? "صيدلية" : license.vertical === "grocery" ? "بقالة/سوبرماركت" : "عام"} />
          <KV k="الخطة" v={license.plan ?? "—"} />
          <KV k="الحد الأقصى للمستخدمين" v={String(license.maxUsers ?? "—")} />
          {license.expiresAt && (
            <KV k="ينتهي في" v={new Date(license.expiresAt).toLocaleDateString("ar-SA", { year: "numeric", month: "long", day: "numeric" })} />
          )}
        </section>
      )}

      {isAdmin && (
        <section style={S.card}>
          <h2 style={S.h2}>منطقة الخطر</h2>
          <p style={{ color: "#64748b", fontSize: 13, marginBottom: 12 }}>
            مسح كل البيانات المحلية يعيد التطبيق لشاشة اختيار الوضع الأولى. لا يمكن التراجع.
          </p>
          <div style={S.btnRow}>
            <button onClick={confirmWipe} style={S.btnDanger}>🗑️ مسح كل البيانات وإعادة التعيين</button>
          </div>
        </section>
      )}
    </div>
  );
}

function Tile({ icon, label, value, accent, small }: { icon: string; label: string; value: string; accent?: string; small?: boolean }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 16, boxShadow: "0 1px 3px rgba(0,0,0,.04)" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontSize: 22 }}>{icon}</div>
        <div style={{ fontSize: 12, color: "#64748b" }}>{label}</div>
      </div>
      <div style={{ fontSize: small ? 13 : 20, fontWeight: 700, color: accent ?? "#0f172a" }}>{value}</div>
    </div>
  );
}

/**
 * Tax settings — VAT rate (%) + price-includes-tax toggle.
 *
 * Hidden for non-admins. Persisted by `lib/taxSettings.ts` to localStorage
 * (and mirrored to SQLite via standalone_set_setting in Tauri builds).
 * Sales/Returns screens subscribe to the change event so the cart label
 * and totals update without a refresh.
 *
 * The default rate is derived from the country chosen during activation
 * (e.g. SA→15, EG→14, AE→5). Admin can override at any time and reset
 * to country default with one click.
 */
/**
 * CountrySettingsCard — lets the admin change the operator's country at any
 * time after first-run. Writing the country updates the POS currency symbol
 * (display-only) AND the default VAT rate in lockstep, because both read the
 * same `pos_desktop_country` key. Hidden for non-admins.
 */
function CountrySettingsCard() {
  const sym = useCurrencySymbol();
  const [iso, setIso] = useState<string>(() => getCountryIso());
  const [saved, setSaved] = useState<"" | "ok">("");
  const info = countryByIso(iso);

  function choose(next: string) {
    setIso(next);
    setCountryIso(next);
    setSaved("ok");
    setTimeout(() => setSaved(""), 1500);
  }

  return (
    <section style={S.card}>
      <h2 style={S.h2}>الدولة والعملة</h2>
      <div style={{ marginBottom: 12, fontSize: 13, color: "#64748b" }}>
        تحديد الدولة يضبط رمز العملة المعروض في نقطة البيع (مثال: مصر → ج.م) ونسبة الضريبة الافتراضية.
      </div>
      <div style={{ maxWidth: 420 }}>
        <SearchCombobox
          value={iso}
          onChange={(v) => choose(String(v))}
          options={ARAB_COUNTRIES.map((c) => ({
            value: c.iso,
            label: `${c.flag} ${c.nameAr} (${c.currencySymbol})`,
          }))}
        />
      </div>
      <div style={{ marginTop: 10, fontSize: 13, color: "#0f172a", display: "flex", alignItems: "center", gap: 10 }}>
        العملة الحالية: <strong>{info.nameAr} — {sym}</strong>
        {saved === "ok" && (
          <span style={{ color: "#16a34a", fontSize: 13, fontWeight: 600 }}>✓ تم الحفظ</span>
        )}
      </div>
    </section>
  );
}

function TaxSettingsCard() {
  const sym = useCurrencySymbol();
  const { rate, mode, country, setRate, setMode, resetToCountryDefault } = useTaxSettings();
  const [draft, setDraft] = useState<string>(String(rate));
  const [saved, setSaved] = useState<"" | "ok">("");
  useEffect(() => { setDraft(String(rate)); }, [rate]);

  function flash() { setSaved("ok"); setTimeout(() => setSaved(""), 1500); }

  function commitRate() {
    const n = Number(draft);
    if (!Number.isFinite(n) || n < 0 || n > 100) { setDraft(String(rate)); return; }
    setRate(n);
    flash();
  }

  const defaultForCountry = defaultRateForCountry(country);

  return (
    <section style={S.card}>
      <h2 style={S.h2}>إعدادات الضريبة</h2>
      <p style={{ color: "#64748b", fontSize: 13, marginBottom: 16 }}>
        تتحكم هنا في نسبة ضريبة القيمة المضافة وفي طريقة احتسابها على الفواتير.
        التغيير ينعكس فوراً على شاشة البيع والمرتجعات بدون الحاجة لإعادة تشغيل التطبيق.
      </p>

      {/* Mode toggle */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>طريقة احتساب الضريبة</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <ModeChip
            active={mode === "inclusive"}
            onClick={() => { setMode("inclusive"); flash(); }}
            title="السعر شامل الضريبة"
            sub="سعر الصنف يحتوي على الضريبة (يُفصل عند الطباعة)"
            example="مثال: سعر 115 = (100 صافي + 15 ضريبة)"
          />
          <ModeChip
            active={mode === "exclusive"}
            onClick={() => { setMode("exclusive"); flash(); }}
            title="السعر بدون الضريبة"
            sub="تُضاف الضريبة فوق سعر الصنف في الإجمالي"
            example="مثال: سعر 100 + 15 ضريبة = 115"
          />
        </div>
      </div>

      {/* Rate editor */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>نسبة الضريبة (%)</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="number" step="0.5" min={0} max={100}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRate}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            style={{ width: 110, padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 16, fontWeight: 700, textAlign: "center" }}
          />
          <span style={{ fontSize: 18, fontWeight: 700, color: "#0f172a" }}>%</span>
          <button
            type="button"
            onClick={resetToCountryDefault}
            style={{ padding: "8px 14px", background: "#f1f5f9", color: "#0f172a", border: "1px solid #cbd5e1", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 }}
            title={`الدولة المختارة: ${country} — الافتراضي ${defaultForCountry}%`}
          >
            🔄 إعادة لافتراضي الدولة ({country} = {defaultForCountry}%)
          </button>
          {saved === "ok" && (
            <span style={{ color: "#16a34a", fontSize: 13, fontWeight: 600 }}>✓ تم الحفظ</span>
          )}
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: "#64748b" }}>
          المثال الحالي: على فاتورة بقيمة <strong>100 {sym}</strong>{" "}
          {mode === "inclusive"
            ? <>(شاملة) → ضريبة <strong>{(100 - 100/(1+Number(draft)/100)).toFixed(2)}</strong>، صافي <strong>{(100/(1+Number(draft)/100)).toFixed(2)}</strong></>
            : <>(غير شاملة) → ضريبة <strong>{(100 * Number(draft)/100).toFixed(2)}</strong>، الإجمالي <strong>{(100 * (1+Number(draft)/100)).toFixed(2)}</strong></>}
        </div>
      </div>
    </section>
  );
}

function ModeChip({ active, onClick, title, sub, example }: { active: boolean; onClick: () => void; title: string; sub: string; example: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: "1 1 280px", textAlign: "right" as const, padding: 14,
        background: active ? "linear-gradient(135deg, #dbeafe, #eff6ff)" : "#f8fafc",
        border: `2px solid ${active ? "#2563eb" : "#e2e8f0"}`,
        borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
        boxShadow: active ? "0 2px 8px rgba(37,99,235,0.15)" : "none",
        transition: "all .15s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 16 }}>{active ? "🟢" : "⚪"}</span>
        <span style={{ fontWeight: 700, fontSize: 14, color: active ? "#1e40af" : "#0f172a" }}>{title}</span>
      </div>
      <div style={{ fontSize: 12, color: "#475569", marginBottom: 4 }}>{sub}</div>
      <div style={{ fontSize: 11, color: "#64748b" }}>{example}</div>
    </button>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid #f1f5f9" }}>
    <span style={{ color: "#64748b", fontSize: 13 }}>{k}</span>
    <span style={{ fontFamily: mono ? "ui-monospace, monospace" : undefined, fontSize: mono ? 12 : 14, color: "#0f172a" }}>{v}</span>
  </div>;
}

const S = {
  // Full-viewport row: nav on the right (RTL), main column on the left.
  shell: { display: "flex", height: "100vh", width: "100vw", fontFamily: "'Segoe UI', system-ui, sans-serif", background: "#eef2f7", overflow: "hidden" } as const,

  // Vertical nav rail
  nav: {
    width: 240, flexShrink: 0,
    background: "linear-gradient(180deg, #0f172a 0%, #1e293b 100%)",
    color: "#cbd5e1",
    display: "flex", flexDirection: "column" as const,
    padding: "20px 12px",
    boxShadow: "-4px 0 12px rgba(0,0,0,.08)",
    transition: "width .18s ease",
  } as const,
  // Collapsed nav: 64px icon-only rail. Same gradient + shadow so it still
  // reads as the "sidebar"; just narrower with center-aligned icons.
  navCollapsed: {
    width: 64, flexShrink: 0,
    background: "linear-gradient(180deg, #0f172a 0%, #1e293b 100%)",
    color: "#cbd5e1",
    display: "flex", flexDirection: "column" as const,
    padding: "20px 6px",
    boxShadow: "-4px 0 12px rgba(0,0,0,.08)",
    transition: "width .18s ease",
  } as const,
  brand: { display: "flex", gap: 10, alignItems: "center", padding: "0 8px 20px", borderBottom: "1px solid #334155", marginBottom: 16 } as const,
  brandCollapsed: { display: "flex", justifyContent: "center", padding: "0 0 16px", borderBottom: "1px solid #334155", marginBottom: 12 } as const,
  brandIcon: {
    minWidth: 64, height: 38, padding: "0 10px", borderRadius: 10,
    background: "linear-gradient(135deg, #22d3ee 0%, #2563eb 100%)",
    display: "flex", alignItems: "center", justifyContent: "center",
    color: "#fff", fontWeight: 800, fontSize: 13, letterSpacing: 0.5,
    boxShadow: "0 4px 12px rgba(34,211,238,.3)",
    fontFamily: "'Segoe UI', system-ui, sans-serif",
  } as const,
  brandIconCollapsed: {
    width: 40, height: 40, borderRadius: 10,
    background: "linear-gradient(135deg, #22d3ee 0%, #2563eb 100%)",
    display: "flex", alignItems: "center", justifyContent: "center",
    color: "#fff", fontWeight: 800, fontSize: 18, letterSpacing: 0.5,
    boxShadow: "0 4px 12px rgba(34,211,238,.3)",
    fontFamily: "'Segoe UI', system-ui, sans-serif",
  } as const,
  // Collapse toggle — sits between brand and nav list.
  collapseToggle: {
    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
    margin: "0 0 12px", padding: "6px 10px",
    background: "rgba(59,130,246,.08)", color: "#93c5fd",
    border: "1px solid #334155", borderRadius: 8,
    cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 600,
    transition: "all .12s",
  } as const,
  collapseToggleCollapsed: {
    display: "flex", alignItems: "center", justifyContent: "center",
    margin: "0 0 12px", padding: 8,
    background: "rgba(59,130,246,.08)", color: "#93c5fd",
    border: "1px solid #334155", borderRadius: 8,
    cursor: "pointer", fontFamily: "inherit",
    transition: "all .12s",
  } as const,
  navIconLarge: { fontSize: 22, width: 24, textAlign: "center" as const, lineHeight: 1 } as const,
  // Tiny corner badge for collapsed mode — overlays the icon, top-left.
  navBadgeDot: {
    position: "absolute" as const, top: 4, left: 4,
    minWidth: 18, height: 18, padding: "0 5px",
    background: "#dc2626", color: "#fff",
    borderRadius: 999, fontSize: 10, fontWeight: 700,
    display: "flex", alignItems: "center", justifyContent: "center",
    boxShadow: "0 0 0 2px #1e293b",
  } as const,
  brandName: { fontSize: 16, fontWeight: 700, color: "#f8fafc" } as const,
  brandTag: { fontSize: 10, color: "#94a3b8", marginTop: 2 } as const,

  navList: { display: "flex", flexDirection: "column" as const, gap: 4, flex: 1, overflowY: "auto" as const } as const,
  navItem: {
    display: "flex", alignItems: "center", gap: 12,
    padding: "10px 14px", border: "none",
    background: "transparent", color: "#cbd5e1",
    borderRadius: 8, cursor: "pointer", fontSize: 14,
    fontFamily: "inherit", textAlign: "right" as const,
    transition: "all .12s",
  } as const,
  navItemActive: {
    display: "flex", alignItems: "center", gap: 12,
    padding: "10px 14px", border: "none",
    background: "linear-gradient(90deg, rgba(37,99,235,.2) 0%, rgba(37,99,235,.05) 100%)",
    color: "#fff",
    borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600,
    fontFamily: "inherit", textAlign: "right" as const,
    borderRight: "3px solid #3b82f6",
  } as const,
  navIcon: { fontSize: 18, width: 24, textAlign: "center" as const } as const,
  navLabel: { flex: 1 } as const,
  navBadge: { padding: "2px 8px", background: "#dc2626", color: "#fff", borderRadius: 999, fontSize: 11, fontWeight: 700 } as const,

  // ── Accordion group styles (standalone sidebar) ──
  navGroupHeader: {
    display: "flex", alignItems: "center", gap: 12,
    padding: "10px 14px", border: "none",
    background: "transparent", color: "#e2e8f0",
    borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 700,
    fontFamily: "inherit", textAlign: "right" as const, width: "100%",
    transition: "background .15s",
  } as const,
  navGroupHeaderActive: {
    display: "flex", alignItems: "center", gap: 12,
    padding: "10px 14px", border: "none",
    background: "rgba(148,163,184,.12)", color: "#fff",
    borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 700,
    fontFamily: "inherit", textAlign: "right" as const, width: "100%",
    transition: "background .15s",
  } as const,
  navChevron: {
    fontSize: 12, color: "#94a3b8", lineHeight: 1,
    transition: "transform .22s ease", display: "inline-block",
  } as const,
  navGroupBody: {
    display: "flex", flexDirection: "column" as const, gap: 4,
    overflow: "hidden",
    transition: "max-height .26s ease, opacity .2s ease",
    paddingInlineStart: 4,
  } as const,
  navSubHeader: {
    fontSize: 10, fontWeight: 700, color: "#64748b",
    textTransform: "uppercase" as const, letterSpacing: ".04em",
    padding: "6px 14px 2px",
  } as const,

  navFooter: { borderTop: "1px solid #334155", paddingTop: 12, display: "flex", flexDirection: "column" as const, gap: 8 } as const,
  navUtility: {
    display: "flex", alignItems: "center", gap: 10,
    padding: "8px 14px", background: "transparent",
    color: "#94a3b8", border: "1px solid #334155",
    borderRadius: 8, cursor: "pointer", fontSize: 13, fontFamily: "inherit",
    textAlign: "right" as const,
  } as const,
  modeChip: { fontSize: 10, color: "#64748b", textAlign: "center" as const, padding: "6px", background: "rgba(0,0,0,.2)", borderRadius: 6 } as const,
  versionChip: { fontSize: 10, color: "#94a3b8", textAlign: "center" as const, padding: "4px 6px", fontVariantNumeric: "tabular-nums" as const } as const,

  // Main column
  main: { flex: 1, display: "flex", flexDirection: "column" as const, minWidth: 0, minHeight: 0 } as const,
  topbar: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "14px 24px",
    background: "#fff", borderBottom: "1px solid #e2e8f0",
    flexShrink: 0,
  } as const,
  companyName: { fontSize: 13, color: "#64748b", fontWeight: 500 } as const,
  viewTitle: { fontSize: 20, fontWeight: 700, color: "#0f172a", marginTop: 2 } as const,
  topRight: { display: "flex", gap: 12, alignItems: "center" } as const,
  syncOk: { display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", background: "#f0fdf4", color: "#166534", border: "1px solid #bbf7d0", borderRadius: 999, fontSize: 12, fontWeight: 600 } as const,
  syncDown: { display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 999, fontSize: 12, fontWeight: 600 } as const,
  deviceChip: { padding: "6px 12px", background: "#f1f5f9", color: "#475569", borderRadius: 999, fontSize: 12, fontFamily: "ui-monospace, monospace" } as const,
  cashierChip: {
    display: "flex", alignItems: "center", gap: 8,
    padding: "4px 12px 4px 8px", background: "#eff6ff", border: "1px solid #bfdbfe",
    borderRadius: 999, color: "#1e3a8a", fontSize: 12,
  } as const,
  cashierIcon: { fontSize: 16 } as const,
  cashierInfo: { display: "flex", flexDirection: "column" as const, lineHeight: 1.2 } as const,
  cashierName: { fontWeight: 700, color: "#0f172a" } as const,
  cashierMeta: { fontSize: 10, color: "#64748b" } as const,
  logoutBtn: {
    padding: "6px 12px", background: "#fff", color: "#dc2626",
    border: "1px solid #fecaca", borderRadius: 8, cursor: "pointer",
    fontSize: 12, fontWeight: 600, fontFamily: "inherit",
  } as const,

  warnBanner: {
    display: "flex", alignItems: "center", gap: 10,
    padding: "10px 24px",
    background: "linear-gradient(90deg, #fef3c7 0%, #fde68a 100%)",
    color: "#78350f", borderBottom: "1px solid #fcd34d",
    fontSize: 13, fontWeight: 600, flexShrink: 0,
  } as const,
  // Compact pill version of the expiry banner — fits inside the topbar.
  warnPill: {
    display: "inline-flex", alignItems: "center", gap: 8,
    padding: "6px 14px",
    background: "linear-gradient(90deg, #fef3c7 0%, #fde68a 100%)",
    color: "#78350f", border: "1px solid #fcd34d", borderRadius: 999,
    fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" as const,
    maxWidth: "100%", overflow: "hidden",
    boxShadow: "0 1px 4px rgba(251,191,36,0.25)",
  } as const,
  warnPillUrgent: {
    display: "inline-flex", alignItems: "center", gap: 8,
    padding: "6px 14px",
    background: "linear-gradient(90deg, #fee2e2 0%, #fecaca 100%)",
    color: "#7f1d1d", border: "1px solid #fca5a5", borderRadius: 999,
    fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" as const,
    maxWidth: "100%", overflow: "hidden",
    boxShadow: "0 1px 6px rgba(220,38,38,0.25)",
  } as const,
  pillSegMain: { display: "inline-flex", gap: 3, alignItems: "center" } as const,
  pillSegDate: { fontSize: 11.5, opacity: 0.92 } as const,
  pillSegContact: { fontSize: 11.5, opacity: 0.85 } as const,
  pillDivider: { opacity: 0.4, fontSize: 11 } as const,
  pillWhatsapp: {
    display: "inline-flex", alignItems: "center", gap: 3,
    padding: "3px 10px", background: "#16a34a", color: "#fff",
    borderRadius: 999, fontSize: 11.5, fontWeight: 700,
    textDecoration: "none", whiteSpace: "nowrap" as const,
    boxShadow: "0 1px 3px rgba(22,163,74,0.4)",
  } as const,
  pillPhone: {
    display: "inline-flex", alignItems: "center", gap: 3,
    padding: "3px 10px", background: "#fff", color: "#0f172a",
    border: "1px solid #cbd5e1", borderRadius: 999,
    fontSize: 11.5, fontWeight: 700,
    textDecoration: "none", whiteSpace: "nowrap" as const,
  } as const,
  updateBanner: {
    display: "flex", alignItems: "center", gap: 12,
    padding: "10px 24px",
    background: "linear-gradient(90deg, #dbeafe 0%, #d1fae5 100%)",
    color: "#0c4a6e", borderBottom: "1px solid #93c5fd",
    fontSize: 13, fontWeight: 600, flexShrink: 0,
  } as const,
  updateBtn: {
    padding: "6px 14px", background: "#2563eb", color: "#fff",
    border: "none", borderRadius: 6, cursor: "pointer",
    fontSize: 12, fontWeight: 700, fontFamily: "inherit",
  } as const,
  updateClose: {
    padding: "4px 10px", background: "transparent", color: "#0c4a6e",
    border: "1px solid #93c5fd", borderRadius: 6, cursor: "pointer",
    fontSize: 12, fontFamily: "inherit",
  } as const,
  autoImportBanner: {
    display: "flex", alignItems: "center", gap: 12, padding: "10px 16px",
    background: "#ecfdf5", color: "#065f46", borderBottom: "1px solid #a7f3d0",
    fontSize: 13, fontWeight: 600,
  } as const,
  autoImportClose: {
    padding: "4px 10px", background: "transparent", color: "#065f46",
    border: "1px solid #86efac", borderRadius: 6, cursor: "pointer",
    fontSize: 12, fontFamily: "inherit",
  } as const,
  content: { flex: 1, overflow: "hidden", minHeight: 0, display: "flex", flexDirection: "column" as const } as const,
  pagePad: { padding: 24, overflowY: "auto" as const, flex: 1 } as const,

  // Dashboard internals
  card: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: "0 1px 3px rgba(0,0,0,.04)" } as const,
  h2: { margin: "0 0 14px", fontSize: 16, color: "#0f172a" } as const,
  btnRow: { display: "flex", gap: 12, flexWrap: "wrap" as const } as const,
  btnPrimary: { padding: "10px 18px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600, fontFamily: "inherit" } as const,
  btnDanger: { padding: "10px 18px", background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600, fontFamily: "inherit" } as const,
  success: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: 12, borderRadius: 8, marginTop: 12, fontSize: 14 } as const,
  err: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 12, borderRadius: 8, marginTop: 12, fontSize: 14 } as const,

  // ── Horizontal top navigation bar ──
  topnav: { position: "relative" as const, zIndex: 50, display: "flex", alignItems: "center", gap: 10, padding: "5px 14px", minHeight: 50, background: "linear-gradient(90deg, #0f172a 0%, #1e293b 100%)", borderBottom: "1px solid #334155", flexShrink: 0 } as const,
  topnavBrand: { display: "flex", alignItems: "center", gap: 8, flexShrink: 0, paddingInlineStart: 4 } as const,
  topnavBrandIcon: { width: 30, height: 30, borderRadius: 8, background: "linear-gradient(135deg, #22d3ee 0%, #2563eb 100%)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 15, boxShadow: "0 2px 8px rgba(34,211,238,.3)" } as const,
  topnavBrandText: { fontSize: 13, fontWeight: 700, color: "#f8fafc", whiteSpace: "nowrap" as const } as const,
  topnavItems: { display: "flex", alignItems: "center", flexWrap: "wrap" as const, gap: 3, rowGap: 5, flex: 1, overflow: "visible" as const } as const,
  topnavDivider: { width: 1, height: 20, background: "#334155", margin: "0 3px", flexShrink: 0 } as const,
  topnavControls: { display: "flex", alignItems: "center", gap: 8, flexShrink: 0, paddingInlineStart: 6 } as const,
  topLeaf: { display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" as const, padding: "5px 8px", border: "none", background: "transparent", color: "#cbd5e1", borderRadius: 7, cursor: "pointer", fontSize: 11.5, fontFamily: "inherit", height: 30, flexShrink: 0, transition: "all .12s" } as const,
  topLeafActive: { display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" as const, padding: "5px 8px", border: "none", background: "linear-gradient(180deg, rgba(37,99,235,.35) 0%, rgba(37,99,235,.15) 100%)", color: "#fff", borderRadius: 7, cursor: "pointer", fontSize: 11.5, fontWeight: 700, fontFamily: "inherit", height: 30, flexShrink: 0, boxShadow: "inset 0 -2px 0 #3b82f6" } as const,
  topGroup: { display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" as const, padding: "5px 8px", border: "none", background: "transparent", color: "#e2e8f0", borderRadius: 7, cursor: "pointer", fontSize: 11.5, fontWeight: 600, fontFamily: "inherit", height: 30, flexShrink: 0, transition: "all .12s" } as const,
  topGroupActive: { display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" as const, padding: "5px 8px", border: "none", background: "rgba(148,163,184,.18)", color: "#fff", borderRadius: 7, cursor: "pointer", fontSize: 11.5, fontWeight: 700, fontFamily: "inherit", height: 30, flexShrink: 0 } as const,
  topBadge: { padding: "1px 7px", background: "#dc2626", color: "#fff", borderRadius: 999, fontSize: 10, fontWeight: 700 } as const,
  dropdownPanel: { position: "absolute" as const, top: "calc(100% + 6px)", insetInlineStart: 0, zIndex: 60, minWidth: 230, maxHeight: 420, overflowY: "auto" as const, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, boxShadow: "0 12px 32px rgba(15,23,42,.18)", padding: 6, display: "flex", flexDirection: "column" as const, gap: 2 } as const,
  dropdownItem: { display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", border: "none", background: "transparent", color: "#334155", borderRadius: 8, cursor: "pointer", fontSize: 13, fontFamily: "inherit", textAlign: "right" as const, width: "100%", transition: "background .1s" } as const,
  dropdownItemActive: { display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", border: "none", background: "#eff6ff", color: "#1d4ed8", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 700, fontFamily: "inherit", textAlign: "right" as const, width: "100%" } as const,
  dropdownSub: { padding: "8px 12px 4px", fontSize: 11, fontWeight: 700, color: "#94a3b8" } as const,
  dropdownOverlay: { position: "fixed" as const, inset: 0, zIndex: 40, background: "transparent" } as const,
  periphBtn: { padding: "6px 10px", background: "#fff", color: "#475569", border: "1px solid #e2e8f0", borderRadius: 8, cursor: "pointer", fontSize: 14, fontFamily: "inherit" } as const,
};
