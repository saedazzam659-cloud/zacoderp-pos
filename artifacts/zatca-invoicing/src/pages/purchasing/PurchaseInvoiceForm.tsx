import { contractingOptionsKey, fetchContractingProjectOptions } from "@/lib/contractingProjectOptions";
import { useState, useEffect, useRef } from "react";
import { useEnterNavContainer } from "@/lib/enterNav";
import { validateInvoiceLines } from "@/lib/lineValidation";
import { useRoute, useLocation, useSearch } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJsonArray } from "@/lib/fetchJsonArray";
import { useScreenItemModes, annotateItemCombo } from "@/lib/itemUsageClient";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { JournalScanArchive } from "@/components/JournalScanArchive";
import { renameArchivedKey } from "@/lib/localArchive";
import { trimTrailingZeros } from "@/hooks/use-fmt";
import { useToast } from "@/hooks/use-toast";
import { useStickyPriceIncludesVat } from "@/lib/useStickyPriceIncludesVat";
import { useNextSequenceNumber } from "@/hooks/useNextSequenceNumber";
import { useCompanyTaxes } from "@/hooks/useCompanyTaxes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { eligibleParties, withHistoricalParty } from "@/lib/partyEligibility";
import { DocNavigator } from "@/components/DocNavigator";
import { DocStatusBadge } from "@/components/DocStatusBadge";
import { useEnterNavigation } from "@/hooks/useEnterNavigation";
import { DiscountRow } from "@/components/DiscountRow";
import { currencySymbol } from "@/lib/format";
import { SupplierVatControl } from "@/components/SupplierVatControl";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ArrowRight, ArrowLeft, ShoppingCart, Plus, Trash2, FileText, ListOrdered, ClipboardList, AlertCircle, Wallet, CreditCard, TrendingUp, TrendingDown, Lock, Archive, Undo2 } from "lucide-react";
import EmbeddedAccountNotesTab from "@/pages/account-notes/EmbeddedAccountNotesTab";
import EmbeddedReturnsTab from "@/components/documents/EmbeddedReturnsTab";
import InvoiceArchiveTab from "@/components/InvoiceArchiveTab";
import PurchaseInvoicePaymentsTab from "@/pages/purchasing/PurchaseInvoicePaymentsTab";
import { DateField } from "@/components/ui/date-field";
import PurchaseInvoiceDetails from "./PurchaseInvoiceDetails";
import IndustrialCostsTab, { type IndustrialCostDraft } from "./IndustrialCostsTab";
import {
  catalogUnitsWithHistoricalSelection,
  isActiveItemUnit,
  itemUnitsWithHistoricalSelection,
  serializeDocumentLine,
} from "@/lib/documentLineUnits";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const today = () => new Date().toISOString().slice(0, 10);

interface InvoiceLine {
  _id: string;
  /** Persisted database line id; absent on newly added/duplicated lines. */
  id?: number;
  itemId: string;
  itemName: string;
  itemCode: string;
  unitId: string;
  unit: string;
  conversionFactor: string;
  warehouseId: string;
  qty: string;
  freeQty: string;
  weight: string;
  unitPrice: string;
  discount: string;
  vatRate: string;
  lineTotal: string;
  expenseShare: string;
  finalCost: string;
  batchNumber: string;
  expiryDate: string;
  notes: string;
  // OPTIONAL per-line cost-center CODE (Odoo-style analytic distribution).
  // Empty ⇒ falls back to the HEADER costCenter at JE time (unchanged behavior).
  costCenter: string;
  // ── مصروف يوزع على فترات (deferred expense) — recognition plan ──
  // Present only on lines whose item group categoryType === "deferred_expense".
  deferredStartDate: string;
  deferredEndDate: string;
  deferredPeriodicity: string; // monthly | quarterly | semiannual | annual
  deferredCostCenters: { costCenterId: string; pct: string }[];
  // Optional actual-cost source tag. Kept per purchased line so source identity
  // remains stable for industrial monthly actual-cost collection.
  industrialCost: IndustrialCostDraft | null;
}

function newLine(): InvoiceLine {
  return {
    _id: crypto.randomUUID(), itemId: "", itemName: "", itemCode: "",
    unitId: "", unit: "", conversionFactor: "1", warehouseId: "",
    qty: "1", freeQty: "0", weight: "0", unitPrice: "0", discount: "0", vatRate: "15",
    lineTotal: "0", expenseShare: "0", finalCost: "0", batchNumber: "", expiryDate: "", notes: "",
    costCenter: "",
    deferredStartDate: "", deferredEndDate: "", deferredPeriodicity: "monthly", deferredCostCenters: [],
    industrialCost: null,
  };
}

// `taxMode` controls whether VAT is computed before or after the line
// discount. Defaults to "after_discount" (legacy/ZATCA-standard); the
// caller passes the company-wide preference read from auth.
type TaxMode = "before_discount" | "after_discount";
function calcLine(l: InvoiceLine, priceIncludesVat = false, taxMode: TaxMode = "after_discount") {
  const qty = Number(l.qty) || 0;
  const price = Number(l.unitPrice) || 0;
  const disc = Number(l.discount) || 0;
  const rate = (Number(l.vatRate) || 0) / 100;
  if (taxMode === "before_discount") {
    const fullGross = qty * price;
    const discAmt = fullGross * (disc / 100);
    if (priceIncludesVat) {
      const fullNet = rate > -1 ? fullGross / (1 + rate) : fullGross;
      return { lineTotal: Math.max(0, fullGross - discAmt), subtotal: Math.max(0, fullNet - discAmt) };
    }
    const vat = fullGross * rate;
    return { lineTotal: Math.max(0, fullGross + vat - discAmt), subtotal: Math.max(0, fullGross - discAmt) };
  }
  const gross = qty * price * (1 - disc / 100);
  if (priceIncludesVat) {
    const net = rate > -1 ? gross / (1 + rate) : gross;
    return { lineTotal: gross, subtotal: net };
  }
  const vat = gross * rate;
  return { lineTotal: gross + vat, subtotal: gross };
}

export default function PurchaseInvoiceForm() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const fmt = (n: any) => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const tr = (k: string, opts?: any): string => t(`purchasingPages.purchaseInvoiceForm.${k}`, opts) as string;
  const supName = (s: any) => isRtl ? (s?.nameAr ?? s?.nameEn ?? "") : (s?.nameEn ?? s?.nameAr ?? "");
  const itemNameOf = (i: any) => isRtl ? (i?.nameAr ?? i?.nameEn ?? "") : (i?.nameEn ?? i?.nameAr ?? "");
  const branchName = (b: any) => isRtl ? (b?.nameAr ?? b?.nameEn ?? `#${b?.id}`) : (b?.nameEn ?? b?.nameAr ?? `#${b?.id}`);
  const unitNameOf = (u: any) => isRtl ? (u?.nameAr ?? u?.nameEn ?? "") : (u?.nameEn ?? u?.nameAr ?? "");
  const warehouseName = (w: any) => isRtl ? (w?.nameAr ?? w?.nameEn ?? "") : (w?.nameEn ?? w?.nameAr ?? "");

  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const { data: projectOptions } = useQuery({
    queryKey: contractingOptionsKey(user?.id, cid, undefined, token),
    queryFn: () => fetchContractingProjectOptions(token),
    enabled: !!token,
  });
  const usageModes = useScreenItemModes("purchase_invoices");
  const authH   = { Authorization: `Bearer ${token}` };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [matchNew]  = useRoute("/purchasing/invoices/new");
  const [matchEdit, params] = useRoute("/purchasing/invoices/:id");
  const isNew  = !!matchNew;
  const newArchiveKeyRef = useRef(`PI-new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  // /new matches the /:id route too (id="new") → Number("new")=NaN, and JSX
  // renders `{NaN && <Tab/>}` as a literal "NaN" chip. Only accept numeric ids.
  const _rawId = matchEdit ? String((params as any).id ?? "") : "";
  const editId = !matchNew && /^\d+$/.test(_rawId) ? Number(_rawId) : null;
  // A create can succeed before auto-posting or navigation fails. Preserve the
  // returned id synchronously so the `/new` route can only PUT on retry.
  const persistedInvoiceIdRef = useRef<number | null>(null);
  const saveInFlightRef = useRef(false);
  const newInvoiceRouteRef = useRef<string | null>(null);
  const clientRequestIdRef = useRef<string | null>(null);
  const newInvoiceRoute = isNew ? "/purchasing/invoices/new" : null;
  if (newInvoiceRoute !== newInvoiceRouteRef.current) {
    newInvoiceRouteRef.current = newInvoiceRoute;
    persistedInvoiceIdRef.current = null;
    clientRequestIdRef.current = newInvoiceRoute ? crypto.randomUUID() : null;
  }

  // SAP-style tabbed layout (default) vs classic single-page (per-company
  // opt-out). `?view=1` forces tabbed+read-only and opens on the details tab.
  const search = useSearch();
  const viewMode = new URLSearchParams(search).get("view") === "1";
  const _co = (user as any)?.company;
  const useTabbedLayout = _co?.invoiceFormLayout !== "classic" || viewMode;
  // Company-wide UX flag (الإعدادات العامة): hide the quick add-item bar and
  // let the items grid grow ~2 rows taller in its place.
  const hideQuickAdd = !!_co?.hideQuickAddBar;
  const [activeTab, setActiveTab] = useState<"basic" | "items" | "industrialCosts" | "debitNote" | "creditNote" | "payments" | "returns" | "archive" | "details" | "deferred">("basic");
  // مصروف يوزع على فترات — سطر الحوار المفتوح لتحرير خطة التوزيع
  const [deferredDialogLineId, setDeferredDialogLineId] = useState<string | null>(null);
  useEffect(() => { if (viewMode) setActiveTab("details"); }, [viewMode]);
  const [docNumber,    setDocNumber]    = useState("");
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState("");
  const [supplierInvoiceDate, setSupplierInvoiceDate] = useState("");
  const [invoiceDate,  setInvoiceDate]  = useState(today());
  const [supplierId,   setSupplierId]   = useState("");
  const [branchId,     setBranchId]     = useState("");

  // Peek the NEXT number for the SAME branch the form will submit — counters
  // are per-(sequence, branch), so omitting branchId reads the empty branch-0
  // sentinel and the badge freezes at the start number while saves advance the
  // real branch counter.
  const [paymentType,  setPaymentType]  = useState("credit");
  const seqPeek = useNextSequenceNumber("purchase_invoice", isNew, undefined, branchId, paymentType);
  const [cashBoxId,    setCashBoxId]    = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [currencyCode, setCurrencyCode] = useState("");
  const [exchangeRate, setExchangeRate] = useState("1");
  const [lcId,         setLcId]         = useState("");
  const [distMethod,   setDistMethod]   = useState("value");
  const [notes,        setNotes]        = useState("");
  const [costCenter,   setCostCenter]   = useState("");
  const [projectId, setProjectId] = useState("");
  const [docDiscount,  setDocDiscount]  = useState("0");
  // Sticky toggle — see SalesDocumentForm for behavior contract.
  const stickyPriceIncl = useStickyPriceIncludesVat();
  const [priceIncludesVat, setPriceIncludesVat] = useState(stickyPriceIncl.initial);
  const [lines,        setLines]        = useState<InvoiceLine[]>([newLine()]);
  const [focusLineId, setFocusLineId] = useState<string>(() => "");
  useEffect(() => {
    if (lines.length > 0 && !lines.some(l => l._id === focusLineId)) {
      setFocusLineId(lines[0]._id);
    }
  }, [lines, focusLineId]);
  const addLine = () => {
    const l = newLine();
    const r = percentRateOf(headerTaxId);
    if (r !== null) l.vatRate = String(r);
    setLines(p => [...p, l]);
    setFocusLineId(l._id);
  };
  useEnterNavContainer({ onAppend: () => addLine() });
  // ── "إضافة صنف" quick-add bar state (tabbed items tab) ────────────────
  // Same design as SalesDocumentForm: pick item → warehouse/unit → qty/free/
  // price/discount → commit. Discount here is PERCENT-only (purchase lines
  // have no fixed-amount discount field — no calc-path change).
  const [qaItemId, setQaItemId]           = useState("");
  const [qaWarehouseId, setQaWarehouseId] = useState("");
  const [qaUnitId, setQaUnitId]           = useState("");
  const [qaQty, setQaQty]                 = useState("1");
  const [qaFreeQty, setQaFreeQty]         = useState("0");
  const [qaPrice, setQaPrice]             = useState("");
  const [qaDiscount, setQaDiscount]       = useState("0");
  const quickAddRef = useRef<HTMLDivElement>(null);
  const focusQuickAddStart = () => {
    quickAddRef.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
  };
  const { containerRef, onKeyDown } = useEnterNavigation(() => handleSave());
  const docNumberRef = useRef<HTMLInputElement>(null);

  const [inventoryAccountId, setInventoryAccountId] = useState("");
  const [taxAccountId,       setTaxAccountId]       = useState("");
  const [discountAccountId,  setDiscountAccountId]  = useState("");

  const acctPrefsKey = `purchase-invoice-accts:${cid ?? "all"}`;
  useEffect(() => {
    if (!isNew) return;
    try {
      const raw = localStorage.getItem(acctPrefsKey);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p.inventoryAccountId && !inventoryAccountId) setInventoryAccountId(String(p.inventoryAccountId));
      if (p.taxAccountId       && !taxAccountId)       setTaxAccountId(String(p.taxAccountId));
      if (p.discountAccountId  && !discountAccountId)  setDiscountAccountId(String(p.discountAccountId));
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, cid]);

  useEffect(() => {
    if (!inventoryAccountId && !taxAccountId && !discountAccountId) return;
    try {
      localStorage.setItem(acctPrefsKey, JSON.stringify({ inventoryAccountId, taxAccountId, discountAccountId }));
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inventoryAccountId, taxAccountId, discountAccountId]);

  // Smart document navigator — list of all purchase invoices for the
  // current company (lightweight). Same cache key as the list page so
  // opening the navigator is instant if the user already visited the list.
  const { data: allPurchaseInvoices = [] } = useQuery<any[]>({
    queryKey: ["purchase-invoices", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/purchasing/purchase-invoices?companyId=${cid}` : `${API}/api/purchasing/purchase-invoices`, authH),
    enabled: !!user,
  });
  const { data: suppliers = [] } = useQuery<any[]>({
    queryKey: ["suppliers", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/suppliers?companyId=${cid}` : `${API}/api/suppliers`, authH),
    enabled: !!user,
  });

  const { data: currencies = [] } = useQuery<any[]>({
    queryKey: ["currencies", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/currencies?companyId=${cid}` : `${API}/api/currencies`, authH),
    enabled: !!user,
  });

  const { data: exchangeRates = [] } = useQuery<any[]>({
    queryKey: ["exchange-rates", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/currencies/rates?companyId=${cid}` : `${API}/api/currencies/rates`, authH),
    enabled: !!user,
  });

  const { data: lcs = [] } = useQuery<any[]>({
    queryKey: ["lc", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/purchasing/letters-of-credit?companyId=${cid}` : `${API}/api/purchasing/letters-of-credit`, authH),
    enabled: !!user,
  });

  const { data: inventoryItems = [] } = useQuery<any[]>({
    queryKey: ["inventory-items", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/inventory/items?companyId=${cid}&includeHidden=1` : `${API}/api/inventory/items?includeHidden=1`, authH),
    enabled: !!user,
  });

  const { data: units = [] } = useQuery<any[]>({
    queryKey: ["units", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/inventory/units?companyId=${cid}` : `${API}/api/inventory/units`, authH),
    enabled: !!user,
  });

  const { data: warehouses = [] } = useQuery<any[]>({
    queryKey: ["warehouses", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/inventory/warehouses?companyId=${cid}` : `${API}/api/inventory/warehouses`, authH),
    enabled: !!user,
  });

  const { data: branches = [] } = useQuery<any[]>({
    queryKey: ["branches", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/org/branches?companyId=${cid}` : `${API}/api/org/branches`, authH),
    enabled: !!user,
  });
  const defaultBranch = (branches as any[]).find((b: any) => b.isMain) ?? (branches as any[])[0];
  useEffect(() => {
    if (!isNew || !defaultBranch || branchId) return;
    setBranchId(String(defaultBranch.id));
  }, [isNew, defaultBranch?.id]);

  const defaultWarehouse = (warehouses as any[]).find((w: any) => w.isDefault) ?? (warehouses as any[])[0];
  // Header-level warehouse picker — broadcast to every line on change.
  const [headerWarehouseId, setHeaderWarehouseId] = useState<string>("");
  // Route-transition safeguard — MUST be declared BEFORE the default-fill
  // effect below. Effects run in declaration order, so on mount (and on doc-id
  // change) this clear runs first and the fill then repopulates. Declared the
  // other way round, the clear silently wipes the freshly filled default when
  // warehouses resolve from the react-query cache on first render (state goes
  // "" → id → "" within one commit, so no dep ever changes and the fill never
  // re-runs — the "empty warehouse on new invoice" bug).
  useEffect(() => {
    setHeaderWarehouseId("");
  }, [editId, isNew]);
  useEffect(() => {
    if (!isNew || !defaultWarehouse || headerWarehouseId) return;
    setHeaderWarehouseId(String(defaultWarehouse.id));
  }, [isNew, defaultWarehouse?.id, headerWarehouseId]);
  useEffect(() => {
    if (isNew || headerWarehouseId) return;
    const firstWh = lines.find(l => l.warehouseId)?.warehouseId;
    if (firstWh) setHeaderWarehouseId(String(firstWh));
  }, [isNew, lines, headerWarehouseId]);
  // SERVICE items never touch stock → no warehouse, no batch/expiry. This helper
  // lets the warehouse auto-fill / broadcast effects skip service lines and lets
  // the line grid hide the warehouse + batch + expiry inputs for them.
  const isServiceLine = (l: { itemId: string }) =>
    (inventoryItems as any[]).some((i: any) => String(i.id) === l.itemId && (i.itemType === "service" || i.itemType === "prepaid_expense"));
  // فئات الأصناف — line routing per group categoryType (asset/expense = no stock move)
  const { data: itemGroupsList = [] } = useQuery<any[]>({
    queryKey: ["item-groups", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/inventory/item-groups?companyId=${cid}` : `${API}/api/inventory/item-groups`, authH),
    enabled: !!user,
  });
  const lineGroup = (l: { itemId: string }) => {
    const it = (inventoryItems as any[]).find((i: any) => String(i.id) === l.itemId);
    if (!it?.groupId) return null;
    return (itemGroupsList as any[]).find((g: any) => g.id === it.groupId) ?? null;
  };
  const isGroupNoStockLine = (l: { itemId: string }) => {
    const g = lineGroup(l);
    return g?.categoryType === "fixed_asset" || g?.categoryType === "expense" || g?.categoryType === "deferred_expense";
  };
  const isDeferredLine = (l: { itemId: string }) => lineGroup(l)?.categoryType === "deferred_expense";
  const isNoStockLine = (l: { itemId: string }) => isServiceLine(l) || isGroupNoStockLine(l);
  const hasEmptyWarehouse = lines.some(l => !l.warehouseId && !isNoStockLine(l));
  useEffect(() => {
    if (!headerWarehouseId || !hasEmptyWarehouse) return;
    setLines(prev => prev.map(l => (l.warehouseId || isNoStockLine(l)) ? l : { ...l, warehouseId: headerWarehouseId }));
  }, [headerWarehouseId, hasEmptyWarehouse]);
  function applyHeaderWarehouse(v: string) {
    setHeaderWarehouseId(v);
    if (!v) return;
    setLines(prev => prev.map(l => isNoStockLine(l) ? l : { ...l, warehouseId: v }));
  }
  // Header-level tax picker — dynamic tax catalog (الضرائب). Selecting a
  // percent tax broadcasts its rate to every line's editable vatRate. The
  // chosen taxId is persisted on the document header. ZATCA SAFETY: this
  // only pre-fills the editable rate before issue; it never touches the
  // stored vat_rate/vat_amount/tax_category that ZATCA XML/QR read.
  const { taxes: taxCatalog, defaultPercentTax: defaultTax, comboItemsPercent: taxComboItems, percentRateOf } = useCompanyTaxes();
  const [headerTaxId, setHeaderTaxId] = useState<string>("");
  // Same ordering rule as headerWarehouseId: clear BEFORE the default-fill.
  useEffect(() => {
    setHeaderTaxId("");
  }, [editId, isNew]);
  useEffect(() => {
    if (!isNew || !defaultTax || headerTaxId) return;
    applyHeaderTax(String(defaultTax.id));
    // Same race as headerWarehouseId: the clear-on-route-change effect can
    // wipe the value after this ran; re-fill when it resets to "".
  }, [isNew, defaultTax?.id, headerTaxId]);
  function applyHeaderTax(v: string) {
    setHeaderTaxId(v);
    const rate = percentRateOf(v);
    if (rate === null) return; // fixed/none → leave line rates untouched
    setLines(prev => prev.map(l => {
      const updated = { ...l, vatRate: String(rate) };
      const { lineTotal } = calcLine(updated, priceIncludesVat);
      return { ...updated, lineTotal: lineTotal.toFixed(2), finalCost: (lineTotal + Number(updated.expenseShare || 0)).toFixed(2) };
    }));
  }

  const { data: supplierBalances = [] } = useQuery<any[]>({
    queryKey: ["supplier-balances", cid],
    queryFn: () => fetchJsonArray(`${API}/api/suppliers/balances?companyId=${cid}`, authH),
    enabled: !!user && !!cid && paymentType === "credit",
  });

  const { data: costCentersList = [] } = useQuery<any[]>({
    queryKey: ["cost-centers", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/cost-centers?companyId=${cid}`, { headers });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!cid,
    staleTime: 60_000,
  });
  const { data: cashBoxes = [] } = useQuery<any[]>({
    queryKey: ["cash-boxes", cid],
    queryFn: () => fetchJsonArray(`${API}/api/cash-boxes?companyId=${cid}`, authH),
    enabled: !!user && !!cid && paymentType === "cash",
  });
  const { data: cashBoxBalances = [] } = useQuery<any[]>({
    queryKey: ["cash-boxes-bal", cid],
    queryFn: () => fetchJsonArray(`${API}/api/cash-boxes/balances?companyId=${cid}`, authH),
    enabled: !!user && !!cid && paymentType === "cash",
  });
  const { data: bankAccounts = [] } = useQuery<any[]>({
    queryKey: ["bank-accounts", cid],
    queryFn: () => fetchJsonArray(`${API}/api/bank-accounts?companyId=${cid}`, authH),
    enabled: !!user && !!cid && paymentType === "bank",
  });
  const { data: bankAccountBalances = [] } = useQuery<any[]>({
    queryKey: ["bank-accounts-bal", cid],
    queryFn: () => fetchJsonArray(`${API}/api/bank-accounts/balances?companyId=${cid}`, authH),
    enabled: !!user && !!cid && paymentType === "bank",
  });

  const defaultCurrency = currencies.find((c: any) => c.isDefault) ?? currencies[0];

  function getLatestRate(selectedCode: string): string {
    if (!currencies.length) return "1";
    const selected = currencies.find((c: any) => c.code === selectedCode);
    const base = defaultCurrency;
    if (!selected || !base || selected.id === base.id) return "1";
    const rate = exchangeRates
      .filter((r: any) =>
        (r.fromCurrencyId === selected.id && r.toCurrencyId === base.id) ||
        (r.fromCurrencyId === base.id     && r.toCurrencyId === selected.id)
      )
      .sort((a: any, b: any) => b.effectiveDate.localeCompare(a.effectiveDate))[0];
    if (!rate) return "1";
    if (rate.fromCurrencyId === selected.id) return String(rate.rate);
    return String((1 / Number(rate.rate)).toFixed(6));
  }

  async function handleCurrencyChange(code: string) {
    setCurrencyCode(code);
    setExchangeRate(getLatestRate(code));
    await repriceAllLinesForCurrency(code);
  }

  useEffect(() => {
    if (!isNew || !defaultCurrency || currencyCode) return;
    setCurrencyCode(defaultCurrency.code);
  }, [isNew, defaultCurrency?.code]);

  const { data: existing, isLoading: loadingEdit } = useQuery({
    queryKey: ["purchase-invoice", editId],
    queryFn: async () => {
      const r = await fetch(`${API}/api/purchasing/purchase-invoices/${editId}?companyId=${cid}`, { headers: authH });
      return r.json();
    },
    enabled: !!editId,
  });

  useEffect(() => {
    if (!isNew) return;
    if (seqPeek.hasSequence && seqPeek.number) setDocNumber(seqPeek.number);
  }, [isNew, seqPeek.hasSequence, seqPeek.number]);

  useEffect(() => {
    if (!existing) return;
    setDocNumber(existing.docNumber ?? "");
    setSupplierInvoiceNumber(existing.supplierInvoiceNumber ?? "");
    setSupplierInvoiceDate(existing.supplierInvoiceDate ?? "");
    setInvoiceDate(existing.invoiceDate ?? today());
    setSupplierId(existing.supplierId ? String(existing.supplierId) : "");
    setBranchId(existing.branchId ? String(existing.branchId) : "");
    setPaymentType(existing.paymentType ?? "credit");
    setCashBoxId(existing.cashBoxId ? String(existing.cashBoxId) : "");
    setBankAccountId(existing.bankAccountId ? String(existing.bankAccountId) : "");
    setCurrencyCode(existing.currencyCode ?? "SAR");
    setExchangeRate(String(existing.exchangeRate ?? "1"));
    setLcId(existing.lcId ? String(existing.lcId) : "");
    setDistMethod(existing.distributionMethod ?? "value");
    setNotes(existing.notes ?? "");
    setCostCenter(existing.costCenter ?? "");
    setProjectId(existing.projectId == null ? "" : String(existing.projectId));
    setDocDiscount(String(existing.discountAmount ?? "0"));
    setPriceIncludesVat(!!existing.priceIncludesVat);
    setInventoryAccountId(existing.inventoryAccountId ? String(existing.inventoryAccountId) : "");
    setTaxAccountId(existing.taxAccountId ? String(existing.taxAccountId) : "");
    setDiscountAccountId(existing.discountAccountId ? String(existing.discountAccountId) : "");
    setHeaderTaxId((existing as any).taxId != null ? String((existing as any).taxId) : "");
    setLines(existing.lines?.length ? existing.lines.map((l: any) => ({
      freeQty:     String(l.freeQty ?? "0"),
      _id: crypto.randomUUID(),
      id: Number.isInteger(Number(l.id)) ? Number(l.id) : undefined,
      itemId:      l.itemId      ? String(l.itemId)      : "",
      itemName:    l.itemName    ?? "",
      itemCode:    l.itemCode    ?? "",
      unitId:      l.unitId      ? String(l.unitId)      : "",
      unit:        l.unit        ?? "",
      conversionFactor: String(l.conversionFactor ?? "1"),
      warehouseId: l.warehouseId ? String(l.warehouseId) : "",
      qty:         String(l.qty),
      weight:      String(l.weight ?? "0"),
      unitPrice:   String(l.unitPrice),
      discount:    String(l.discount ?? "0"),
      vatRate:     (l.vatRate != null && l.vatRate !== "" ? String(l.vatRate) : "15"),
      lineTotal:   String(l.lineTotal),
      expenseShare:String(l.expenseShare ?? "0"),
      finalCost:   String(l.finalCost ?? "0"),
      batchNumber: l.batchNumber ?? "",
      expiryDate:  l.expiryDate  ?? "",
      notes:       l.notes ?? "",
      costCenter:  l.costCenter ?? "",
      deferredStartDate:   l.deferredStartDate ?? "",
      deferredEndDate:     l.deferredEndDate ?? "",
      deferredPeriodicity: l.deferredPeriodicity ?? "monthly",
      deferredCostCenters: Array.isArray(l.deferredCostCenters)
        ? l.deferredCostCenters.map((c: any) => ({ costCenterId: String(c.costCenterId ?? ""), pct: String(c.pct ?? "") }))
        : [],
      industrialCost: l.industrialCost ? {
        costType: String(l.industrialCost.costType ?? ""),
        factoryId: String(l.industrialCost.factoryId ?? ""),
        costCenter: String(l.industrialCost.costCenter ?? ""),
        period: String(l.industrialCost.period ?? ""),
        allocationDriver: String(l.industrialCost.allocationDriver ?? ""),
      } : null,
    })) : (useTabbedLayout ? [] : [newLine()]));
    void Promise.all(
      (existing.lines ?? [])
        .map((l: any) => l.itemId ? String(l.itemId) : "")
        .filter(Boolean)
        .filter((id: string, i: number, ids: string[]) => ids.indexOf(id) === i)
        .map((id: string) => fetchItemUnits(id)),
    );
  }, [existing]);

  const duplicatedRef = useRef(false);
  useEffect(() => {
    if (!isNew || duplicatedRef.current || !user) return;
    const params = new URLSearchParams(window.location.search);
    const fromId = params.get("from");
    if (!fromId) return;
    duplicatedRef.current = true;

    (async () => {
      try {
        const r = await fetch(`${API}/api/purchasing/purchase-invoices/${fromId}?companyId=${cid}`, { headers: authH });
        if (!r.ok) return;
        const src = await r.json();
        setDocNumber("");
        setSupplierInvoiceNumber("");
        setSupplierInvoiceDate("");
        setInvoiceDate(today());
        setSupplierId(src.supplierId ? String(src.supplierId) : "");
        setBranchId(src.branchId ? String(src.branchId) : "");
        setPaymentType(src.paymentType ?? "credit");
        setCashBoxId(src.cashBoxId ? String(src.cashBoxId) : "");
        setBankAccountId(src.bankAccountId ? String(src.bankAccountId) : "");
        setCurrencyCode(src.currencyCode ?? "SAR");
        setExchangeRate(String(src.exchangeRate ?? "1"));
        setLcId(src.lcId ? String(src.lcId) : "");
        setDistMethod(src.distributionMethod ?? "value");
        setNotes(src.notes ?? "");
        setDocDiscount(String(src.discountAmount ?? "0"));
        setPriceIncludesVat(!!src.priceIncludesVat);
        setInventoryAccountId(src.inventoryAccountId ? String(src.inventoryAccountId) : "");
        setTaxAccountId(src.taxAccountId ? String(src.taxAccountId) : "");
        setDiscountAccountId(src.discountAccountId ? String(src.discountAccountId) : "");
        setLines(src.lines?.length ? src.lines.map((l: any) => ({
          freeQty:     String(l.freeQty ?? "0"),
          _id: crypto.randomUUID(),
          itemId:      l.itemId      ? String(l.itemId)      : "",
          itemName:    l.itemName    ?? "",
          itemCode:    l.itemCode    ?? "",
          unitId:      l.unitId      ? String(l.unitId)      : "",
          unit:        l.unit        ?? "",
          conversionFactor: String(l.conversionFactor ?? "1"),
          warehouseId: l.warehouseId ? String(l.warehouseId) : "",
          qty:         String(l.qty),
          weight:      String(l.weight ?? "0"),
          unitPrice:   String(l.unitPrice),
          discount:    String(l.discount ?? "0"),
          vatRate:     (l.vatRate != null && l.vatRate !== "" ? String(l.vatRate) : "15"),
          lineTotal:   String(l.lineTotal),
          expenseShare:String(l.expenseShare ?? "0"),
          finalCost:   String(l.finalCost ?? "0"),
          batchNumber: l.batchNumber ?? "",
          expiryDate:  l.expiryDate  ?? "",
          notes:       l.notes ?? "",
          costCenter:  l.costCenter ?? "",
          deferredStartDate:   l.deferredStartDate ?? "",
          deferredEndDate:     l.deferredEndDate ?? "",
          deferredPeriodicity: l.deferredPeriodicity ?? "monthly",
          deferredCostCenters: Array.isArray(l.deferredCostCenters)
            ? l.deferredCostCenters.map((c: any) => ({ costCenterId: String(c.costCenterId ?? ""), pct: String(c.pct ?? "") }))
            : [],
          industrialCost: l.industrialCost ? {
            costType: String(l.industrialCost.costType ?? ""),
            factoryId: String(l.industrialCost.factoryId ?? ""),
            costCenter: String(l.industrialCost.costCenter ?? ""),
            period: String(l.industrialCost.period ?? ""),
            allocationDriver: String(l.industrialCost.allocationDriver ?? ""),
          } : null,
        })) : (useTabbedLayout ? [] : [newLine()]));
        toast({ title: tr("duplicated") });
        const url = new URL(window.location.href);
        url.searchParams.delete("from");
        window.history.replaceState({}, "", url.toString());
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, user, cid]);

  function updateLine(id: string, field: keyof InvoiceLine, value: string) {
    setLines(prev => prev.map(l => {
      if (l._id !== id) return l;
      const updated = { ...l, [field]: value };
      const { lineTotal } = calcLine(updated, priceIncludesVat);
      return { ...updated, lineTotal: lineTotal.toFixed(2), finalCost: (lineTotal + Number(updated.expenseShare || 0)).toFixed(2) };
    }));
  }

  useEffect(() => {
    setLines(prev => prev.map(l => {
      const { lineTotal } = calcLine(l, priceIncludesVat);
      return { ...l, lineTotal: lineTotal.toFixed(2), finalCost: (lineTotal + Number(l.expenseShare || 0)).toFixed(2) };
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceIncludesVat]);

  const [itemUnitsMap, setItemUnitsMap] = useState<Record<string, any[]>>({});
  async function fetchItemUnits(itemId: string): Promise<any[]> {
    if (itemUnitsMap[itemId]) return itemUnitsMap[itemId];
    const r = await fetch(`${API}/api/inventory/items/${itemId}/units?companyId=${cid}`, { headers: authH });
    const rows = r.ok ? await r.json() : [];
    setItemUnitsMap(prev => ({ ...prev, [itemId]: rows }));
    return rows;
  }

  // Pre-fetch units for the quick-add bar's chosen item so its unit picker is
  // populated BEFORE commit, and default the picker to the item's base unit.
  useEffect(() => {
    if (!qaItemId) { setQaUnitId(""); return; }
    let cancelled = false;
    (async () => {
      const us = await fetchItemUnits(qaItemId);
      if (cancelled) return;
      const base = us.find((u: any) => u.isBase && isActiveItemUnit(u)) ?? us.find(isActiveItemUnit);
      setQaUnitId(base?.unitId != null ? String(base.unitId) : "");
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qaItemId]);

  // Per-currency cost cache: itemId → [{ currencyCode, costPrice, ... }]
  const [itemCurrencyPricesMap, setItemCurrencyPricesMap] = useState<Record<string, any[]>>({});
  async function fetchItemCurrencyPrices(itemId: string): Promise<any[]> {
    if (itemCurrencyPricesMap[itemId]) return itemCurrencyPricesMap[itemId];
    const r = await fetch(`${API}/api/inventory/items/${itemId}/currency-prices?companyId=${cid}`, { headers: authH });
    const rows = r.ok ? await r.json() : [];
    setItemCurrencyPricesMap(prev => ({ ...prev, [itemId]: rows }));
    return rows;
  }
  function pickCurrencyCost(rows: any[], code: string): string | null {
    const m = rows.find((p: any) => p.currencyCode === code);
    if (!m || m.costPrice == null || m.costPrice === "") return null;
    return String(m.costPrice);
  }

  async function selectItem(lineId: string, itemId: string) {
    const item = inventoryItems.find((i: any) => String(i.id) === itemId);
    if (!item) { updateLine(lineId, "itemId", ""); return; }
    const itemUnits = await fetchItemUnits(itemId);
    const base = itemUnits.find((u: any) => u.isBase && isActiveItemUnit(u)) ?? itemUnits.find(isActiveItemUnit);
    const fallbackUnit = units.find((u: any) => u.id === item.unitId);
    let chosenPrice: string = String(base?.costPrice ?? item.costPrice ?? "0");
    if (currencyCode && defaultCurrency && currencyCode !== defaultCurrency.code) {
      const cps = await fetchItemCurrencyPrices(itemId);
      const m = pickCurrencyCost(cps, currencyCode);
      if (m != null) chosenPrice = m;
    }
    setLines(prev => prev.map(l => {
      if (l._id !== lineId) return l;
      const isService = item.itemType === "service" || item.itemType === "prepaid_expense";
      const updated: InvoiceLine = {
        ...l,
        itemId:    String(item.id),
        itemName:  itemNameOf(item),
        itemCode:  item.code   ?? "",
        unitId:    base?.unitId ? String(base.unitId) : (item.unitId ? String(item.unitId) : ""),
        unit:      unitNameOf(base?.unit) || unitNameOf(fallbackUnit) || "",
        conversionFactor: String(base?.conversionFactor ?? "1"),
        unitPrice: trimTrailingZeros(chosenPrice),
        vatRate:   (item.vatRate != null && item.vatRate !== "" ? String(item.vatRate) : "15"),
        // Service lines never hit inventory: drop warehouse + batch + expiry.
        warehouseId: isService ? "" : l.warehouseId,
        batchNumber: isService ? "" : l.batchNumber,
        expiryDate:  isService ? "" : l.expiryDate,
      };
      const { lineTotal } = calcLine(updated, priceIncludesVat);
      return { ...updated, lineTotal: lineTotal.toFixed(2), finalCost: (lineTotal + Number(updated.expenseShare || 0)).toFixed(2) };
    }));
  }

  // Commit the "إضافة صنف" bar into a new grid line. Appends an empty line,
  // runs the SAME selectItem auto-fill (catalog/currency cost, base unit,
  // VAT), then applies the bar's overrides through updateLine (which
  // recomputes lineTotal/finalCost per field). Zero duplicated pricing logic.
  async function handleQuickAdd() {
    if (!qaItemId) return;
    const l = newLine();
    const r = percentRateOf(headerTaxId);
    if (r !== null) l.vatRate = String(r);
    // Seed the warehouse BEFORE selectItem (it preserves warehouseId for
    // non-service items, and blanks it for service items automatically).
    if (qaWarehouseId) l.warehouseId = qaWarehouseId;
    else if (headerWarehouseId) l.warehouseId = headerWarehouseId;
    setLines(p => [...p, l]);
    await selectItem(l._id, qaItemId);
    // Honor an explicit unit choice from the bar (multi-unit items). Runs
    // BEFORE price/discount below so a manually typed price still wins.
    if (qaUnitId) changeLineUnit(l._id, qaUnitId);
    updateLine(l._id, "qty", qaQty || "1");
    if (qaFreeQty && qaFreeQty !== "0") updateLine(l._id, "freeQty", qaFreeQty);
    if (qaPrice.trim() !== "" && qaPrice !== "0") updateLine(l._id, "unitPrice", qaPrice);
    if (qaDiscount && qaDiscount !== "0") updateLine(l._id, "discount", qaDiscount);
    setFocusLineId(l._id);
    // Reset the bar for the next entry.
    setQaItemId(""); setQaQty("1"); setQaFreeQty("0"); setQaPrice(""); setQaDiscount("0");
  }

  const repriceVersion = useRef(0);
  async function repriceAllLinesForCurrency(code: string) {
    if (!defaultCurrency) return;
    const myVersion = ++repriceVersion.current;
    const isDefault = code === defaultCurrency.code;
    const updates: Record<string, string> = {};
    for (const l of lines) {
      if (!l.itemId) continue;
      let np: string | null = null;
      if (isDefault) {
        const itemUnits = await fetchItemUnits(l.itemId);
        const row = itemUnits.find((u: any) => String(u.unitId) === l.unitId)
          ?? itemUnits.find((u: any) => u.isBase && isActiveItemUnit(u)) ?? itemUnits.find(isActiveItemUnit);
        const item = inventoryItems.find((i: any) => String(i.id) === l.itemId);
        const v = row?.costPrice ?? item?.costPrice;
        if (v != null) np = String(v);
      } else {
        const cps = await fetchItemCurrencyPrices(l.itemId);
        const m = pickCurrencyCost(cps, code);
        if (m != null) np = m;
      }
      if (np != null) updates[l._id] = trimTrailingZeros(np);
    }
    if (myVersion !== repriceVersion.current) return;
    if (!Object.keys(updates).length) return;
    setLines(prev => prev.map(l => {
      const np = updates[l._id];
      if (np == null) return l;
      const updated: InvoiceLine = { ...l, unitPrice: np };
      const { lineTotal } = calcLine(updated, priceIncludesVat);
      return { ...updated, lineTotal: lineTotal.toFixed(2), finalCost: (lineTotal + Number(updated.expenseShare || 0)).toFixed(2) };
    }));
  }

  function changeLineUnit(lineId: string, newUnitId: string) {
    setLines(prev => prev.map(l => {
      if (l._id !== lineId) return l;
      const itemUnits = itemUnitsMap[l.itemId] ?? [];
      const row = itemUnits.find((u: any) => String(u.unitId) === newUnitId);
      const globalUnit = units.find((u: any) => String(u.id) === newUnitId);
      const updated: InvoiceLine = {
        ...l,
        unitId: newUnitId,
        unit: unitNameOf(row?.unit) || unitNameOf(globalUnit) || "",
        conversionFactor: String(row?.conversionFactor ?? "1"),
        unitPrice: row?.costPrice != null ? trimTrailingZeros(row.costPrice) : l.unitPrice,
      };
      const { lineTotal } = calcLine(updated, priceIncludesVat);
      return { ...updated, lineTotal: lineTotal.toFixed(2), finalCost: (lineTotal + Number(updated.expenseShare || 0)).toFixed(2) };
    }));
  }

  async function distributeExpenses() {
    if (!selectedLc || !lines.length) {
      toast({ title: tr("selectLcFirst"), variant: "destructive" });
      return;
    }
    const totalBase = distMethod === "qty"
      ? lines.reduce((s, l) => s + (Number(l.qty) || 0), 0)
      : lines.reduce((s, l) => s + (Number(l.lineTotal) || 0), 0);
    if (!totalBase) {
      toast({ title: tr("enterLinesFirst"), variant: "destructive" });
      return;
    }

    // Distribute the LC's expenses *in base currency*. Each expense row is
    // converted via its own historical rate (IAS 21) on the server, so we sum
    // the pre-computed `amountBase`/`totalExpensesBase` rather than raw amounts.
    let totalLcExpenses = 0;
    let baseCur = defaultCurrency?.code ?? "SAR";
    try {
      const url = `${API}/api/purchasing/letters-of-credit/${selectedLc.id}${cid ? `?companyId=${cid}` : ""}`;
      const r = await fetch(url, { headers: authH });
      if (!r.ok) throw new Error(tr("lcLoadFail"));
      const detail = await r.json();
      baseCur = detail.baseCurrency ?? baseCur;
      totalLcExpenses = Number(detail.totalExpensesBase ?? 0)
        || (detail.expenses ?? []).reduce(
            (s: number, e: any) => s + (Number(e.amountBase ?? e.amount) || 0), 0);
    } catch (err: any) {
      toast({ title: err.message || tr("lcLoadFail"), variant: "destructive" });
      return;
    }

    if (totalLcExpenses <= 0) {
      toast({ title: tr("lcNoExpenses"), variant: "destructive" });
      return;
    }

    setLines(prev => prev.map(l => {
      const base = distMethod === "qty" ? Number(l.qty) : Number(l.lineTotal);
      const share = (base / totalBase) * totalLcExpenses;
      const finalCost = Number(l.lineTotal) + share;
      return { ...l, expenseShare: share.toFixed(2), finalCost: finalCost.toFixed(2) };
    }));
    toast({ title: tr("lcDistributed"), description: tr("lcDistributedDesc", { total: fmt(totalLcExpenses), cur: baseCur }) });
  }

  const subtotal       = lines.reduce((s, l) => { const { subtotal } = calcLine(l, priceIncludesVat); return s + subtotal; }, 0);
  const vatAmount      = lines.reduce((s, l) => { const { lineTotal, subtotal } = calcLine(l, priceIncludesVat); return s + (lineTotal - subtotal); }, 0);
  const lineDiscountTotal = lines.reduce((s, l) => {
    const noDisc = calcLine({ ...l, discount: "0" }, priceIncludesVat).lineTotal;
    const withDisc = calcLine(l, priceIncludesVat).lineTotal;
    return s + Math.max(0, noDisc - withDisc);
  }, 0);
  const grossTotal     = subtotal + vatAmount;
  const docDiscountAmt = Math.max(0, Math.min(grossTotal, Number(docDiscount) || 0));
  const totalAmount    = grossTotal - docDiscountAmt;
  const totalExpLoaded = lines.reduce((s, l) => s + (Number(l.expenseShare) || 0), 0);
  const selectedLc     = lcs.find((lc: any) => String(lc.id) === lcId);

  // Per-doc-type auto-posting flag with global fallback. See
  // SalesDocumentForm for the full rationale on the legacy fallback.
  const _gl = _co?.autoPostingEnabled !== false;
  const autoPostingEnabled = _co?.autoPostPurchase === undefined || _co?.autoPostPurchase === null
    ? _gl
    : _co.autoPostPurchase !== false;
  const saveMut = useMutation({
    mutationFn: async (data: any) => {
      const persistedId = persistedInvoiceIdRef.current ?? editId;
      const method = persistedId ? "PUT" : "POST";
      const url = persistedId
        ? `${API}/api/purchasing/purchase-invoices/${persistedId}`
        : `${API}/api/purchasing/purchase-invoices`;
      const res = await fetch(url, { method, headers, body: JSON.stringify(data) });
      const j = await res.json(); if (!res.ok) throw new Error(j.error);
      // Capture before auto-post so its failure cannot lead to a second POST.
      if (method === "POST" && j?.id) {
        persistedInvoiceIdRef.current = Number(j.id);
      }

      if (autoPostingEnabled && j?.id && (j.status ?? "draft") === "draft") {
        const postRes = await fetch(`${API}/api/purchasing/purchase-invoices/${j.id}/post`, {
          method: "PATCH", headers,
        });
        const postJson = await postRes.json().catch(() => ({}));
        if (!postRes.ok) {
          throw new Error(tr("savedNotPosted", { err: postJson.error || postRes.statusText }));
        }
        return postJson;
      }
      return j;
    },
    onSuccess: (saved: any) => {
      qc.invalidateQueries({ queryKey: ["purchase-invoices"] });
      if (isNew && saved?.docNumber) {
        renameArchivedKey(newArchiveKeyRef.current, saved.docNumber);
        fetch(`${API}/api/document-archives/rekey`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            screenKey: "purchase_invoices",
            oldDocKey: newArchiveKeyRef.current,
            newDocKey: saved.docNumber,
          }),
        }).catch(() => {});
      }
      toast({ title: autoPostingEnabled
        ? (isNew ? tr("createdAndPosted") : tr("savedAndPosted"))
        : (isNew ? tr("createdDraft") : tr("savedDraft"))
      });
      // الترحيل نجح لكن توليد قيود التسوية الدورية (المصروف المقدم) فشل —
      // نبّه المستخدم بدل ما يفترض إن القيود الشهرية اتولّدت.
      if (Array.isArray(saved?.adjustmentRunWarnings) && saved.adjustmentRunWarnings.length) {
        for (const w of saved.adjustmentRunWarnings) {
          toast({ title: String(w), variant: "destructive" });
        }
      }
      // ابقَ داخل الفاتورة بعد الحفظ (بدل الرجوع للقائمة) حتى يقدر
      // المستخدم يستخدم تبويب «السداد» مباشرة. فاتورة جديدة → افتحها
      // في وضع التعديل بالمعرّف المحفوظ.
      if (isNew && saved?.id) {
        navigate(`/purchasing/invoices/${saved.id}`);
      }
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
    onSettled: () => {
      saveInFlightRef.current = false;
    },
  });

  // فك ترحيل الفاتورة من داخل الشاشة نفسها (بدل الرجوع لقائمة الفواتير):
  // يعيدها إلى مسودة، ويحوّل القيود الدورية المرتبطة (المصروف المقدم) إلى
  // مسودات محتفظة بأرقامها التسلسلية لحين إعادة الترحيل.
  const unpostMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API}/api/purchasing/purchase-invoices/${editId}/unpost`, { method: "PATCH", headers });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || tr("unpostFailed"));
      return j;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase-invoices"] });
      qc.invalidateQueries({ queryKey: ["purchase-invoice", editId] });
      toast({ title: tr("unposted") });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  function handleSave() {
    // State-based disabled buttons are asynchronous; this synchronous lock
    // blocks duplicate click/Enter events in the same render.
    if (saveInFlightRef.current || saveMut.isPending) return;
    // Required-fields gate (mirrors the server's 400 in /purchase-invoices):
    // every purchase invoice must carry an explicit supplier + branch.
    // Surfaced as a destructive toast BEFORE the network round-trip so the
    // user sees the failure instantly with both missing fields listed.
    const missing: string[] = [];
    if (!supplierId) missing.push("المورد");
    if (!branchId)   missing.push("الفرع");
    if (missing.length) {
      toast({
        title: "⚠️ بيانات ناقصة — لا يمكن حفظ الفاتورة",
        description: `الحقول التالية مطلوبة: ${missing.join("، ")}`,
        variant: "destructive",
      });
      return;
    }
    // Per-line gate: item name + unit + qty + price required on every row.
    const lineCheck = validateInvoiceLines(lines, { requireRealItem: true });
    if (!lineCheck.ok) {
      toast({ title: lineCheck.title, description: lineCheck.description, variant: "destructive" });
      return;
    }
    const data: any = {
      companyId: cid, branchId: branchId || null,
      docNumber: docNumber || null, supplierInvoiceNumber: supplierInvoiceNumber || null, supplierInvoiceDate: supplierInvoiceDate || null, invoiceDate,
      supplierId: supplierId || null, paymentType,
      cashBoxId: paymentType === "cash" ? (cashBoxId || null) : null,
      bankAccountId: paymentType === "bank" ? (bankAccountId || null) : null,
      currencyCode,
      exchangeRate, lcId: lcId || null, distributionMethod: distMethod,
      inventoryAccountId: inventoryAccountId ? Number(inventoryAccountId) : null,
      taxAccountId:       taxAccountId       ? Number(taxAccountId)       : null,
      discountAccountId:  discountAccountId  ? Number(discountAccountId)  : null,
      taxId: headerTaxId ? Number(headerTaxId) : null,
      subtotal: subtotal.toFixed(2), vatAmount: vatAmount.toFixed(2),
      discountAmount: docDiscountAmt.toFixed(2), totalExpensesLoaded: totalExpLoaded.toFixed(2),
      totalAmount: (totalAmount + totalExpLoaded).toFixed(2),
      priceIncludesVat,
      notes: notes || null,
      // Header-level cost center — when set, the /post handler tags every
      // generated JE line with this code so cost-center reports pick it up.
      costCenter: costCenter || null,
      projectId: projectId ? Number(projectId) : null,
      lines: lines.filter(l => l.itemName).map(l => ({
        ...serializeDocumentLine(l),
        // خطة توزيع المصروف — تُرسل فقط لو السطر مؤجّل ومكتمل التواريخ
        deferredStartDate:   isDeferredLine(l) && l.deferredStartDate ? l.deferredStartDate : null,
        deferredEndDate:     isDeferredLine(l) && l.deferredEndDate   ? l.deferredEndDate   : null,
        deferredPeriodicity: isDeferredLine(l) ? (l.deferredPeriodicity || "monthly") : null,
        // Canonical split shape {costCenterId:int, pct:number} — matches the
        // backend parseCcSplit contract exactly (validated again at /post).
        deferredCostCenters: isDeferredLine(l) && l.deferredCostCenters.length
          ? l.deferredCostCenters
              .filter(c => Number(c.costCenterId) > 0 && Number(c.pct) > 0)
              .map(c => ({ costCenterId: Number(c.costCenterId), pct: Number(c.pct) }))
          : null,
      })),
    };
    // Retain this UUID for retries until an explicit new form is opened. The
    // backend treats it as the POST idempotency key; updates never need it.
    if (!persistedInvoiceIdRef.current && clientRequestIdRef.current) {
      data.clientRequestId = clientRequestIdRef.current;
    }
    saveInFlightRef.current = true;
    saveMut.mutate(data);
  }

  // On NEW docs in the tabbed layout, drop the initial pristine seed line:
  // entry happens via the quick-add bar (which always APPENDS a fresh line),
  // so the pre-seeded empty row just lingers in the grid and confuses users.
  // Runs ONCE; a later flip to the classic layout re-seeds a single editable
  // row (in-grid entry is the norm there). Save paths are unaffected — they
  // already skip empty rows (filter on itemName).
  // NOTE: these hooks MUST live ABOVE the loadingEdit early-return below —
  // hooks after a conditional return change the hook count between the
  // loading render and the loaded render → React error #310 (prod crash).
  const seedPrunedRef = useRef(false);
  useEffect(() => {
    if (!isNew) return;
    if (useTabbedLayout) {
      if (seedPrunedRef.current) return;
      seedPrunedRef.current = true;
      setLines(p => (p.length === 1 && !p[0].itemId && !p[0].itemName && !p[0].notes ? [] : p));
    } else if (lines.length === 0) {
      addLine();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useTabbedLayout, isNew, lines.length]);

  if (!isNew && loadingEdit) return <div className="flex items-center justify-center h-64 text-muted-foreground">{tr("loadingEdit")}</div>;

  const supplierItems = [
    { value: "", label: tr("noSupplierOpt") },
    ...withHistoricalParty(
      eligibleParties(suppliers, "purchase", supplierId).map((s: any) => ({ value: String(s.id), label: supName(s) })),
      supplierId, `#${supplierId} — المورد المرتبط سابقاً`,
    ),
  ];
  // The dropdown label always shows the LC's GRAND TOTAL in the company's
  // base currency (LC amount + expenses, both already converted via IAS 21
  // historical rates by the server). For multi-currency LCs the user sees a
  // single SAR figure they can reason about, not a mix of USD/SAR.
  const lcItems = [
    { value: "", label: tr("noLcOpt") },
    ...lcs.filter((l: any) => l.status !== "closed").map((l: any) => {
      const grand = Number(l.totalAmountBase ?? l.totalAmount ?? 0)
                  + Number(l.totalExpensesBase ?? 0);
      const cur   = l.baseCurrency ?? defaultCurrency?.code ?? "SAR";
      return { value: String(l.id), label: `${l.lcNumber} (${cur} ${fmt(grand)})` };
    }),
  ];
  const itemComboItems = annotateItemCombo([
    { value: "", label: tr("itemSearchPh") },
    ...inventoryItems.map((i: any) => ({
      value: String(i.id),
      code: i.code ?? undefined,
      label: itemNameOf(i),
    })),
  ], usageModes);
  const unitItems = units
    .filter((u: any) => u.isActive !== false)
    .map((u: any) => ({ value: String(u.id), label: unitNameOf(u) }));

  // Ledger-grid headers (sales-invoice items-tab design): leading "#" index
  // column; notes moved OUT of the columns into a full-width sub-row.
  const HEADERS = [
    "#",
    tr("lineCols.itemCode"),
    tr("lineCols.item"),
    tr("lineCols.warehouse"),
    tr("lineCols.unit"),
    tr("lineCols.qty"),
    t("salesDocForm.colFreeQty"),
    tr("lineCols.weight"),
    tr("lineCols.unitPrice"),
    tr("lineCols.discount"),
    tr("lineCols.vat"),
    tr("lineCols.expenses"),
    tr("lineCols.finalCost"),
    "رقم الدفعة",
    "تاريخ الانتهاء",
    "مركز التكلفة",
    "",
  ];

  // ── tabbed-shell helpers ──────────────────────────────────────────────
  const isPosted = !isNew && (existing as any)?.status === "posted";
  // In view-only mode OR on a posted invoice the whole form is read-only.
  const editLock = viewMode || isPosted;
  // A purchase invoice needs a date AND a supplier before the items tab.
  // EXISTING docs (edit/view) already passed save validation — never lock
  // their items tab (legacy/incomplete headers or late async loads).
  const missingBasicFields = (!isNew || viewMode) ? [] : [
    ...(!invoiceDate ? ["التاريخ"] : []),
    ...(!supplierId ? ["المورد"] : []),
  ];
  const basicFieldsValid = missingBasicFields.length === 0;
  // Never silently block the items tab — explain exactly what is missing.
  const explainMissingBasics = () => {
    toast({
      title: "أكمل البيانات الأساسية أولاً",
      description: `الحقول الناقصة: ${missingBasicFields.join("، ")}`,
      variant: "destructive",
    });
  };
  const handleTabChange = (v: string) => {
    if (v === "items" && !basicFieldsValid) { explainMissingBasics(); return; }
    setActiveTab(v as any);
  };

  const nextButtonBlock = (
    <div className="flex justify-end pt-2">
      <Button type="button" onClick={() => { if (!basicFieldsValid) { explainMissingBasics(); return; } setActiveTab("items"); }} className="gap-1.5">
        التالي: الأصناف
        {isRtl ? <ArrowLeft className="h-4 w-4" /> : <ArrowRight className="h-4 w-4" />}
      </Button>
    </div>
  );

  const saveButton = !editLock ? (
    <Button data-enter-submit="true" onClick={handleSave} disabled={saveMut.isPending}>
      {saveMut.isPending ? tr("saving") : isNew ? tr("saveInvoice") : tr("saveEdit")}
    </Button>
  ) : null;

  const topActionBar = (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3 mb-1">
      <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={() => setActiveTab("basic")}>
        {isRtl ? <ArrowRight className="h-4 w-4" /> : <ArrowLeft className="h-4 w-4" />}
        البيانات الأساسية
      </Button>
      <div className="flex flex-wrap items-center gap-2">
        {saveButton}
      </div>
    </div>
  );

  // ── "إضافة صنف" quick-entry bar (tabbed items tab) ────────────────────
  // Same design as the sales-invoice items tab: pick item → commit. The item
  // picker auto-fills the accurate cost/unit/VAT on commit (handleQuickAdd →
  // selectItem), so leaving السعر blank is the norm.
  // ‹السعر شامل الضريبة› toggle — rendered inside the quick-add bar normally,
  // or standalone above the grid when the bar is hidden (hideQuickAdd), since
  // it is the only editable VAT-mode control on the tabbed items tab.
  const vatModeToggle = (
        <label
          data-testid="price-includes-vat-toggle"
          className={cn(
            "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs cursor-pointer select-none transition-colors",
            priceIncludesVat ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"
          )}
          title={priceIncludesVat ? (tr("vatHintIncl") as string) : (tr("vatHintExcl") as string)}
        >
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary cursor-pointer"
            checked={priceIncludesVat}
            onChange={e => {
              setPriceIncludesVat(e.target.checked);
              stickyPriceIncl.persist(e.target.checked);
            }}
          />
          <span className="font-semibold whitespace-nowrap">{tr("priceIncludesVat")}</span>
          <span className={cn("px-1.5 py-0.5 rounded text-[10px] whitespace-nowrap", priceIncludesVat ? "bg-primary/10 text-primary" : "bg-muted text-foreground/70")}>
            {priceIncludesVat ? tr("inclVat") : tr("exclVat")}
          </span>
        </label>
  );

  const quickAddBar = (
    <div className="mb-3 rounded-xl border-2 border-primary/30 bg-primary/5 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-primary">
          <Plus className="h-4 w-4" />
          <span>إضافة صنف</span>
        </div>
        {vatModeToggle}
      </div>
      <div
        ref={quickAddRef}
        data-enter-scope
        className="grid gap-2 items-end"
        style={{ gridTemplateColumns: "minmax(200px,2fr) 140px 120px 76px 76px 110px 110px auto" }}
      >
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">الصنف</label>
          <SearchCombobox
            items={itemComboItems}
            value={qaItemId}
            onValueChange={setQaItemId}
            placeholder={tr("itemSearchPh")}
            searchPlaceholder="ابحث بالكود أو الاسم..."
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">{tr("lineCols.warehouse")}</label>
          <SearchCombobox
            items={(warehouses as any[]).map((w: any) => ({ value: String(w.id), code: w.code, label: w.nameAr, labelEn: w.nameEn }))}
            value={qaWarehouseId}
            onValueChange={setQaWarehouseId}
            placeholder={tr("lineCols.warehouse")}
            searchPlaceholder="ابحث بالكود أو الاسم..."
            className="h-9 text-xs"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">{tr("lineCols.unit")}</label>
          {(() => {
            const iu = (qaItemId && itemUnitsMap[qaItemId]) ? itemUnitsMap[qaItemId] : [];
            const opts = itemUnitsWithHistoricalSelection(iu, qaUnitId).map((u: any) => ({
              value: String(u.unitId),
              label: `${unitNameOf(u.unit)}${Number(u.conversionFactor) !== 1 ? ` (×${trimTrailingZeros(u.conversionFactor)})` : ""}`,
              disabled: u.isActive === false || u.unit?.isActive === false,
            }));
            return (
              <Select value={qaUnitId || undefined} onValueChange={setQaUnitId} disabled={opts.length === 0}>
                <SelectTrigger className="h-9 text-xs"><SelectValue placeholder={tr("unitPh")} /></SelectTrigger>
                <SelectContent>
                  {opts.map((u: any) => <SelectItem key={u.value} value={u.value} disabled={u.disabled}>{u.label}</SelectItem>)}
                </SelectContent>
              </Select>
            );
          })()}
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">{tr("lineCols.qty")}</label>
          <Input className="h-9 text-xs" type="text" inputMode="numeric" dir="ltr" value={qaQty}
            onChange={e => setQaQty(e.target.value.replace(/[^0-9]/g, ""))} />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">{t("salesDocForm.colFreeQty")}</label>
          <Input className="h-9 text-xs bg-amber-50 border-amber-200 text-amber-900 font-mono" type="text" inputMode="numeric" dir="ltr" value={qaFreeQty}
            onChange={e => setQaFreeQty(e.target.value.replace(/[^0-9]/g, ""))} />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">{tr("lineCols.unitPrice")}</label>
          <Input className="h-9 text-xs" type="text" inputMode="decimal" dir="ltr" placeholder="تلقائي" value={qaPrice}
            onChange={e => setQaPrice(e.target.value.replace(/[^0-9.]/g, ""))} />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">خصم %</label>
          <Input className="h-9 text-xs" type="text" inputMode="decimal" dir="ltr" value={qaDiscount}
            onChange={e => setQaDiscount(e.target.value.replace(/[^0-9.]/g, ""))}
            onKeyDown={e => {
              // Last field in the bar: Enter commits the line (if an item is
              // chosen) and loops focus back to the item picker so the user
              // can keep entering without touching the mouse.
              if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                e.stopPropagation();
                if (qaItemId) void handleQuickAdd().finally(focusQuickAddStart);
                else focusQuickAddStart();
              }
            }} />
        </div>
        <Button type="button" size="sm" className="h-9 gap-1.5 whitespace-nowrap" onClick={() => void handleQuickAdd()} disabled={!qaItemId} data-testid="button-quick-add-item">
          <Plus className="h-4 w-4" />
          إضافة إلى الجريدة
        </Button>
      </div>
    </div>
  );

  const detailsSection = (
    <PurchaseInvoiceDetails
      docId={editId}
      doc={existing}
      cid={cid}
      token={token}
      navigate={navigate}
    />
  );

  return (
    <div ref={containerRef} onKeyDown={onKeyDown} className="space-y-5 w-full" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate("/purchasing/invoices")}>
          {isRtl ? <ArrowRight className="h-4 w-4" /> : <ArrowLeft className="h-4 w-4" />}
        </Button>
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
            <ShoppingCart className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold">{isNew ? tr("newTitle") : tr("editTitle", { id: editId })}</h1>
            <p className="text-xs text-muted-foreground">{tr("subtitle")}</p>
          </div>
        </div>
        <JournalScanArchive
          jeKey={isNew ? newArchiveKeyRef.current : ((existing as any)?.docNumber ?? `PI-${editId}`)}
          screenKey="purchase_invoices"
          companyName={user?.company?.nameAr ?? null}
        />
        {/* Posted/draft/cancelled status pill — visible only when editing
            an existing purchase invoice. */}
        {!isNew && (existing as any) && (
          <DocStatusBadge status={(existing as any).status} />
        )}
        {/* Smart prev/next + search navigator across every purchase invoice
            of the current company. Lets the user step through docs or jump
            to one by typing a recognizable fragment. */}
        <DocNavigator
          items={(allPurchaseInvoices as any[]).map((d: any) => {
            const s = (suppliers as any[]).find((s: any) => Number(s.id) === Number(d.supplierId));
            return {
              id: d.id,
              docNumber: d.docNumber,
              partyName: s ? (s.nameAr ?? s.nameEn ?? `#${s.id}`) : "—",
              date: d.invoiceDate ?? "",
              total: d.totalAmount ?? 0,
              currencyCode: d.currencyCode ?? "",
            };
          })}
          currentId={editId}
          basePath="/purchasing/invoices"
          fallbackPrefix="PI-"
          className="ms-auto"
        />
      </div>

      {!isNew && (existing as any)?.status === "posted" && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 text-sm flex items-center gap-2">
          <Lock className="h-4 w-4" />
          <span>{tr("postedReadOnly")}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ms-auto shrink-0 border-amber-400 text-amber-900 hover:bg-amber-100"
            disabled={unpostMut.isPending}
            onClick={() => {
              if (window.confirm(tr("unpostConfirm"))) unpostMut.mutate();
            }}
            data-testid="button-unpost-invoice"
          >
            {unpostMut.isPending ? tr("unposting") : tr("unpostButton")}
          </Button>
        </div>
      )}
      <Tabs value={useTabbedLayout ? activeTab : "header"} onValueChange={handleTabChange} dir={isRtl ? "rtl" : "ltr"}>
        <Card className="border-2">
          <CardHeader className="p-0">
            {/* Tab chips FIRST (inline-start): RTL Arabic → tabs start from the
                right; LTR English → from the left. flex-nowrap + shrink-0 keep
                every chip on ONE line; the hint text truncates instead. */}
            <div className="flex items-center justify-between gap-3 flex-nowrap px-4 py-2 border-b bg-muted/20">
              {useTabbedLayout ? (
                <TabsList className="h-8 bg-background border gap-1 shrink-0">
                  <TabsTrigger value="basic" className="h-7 px-3 text-xs gap-1.5 whitespace-nowrap data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                    <FileText className="h-3.5 w-3.5" />البيانات الأساسية
                  </TabsTrigger>
                  <TabsTrigger value="items" className={`h-7 px-3 text-xs gap-1.5 whitespace-nowrap data-[state=active]:bg-primary data-[state=active]:text-primary-foreground ${basicFieldsValid ? "" : "opacity-50"}`}>
                    <ListOrdered className="h-3.5 w-3.5" />الأصناف
                  </TabsTrigger>
                  <TabsTrigger value="industrialCosts" className="h-7 px-3 text-xs gap-1.5 whitespace-nowrap data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                    <TrendingUp className="h-3.5 w-3.5" />التكاليف الصناعية
                  </TabsTrigger>
                  {/* Linked-ops tabs stay VISIBLE on a new invoice but disabled
                      until it is saved (they need a persisted invoice id). */}
                  <TabsTrigger value="debitNote" disabled={!editId} className="h-7 px-3 text-xs gap-1.5 whitespace-nowrap data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                    <FileText className="h-3.5 w-3.5" />إشعار مدين
                  </TabsTrigger>
                  <TabsTrigger value="creditNote" disabled={!editId} className="h-7 px-3 text-xs gap-1.5 whitespace-nowrap data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                    <FileText className="h-3.5 w-3.5" />إشعار دائن
                  </TabsTrigger>
                  <TabsTrigger value="payments" className="h-7 px-3 text-xs gap-1.5 whitespace-nowrap data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                    <Wallet className="h-3.5 w-3.5" />السداد
                  </TabsTrigger>
                  <TabsTrigger value="returns" disabled={!editId} className="h-7 px-3 text-xs gap-1.5 whitespace-nowrap data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                    <Undo2 className="h-3.5 w-3.5" />الإرجاع
                  </TabsTrigger>
                  {lines.some(l => isDeferredLine(l)) && (
                    <TabsTrigger value="deferred" disabled={!editId} className="h-7 px-3 text-xs gap-1.5 whitespace-nowrap data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                      <ClipboardList className="h-3.5 w-3.5" />مصروف مرحّل
                    </TabsTrigger>
                  )}
                  <TabsTrigger value="archive" disabled={!editId} className="h-7 px-3 text-xs gap-1.5 whitespace-nowrap data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                    <Archive className="h-3.5 w-3.5" />أرشفة
                  </TabsTrigger>
                  <TabsTrigger value="details" className="h-7 px-3 text-xs gap-1.5 whitespace-nowrap data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                    <ClipboardList className="h-3.5 w-3.5" />التفاصيل
                  </TabsTrigger>
                </TabsList>
              ) : (
                <TabsList className="h-8 bg-background border gap-1 shrink-0">
                  <TabsTrigger value="header" className="h-7 px-3 text-xs gap-1.5 whitespace-nowrap data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                    <FileText className="h-3.5 w-3.5" />{tr("headerData")}
                  </TabsTrigger>
                </TabsList>
              )}
              <p className="flex-1 min-w-0 text-[11px] text-muted-foreground truncate text-end">
                {useTabbedLayout && activeTab === "details"
                  ? "تفاصيل العمليات المرتبطة بفاتورة الشراء"
                  : tr("linesSummary", { count: lines.filter(l => l.itemName).length, total: fmt(totalAmount + totalExpLoaded) })}
              </p>
            </div>
          </CardHeader>

          <TabsContent value={useTabbedLayout ? "basic" : "header"} className="mt-0">
            <CardContent className="pt-5 pb-5 space-y-4">
            <fieldset disabled={editLock} className="contents">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.invoiceNumber")}</Label>
                  {(() => {
                    const lockOnEdit = !isNew;
                    const lockOnSeq  = isNew && seqPeek.hasSequence;
                    const locked     = lockOnEdit || lockOnSeq;
                    return (
                      <Input
                        ref={docNumberRef}
                        className={cn("h-9 text-sm", locked && "bg-muted/40 cursor-not-allowed")}
                        placeholder={isNew && seqPeek.loading ? "…" : tr("auto")}
                        value={docNumber}
                        onChange={e => { if (!locked) setDocNumber(e.target.value); }}
                        readOnly={locked}
                        title={lockOnEdit ? tr("lockTitle") : (lockOnSeq ? `${seqPeek.sequenceCode ?? ""}` : undefined)}
                      />
                    );
                  })()}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.date")}</Label>
                  <DateField className="h-9 text-sm" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} required />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.supplier")}</Label>
                  <SearchCombobox items={supplierItems} value={supplierId} onValueChange={setSupplierId} placeholder={tr("fields.supplierPh")} />
                </div>
                <SupplierVatControl suppliers={suppliers} supplierId={supplierId} onSupplierChange={setSupplierId} />
                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.supplierInvoiceNumber")}</Label>
                  <Input className="h-9 text-sm" placeholder={tr("fields.supplierInvoiceNumberPh")} value={supplierInvoiceNumber} onChange={e => setSupplierInvoiceNumber(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.supplierInvoiceDate")}</Label>
                  <DateField className="h-9 text-sm" value={supplierInvoiceDate} onChange={e => setSupplierInvoiceDate(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.branch")}</Label>
                  <Select value={branchId || undefined} onValueChange={setBranchId}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue placeholder={tr("fields.branchPh")} /></SelectTrigger>
                    <SelectContent>
                      {(branches as any[]).map((b: any) => (
                        <SelectItem key={b.id} value={String(b.id)}>{branchName(b)}{b.isMain ? tr("fields.mainBranchTag") : ""}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.lc")}</Label>
                  <SearchCombobox items={lcItems} value={lcId} onValueChange={setLcId} placeholder={tr("fields.lcPh")} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.notes")}</Label>
                  <Input className="h-9 text-sm" value={notes} onChange={e => setNotes(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">مركز التكلفة</Label>
                  <select
                    value={costCenter}
                    onChange={e => setCostCenter(e.target.value)}
                    data-testid="purchase-cost-center"
                    className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background"
                  >
                    <option value="">— بدون مركز تكلفة —</option>
                    {(costCentersList as any[])
                      .filter((c: any) => c.isActive !== false)
                      .map((c: any) => (
                        <option key={c.id} value={c.code}>
                          {c.code} — {c.nameAr}
                        </option>
                      ))}
                  </select>
                  <p className="text-[10px] text-muted-foreground">يُسند تلقائياً إلى كل سطور القيد عند الترحيل.</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">المشروع (اختياري)</Label>
                  <select aria-label="مشروع فاتورة الشراء" value={projectId} onChange={e => setProjectId(e.target.value)}
                    className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background">
                    <option value="">— بدون مشروع —</option>
                    {(projectOptions?.projects ?? []).filter(p => !branchId || p.branchId == null || String(p.branchId) === branchId)
                      .map(p => <option key={p.id} value={p.id}>{p.code} — {p.nameAr}</option>)}
                  </select>
                  <p className="text-[10px] text-muted-foreground">مشتريات المستودع لا تُحتسب مصروفاً فورياً للمشروع.</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">المستودع</Label>
                  <SearchCombobox
                    items={(warehouses as any[]).map((w: any) => ({
                      value: String(w.id),
                      label: warehouseName(w) || `#${w.id}`,
                    }))}
                    value={headerWarehouseId}
                    onValueChange={applyHeaderWarehouse}
                    placeholder="اختر المستودع"
                  />
                  <p className="text-[10px] text-muted-foreground">يُعبَّأ تلقائياً على كل سطور الأصناف عند الاختيار.</p>
                </div>
                {taxCatalog.length > 0 && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">الضريبة</Label>
                    <SearchCombobox
                      items={taxComboItems}
                      value={headerTaxId}
                      onValueChange={applyHeaderTax}
                      placeholder="اختر الضريبة"
                    />
                    <p className="text-[10px] text-muted-foreground">تُطبَّق نسبتها تلقائياً على كل سطور الأصناف.</p>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.paymentType")}</Label>
                  <Select value={paymentType} onValueChange={(v) => {
                    setPaymentType(v);
                    if (v === "cash") {
                      if (!cashBoxId) {
                        const first = [...(cashBoxes as any[])].sort((a: any, b: any) => (a.id || 0) - (b.id || 0)).find((b: any) => b.isActive !== false);
                        if (first) setCashBoxId(String(first.id));
                      }
                      setBankAccountId("");
                    } else if (v === "bank") {
                      if (!bankAccountId) {
                        const first = [...(bankAccounts as any[])].sort((a: any, b: any) => (a.id || 0) - (b.id || 0)).find((b: any) => b.isActive !== false);
                        if (first) setBankAccountId(String(first.id));
                      }
                      setCashBoxId("");
                    } else {
                      setCashBoxId("");
                      setBankAccountId("");
                    }
                  }}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="credit">
                        <span className="flex items-center gap-2"><CreditCard className="h-3.5 w-3.5" />{tr("payment.credit")}</span>
                      </SelectItem>
                      <SelectItem value="cash">
                        <span className="flex items-center gap-2"><Wallet className="h-3.5 w-3.5" />{tr("payment.cash")}</span>
                      </SelectItem>
                      <SelectItem value="bank">
                        <span className="flex items-center gap-2"><CreditCard className="h-3.5 w-3.5" />{tr("payment.bank")}</span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.currency")}</Label>
                  {currencies.length > 0 ? (
                    <Select value={currencyCode} onValueChange={handleCurrencyChange}>
                      <SelectTrigger className="h-9 text-sm"><SelectValue placeholder={tr("fields.currencyPh")} /></SelectTrigger>
                      <SelectContent>
                        {currencies.map((c: any) => {
                          const cName = isRtl ? c.nameAr : (c.nameEn ?? c.nameAr);
                          return <SelectItem key={c.id} value={c.code}>{c.code} {cName ? `— ${cName}` : ""}</SelectItem>;
                        })}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input className="h-9 text-sm" placeholder="SAR" value={currencyCode} onChange={e => setCurrencyCode(e.target.value)} />
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs flex items-center justify-between">
                    <span>{tr("fields.exchangeRate")}</span>
                    {currencyCode && currencyCode !== (defaultCurrency?.code ?? "SAR") && (
                      <span className="text-[10px] text-muted-foreground font-normal">
                        1 {currencyCode} = {Number(exchangeRate) > 0 ? Number(exchangeRate).toFixed(4) : "—"} {defaultCurrency?.code ?? "SAR"}
                      </span>
                    )}
                  </Label>
                  <Input type="text" inputMode="decimal" className="h-9 text-sm" dir="ltr"
                    value={exchangeRate}
                    onChange={e => setExchangeRate(e.target.value.replace(/[^0-9.]/g, ""))} />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">{tr("fields.distributeMethod")}</Label>
                  <Select value={distMethod} onValueChange={setDistMethod}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="value">{tr("distribute.value")}</SelectItem>
                      <SelectItem value="qty">{tr("distribute.qty")}</SelectItem>
                      <SelectItem value="weight">{tr("distribute.weight")}</SelectItem>
                      <SelectItem value="manual">{tr("distribute.manual")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {paymentType === "bank" ? (
                (() => {
                  const balMap: Record<number, number> = Object.fromEntries(
                    (bankAccountBalances as any[]).map((b: any) => [b.bankAccountId, Number(b.balance)])
                  );
                  const activeBanks = (bankAccounts as any[]).filter((b: any) => b.isActive !== false);
                  const items = [
                    { value: "", label: tr("selectBank") },
                    ...activeBanks.map((b: any) => ({
                      value: String(b.id),
                      label: `${branchName(b)} — ${tr("balanceLabel")}: ${fmt(balMap[b.id] ?? 0)} ${currencyCode}`,
                    })),
                  ];
                  const sel = activeBanks.find((b: any) => String(b.id) === bankAccountId);
                  const bal = sel ? (balMap[sel.id] ?? 0) : 0;
                  const totalDue = totalAmount + totalExpLoaded;
                  const remaining = bal - totalDue;
                  const insufficient = !!sel && remaining < 0;
                  return (
                    <div className="space-y-2">
                      <div className="space-y-1.5">
                        <Label className="text-xs">{tr("bankAccount")}</Label>
                        <SearchCombobox items={items} value={bankAccountId} onValueChange={setBankAccountId} placeholder={tr("bankAccountPh")} />
                      </div>
                      <div className={cn(
                        "rounded-lg border p-3 flex items-start gap-3",
                        !bankAccountId ? "bg-amber-50 border-amber-200 text-amber-800" :
                        insufficient ? "bg-red-50 border-red-200 text-red-800" :
                        "bg-emerald-50 border-emerald-200 text-emerald-800"
                      )}>
                        <CreditCard className="h-4 w-4 mt-0.5 shrink-0" />
                        {!bankAccountId ? (
                          <div className="text-xs">
                            <p className="font-semibold">{tr("bankPayTitle")}</p>
                            <p className="opacity-80 mt-0.5">{tr("bankPayDesc")}</p>
                          </div>
                        ) : (
                          <div className="text-xs flex-1">
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                              <span className="font-semibold">{tr("accountLabel")}: <strong>{branchName(sel)}</strong></span>
                              <span className="flex items-center gap-1"><TrendingUp className="h-3 w-3" />{tr("balanceLabel")}: <strong className="font-mono">{fmt(bal)}</strong></span>
                              <span className="flex items-center gap-1"><TrendingDown className="h-3 w-3" />{tr("withdrawn")}: <strong className="font-mono">{fmt(totalDue)}</strong></span>
                              <span className={cn("flex items-center gap-1", isRtl ? "border-r pr-3 mr-1" : "border-l pl-3 ml-1")}>{tr("remaining")}: <strong className="font-mono">{fmt(remaining)}</strong></span>
                            </div>
                            {insufficient && (
                              <p className="mt-1.5 text-[11px] font-semibold">{tr("balanceInsufficient")}</p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()
              ) : paymentType === "credit" ? (
                (() => {
                  const sup = suppliers.find((s: any) => String(s.id) === supplierId);
                  const balRow = supplierBalances.find((b: any) => b.supplierId === Number(supplierId));
                  const currentBal = balRow ? Number(balRow.balance) : 0;
                  const newBal = currentBal + (totalAmount + totalExpLoaded);
                  const creditLimit = sup ? Number(sup.creditLimit ?? 0) : 0;
                  const overLimit = creditLimit > 0 && newBal > creditLimit;
                  return (
                    <div className={cn(
                      "rounded-lg border p-3 flex items-start gap-3",
                      !supplierId ? "bg-amber-50 border-amber-200 text-amber-800" :
                      overLimit ? "bg-red-50 border-red-200 text-red-800" :
                      "bg-blue-50 border-blue-200 text-blue-800"
                    )}>
                      <CreditCard className="h-4 w-4 mt-0.5 shrink-0" />
                      {!supplierId ? (
                        <div className="text-xs">
                          <p className="font-semibold">{tr("creditTitle")}</p>
                          <p className="opacity-80 mt-0.5">{tr("creditDesc")}</p>
                        </div>
                      ) : (
                        <div className="text-xs flex-1">
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                            <span className="font-semibold">{tr("supplierLabel")}: <strong>{supName(sup)}</strong></span>
                            <span className="flex items-center gap-1">
                              <TrendingUp className="h-3 w-3" />
                              {tr("currentBalance")}: <strong className="font-mono">{fmt(currentBal)}</strong> {currencyCode}
                            </span>
                            <span className="flex items-center gap-1">
                              {tr("plusInvoice")}: <strong className="font-mono">{fmt(totalAmount + totalExpLoaded)}</strong>
                            </span>
                            <span className={cn("flex items-center gap-1", isRtl ? "border-r pr-3 mr-1" : "border-l pl-3 ml-1")}>
                              {tr("balanceAfterPost")}: <strong className="font-mono">{fmt(newBal)}</strong> {currencyCode}
                            </span>
                          </div>
                          {creditLimit > 0 && (
                            <p className={cn("mt-1.5 text-[11px]", overLimit ? "font-semibold" : "opacity-80")}>
                              {overLimit ? "⚠ " : ""}{tr("creditLimit")}: <strong className="font-mono">{fmt(creditLimit)}</strong>
                              {overLimit && ` — ${tr("exceededBy", { amt: fmt(newBal - creditLimit) })}`}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()
              ) : (
                (() => {
                  const balMap: Record<number, number> = Object.fromEntries(
                    (cashBoxBalances as any[]).map((b: any) => [b.cashBoxId, Number(b.balance)])
                  );
                  const activeBoxes = (cashBoxes as any[]).filter((b: any) => b.isActive);
                  const cashBoxItems = [
                    { value: "", label: tr("selectCashBoxOpt") },
                    ...activeBoxes.map((b: any) => ({
                      value: String(b.id),
                      label: `${branchName(b)} — ${tr("balanceLabel")}: ${fmt(balMap[b.id] ?? 0)} ${currencyCode}`,
                    })),
                  ];
                  const selBox = activeBoxes.find((b: any) => String(b.id) === cashBoxId);
                  const boxBal = selBox ? (balMap[selBox.id] ?? 0) : 0;
                  const totalDue = totalAmount + totalExpLoaded;
                  const remaining = boxBal - totalDue;
                  const insufficient = !!selBox && remaining < 0;
                  return (
                    <div className="space-y-2">
                      <div className="space-y-1.5">
                        <Label className="text-xs">{tr("cashBox")}</Label>
                        <SearchCombobox items={cashBoxItems} value={cashBoxId} onValueChange={setCashBoxId} placeholder={tr("cashBoxPh")} />
                      </div>
                      <div className={cn(
                        "rounded-lg border p-3 flex items-start gap-3",
                        !cashBoxId ? "bg-amber-50 border-amber-200 text-amber-800" :
                        insufficient ? "bg-red-50 border-red-200 text-red-800" :
                        "bg-emerald-50 border-emerald-200 text-emerald-800"
                      )}>
                        <Wallet className="h-4 w-4 mt-0.5 shrink-0" />
                        {!cashBoxId ? (
                          <div className="text-xs">
                            <p className="font-semibold">{tr("cashPayTitle")}</p>
                            <p className="opacity-80 mt-0.5">{tr("cashPayDesc")}</p>
                          </div>
                        ) : (
                          <div className="text-xs flex-1">
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                              <span className="font-semibold">{tr("cashBox").replace(" *", "")}: <strong>{branchName(selBox)}</strong></span>
                              <span className="flex items-center gap-1">
                                <TrendingUp className="h-3 w-3" />
                                {tr("balanceLabel")}: <strong className="font-mono">{fmt(boxBal)}</strong>
                              </span>
                              <span className="flex items-center gap-1">
                                <TrendingDown className="h-3 w-3" />
                                {tr("withdrawn")}: <strong className="font-mono">{fmt(totalDue)}</strong>
                              </span>
                              <span className={cn("flex items-center gap-1", isRtl ? "border-r pr-3 mr-1" : "border-l pl-3 ml-1")}>
                                {tr("remaining")}: <strong className={cn("font-mono", insufficient && "font-bold")}>{fmt(remaining)}</strong> {currencyCode}
                              </span>
                            </div>
                            {insufficient && (
                              <p className="mt-1.5 text-[11px] font-semibold">
                                {tr("cashInsufficient", { amt: `${fmt(Math.abs(remaining))} ${currencyCode}` })}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                      {activeBoxes.length === 0 && (
                        <p className="text-[11px] text-muted-foreground">
                          {tr("noCashBoxes")}<strong>{tr("cashBanksMenu")}</strong>.
                        </p>
                      )}
                    </div>
                  );
                })()
              )}

              {selectedLc && (() => {
                // Show the LC balance entirely in the company base currency:
                // grand total (LC + expenses, both base) regardless of the LC's
                // own currency. This is the figure the user will load and finance.
                const baseCur   = selectedLc.baseCurrency ?? defaultCurrency?.code ?? "SAR";
                const lcBase    = Number(selectedLc.totalAmountBase   ?? selectedLc.totalAmount ?? 0);
                const expBase   = Number(selectedLc.totalExpensesBase ?? 0);
                const grandBase = lcBase + expBase;
                const usedBase  = Number(selectedLc.usedAmount ?? 0);
                const remGoods  = Math.max(0, lcBase - usedBase);
                return (
                  <div className="space-y-2">
                    <div className="flex items-center gap-3 p-3 rounded-lg bg-blue-50 border border-blue-200 text-xs text-blue-700">
                      <AlertCircle className="h-4 w-4 shrink-0" />
                      <span>
                        {tr("lcInfo", { lc: selectedLc.lcNumber, remaining: `${fmt(grandBase)} ${baseCur}` })}
                      </span>
                      <Button type="button" size="sm" variant="outline" className={cn("h-6 text-xs border-blue-300 text-blue-700", isRtl ? "mr-auto" : "ml-auto")} onClick={distributeExpenses}>
                        {tr("lcDistribute")}
                      </Button>
                    </div>
                    {/* LC posting notice: explains that the supplier will NOT be
                        credited at posting time — the LC settlement account is
                        credited instead, and the LC usage is auto-updated. */}
                    <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-800 leading-relaxed">
                      <strong className="block mb-1">{tr("lcPostingTitle")}</strong>
                      {tr("lcPostingNote", {
                        goods: `${fmt(remGoods)} ${baseCur}`,
                        used:  `${fmt(usedBase)} ${baseCur}`,
                        total: `${fmt(lcBase)} ${baseCur}`,
                      })}
                    </div>
                  </div>
                );
              })()}

            </fieldset>
              {useTabbedLayout && nextButtonBlock}
            </CardContent>
          </TabsContent>

          <TabsContent value={useTabbedLayout ? "items" : "header"} className="mt-0">
            <CardContent className="pt-2 pb-5 border-t">
              {useTabbedLayout && topActionBar}
              <fieldset disabled={editLock} className="contents">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground/80">
                <ListOrdered className="h-4 w-4" />
                <span>{tr("linesTitle")} ({lines.filter(l => l.itemName).length})</span>
              </div>
              {useTabbedLayout && (hideQuickAdd
                ? <div className="mb-3 flex justify-end">{vatModeToggle}</div>
                : quickAddBar)}
              {(() => {
                const GRID_COLS = "38px 100px minmax(220px,1.3fr) 130px 100px 64px 64px 70px 95px 70px 64px 95px 105px 110px 125px 150px 34px";
                const addGridLine = () => {
                  const nl = newLine();
                  const r = percentRateOf(headerTaxId);
                  if (r !== null) nl.vatRate = String(r);
                  if (headerWarehouseId) nl.warehouseId = headerWarehouseId;
                  setLines(p => [...p, nl]);
                  setFocusLineId(nl._id);
                };
                return (
              <div data-enter-nav-container="lines" className="mb-3 rounded-xl border bg-card overflow-hidden">
                <div className={cn("overflow-auto min-h-[200px]", (useTabbedLayout && hideQuickAdd) ? "max-h-[calc(100vh-260px)]" : "max-h-[calc(100vh-360px)]")}>
                <div className="min-w-max">
                <div
                  className="grid gap-1.5 px-3 py-2 border-b bg-muted/40 sticky top-0 z-10"
                  style={{ gridTemplateColumns: GRID_COLS }}
                >
                  {HEADERS.map((h, i) => (
                    <p
                      key={i}
                      className={cn(
                        "text-[11px] font-medium truncate",
                        h === tr("lineCols.finalCost") ? "font-semibold text-primary" : "text-muted-foreground"
                      )}
                      title={h}
                    >{h}</p>
                  ))}
                </div>
                <div className="divide-y">
                {lines.length === 0 && (
                  <div className="px-3 py-10 text-center text-sm text-muted-foreground">
                    لا توجد أصناف بعد — أضف صنفًا من الشريط بالأعلى.
                  </div>
                )}
                {lines.map((l, idx) => (
                  <div key={l._id} className="px-3 py-2 hover:bg-muted/30 transition-colors">
                    <div
                      className="grid gap-1.5 items-center"
                      style={{ gridTemplateColumns: GRID_COLS }}
                    >
                      <span className="text-xs text-muted-foreground tabular-nums">{idx + 1}</span>
                      <Input className="h-8 text-xs bg-muted/40 font-mono" readOnly={!!l.itemId} placeholder={tr("auto")} value={l.itemCode}
                        onChange={e => updateLine(l._id, "itemCode", e.target.value)} />
                      {inventoryItems.length > 0 ? (
                        <SearchCombobox
                          items={itemComboItems}
                          value={l.itemId}
                          onValueChange={v => selectItem(l._id, v)}
                          placeholder={tr("itemSearchPh")}
                          searchPlaceholder="ابحث بالكود أو الاسم..."
                        />
                      ) : (
                        <Input className="h-8 text-xs" placeholder={tr("itemNamePh")} value={l.itemName}
                          onChange={e => updateLine(l._id, "itemName", e.target.value)} />
                      )}
                      {isServiceLine(l) ? (
                        <div className="h-8 flex items-center justify-center rounded-md bg-muted/40 text-[11px] text-muted-foreground" title={t("inventoryMaster.items.serviceNoStockHint") as string}>
                          {t("salesDocForm.serviceNoWarehouse")}
                        </div>
                      ) : isGroupNoStockLine(l) ? (
                        <div className={cn(
                          "h-8 flex items-center justify-center rounded-md text-[11px] font-medium",
                          lineGroup(l)?.categoryType === "fixed_asset"
                            ? "bg-purple-50 text-purple-700 dark:bg-purple-950 dark:text-purple-300"
                            : lineGroup(l)?.categoryType === "deferred_expense"
                            ? "bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300"
                            : "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
                        )}>
                          {lineGroup(l)?.categoryType === "fixed_asset"
                            ? (t("inventoryMaster.itemGroups.typeFixedAsset") as string)
                            : lineGroup(l)?.categoryType === "deferred_expense"
                            ? (t("inventoryMaster.itemGroups.typeDeferredExpense") as string)
                            : (t("inventoryMaster.itemGroups.typeExpense") as string)}
                        </div>
                      ) : warehouses.length > 0 ? (
                        <div className={cn("rounded-md", l.itemId && !l.warehouseId && "ring-1 ring-amber-400")}>
                          <SearchCombobox
                            items={(warehouses as any[]).map((w: any) => ({ value: String(w.id), code: w.code, label: w.nameAr, labelEn: w.nameEn }))}
                            value={l.warehouseId}
                            onValueChange={v => updateLine(l._id, "warehouseId", v)}
                            placeholder={tr("lineCols.warehouse")}
                            searchPlaceholder="ابحث بالكود أو الاسم..."
                            className="h-8 text-xs"
                          />
                        </div>
                      ) : (
                        <Input className="h-8 text-xs" placeholder="—" readOnly />
                      )}
                      {(() => {
                        const itemUnits = (l.itemId && itemUnitsMap[l.itemId]) ? itemUnitsMap[l.itemId] : [];
                        const opts = itemUnits.length > 0
                          ? itemUnitsWithHistoricalSelection(itemUnits, l.unitId).map((iu: any) => ({
                              value: String(iu.unitId),
                              label: `${unitNameOf(iu.unit)}${Number(iu.conversionFactor) !== 1 ? ` (×${trimTrailingZeros(iu.conversionFactor)})` : ""}`,
                              disabled: iu.isActive === false || iu.unit?.isActive === false,
                            }))
                          : [
                              ...unitItems,
                              ...catalogUnitsWithHistoricalSelection(units, l.unitId)
                                .filter((u: any) => !unitItems.some((x: any) => x.value === String(u.id)))
                                .map((u: any) => ({ value: String(u.id), label: unitNameOf(u) || `#${u.id}`, disabled: u.isActive === false })),
                            ];
                        return units.length > 0 ? (
                          <Select value={l.unitId || undefined} onValueChange={v => changeLineUnit(l._id, v)}>
                            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder={tr("unitPh")} /></SelectTrigger>
                            <SelectContent>
                              {opts.map((u: any) => <SelectItem key={u.value} value={u.value} disabled={u.disabled}>{u.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input className="h-8 text-xs" placeholder={tr("unitPh")} value={l.unit}
                            onChange={e => updateLine(l._id, "unit", e.target.value)} />
                        );
                      })()}
                      <Input className="h-8 text-xs" type="text" inputMode="numeric" value={l.qty} data-hide-default-one
                        onChange={e => updateLine(l._id, "qty", e.target.value.replace(/[^0-9]/g, ""))} />
                      <Input className="h-8 text-xs bg-amber-50 border-amber-200 text-amber-900 font-mono"
                        type="text" inputMode="numeric" value={l.freeQty}
                        title={t("salesDocForm.colFreeQtyHint") as string}
                        onChange={e => updateLine(l._id, "freeQty", e.target.value.replace(/[^0-9]/g, ""))} />
                      <Input className="h-8 text-xs" type="text" inputMode="decimal" value={l.weight}
                        onChange={e => updateLine(l._id, "weight", e.target.value.replace(/[^0-9.]/g, ""))} />
                      <Input className="h-8 text-xs" type="text" inputMode="decimal" value={l.unitPrice}
                        onChange={e => updateLine(l._id, "unitPrice", e.target.value.replace(/[^0-9.]/g, ""))} />
                      <Input className="h-8 text-xs" type="text" inputMode="decimal" value={l.discount}
                        onChange={e => updateLine(l._id, "discount", e.target.value.replace(/[^0-9.]/g, ""))} />
                      <Input className="h-8 text-xs" type="text" inputMode="decimal" value={l.vatRate}
                        onChange={e => updateLine(l._id, "vatRate", e.target.value.replace(/[^0-9.]/g, ""))} />
                      <Input className="h-8 text-xs bg-blue-50 text-blue-700" readOnly value={fmt(l.expenseShare)} />
                      <Input className="h-8 text-xs bg-primary/5 font-semibold text-primary font-mono" dir="ltr" readOnly value={fmt(l.finalCost)} />
                      {isNoStockLine(l) ? (
                        <Input className="h-8 text-xs bg-muted/30" placeholder="—" readOnly />
                      ) : (
                        <Input className="h-8 text-xs" placeholder="رقم الدفعة" value={l.batchNumber}
                          onChange={e => updateLine(l._id, "batchNumber", e.target.value)} />
                      )}
                      {isNoStockLine(l) ? (
                        <Input className="h-8 text-xs bg-muted/30" placeholder="—" readOnly />
                      ) : (
                        <DateField className="h-8 text-xs" value={l.expiryDate}
                          onChange={e => updateLine(l._id, "expiryDate", e.target.value)} />
                      )}
                      {/* OPTIONAL per-line cost center (توزيع تحليلي) — empty falls back to header */}
                      {(costCentersList as any[]).length > 0 ? (
                        <select
                          className="h-8 text-[11px] rounded-md border bg-background px-1 w-full"
                          value={l.costCenter}
                          title="مركز التكلفة للسطر (اختياري) — الافتراضي: رأس المستند"
                          onChange={e => updateLine(l._id, "costCenter", e.target.value)}
                        >
                          <option value="">رأس المستند</option>
                          {(costCentersList as any[])
                            .filter((c: any) => c.isActive !== false)
                            .map((c: any) => (
                              <option key={c.id} value={c.code}>{c.code} — {c.nameAr ?? c.nameEn ?? ""}</option>
                            ))}
                        </select>
                      ) : (
                        <Input className="h-8 text-xs bg-muted/30" placeholder="—" readOnly />
                      )}
                      <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-destructive"
                        onClick={() => setLines(p => p.filter(x => x._id !== l._id))}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    {(l.itemId || l.itemName || l.notes) && (
                      <div className="mt-1.5 pr-[38px] flex items-center gap-1.5">
                        <Input
                          className="h-7 text-[11px] bg-muted/20 border-dashed flex-1"
                          placeholder={t("salesDocForm.notesPlaceholder")}
                          value={l.notes}
                          onChange={e => updateLine(l._id, "notes", e.target.value)}
                        />
                        {isDeferredLine(l) && (
                          <Button
                            type="button" variant="outline" size="sm"
                            className={cn(
                              "h-7 px-2.5 text-[11px] gap-1.5 shrink-0",
                              l.deferredStartDate && l.deferredEndDate
                                ? "border-teal-300 text-teal-700 bg-teal-50 dark:bg-teal-950 dark:text-teal-300"
                                : "border-amber-400 text-amber-700 bg-amber-50 dark:bg-amber-950 dark:text-amber-300 ring-1 ring-amber-400",
                            )}
                            onClick={() => setDeferredDialogLineId(l._id)}
                          >
                            <ClipboardList className="h-3 w-3" />
                            {l.deferredStartDate && l.deferredEndDate
                              ? `خطة التوزيع: ${l.deferredStartDate} ← ${l.deferredEndDate}`
                              : "⚠ حدد خطة توزيع المصروف (مطلوبة للترحيل)"}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                </div>
                </div>
                </div>
                <div className="border-t bg-muted/20 px-3 py-2">
                  <Button type="button" variant="outline" size="sm" className="gap-2" onClick={addGridLine}>
                    <Plus className="h-4 w-4" />{tr("addLine")}
                  </Button>
                </div>
              </div>
                );
              })()}

              {useTabbedLayout ? (
              /* Compact single-strip totals — mirrors the sales invoice items
                 tab. The VAT toggle lives at the top of the tab (quickAddBar),
                 so it is intentionally absent here. */
              <div className="mt-3 rounded-xl border bg-muted/30 px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
                  <span className={cn("text-[10px] font-semibold px-2 py-0.5 rounded", priceIncludesVat ? "bg-primary/10 text-primary" : "bg-muted text-foreground/70")}>
                    {priceIncludesVat ? tr("inclVat") : tr("exclVat")}
                  </span>
                  <div className="flex items-center gap-1.5 ms-auto">
                    <span className="text-muted-foreground text-xs">{tr("subtotal")}</span>
                    <span className="font-mono">{fmt(subtotal)}</span>
                  </div>
                  {lineDiscountTotal > 0 && (
                    <div className="flex items-center gap-1.5" data-testid="line-discount-total">
                      <span className="text-muted-foreground text-xs">{tr("itemDiscount")}</span>
                      <span className="font-mono text-rose-700">−{fmt(lineDiscountTotal)}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground text-xs">{tr("vatAmount")}</span>
                    <span className="font-mono text-amber-700">{fmt(vatAmount)}</span>
                  </div>
                  <div className="min-w-[210px]">
                    <DiscountRow gross={grossTotal} value={docDiscount} onChange={setDocDiscount} currencySymbol={currencySymbol(currencyCode || defaultCurrency?.code, currencies)} />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground text-xs">{tr("lcExpenses")}</span>
                    <span className="font-mono text-blue-700">{fmt(totalExpLoaded)}</span>
                  </div>
                  <div className="flex items-center gap-1.5 border-s ps-4">
                    <span className="font-semibold text-xs">{priceIncludesVat ? tr("totalIncl") : tr("totalLabel")}</span>
                    <span className="font-mono text-base font-bold text-primary">{fmt(totalAmount + totalExpLoaded)}</span>
                  </div>
                </div>
                {currencyCode && currencyCode !== (defaultCurrency?.code ?? "SAR") && Number(exchangeRate) > 0 && (
                  <p className="mt-1 text-[10px] text-muted-foreground text-end">
                    {tr("equivIn")} {defaultCurrency?.code ?? "SAR"}: {fmt((totalAmount + totalExpLoaded) * Number(exchangeRate))}
                  </p>
                )}
              </div>
              ) : (
              <div className="mt-5 flex flex-wrap justify-between gap-4">
                <label
                  data-testid="price-includes-vat-toggle"
                  className={cn(
                    "flex items-start gap-2.5 rounded-xl border-2 p-3 cursor-pointer select-none transition-colors max-w-sm",
                    priceIncludesVat ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"
                  )}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-primary cursor-pointer"
                    checked={priceIncludesVat}
                    onChange={e => {
                      setPriceIncludesVat(e.target.checked);
                      stickyPriceIncl.persist(e.target.checked);
                    }}
                  />
                  <div className="space-y-0.5">
                    <p className="text-xs font-semibold">{tr("priceIncludesVat")}</p>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      {priceIncludesVat ? tr("vatHintIncl") : tr("vatHintExcl")}
                    </p>
                  </div>
                </label>

                <div className="w-72 space-y-2 text-sm border rounded-xl p-4 bg-muted/30">
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground -mt-1">
                    <span>{tr("calcMethod")}</span>
                    <span className={cn("font-semibold px-2 py-0.5 rounded", priceIncludesVat ? "bg-primary/10 text-primary" : "bg-muted text-foreground/70")}>
                      {priceIncludesVat ? tr("inclVat") : tr("exclVat")}
                    </span>
                  </div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{tr("subtotal")}</span><span className="font-mono">{fmt(subtotal)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{tr("vatAmount")}</span><span className="font-mono text-amber-700">{fmt(vatAmount)}</span></div>
                  {lineDiscountTotal > 0 && (
                    <div className="flex justify-between text-rose-700" data-testid="line-discount-total">
                      <span className="text-muted-foreground">{tr("itemDiscount")}</span>
                      <span className="font-mono">−{fmt(lineDiscountTotal)}</span>
                    </div>
                  )}
                  <DiscountRow gross={grossTotal} value={docDiscount} onChange={setDocDiscount} currencySymbol={currencySymbol(currencyCode || defaultCurrency?.code, currencies)} />
                  <div className="flex justify-between"><span className="text-muted-foreground">{tr("lcExpenses")}</span><span className="font-mono text-blue-700">{fmt(totalExpLoaded)}</span></div>
                  <div className="flex justify-between font-bold border-t pt-2 text-base">
                    <span>{priceIncludesVat ? tr("totalIncl") : tr("totalLabel")}</span>
                    <span className="font-mono text-primary">{fmt(totalAmount + totalExpLoaded)}</span>
                  </div>
                  {currencyCode && currencyCode !== (defaultCurrency?.code ?? "SAR") && Number(exchangeRate) > 0 && (
                    <p className="text-[10px] text-muted-foreground border-t pt-1">
                      {tr("equivIn")} {defaultCurrency?.code ?? "SAR"}: {fmt((totalAmount + totalExpLoaded) * Number(exchangeRate))}
                    </p>
                  )}
                </div>
              </div>
              )}
              </fieldset>
            </CardContent>
          </TabsContent>

          {useTabbedLayout && (
            <>
            <TabsContent value="industrialCosts" className="mt-0">
              <CardContent className="pt-5 pb-5">
                <IndustrialCostsTab
                  lines={lines}
                  branches={branches as any[]}
                  costCenters={costCentersList as any[]}
                  disabled={viewMode || (existing as any)?.status === "posted"}
                  onChange={(lineId, industrialCost) => setLines(prev => prev.map(line => line._id === lineId ? { ...line, industrialCost } : line))}
                />
              </CardContent>
            </TabsContent>
            <TabsContent value="payments" className="mt-0">
              <CardContent className="pt-5 pb-5">
                <PurchaseInvoicePaymentsTab
                  invoiceId={editId}
                  docNumber={docNumber}
                  companyId={user?.company?.id}
                  token={token}
                  supplierId={supplierId}
                  supplierName={supName((suppliers as any[]).find((s: any) => String(s.id) === String(supplierId))) || ""}
                  invoiceTotal={totalAmount + totalExpLoaded}
                  invoiceExchangeRate={Number(exchangeRate) || 1}
                  currencyCode={currencyCode}
                  paymentType={paymentType}
                  cashBoxId={cashBoxId}
                  bankAccountId={bankAccountId}
                />
              </CardContent>
            </TabsContent>
            {editId && (
              <TabsContent value="returns" className="mt-0">
                <CardContent className="pt-5 pb-5">
                  <EmbeddedReturnsTab
                    kind="purchase"
                    invoiceId={editId}
                    docNumber={(existing as any)?.docNumber ?? docNumber}
                    companyId={user?.company?.id}
                    token={token}
                    invoiceTotal={totalAmount + totalExpLoaded}
                  />
                </CardContent>
              </TabsContent>
            )}
            {editId && (
              <TabsContent value="debitNote" className="mt-0">
                {(() => {
                  const sup = (suppliers as any[]).find((s: any) => String(s.id) === String(supplierId));
                  return (
                    <EmbeddedAccountNotesTab
                      partyType="supplier"
                      noteType="debit"
                      partyId={supplierId ? Number(supplierId) : null}
                      partyName={sup ? (sup.nameAr ?? sup.nameEn ?? null) : null}
                      partyVatNumber={sup?.vatNumber ?? null}
                      partyAccountId={sup?.accountId ?? null}
                      invoiceDocNumber={(existing as any)?.docNumber ?? docNumber ?? null}
                      invoiceDate={invoiceDate}
                      disabled={viewMode}
                    />
                  );
                })()}
              </TabsContent>
            )}
            {editId && (
              <TabsContent value="creditNote" className="mt-0">
                {(() => {
                  const sup = (suppliers as any[]).find((s: any) => String(s.id) === String(supplierId));
                  return (
                    <EmbeddedAccountNotesTab
                      partyType="supplier"
                      noteType="credit"
                      partyId={supplierId ? Number(supplierId) : null}
                      partyName={sup ? (sup.nameAr ?? sup.nameEn ?? null) : null}
                      partyVatNumber={sup?.vatNumber ?? null}
                      partyAccountId={sup?.accountId ?? null}
                      invoiceDocNumber={(existing as any)?.docNumber ?? docNumber ?? null}
                      invoiceDate={invoiceDate}
                      disabled={viewMode}
                    />
                  );
                })()}
              </TabsContent>
            )}
            {editId && (
              <TabsContent value="archive" className="mt-0">
                <CardContent className="pt-5 pb-5">
                  <InvoiceArchiveTab
                    invoiceId={editId}
                    invoiceType="purchase"
                    invoiceNumber={docNumber}
                    seed={{
                      branchId: branchId ? Number(branchId) : null,
                      warehouseId: headerWarehouseId ? Number(headerWarehouseId) : null,
                      warehouseName: warehouseName((warehouses as any[]).find((w: any) => String(w.id) === headerWarehouseId)) || null,
                      partyId: supplierId ? Number(supplierId) : null,
                      partyType: "supplier",
                      partyName: supName((suppliers as any[]).find((s: any) => String(s.id) === String(supplierId))) || null,
                      lines: lines.filter(l => l.itemName).map(l => ({
                        itemName: l.itemName, unit: l.unit,
                        orderedQty: Number(l.qty) || 0, actualQty: Number(l.qty) || 0,
                      })),
                    }}
                  />
                </CardContent>
              </TabsContent>
            )}
            {editId && (
              <TabsContent value="deferred" className="mt-0">
                <CardContent className="pt-5 pb-5">
                  <DeferredExpenseTab invoiceId={editId} api={API} authH={authH} cid={cid} fmt={fmt} ccs={costCentersList as any[]} />
                </CardContent>
              </TabsContent>
            )}
            <TabsContent value="details" className="mt-0">
              <CardContent className="pt-5 pb-5">
                {detailsSection}
              </CardContent>
            </TabsContent>
            </>
          )}
        </Card>
      </Tabs>

      {/* ── حوار خطة توزيع المصروف (مصروف يوزع على فترات) ── */}
      <Dialog open={!!deferredDialogLineId} onOpenChange={o => { if (!o) setDeferredDialogLineId(null); }}>
        <DialogContent className="max-w-lg" dir="rtl">
          <DialogHeader>
            <DialogTitle>خطة توزيع المصروف على الفترات</DialogTitle>
          </DialogHeader>
          {(() => {
            const dl = lines.find(l => l._id === deferredDialogLineId);
            if (!dl) return null;
            const patch = (p: Partial<InvoiceLine>) =>
              setLines(prev => prev.map(l => l._id === dl._id ? { ...l, ...p } : l));
            const ccSum = dl.deferredCostCenters.reduce((s, c) => s + (Number(c.pct) || 0), 0);
            const activeCcs = (costCentersList as any[]).filter((c: any) => c.isActive !== false);
            return (
              <div className="space-y-4">
                <div className="text-sm text-muted-foreground">
                  الصنف: <span className="font-medium text-foreground">{dl.itemName || "—"}</span>
                  {" — "}قيمة السطر: <span className="font-mono">{fmt(dl.finalCost || dl.lineTotal)}</span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">تاريخ بداية التوزيع <span className="text-destructive">*</span></Label>
                    <DateField className="h-9 text-sm" value={dl.deferredStartDate}
                      onChange={e => patch({ deferredStartDate: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">تاريخ نهاية التوزيع <span className="text-destructive">*</span></Label>
                    <DateField className="h-9 text-sm" value={dl.deferredEndDate}
                      onChange={e => patch({ deferredEndDate: e.target.value })} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">دورية التحميل</Label>
                  <Select value={dl.deferredPeriodicity || "monthly"} onValueChange={v => patch({ deferredPeriodicity: v })}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="monthly">شهري</SelectItem>
                      <SelectItem value="quarterly">ربع سنوي</SelectItem>
                      <SelectItem value="semiannual">نصف سنوي</SelectItem>
                      <SelectItem value="annual">سنوي</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">توزيع مراكز التكلفة (اختياري — نسب %)</Label>
                    <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs gap-1"
                      disabled={activeCcs.length === 0}
                      onClick={() => patch({ deferredCostCenters: [...dl.deferredCostCenters, { costCenterId: "", pct: "" }] })}>
                      <Plus className="h-3 w-3" />إضافة مركز
                    </Button>
                  </div>
                  {dl.deferredCostCenters.map((c, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <select
                        className="h-8 text-xs rounded-md border bg-background px-2 flex-1"
                        value={c.costCenterId}
                        onChange={e => {
                          const next = dl.deferredCostCenters.map((x, j) => j === i ? { ...x, costCenterId: e.target.value } : x);
                          patch({ deferredCostCenters: next });
                        }}
                      >
                        <option value="">— اختر مركز التكلفة —</option>
                        {activeCcs.map((cc: any) => (
                          <option key={cc.id} value={String(cc.id)}>{cc.code} — {cc.nameAr ?? cc.nameEn ?? ""}</option>
                        ))}
                      </select>
                      <Input className="h-8 text-xs w-24 font-mono" dir="ltr" type="text" inputMode="decimal"
                        placeholder="%" value={c.pct}
                        onChange={e => {
                          const v = e.target.value.replace(/[^0-9.]/g, "");
                          const next = dl.deferredCostCenters.map((x, j) => j === i ? { ...x, pct: v } : x);
                          patch({ deferredCostCenters: next });
                        }} />
                      <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-destructive"
                        onClick={() => patch({ deferredCostCenters: dl.deferredCostCenters.filter((_, j) => j !== i) })}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                  {dl.deferredCostCenters.length > 0 && (
                    <div className={cn("text-xs font-medium", Math.abs(ccSum - 100) < 0.01 ? "text-emerald-600" : "text-amber-600")}>
                      مجموع النسب: {ccSum}% {Math.abs(ccSum - 100) >= 0.01 && "— يجب أن يساوي 100% عند الترحيل"}
                    </div>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  عند ترحيل الفاتورة سيتم إنشاء قيد تسوية دورية مرتبطة تلقائياً تحمّل المصروف على الفترات المحددة
                  (من حساب المصروف المقدم إلى حساب المصروف)؛ يظهر التنفيذ في تبويب «مصروف مرحّل» وفي جدولة التسويات.
                </p>
                <DialogFooter>
                  <Button type="button" onClick={() => setDeferredDialogLineId(null)}>تم</Button>
                </DialogFooter>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {!useTabbedLayout && (
      <div className="flex justify-end gap-2">
        <Button variant="outline" data-enter-skip="true" onClick={() => navigate("/purchasing/invoices")}>
          {isPosted ? tr("back") : tr("cancel")}
        </Button>
        {!isPosted && (
          <Button data-enter-submit="true" onClick={handleSave} disabled={saveMut.isPending}>
            {saveMut.isPending ? tr("saving") : isNew ? tr("saveInvoice") : tr("saveEdit")}
          </Button>
        )}
      </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// تبويب «مصروف مرحّل» — يعرض سطور المصروف المؤجل وقيود التسوية المرتبطة
// والتنفيذات الدورية المتولدة، مع تعديل التسوية وعرض القيد داخل الفاتورة.
// ─────────────────────────────────────────────────────────────────────────────
function DeferredExpenseTab({ invoiceId, api, authH, cid, fmt, ccs }: {
  invoiceId: number; api: string; authH: Record<string, string>;
  cid: number | undefined; fmt: (n: any) => string; ccs: any[];
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const withCid = (path: string) => cid ? `${api}${path}${path.includes("?") ? "&" : "?"}companyId=${cid}` : `${api}${path}`;
  // Resolve canonical split ids → cost-center codes for display.
  const ccLabel = (id: any) => {
    const cc = (ccs ?? []).find((c: any) => Number(c.id) === Number(id));
    return cc ? String(cc.code ?? cc.id) : `#${id}`;
  };
  const { data, isLoading, error } = useQuery<any>({
    queryKey: ["/purchase-invoice-deferred", invoiceId],
    queryFn: async () => {
      const r = await fetch(withCid(`/api/purchasing/purchase-invoices/${invoiceId}/deferred`), { headers: authH });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? "فشل التحميل");
      return r.json();
    },
  });

  // ── تعديل التسوية (المبلغ / تاريخ النهاية) — PUT /api/adjustments/:id ──
  const [editAdj, setEditAdj] = useState<any | null>(null);
  const [editTotal, setEditTotal] = useState("");
  const [editStart, setEditStart] = useState("");
  const [editEnd, setEditEnd] = useState("");
  const openEdit = (a: any, hasRuns: boolean) => {
    setEditAdj({ ...a, _hasRuns: hasRuns });
    setEditTotal(String(a.totalAmount ?? ""));
    setEditStart(a.startDate ?? "");
    setEditEnd(a.endDate ?? "");
  };
  const saveEdit = useMutation({
    mutationFn: async () => {
      const body: any = { totalAmount: Number(editTotal), endDate: editEnd };
      if (!editAdj?._hasRuns) body.startDate = editStart;
      const r = await fetch(withCid(`/api/adjustments/${editAdj.id}`), {
        method: "PUT",
        headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error ?? "فشل حفظ التعديل");
      return j;
    },
    onSuccess: (j: any) => {
      toast({
        title: "تم تعديل التسوية وإعادة توزيع الأقساط",
        description: j?.catchUpRuns ? `تم توليد ${j.catchUpRuns} قيد مستحق فوراً` : undefined,
      });
      setEditAdj(null);
      qc.invalidateQueries({ queryKey: ["/purchase-invoice-deferred", invoiceId] });
    },
    onError: (e: any) => toast({ title: e?.message ?? "فشل حفظ التعديل", variant: "destructive" }),
  });

  // ── عرض قيد اليومية داخل الفاتورة (نقرة على رقم القيد) ──
  const [viewJeId, setViewJeId] = useState<number | null>(null);
  const jeQ = useQuery<any>({
    queryKey: ["/deferred-je-view", viewJeId, cid],
    enabled: viewJeId != null,
    queryFn: async () => {
      const r = await fetch(withCid(`/api/journal-entries/${viewJeId}`), { headers: authH });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? "فشل تحميل القيد");
      return r.json();
    },
  });
  const accountsQ = useQuery<any[]>({
    queryKey: ["/deferred-je-accounts", cid],
    enabled: viewJeId != null,
    queryFn: async () => {
      const r = await fetch(withCid(`/api/accounts`), { headers: authH });
      const j = await r.json().catch(() => null);
      return Array.isArray(j) ? j : [];
    },
  });
  const accLabel = (id: any) => {
    const a = (accountsQ.data ?? []).find((x: any) => Number(x.id) === Number(id));
    return a ? `${a.code ?? a.id} — ${a.nameAr ?? a.nameEn ?? ""}` : `#${id ?? "—"}`;
  };

  if (isLoading) return <div className="text-sm text-muted-foreground py-6 text-center">جارٍ التحميل…</div>;
  if (error) return <div className="text-sm text-destructive py-6 text-center">{(error as any)?.message ?? "خطأ"}</div>;
  const lines: any[] = Array.isArray(data?.lines) ? data.lines : [];
  const adjustments: any[] = Array.isArray(data?.adjustments) ? data.adjustments : [];
  const runs: any[] = Array.isArray(data?.runs) ? data.runs : [];
  const runsByAdj = (adjId: number) => runs.filter((r: any) => Number(r.adjustmentId) === Number(adjId));
  const periodicityLabel = (p: any) =>
    p === "quarterly" ? "ربع سنوي" : p === "semiannual" ? "نصف سنوي" : p === "annual" ? "سنوي" : "شهري";
  if (!lines.length && !adjustments.length) {
    return (
      <div className="text-sm text-muted-foreground py-8 text-center">
        لا توجد سطور مصروف مؤجل في هذه الفاتورة — تُنشأ قيود التوزيع تلقائياً عند ترحيل فاتورة تحتوي أصنافاً من مجموعة «مصروف يوزع على فترات».
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold mb-2">سطور المصروف المؤجل</h3>
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-3 py-2 text-start">الصنف</th>
                <th className="px-3 py-2 text-start">من</th>
                <th className="px-3 py-2 text-start">إلى</th>
                <th className="px-3 py-2 text-start">الدورية</th>
                <th className="px-3 py-2 text-end">القيمة</th>
                <th className="px-3 py-2 text-start">مراكز التكلفة</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l: any) => (
                <tr key={l.id} className="border-t">
                  <td className="px-3 py-2">{l.itemName ?? "—"}</td>
                  <td className="px-3 py-2 font-mono" dir="ltr">{l.deferredStartDate ?? "—"}</td>
                  <td className="px-3 py-2 font-mono" dir="ltr">{l.deferredEndDate ?? "—"}</td>
                  <td className="px-3 py-2">{periodicityLabel(l.deferredPeriodicity)}</td>
                  <td className="px-3 py-2 text-end font-mono">{fmt(l.finalCost ?? l.lineTotal)}</td>
                  <td className="px-3 py-2">
                    {Array.isArray(l.deferredCostCenters) && l.deferredCostCenters.length
                      ? l.deferredCostCenters.map((c: any) => `${ccLabel(c.costCenterId)} (${c.pct}%)`).join("، ")
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {adjustments.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">قيود التسوية المرتبطة</h3>
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-3 py-2 text-start">الوصف</th>
                  <th className="px-3 py-2 text-start">من</th>
                  <th className="px-3 py-2 text-start">إلى</th>
                  <th className="px-3 py-2 text-start">الدورية</th>
                  <th className="px-3 py-2 text-end">الإجمالي</th>
                  <th className="px-3 py-2 text-start">الحالة</th>
                  <th className="px-3 py-2 text-start">تعديل</th>
                </tr>
              </thead>
              <tbody>
                {adjustments.map((a: any) => (
                  <tr key={a.id} className="border-t">
                    <td className="px-3 py-2">{a.description ?? a.nameAr ?? a.name ?? `تسوية #${a.id}`}</td>
                    <td className="px-3 py-2 font-mono" dir="ltr">{a.startDate ?? "—"}</td>
                    <td className="px-3 py-2 font-mono" dir="ltr">{a.endDate ?? "—"}</td>
                    <td className="px-3 py-2">{periodicityLabel(a.periodicity)}</td>
                    <td className="px-3 py-2 text-end font-mono">{fmt(a.totalAmount)}</td>
                    <td className="px-3 py-2">
                      <span className={cn(
                        "inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium",
                        a.status === "active"
                          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                          : "bg-muted text-muted-foreground",
                      )}>
                        {a.status === "active" ? "نشطة" : a.status === "completed" ? "مكتملة" : a.status ?? "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {["active", "completed"].includes(a.status) ? (
                        <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-[11px]"
                          onClick={() => openEdit(a, runsByAdj(a.id).length > 0)} data-testid={`button-edit-deferred-adj-${a.id}`}>
                          تعديل
                        </Button>
                      ) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {runs.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">التنفيذات الدورية ({runs.length})</h3>
          <div className="rounded-md border overflow-x-auto max-h-64 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-start">تاريخ الفترة</th>
                  <th className="px-3 py-2 text-end">المبلغ</th>
                  <th className="px-3 py-2 text-start">الحالة</th>
                  <th className="px-3 py-2 text-start">قيد اليومية</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r: any) => {
                  const st = r.jeStatus ?? r.status ?? null;
                  return (
                  <tr key={r.id} className="border-t">
                    <td className="px-3 py-2 font-mono" dir="ltr">{r.jeDate ?? r.periodMonth ?? r.periodDate ?? "—"}</td>
                    <td className="px-3 py-2 text-end font-mono">{fmt(r.amount)}</td>
                    <td className="px-3 py-2">
                      <span className={cn(
                        "inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium",
                        st === "posted"
                          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                          : "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
                      )}>
                        {st === "posted" ? "مرحّل" : st === "draft" ? "مسودة" : st ?? "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono" dir="ltr">
                      {r.journalEntryId != null ? (
                        <button type="button"
                          className="text-primary underline underline-offset-2 hover:opacity-80 font-mono"
                          onClick={() => setViewJeId(Number(r.journalEntryId))}
                          data-testid={`link-deferred-je-${r.id}`}>
                          {r.jeDocNumber ?? `QYD-${String(r.journalEntryId).padStart(4, "0")}`}
                        </button>
                      ) : "—"}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── حوار تعديل التسوية (المبلغ / التواريخ) مع إعادة التوزيع التلقائي ── */}
      <Dialog open={!!editAdj} onOpenChange={o => { if (!o) setEditAdj(null); }}>
        <DialogContent className="max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle>تعديل تسوية المصروف المرحّل</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">المبلغ الإجمالي (صافي بدون ضريبة)</Label>
              <Input type="text" inputMode="decimal" dir="ltr" value={editTotal}
                onChange={e => setEditTotal(e.target.value)}
                data-testid="input-deferred-edit-total" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">تاريخ البداية</Label>
                <DateField value={editStart} onChange={e => setEditStart(e.target.value)} disabled={!!editAdj?._hasRuns} />
                {editAdj?._hasRuns && (
                  <p className="text-[10px] text-muted-foreground mt-1">مقفول بعد توليد أول قيد</p>
                )}
              </div>
              <div>
                <Label className="text-xs">تاريخ النهاية</Label>
                <DateField value={editEnd} onChange={e => setEditEnd(e.target.value)} />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground leading-5">
              الأشهر المولَّدة بالفعل تبقى كما هي — المتبقي (المبلغ الجديد − المُحقَّق) يُعاد توزيعه تلقائياً على الأشهر المتبقية، وأي شهر مستحق يُولَّد قيده فوراً.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditAdj(null)}>إلغاء</Button>
            <Button type="button" onClick={() => saveEdit.mutate()} disabled={saveEdit.isPending}
              data-testid="button-save-deferred-edit">
              {saveEdit.isPending ? "جارٍ الحفظ…" : "حفظ التعديل"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── حوار عرض قيد اليومية داخل الفاتورة ── */}
      <Dialog open={viewJeId != null} onOpenChange={o => { if (!o) setViewJeId(null); }}>
        <DialogContent className="max-w-2xl" dir="rtl">
          <DialogHeader>
            <DialogTitle>
              قيد اليومية {jeQ.data?.docNumber ?? (viewJeId != null ? `QYD-${String(viewJeId).padStart(4, "0")}` : "")}
            </DialogTitle>
          </DialogHeader>
          {jeQ.isLoading ? (
            <div className="text-sm text-muted-foreground py-6 text-center">جارٍ التحميل…</div>
          ) : jeQ.error ? (
            <div className="text-sm text-destructive py-6 text-center">{(jeQ.error as any)?.message ?? "خطأ"}</div>
          ) : jeQ.data ? (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div><span className="text-muted-foreground">التاريخ: </span><span className="font-mono" dir="ltr">{jeQ.data.entryDate ?? "—"}</span></div>
                <div>
                  <span className="text-muted-foreground">الحالة: </span>
                  <span className={cn(
                    "inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium",
                    jeQ.data.status === "posted"
                      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                      : "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
                  )}>
                    {jeQ.data.status === "posted" ? "مرحّل" : "مسودة"}
                  </span>
                </div>
                <div className="col-span-3"><span className="text-muted-foreground">الوصف: </span>{jeQ.data.description ?? "—"}</div>
              </div>
              <div className="rounded-md border overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-start">الحساب</th>
                      <th className="px-3 py-2 text-start">البيان</th>
                      <th className="px-3 py-2 text-end">مدين</th>
                      <th className="px-3 py-2 text-end">دائن</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(Array.isArray(jeQ.data.lines) ? jeQ.data.lines : []).map((l: any) => (
                      <tr key={l.id} className="border-t">
                        <td className="px-3 py-2">{accLabel(l.accountId)}</td>
                        <td className="px-3 py-2">{l.description ?? "—"}</td>
                        <td className="px-3 py-2 text-end font-mono">{Number(l.debit) > 0 ? fmt(l.debit) : "—"}</td>
                        <td className="px-3 py-2 text-end font-mono">{Number(l.credit) > 0 ? fmt(l.credit) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-muted/30 font-semibold">
                    <tr className="border-t">
                      <td className="px-3 py-2" colSpan={2}>الإجمالي</td>
                      <td className="px-3 py-2 text-end font-mono">
                        {fmt((Array.isArray(jeQ.data.lines) ? jeQ.data.lines : []).reduce((s: number, l: any) => s + (Number(l.debit) || 0), 0))}
                      </td>
                      <td className="px-3 py-2 text-end font-mono">
                        {fmt((Array.isArray(jeQ.data.lines) ? jeQ.data.lines : []).reduce((s: number, l: any) => s + (Number(l.credit) || 0), 0))}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
