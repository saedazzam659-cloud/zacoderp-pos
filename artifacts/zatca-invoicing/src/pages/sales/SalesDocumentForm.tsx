import { useState, useEffect, useRef, useMemo } from "react";
import { useRegisterScreenActions, type ScreenActionsRegistration, type ScreenFieldDef } from "@/contexts/ScreenActionsContext";
import { useEnterNavContainer } from "@/lib/enterNav";
import { validateInvoiceLines } from "@/lib/lineValidation";
import { syncLineDiscount, effectiveLineDiscount } from "@/lib/lineDiscountSync";
import { useEnterNavigation } from "@/hooks/useEnterNavigation";
import { useAutoFocusOnMount } from "@/hooks/useAutoFocusOnMount";
import { useRoute, useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { JournalScanArchive } from "@/components/JournalScanArchive";
import { trimTrailingZeros } from "@/hooks/use-fmt";
import { useFormatters, currencySymbol } from "@/lib/format";
import { useStickyPriceIncludesVat } from "@/lib/useStickyPriceIncludesVat";
import { useFieldPolicy } from "@/hooks/useInvoiceFieldPolicy";
import { useToast } from "@/hooks/use-toast";
import { getSaveToastTitle } from "@/lib/saveToast";
import { ensurePrinterReady } from "@/lib/printerGuard";
import { useNextSequenceNumber, type SequenceTxType } from "@/hooks/useNextSequenceNumber";
import { useCompanyTaxes } from "@/hooks/useCompanyTaxes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { DocNavigator } from "@/components/DocNavigator";
import { DocStatusBadge } from "@/components/DocStatusBadge";
import { AccountCombobox } from "@/components/AccountCombobox";
import { CustomerVatControl } from "@/components/CustomerVatControl";
import { DiscountRow } from "@/components/DiscountRow";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ArrowRight, ArrowLeft, ShoppingBag, FileSignature, ClipboardList, Plus, Trash2, FileText, ListOrdered, Calculator, Tag, Printer, Lock, Receipt, ShieldCheck } from "lucide-react";
import { offersApi } from "@/lib/offersApi";
import { fetchJsonArray } from "@/lib/fetchJsonArray";
import { DateField } from "@/components/ui/date-field";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const today = () => new Date().toISOString().slice(0, 10);

interface DocLine {
  _id: string;
  itemId: string;
  itemName: string;
  itemCode: string;
  unitId: string;
  unit: string;
  conversionFactor: string;
  warehouseId: string;
  qty: string;
  // Free (bonus) qty — deducts stock like `qty` but adds 0 to revenue/VAT.
  freeQty: string;
  unitPrice: string;
  discount: string;
  // Fixed-amount discount on the line, applied AFTER the percent discount.
  // Stored in the same VAT-inclusion basis as `unitPrice`. Posts to the
  // SAME discount account on the JE as the percent discount.
  discountAmount: string;
  vatRate: string;
  lineTotal: string;
  notes: string;
  // Promotion that the engine matched to this line (null when no offer
  // applies). Saved on the invoice line for audit trail; cleared when the
  // user changes inputs that make the offer no longer qualify.
  appliedOfferId: number | null;
  appliedOfferName: string | null;
  // Snapshot of the field values the engine wrote LAST. Used so that on a
  // "no match" tick we only revert fields the engine actually owns —
  // preserving any manual edits the user made on top of (or alongside) an
  // engine-applied value. Cleared whenever the user types into the field
  // (handled via updateLine).
  engineUnitPrice: string | null;
  engineDiscount:  string | null;
  // The unit price BEFORE the engine ever touched it. Sent to the matcher
  // every cycle so the engine evaluates offers against a stable base, never
  // against its own previous output. Without this, a price-mode line_pricing
  // offer could flip to percent mode on cycle 2 (because np === unitPrice
  // makes the price lever yield 0 saving) and stack a discount % on top of
  // the already-reduced price → cross-cycle double-discount.
  // Updated only when the user manually edits unitPrice or selects an item.
  baseUnitPrice: string;
}

function newLine(): DocLine {
  return {
    _id: crypto.randomUUID(), itemId: "", itemName: "", itemCode: "",
    unitId: "", unit: "", conversionFactor: "1", warehouseId: "",
    qty: "1", freeQty: "0", unitPrice: "0", discount: "0", discountAmount: "0", vatRate: "15",
    lineTotal: "0", notes: "",
    appliedOfferId: null, appliedOfferName: null,
    engineUnitPrice: null, engineDiscount: null,
    baseUnitPrice: "0",
  };
}

// Tax calculation mode — comes from the company-wide setting
// `taxCalculationMode`. "after_discount" (default) = legacy behaviour:
// discount reduces the taxable base then VAT is added (ZATCA-standard).
// "before_discount" = VAT is computed on the full price first, then the
// discount is subtracted from the gross total (used for post-tax
// incentive discounts like coupons).
type TaxMode = "before_discount" | "after_discount";
function calcLine(l: DocLine, priceIncludesVat = false, taxMode: TaxMode = "after_discount") {
  const qty   = Number(l.qty) || 0;
  const price = Number(l.unitPrice) || 0;
  const rate  = (Number(l.vatRate) || 0) / 100;
  // `discount` (%) and `discountAmount` (SAR) are now two views of the
  // same value — kept in sync via `syncLineDiscount`. We use the SAR
  // amount as the single source of truth (with a % fallback for legacy
  // rows that only carry the percentage). Previously both were
  // subtracted, which double-counted whenever a user typed into either.
  const discAmtEff = effectiveLineDiscount(l);
  if (taxMode === "before_discount") {
    // VAT is computed on the FULL (un-discounted) price; the discount
    // then reduces the gross total post-tax.
    const fullGross = Math.max(0, qty * price);
    if (priceIncludesVat) {
      const fullNet = rate > -1 ? fullGross / (1 + rate) : fullGross;
      const vat = fullGross - fullNet;
      const lineTotal = Math.max(0, fullGross - discAmtEff);
      const subtotal = Math.max(0, fullNet - discAmtEff);
      return { subtotal, vat, lineTotal };
    }
    const vat = fullGross * rate;
    const subtotal = Math.max(0, fullGross - discAmtEff);
    const lineTotal = Math.max(0, fullGross + vat - discAmtEff);
    return { subtotal, vat, lineTotal };
  }
  // Legacy "after_discount" behaviour — unchanged.
  const gross = Math.max(0, qty * price - discAmtEff);
  if (priceIncludesVat) {
    const net = rate > -1 ? gross / (1 + rate) : gross;
    const vat = gross - net;
    return { subtotal: net, vat, lineTotal: gross };
  }
  const vat = gross * rate;
  return { subtotal: gross, vat, lineTotal: gross + vat };
}

export interface SalesDocumentFormProps {
  mode: "invoice" | "quotation" | "order";
}

export default function SalesDocumentForm({ mode }: SalesDocumentFormProps) {
  const isInvoice   = mode === "invoice";
  const isQuotation = mode === "quotation";
  const isOrder     = mode === "order";
  // "Operational" documents (invoice + sales order) carry the same set of
  // operational fields: branch, sales rep, payment type, cash/bank account.
  // Quotations are commercial offers only and skip these. Sales orders look
  // like invoices on the form but produce ZERO accounting/stock side-effects
  // server-side — that finance-free contract is enforced in the route, not
  // here. Accounting account fields and offers stay invoice-only.
  const usesOps     = isInvoice || isOrder;
  // Branch is now a first-class field on ALL sales documents (invoice / order
  // / quotation) so quotations can be scoped per branch like invoices. The
  // other operational fields (payment type, cash/bank, sales rep) remain
  // invoice/order-only via `usesOps`.
  const usesBranch  = isInvoice || isOrder || isQuotation;
  const basePath    = isInvoice ? "/sales/invoices"   : isOrder ? "/sales/orders"   : "/sales/quotations";
  const apiPath     = isInvoice ? "sales-invoices"    : isOrder ? "sales-orders"    : "sales-quotations";
  const queryKey    = isInvoice ? "sales-invoice"     : isOrder ? "sales-order"     : "sales-quotation";

  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const { t } = useTranslation();
  const { fmt, isRtl } = useFormatters();
  const BackIcon = isRtl ? ArrowRight : ArrowLeft;
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const authH   = { Authorization: `Bearer ${token}` };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [matchNew]            = useRoute(`${basePath}/new`);
  const [matchEdit, params]   = useRoute(`${basePath}/:id`);
  const isNew  = !!matchNew;
  const editId = matchEdit ? Number((params as any).id) : null;

  // SuperAdmin "Invoice Field Policies" governance — controls which header
  // fields are visible / readonly / required, and locks the date to today
  // when the matching profile says so. Admins/superadmins always bypass via
  // the hook (returns editable for everything). Field keys here MUST match
  // FIELD_CATALOGUE.sales in lib/db/src/schema/invoiceFieldPolicies.ts.
  const fp = useFieldPolicy("sales");
  const dateBounds = fp.dateBounds("date") ?? {};

  const [activeTab, setActiveTab]       = useState("header");
  const [docNumber, setDocNumber]       = useState("");
  const [docDate,   setDocDate]         = useState(today());
  const [validUntil,setValidUntil]      = useState("");
  const [customerId,setCustomerId]      = useState("");
  // ID of the quotation the user picked from the "بناءً على عرض سعر"
  // combobox on the new-invoice form. Sent on save so the backend can mark
  // the source quotation as converted and back-link it. Only meaningful
  // when isInvoice && isNew. Cleared on save/navigation alongside the rest
  // of the form state.
  const [sourceQuotationId, setSourceQuotationId] = useState("");
  const [branchId,  setBranchId]        = useState("");
  const [paymentType,setPaymentType]    = useState("credit");
  const [cashBoxId, setCashBoxId]       = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [currencyCode,setCurrencyCode]  = useState("");
  const [exchangeRate,setExchangeRate]  = useState("1");
  const [notes,     setNotes]           = useState("");
  const [costCenter, setCostCenter]     = useState("");
  const [salesRepId, setSalesRepId]     = useState("");
  // The "السعر شامل الضريبة" toggle is sticky: it remembers the user's last
  // choice in localStorage so a new invoice opens with the same setting.
  // Loading an existing invoice / quotation prefill / "based on" path will
  // override the value but is NOT persisted as the new default — only the
  // user manually clicking the checkbox updates the persisted preference.
  const stickyPriceIncl = useStickyPriceIncludesVat();
  const [priceIncludesVat, setPriceIncludesVat] = useState(stickyPriceIncl.initial);
  // ── نوع الفاتورة (ZATCA) ─────────────────────────────────────────────────
  // "standard"   = فاتورة ضريبية B2B  → يلزم رقم ضريبي + سجل تجاري + عنوان
  //                                     وطني كامل للعميل (متطلبات زاتكا)
  // "simplified" = فاتورة ضريبية مبسطة B2C → يكفي اسم العميل
  // الاختيار يبدأ افتراضيًا "مبسطة"؛ ويُرفع إلى "ضريبية" تلقائيًا عند اختيار
  // عميل لديه رقم ضريبي مسجَّل (سلوك ودود لا يربك مستخدم التجزئة).
  const [invoiceType, setInvoiceType] = useState<"standard" | "simplified">("simplified");
  const invoiceTypeUserPickedRef = useRef(false);
  const [docDiscount, setDocDiscount]   = useState("0");
  // Document-level promotion that the engine applied (drives docDiscount when
  // non-null). Cleared automatically when the cart no longer qualifies. Saved
  // alongside docDiscount so the back-office can audit which offer triggered
  // the document-wide saving.
  const [documentOfferId,   setDocumentOfferId]   = useState<number | null>(null);
  const [documentOfferName, setDocumentOfferName] = useState<string | null>(null);
  // Latest documentOfferId mirror for the apply-matches effect — lets the
  // effect know whether the previous cycle applied a doc-offer (so we only
  // wipe docDiscount when WE set it, never the user's manual entry).
  const documentOfferIdRef = useRef<number | null>(null);
  useEffect(() => { documentOfferIdRef.current = documentOfferId; }, [documentOfferId]);
  const [lines,     setLines]           = useState<DocLine[]>(() => {
    const l = newLine();
    return [l];
  });
  const [focusLineId, setFocusLineId] = useState<string>(() => lines[0]?._id ?? "");
  const addLine = () => {
    const l = newLine();
    const r = percentRateOf(headerTaxId);
    if (r !== null) l.vatRate = String(r);
    setLines(p => [...p, l]);
    setFocusLineId(l._id);
  };
  useEnterNavContainer({ onAppend: () => addLine() });
  const { containerRef: enterNavRef, onKeyDown: enterNavKey } = useEnterNavigation(() => handleSave());
  const docNumberRef = useRef<HTMLInputElement>(null);

  // Accounts used to build journal entry on posting (invoices only)
  const [cogsAccountId,      setCogsAccountId]      = useState("");
  const [inventoryAccountId, setInventoryAccountId] = useState("");
  const [salesAccountId,     setSalesAccountId]     = useState("");
  const [taxAccountId,       setTaxAccountId]       = useState("");
  const [discountAccountId,  setDiscountAccountId]  = useState("");

  // Persist last-used accounts per company so new invoices auto-fill them
  const acctPrefsKey = `sales-invoice-accts:${cid ?? "all"}`;
  useEffect(() => {
    if (!isNew || !isInvoice) return;
    try {
      const raw = localStorage.getItem(acctPrefsKey);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p.salesAccountId    && !salesAccountId)    setSalesAccountId(String(p.salesAccountId));
      if (p.cogsAccountId     && !cogsAccountId)     setCogsAccountId(String(p.cogsAccountId));
      if (p.inventoryAccountId&& !inventoryAccountId)setInventoryAccountId(String(p.inventoryAccountId));
      if (p.taxAccountId      && !taxAccountId)      setTaxAccountId(String(p.taxAccountId));
      if (p.discountAccountId && !discountAccountId) setDiscountAccountId(String(p.discountAccountId));
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, isInvoice, cid]);

  useEffect(() => {
    if (!isInvoice) return;
    if (!salesAccountId && !cogsAccountId && !inventoryAccountId && !taxAccountId && !discountAccountId) return;
    try {
      localStorage.setItem(acctPrefsKey, JSON.stringify({
        salesAccountId, cogsAccountId, inventoryAccountId, taxAccountId, discountAccountId,
      }));
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salesAccountId, cogsAccountId, inventoryAccountId, taxAccountId, discountAccountId]);

  // Lookups
  const { data: customers = [] } = useQuery<any[]>({
    queryKey: ["customers", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/customers?companyId=${cid}` : `${API}/api/customers`, authH),
    enabled: !!user,
  });

  // ── Auto-detect نوع الفاتورة من العميل ─────────────────────────────────
  // عند اختيار عميل لديه رقم ضريبي → نرفع تلقائيًا إلى "ضريبية" (standard).
  // إذا اختار المستخدم النوع يدويًا (invoiceTypeUserPickedRef = true) لا
  // نتدخّل أبدًا — احترامًا لقصد المستخدم. كذلك لا نطبّق التخفيض (إلى مبسطة)
  // تلقائيًا إذا غاب الرقم الضريبي، لأن المستخدم قد يكون يبحث عن البيانات
  // الناقصة لتعبئتها قبل الحفظ.
  useEffect(() => {
    if (!isInvoice || !customerId || invoiceTypeUserPickedRef.current) return;
    const cust = (customers as any[]).find((c: any) => String(c.id) === String(customerId));
    // ⚠️ يجب أن يستخدم نفس مُتحقّق الحفظ (`isValidSaudiVat`) تمامًا، حتى
    // لا نرفع المستخدم تلقائيًا إلى "ضريبية" برقم 15-خانة لكنه غير مطابق
    // للنمط /^3\d{13}3$/ ثم نمنعه من الحفظ — تجربة محبطة.
    if (cust && isValidSaudiVat(cust.vatNumber)) {
      setInvoiceType("standard");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, customers, isInvoice]);

  // Source-quotation picker: load every quotation for this tenant; we then
  // filter client-side to the only ones that the backend will actually let
  // us use as a source (status === "accepted" AND not already converted).
  // Fetched only on the new-invoice form to avoid wasted bandwidth on
  // edit/quotation/order screens where the picker is hidden.
  const { data: allQuotationsForLink = [] } = useQuery<any[]>({
    queryKey: ["sales-quotations-source-link", cid],
    queryFn: () => fetchJsonArray(`${API}/api/sales/sales-quotations`, authH),
    enabled: !!user && isInvoice && isNew,
    staleTime: 0,
    refetchOnMount: "always",
  });
  // Mirrors the backend gate inside POST /sales-invoices (rules pinned in
  // routes/sales.ts): we surface ONLY accepted, not-yet-converted quotations
  // so the user never picks a row the server will reject.
  const eligibleQuotationsForLink = useMemo(
    () => (allQuotationsForLink as any[]).filter(
      (q: any) => q.status === "accepted" && !q.convertedInvoiceId,
    ),
    [allQuotationsForLink],
  );

  // Pre-fill the new-invoice form from a chosen source quotation. We hit
  // the per-quotation endpoint (which returns header + lines) so we use
  // exactly the same shape the auto-load effect uses for editing — keeping
  // the line shape conversion in one mental model. We deliberately set
  // sourceQuotationId LAST so the combobox stays in sync if any of the
  // earlier setters bail (e.g. a stale render).
  async function loadFromQuotation(qid: string) {
    if (!qid) { setSourceQuotationId(""); return; }
    try {
      const r = await fetch(`${API}/api/sales/sales-quotations/${qid}`, { headers: authH });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        toast({ title: j.error || t("salesDocForm.basedOnQuotationLoadError"), variant: "destructive" });
        return;
      }
      const src = await r.json();
      setCustomerId(src.customerId ? String(src.customerId) : "");
      if (usesBranch) setBranchId(src.branchId ? String(src.branchId) : "");
      setCurrencyCode(src.currencyCode ?? "SAR");
      setExchangeRate(String(src.exchangeRate ?? "1"));
      setPriceIncludesVat(!!src.priceIncludesVat);
      setDocDiscount(String(src.discountAmount ?? "0"));
      setNotes(src.notes ?? "");
      setLines(src.lines?.length ? src.lines.map((l: any) => ({
        _id: crypto.randomUUID(),
        itemId:      l.itemId      ? String(l.itemId)      : "",
        itemName:    l.itemName    ?? "",
        itemCode:    l.itemCode    ?? "",
        unitId:      l.unitId      ? String(l.unitId)      : "",
        unit:        l.unit        ?? "",
        conversionFactor: "1",
        warehouseId: "",
        qty:         String(l.qty),
        freeQty:     String(l.freeQty ?? "0"),
        unitPrice:   String(l.unitPrice),
        discount:    String(l.discount ?? "0"),
        discountAmount: String(l.discountAmount ?? "0"),
        vatRate:     (l.vatRate != null && l.vatRate !== "" ? String(l.vatRate) : "15"),
        lineTotal:   String(l.lineTotal),
        notes:       l.notes ?? "",
        // Quotations don't carry offer-engine state — start with a clean
        // slate and let the invoice's own match cycle re-evaluate.
        appliedOfferId:   null,
        appliedOfferName: null,
        engineUnitPrice:  null,
        engineDiscount:   null,
        baseUnitPrice:    String(l.unitPrice ?? "0"),
      })) : [newLine()]);
      setSourceQuotationId(qid);
      toast({ title: t("salesDocForm.basedOnQuotationLoaded", { num: src.docNumber ?? `SQ-${qid}` }) });
    } catch (e: any) {
      toast({ title: e?.message || t("salesDocForm.basedOnQuotationLoadError"), variant: "destructive" });
    }
  }

  // Smart document navigator (works for invoice / order / quotation modes).
  // Loads a lightweight summary of every doc-of-this-mode for the current
  // company so the user can:
  //   1. Search/load any doc from a single combobox by number, customer
  //      name, or even fragments of date/total (fuzzy match across the
  //      rich label text).
  //   2. Step backward/forward through docs with prev/next arrows using
  //      the canonical ordering (newest id first).
  // Cache key matches the list page (`apiPath`), so opening the navigator
  // is instant once the user has visited the list.
  const { data: allDocs = [] } = useQuery<any[]>({
    queryKey: [apiPath, cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/sales/${apiPath}?companyId=${cid}` : `${API}/api/sales/${apiPath}`, authH),
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
  const { data: inventoryItems = [] } = useQuery<any[]>({
    queryKey: ["inventory-items", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/inventory/items?companyId=${cid}` : `${API}/api/inventory/items`, authH),
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
  const { data: cashBoxes = [] } = useQuery<any[]>({
    queryKey: ["cash-boxes", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/cash-boxes?companyId=${cid}` : `${API}/api/cash-boxes`, authH),
    enabled: !!cid,
  });
  const { data: bankAccounts = [] } = useQuery<any[]>({
    queryKey: ["bank-accounts", cid],
    queryFn: () => fetchJsonArray(`${API}/api/bank-accounts?companyId=${cid}`, authH),
    enabled: !!user,
  });
  const { data: costCentersList = [] } = useQuery<any[]>({
    queryKey: ["cost-centers", cid],
    queryFn: async () => {
      return fetchJsonArray(`${API}/api/cost-centers?companyId=${cid}`, headers);
    },
    enabled: !!cid,
    staleTime: 60_000,
  });
  const { data: salesReps = [] } = useQuery<any[]>({
    queryKey: ["sales-reps", cid],
    queryFn: () => fetchJsonArray(cid ? `${API}/api/sales-reps?companyId=${cid}` : `${API}/api/sales-reps`, authH),
    enabled: !!user && usesOps,
  });
  // ─── My-rep auto-attribution ─────────────────────────────────────────
  // If the logged-in user is linked to a sales rep (sales_reps.user_id), the
  // backend already auto-attributes the invoice to that rep on save. The UI
  // mirrors this by (a) pre-selecting the rep on a new doc and (b) locking
  // the combobox so the user can't reassign their own commissions to a
  // colleague. Admin / superadmin keep full freedom (myRep stays null).
  const { data: myRep } = useQuery<any>({
    queryKey: ["sales-reps-me-current", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/sales-reps/me/current?companyId=${cid ?? ""}`, { headers: authH });
      if (r.status === 404) return null;
      if (!r.ok) return null;
      return r.json();
    },
    enabled: !!user && !!cid && usesOps && user?.role !== "superadmin" && user?.role !== "admin",
    staleTime: 5 * 60_000,
  });
  const repLocked = !!myRep?.id;
  // ─── Auto-pre-select the linked rep on a NEW doc ───
  // We only touch state when (a) the doc is new (so existing-doc loads aren't
  // overwritten) and (b) the field is still empty (preserves any explicit
  // user choice if they cleared it deliberately). Edit/quotation-source paths
  // already restore salesRepId from the source row.
  useEffect(() => {
    if (repLocked && isNew && !salesRepId) {
      setSalesRepId(String(myRep.id));
    }
  }, [repLocked, isNew, myRep?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // الفرع الافتراضي: المستخدم المقيَّد على فرع (viewAllBranches=false) يُحمَّل له
  // فرعه المخصَّص تلقائياً أولاً، وإلا الفرع الرئيسي ثم أول فرع متاح.
  const isPrivilegedUser = user?.role === "admin" || user?.role === "superadmin";
  const assignedBranchId =
    (!isPrivilegedUser && user?.viewAllBranches === false && ((user?.branchIds?.length ?? 0) > 0))
      ? user!.branchIds![0]
      : null;
  const defaultBranch =
    (assignedBranchId != null
      ? (branches as any[]).find((b: any) => String(b.id) === String(assignedBranchId))
      : undefined)
    ?? (branches as any[]).find((b: any) => b.isMain)
    ?? (branches as any[])[0];
  useEffect(() => {
    if (!isNew || !defaultBranch || branchId) return;
    setBranchId(String(defaultBranch.id));
  }, [isNew, defaultBranch?.id]);

  // المستودع الافتراضي مرتبط بالفرع المختار: نختار المستودع الافتراضي ضمن فرع
  // المستند (أو أول مستودع فيه)، ثم نرجع للمستودع الافتراضي العام كحل أخير.
  const branchWarehouses = (warehouses as any[]).filter(
    (w: any) => branchId && String(w.branchId) === String(branchId),
  );
  const defaultWarehouse =
    (branchId ? (branchWarehouses.find((w: any) => w.isDefault) ?? branchWarehouses[0]) : undefined)
    ?? (warehouses as any[]).find((w: any) => w.isDefault)
    ?? (warehouses as any[])[0];
  // Header-level warehouse picker — when the user selects a warehouse here it
  // is broadcast to every line, and any newly added line inherits it. On new
  // docs it auto-loads the selected branch's warehouse; if the branch changes
  // and the current warehouse no longer belongs to it, it re-applies the
  // branch's default — but a manual in-branch pick is preserved. On edit it
  // reflects the first line's warehouse (handled by the effect below).
  const [headerWarehouseId, setHeaderWarehouseId] = useState<string>("");
  useEffect(() => {
    if (!isNew || !branchId) return;
    const inBranch = branchWarehouses.some((w: any) => String(w.id) === headerWarehouseId);
    if (headerWarehouseId && inBranch) return;
    const wh = branchWarehouses.find((w: any) => w.isDefault) ?? branchWarehouses[0] ?? defaultWarehouse;
    if (wh) applyHeaderWarehouse(String(wh.id));
  }, [isNew, branchId, warehouses, headerWarehouseId]); // eslint-disable-line react-hooks/exhaustive-deps
  // SERVICE items never touch stock, so they must NOT carry a warehouse. This
  // helper lets the warehouse auto-fill / broadcast effects skip service lines
  // and lets the line grid hide the warehouse picker for them.
  const isServiceLine = (l: { itemId: string }) =>
    (inventoryItems as any[]).some((i: any) => String(i.id) === l.itemId && i.itemType === "service");
  useEffect(() => {
    if (isNew || headerWarehouseId) return;
    const firstWh = lines.find(l => l.warehouseId)?.warehouseId;
    if (firstWh) setHeaderWarehouseId(String(firstWh));
  }, [isNew, lines, headerWarehouseId]);
  const hasEmptyWarehouse = lines.some(l => !l.warehouseId && !isServiceLine(l));
  useEffect(() => {
    if (!headerWarehouseId || !hasEmptyWarehouse) return;
    setLines(prev => prev.map(l => (l.warehouseId || isServiceLine(l)) ? l : { ...l, warehouseId: headerWarehouseId }));
  }, [headerWarehouseId, hasEmptyWarehouse]);
  function applyHeaderWarehouse(v: string) {
    setHeaderWarehouseId(v);
    if (!v) return;
    setLines(prev => prev.map(l => isServiceLine(l) ? l : { ...l, warehouseId: v }));
  }
  // Header-level tax picker — dynamic tax catalog (الضرائب). Selecting a
  // percent tax broadcasts its rate to every line's editable vatRate (which
  // is what flows into the pre-issue VAT calc). The chosen taxId is persisted
  // on the document header. ZATCA SAFETY: this only pre-fills the editable
  // rate before issue; it never touches the stored vat_rate/vat_amount/
  // tax_category that ZATCA XML/QR read at/after issue.
  const { taxes: taxCatalog, defaultPercentTax: defaultTax, comboItemsPercent: taxComboItems, percentRateOf } = useCompanyTaxes();
  const [headerTaxId, setHeaderTaxId] = useState<string>("");
  useEffect(() => {
    if (!isNew || !defaultTax || headerTaxId) return;
    applyHeaderTax(String(defaultTax.id));
  }, [isNew, defaultTax?.id]);
  function applyHeaderTax(v: string) {
    setHeaderTaxId(v);
    const rate = percentRateOf(v);
    if (rate === null) return; // fixed/none → leave line rates untouched
    setLines(prev => prev.map(l => {
      const updated = { ...l, vatRate: String(rate) };
      const { lineTotal } = calcLine(updated, priceIncludesVat, taxMode);
      return { ...updated, lineTotal: lineTotal.toFixed(2) };
    }));
  }
  // Route-transition safeguard: when the user navigates from one doc to
  // another while this component stays mounted (edit→edit, edit→new, etc.),
  // clear the header value so the init/derive effects re-populate from the
  // freshly loaded doc instead of leaking the previous selection.
  useEffect(() => {
    setHeaderWarehouseId("");
    setHeaderTaxId("");
  }, [editId, isNew]);

  const defaultCurrency = currencies.find((c: any) => c.isDefault) ?? currencies[0];

  function getLatestRate(selectedCode: string): string {
    if (!currencies.length) return "1";
    const selected = currencies.find((c: any) => c.code === selectedCode);
    const base = defaultCurrency;
    if (!selected || !base || selected.id === base.id) return "1";
    const rate = exchangeRates
      .filter((r: any) =>
        (r.fromCurrencyId === selected.id && r.toCurrencyId === base.id) ||
        (r.fromCurrencyId === base.id     && r.toCurrencyId === selected.id))
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
  // Re-price every line whose item has a per-currency price configured. When
  // the new currency IS the company default, snap unitPrice back to the
  // item's catalog (current-unit) salePrice; the user previously saw a
  // foreign-currency price for that line and switching back must restore
  // the SAR figure, otherwise the gross would silently jump.
  // Stale-guard: if the user toggles the currency selector faster than the
  // async fetches resolve, only the most recent invocation may apply its
  // setLines — older runs would otherwise overwrite the latest selection
  // with prices for the wrong currency.
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
          ?? itemUnits.find((u: any) => u.isBase)
          ?? itemUnits[0];
        const item = inventoryItems.find((i: any) => String(i.id) === l.itemId);
        const v = row?.salePrice ?? item?.sellPrice ?? item?.price;
        if (v != null) np = String(v);
      } else {
        const cps = await fetchItemCurrencyPrices(l.itemId);
        const m = pickCurrencyPrice(cps, code);
        if (m != null) np = m;
      }
      if (np != null) updates[l._id] = trimTrailingZeros(np);
    }
    if (myVersion !== repriceVersion.current) return;
    if (!Object.keys(updates).length) return;
    setLines(prev => prev.map(l => {
      const np = updates[l._id];
      if (np == null) return l;
      const updated: DocLine = {
        ...l, unitPrice: np, baseUnitPrice: np,
        engineUnitPrice: null, engineDiscount: null,
        appliedOfferId: null, appliedOfferName: null,
      };
      const { lineTotal } = calcLine(updated, priceIncludesVat);
      return { ...updated, lineTotal: lineTotal.toFixed(2) };
    }));
  }

  useEffect(() => {
    if (!isNew || !defaultCurrency || currencyCode) return;
    setCurrencyCode(defaultCurrency.code);
  }, [isNew, defaultCurrency?.code]);

  // Load existing
  const { data: existing, isLoading: loadingEdit } = useQuery({
    queryKey: [queryKey, editId],
    queryFn: async () => {
      const r = await fetch(`${API}/api/sales/${apiPath}/${editId}?companyId=${cid}`, { headers: authH });
      return r.json();
    },
    enabled: !!editId,
  });

  // Pull the next number from the central sequence engine. Each document
  // type has its own sequence ("sales_invoice" / "sales_order"); quotations
  // don't have one. When no active sequence exists, the field falls back to
  // the legacy free-typed input.
  // For quotations we still pass a tx type the hook understands but disable
  // the fetch — keeps the union type honest without runtime impact.
  const sequenceType: SequenceTxType = isOrder ? "sales_order" : "sales_invoice";
  const sequenceEnabled = (isInvoice || isOrder) && !editId;
  const seqPeek = useNextSequenceNumber(sequenceType, sequenceEnabled, undefined, branchId, isInvoice ? paymentType : undefined);
  useEffect(() => {
    if (!sequenceEnabled) return;
    if (seqPeek.hasSequence && seqPeek.number) setDocNumber(seqPeek.number);
  }, [sequenceEnabled, seqPeek.hasSequence, seqPeek.number]);

  useEffect(() => {
    if (!existing) return;
    setDocNumber(existing.docNumber ?? "");
    // Date column name differs per document type.
    const dateField = isInvoice ? existing.invoiceDate
                    : isOrder   ? existing.orderDate
                                : existing.quotationDate;
    setDocDate(dateField ?? today());
    // Quotation: validUntil. Order: expectedDeliveryDate. Both ride on the
    // same `validUntil` state for UI simplicity (it's a free-form date).
    if (isQuotation) setValidUntil(existing.validUntil ?? "");
    if (isOrder)     setValidUntil(existing.expectedDeliveryDate ?? "");
    setCustomerId(existing.customerId ? String(existing.customerId) : "");
    if (usesBranch) setBranchId(existing.branchId ? String(existing.branchId) : "");
    if (usesOps) setPaymentType(existing.paymentType ?? "credit");
    if (usesOps) setCashBoxId(existing.cashBoxId ? String(existing.cashBoxId) : "");
    if (usesOps) setBankAccountId(existing.bankAccountId ? String(existing.bankAccountId) : "");
    setCurrencyCode(existing.currencyCode ?? "SAR");
    setExchangeRate(String(existing.exchangeRate ?? "1"));
    setNotes(existing.notes ?? "");
    setCostCenter(existing.costCenter ?? "");
    if (usesOps) setSalesRepId(existing.salesRepId ? String(existing.salesRepId) : "");
    setPriceIncludesVat(!!existing.priceIncludesVat);
    // استرجاع نوع الفاتورة المحفوظ — وعلامة المستخدم على «اختاره يدويًا»
    // حتى لا يقوم تأثير الاكتشاف التلقائي بتغييره عند إعادة فتح الفاتورة.
    if (isInvoice && (existing as any).invoiceType) {
      setInvoiceType((existing as any).invoiceType === "standard" ? "standard" : "simplified");
      invoiceTypeUserPickedRef.current = true;
    }
    setDocDiscount(String(existing.discountAmount ?? "0"));
    if ((existing as any).taxId != null) setHeaderTaxId(String((existing as any).taxId));
    if (isInvoice) {
      setCogsAccountId(existing.cogsAccountId ? String(existing.cogsAccountId) : "");
      setInventoryAccountId(existing.inventoryAccountId ? String(existing.inventoryAccountId) : "");
      setSalesAccountId(existing.salesAccountId ? String(existing.salesAccountId) : "");
      setTaxAccountId(existing.taxAccountId ? String(existing.taxAccountId) : "");
      setDiscountAccountId(existing.discountAccountId ? String(existing.discountAccountId) : "");
    }
    setLines(existing.lines?.length ? existing.lines.map((l: any) => ({
      _id: crypto.randomUUID(),
      itemId:      l.itemId      ? String(l.itemId)      : "",
      itemName:    l.itemName    ?? "",
      itemCode:    l.itemCode    ?? "",
      unitId:      l.unitId      ? String(l.unitId)      : "",
      unit:        l.unit        ?? "",
      conversionFactor: String(l.conversionFactor ?? "1"),
      warehouseId: l.warehouseId ? String(l.warehouseId) : "",
      qty:         String(l.qty),
      freeQty:     String(l.freeQty ?? "0"),
      unitPrice:   String(l.unitPrice),
      discount:    String(l.discount ?? "0"),
      discountAmount: String(l.discountAmount ?? "0"),
      vatRate:     (l.vatRate != null && l.vatRate !== "" ? String(l.vatRate) : "15"),
      lineTotal:   String(l.lineTotal),
      notes:       l.notes ?? "",
      // Carry forward the historical offer link so the badge shows on edit.
      // The auto-match effect may overwrite this with a fresh decision when
      // the cart still qualifies, or clear it when conditions changed.
      appliedOfferId:   l.appliedOfferId   ? Number(l.appliedOfferId)        : null,
      appliedOfferName: l.appliedOfferName ? String(l.appliedOfferName)      : null,
      // Treat persisted offer values as engine-owned on load so a re-match
      // on no-qualify can revert them; the matcher will overwrite these
      // refs as soon as it runs against the loaded cart.
      engineUnitPrice:  l.appliedOfferId ? String(l.unitPrice ?? "0")        : null,
      engineDiscount:   l.appliedOfferId ? String(l.discount  ?? "0")        : null,
      // Best-effort: persisted unitPrice IS the base for non-engine-owned
      // lines, and is the post-override price for engine-owned ones (we
      // didn't save the original). Acceptable trade-off — on no-match the
      // line drops out cleanly; on still-qualify the engine writes the same
      // value and idempotency holds.
      baseUnitPrice:    String(l.unitPrice ?? "0"),
    })) : [newLine()]);
    if (isInvoice) {
      setDocumentOfferId(existing.documentOfferId ? Number(existing.documentOfferId) : null);
      setDocumentOfferName(existing.documentOfferName ? String(existing.documentOfferName) : null);
    }
  }, [existing]);

  // ── Duplicate from another document (?from=<id> on /new) ──
  const duplicatedRef = useRef(false);
  useEffect(() => {
    if (!isNew || duplicatedRef.current || !user) return;
    const params = new URLSearchParams(window.location.search);
    const fromId = params.get("from");
    if (!fromId) return;
    duplicatedRef.current = true;

    (async () => {
      try {
        const r = await fetch(`${API}/api/sales/${apiPath}/${fromId}?companyId=${cid}`, { headers: authH });
        if (!r.ok) return;
        const src = await r.json();
        setDocNumber("");
        setDocDate(today());
        if (!isInvoice) setValidUntil("");
        setCustomerId(src.customerId ? String(src.customerId) : "");
        if (usesBranch) setBranchId(src.branchId ? String(src.branchId) : "");
        if (usesOps) setPaymentType(src.paymentType ?? "credit");
        if (usesOps) setCashBoxId(src.cashBoxId ? String(src.cashBoxId) : "");
        if (usesOps) setBankAccountId(src.bankAccountId ? String(src.bankAccountId) : "");
        setCurrencyCode(src.currencyCode ?? "SAR");
        setExchangeRate(String(src.exchangeRate ?? "1"));
        setNotes(src.notes ?? "");
        if (usesOps) setSalesRepId(src.salesRepId ? String(src.salesRepId) : "");
        setPriceIncludesVat(!!src.priceIncludesVat);
        setDocDiscount(String(src.discountAmount ?? "0"));
        if (isInvoice) {
          setCogsAccountId(src.cogsAccountId ? String(src.cogsAccountId) : "");
          setInventoryAccountId(src.inventoryAccountId ? String(src.inventoryAccountId) : "");
          setSalesAccountId(src.salesAccountId ? String(src.salesAccountId) : "");
          setTaxAccountId(src.taxAccountId ? String(src.taxAccountId) : "");
          setDiscountAccountId(src.discountAccountId ? String(src.discountAccountId) : "");
        }
        setLines(src.lines?.length ? src.lines.map((l: any) => ({
          _id: crypto.randomUUID(),
          itemId:      l.itemId      ? String(l.itemId)      : "",
          itemName:    l.itemName    ?? "",
          itemCode:    l.itemCode    ?? "",
          unitId:      l.unitId      ? String(l.unitId)      : "",
          unit:        l.unit        ?? "",
          conversionFactor: String(l.conversionFactor ?? "1"),
          warehouseId: l.warehouseId ? String(l.warehouseId) : "",
          qty:         String(l.qty),
          freeQty:     String(l.freeQty ?? "0"),
          unitPrice:   String(l.unitPrice),
          discount:    String(l.discount ?? "0"),
          discountAmount: String(l.discountAmount ?? "0"),
          vatRate:     (l.vatRate != null && l.vatRate !== "" ? String(l.vatRate) : "15"),
          lineTotal:   String(l.lineTotal),
          notes:       l.notes ?? "",
          // Don't carry the historical offer onto a duplicate — the new
          // invoice will get a fresh match cycle.
          appliedOfferId:   null,
          appliedOfferName: null,
          engineUnitPrice:  null,
          engineDiscount:   null,
          baseUnitPrice:    String(l.unitPrice ?? "0"),
        })) : [newLine()]);
        // Same logic for the document offer — duplicate gets a fresh match.
        setDocumentOfferId(null);
        setDocumentOfferName(null);
        toast({ title: t("salesDocForm.toastDuplicated") });
        const url = new URL(window.location.href);
        url.searchParams.delete("from");
        window.history.replaceState({}, "", url.toString());
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, user, cid]);

  // ── Convert a quotation → invoice (?fromQuotation=<id> on /new) ──
  // The quotation is NOT marked "converted" here; that happens ONLY when the
  // user SAVES the invoice (POST /sales-invoices carries sourceQuotationId and
  // the server flips the quotation atomically). Abandoning this form therefore
  // leaves the quotation untouched ("accepted") — exactly the requested flow.
  const quotationSeedRef = useRef(false);
  useEffect(() => {
    if (!isNew || !isInvoice || quotationSeedRef.current || !user) return;
    const qid = new URLSearchParams(window.location.search).get("fromQuotation");
    if (!qid) return;
    quotationSeedRef.current = true;
    (async () => {
      await loadFromQuotation(qid);
      const url = new URL(window.location.href);
      url.searchParams.delete("fromQuotation");
      window.history.replaceState({}, "", url.toString());
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, isInvoice, user, cid]);

  function updateLine(id: string, field: keyof DocLine, value: string) {
    setLines(prev => prev.map(l => {
      if (l._id !== id) return l;
      const updated: DocLine = { ...l, [field]: value };
      // User typing into unitPrice or discount means they're taking over
      // that field. Drop the engine-owned snapshot for it so the matcher's
      // next "no match" pass won't silently revert their value to 0 / the
      // engine's prior write. Keep the badge if the OTHER field is still
      // engine-owned, otherwise also clear the offer link.
      if (field === "unitPrice" && value !== l.engineUnitPrice) {
        updated.engineUnitPrice = null;
        // User typed a new unit price — that's the new base for matching.
        updated.baseUnitPrice = value || "0";
      }
      if (field === "discount" && value !== l.engineDiscount) {
        updated.engineDiscount = null;
      }
      // Bidirectional sync: editing one of the two discount inputs
      // (% vs SAR amount) auto-fills the other so they mirror each
      // other. See `lib/lineDiscountSync.ts`.
      if (field === "discount" || field === "discountAmount") {
        const synced = syncLineDiscount(l, field, value);
        updated.discount       = synced.discount;
        updated.discountAmount = synced.discountAmount;
      }
      if (l.appliedOfferId && updated.engineUnitPrice === null && updated.engineDiscount === null) {
        updated.appliedOfferId = null;
        updated.appliedOfferName = null;
      }
      const { lineTotal } = calcLine(updated, priceIncludesVat);
      return { ...updated, lineTotal: lineTotal.toFixed(2) };
    }));
  }

  // Recompute every line's lineTotal whenever the inclusive/exclusive flag changes
  useEffect(() => {
    setLines(prev => prev.map(l => {
      const { lineTotal } = calcLine(l, priceIncludesVat);
      return { ...l, lineTotal: lineTotal.toFixed(2) };
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceIncludesVat]);

  // Cache item-specific unit prices: itemId → [{ unitId, unit:{id,nameAr}, conversionFactor, salePrice, costPrice, isBase }]
  const [itemUnitsMap, setItemUnitsMap] = useState<Record<string, any[]>>({});
  async function fetchItemUnits(itemId: string): Promise<any[]> {
    if (itemUnitsMap[itemId]) return itemUnitsMap[itemId];
    const r = await fetch(`${API}/api/inventory/items/${itemId}/units?companyId=${cid}`, { headers: authH });
    const rows = r.ok ? await r.json() : [];
    setItemUnitsMap(prev => ({ ...prev, [itemId]: rows }));
    return rows;
  }

  // Cache item-specific per-currency prices: itemId → [{ currencyCode, salePrice, costPrice, ... }]
  // The header currency drives line pricing — when a non-default currency is
  // selected and the item has a row for it, that price wins over the catalog
  // (SAR) salePrice, otherwise the customer would be quoted in foreign units
  // at a base-currency number.
  const [itemCurrencyPricesMap, setItemCurrencyPricesMap] = useState<Record<string, any[]>>({});
  async function fetchItemCurrencyPrices(itemId: string): Promise<any[]> {
    if (itemCurrencyPricesMap[itemId]) return itemCurrencyPricesMap[itemId];
    const r = await fetch(`${API}/api/inventory/items/${itemId}/currency-prices?companyId=${cid}`, { headers: authH });
    const rows = r.ok ? await r.json() : [];
    setItemCurrencyPricesMap(prev => ({ ...prev, [itemId]: rows }));
    return rows;
  }
  function pickCurrencyPrice(rows: any[], code: string): string | null {
    const match = rows.find((p: any) => p.currencyCode === code);
    if (!match) return null;
    const v = match.salePrice;
    return v != null && v !== "" ? String(v) : null;
  }

  async function selectItem(lineId: string, itemId: string) {
    const item = inventoryItems.find((i: any) => String(i.id) === itemId);
    if (!item) { updateLine(lineId, "itemId", ""); return; }
    const itemUnits = await fetchItemUnits(itemId);
    // Pick base unit (or first configured, or fallback to item's default unit)
    const base = itemUnits.find((u: any) => u.isBase) ?? itemUnits[0];
    const fallbackUnit = units.find((u: any) => u.id === item.unitId);
    const chosenUnitId = base?.unitId ?? item.unitId ?? null;
    const chosenUnitName = base?.unit?.nameAr ?? fallbackUnit?.nameAr ?? "";
    const catalogPrice = base?.salePrice ?? item.sellPrice ?? item.price ?? "0";
    let chosenPrice: string = String(catalogPrice);
    if (currencyCode && defaultCurrency && currencyCode !== defaultCurrency.code) {
      const cps = await fetchItemCurrencyPrices(itemId);
      const match = pickCurrencyPrice(cps, currencyCode);
      if (match != null) chosenPrice = match;
    }
    const chosenFactor = base?.conversionFactor ?? "1";

    setLines(prev => prev.map(l => {
      if (l._id !== lineId) return l;
      const newPrice = trimTrailingZeros(chosenPrice);
      const updated: DocLine = {
        ...l,
        itemId:    String(item.id),
        itemName:  item.nameAr ?? "",
        itemCode:  item.code   ?? "",
        // Service items never hit inventory → never inherit a warehouse.
        warehouseId: item.itemType === "service" ? "" : l.warehouseId,
        unitId:    chosenUnitId ? String(chosenUnitId) : "",
        unit:      chosenUnitName,
        conversionFactor: String(chosenFactor),
        unitPrice: newPrice,
        // Picking a new item resets the engine ownership and the matching
        // base — the catalog price IS the new base.
        baseUnitPrice: newPrice,
        engineUnitPrice: null,
        engineDiscount:  null,
        appliedOfferId:  null,
        appliedOfferName: null,
        discount:  "0",
        vatRate:   (item.vatRate != null && item.vatRate !== "" ? String(item.vatRate) : "15"),
      };
      const { lineTotal } = calcLine(updated, priceIncludesVat);
      return { ...updated, lineTotal: lineTotal.toFixed(2) };
    }));
  }

  function changeLineUnit(lineId: string, newUnitId: string) {
    setLines(prev => prev.map(l => {
      if (l._id !== lineId) return l;
      const itemUnits = itemUnitsMap[l.itemId] ?? [];
      const row = itemUnits.find((u: any) => String(u.unitId) === newUnitId);
      const globalUnit = units.find((u: any) => String(u.id) === newUnitId);
      // If item has this unit configured, snap to its salePrice; either way
      // a unit change resets the matching base (the item now has a new
      // catalog price for this unit) and clears any engine ownership /
      // applied offer — it must be re-evaluated next cycle.
      const newPrice = row?.salePrice != null ? trimTrailingZeros(row.salePrice) : l.unitPrice;
      const updated: DocLine = {
        ...l,
        unitId: newUnitId,
        unit: row?.unit?.nameAr ?? globalUnit?.nameAr ?? "",
        conversionFactor: String(row?.conversionFactor ?? "1"),
        unitPrice: newPrice,
        baseUnitPrice: newPrice,
        engineUnitPrice: null,
        engineDiscount:  null,
        appliedOfferId:  null,
        appliedOfferName: null,
        discount:  "0",
      };
      const { lineTotal } = calcLine(updated, priceIncludesVat);
      return { ...updated, lineTotal: lineTotal.toFixed(2) };
    }));
  }

  // ── Promotion engine ─────────────────────────────────────────────────
  // The server is authoritative for promo math (it already filters by
  // tenant + active window + scopes). The form sends the cart whenever it
  // changes; the apply-effect below maps the response back onto the lines
  // and the document discount field. Only invoice mode runs offers — the
  // quotation form ships pricing manually.
  // Sig is keyed off baseUnitPrice (NOT unitPrice) so the engine's own
  // writes don't trigger a re-fetch — that's what closes the cross-cycle
  // double-discount loop the architect flagged.
  const cartSig = lines
    .filter(l => l.itemId && Number(l.qty) > 0 && Number(l.baseUnitPrice) > 0)
    .map(l => `${l._id}:${l.itemId}:${l.qty}:${l.baseUnitPrice}`)
    .join("|");
  // When loading an existing invoice for edit, snapshot the cart signature
  // so we can suppress the engine's first re-evaluation. Otherwise an offer
  // that no longer matches (or whose price-list changed) would silently
  // strip the historical discount off persisted lines and leave the form
  // showing a fresh subtotal that disagrees with what the customer was
  // actually billed. The engine resumes the moment the user touches the
  // cart (signature changes), so adding/removing/editing a line still
  // applies live promos as before.
  const loadedCartSigRef = useRef<string | null>(null);
  useEffect(() => {
    if (!editId || !existing) return;
    if (loadedCartSigRef.current !== null) return;
    // Wait for the hydration setLines to land — until then cartSig is the
    // pre-hydration empty signature and locking it would either no-op (if
    // empty stays empty) or worse, capture a stale baseline that lets the
    // engine re-evaluate the moment lines hydrate. Empty cartSig is the
    // sentinel for "not yet hydrated" because the filter requires itemId
    // and a positive baseUnitPrice — both only present after hydration.
    if (!cartSig) return;
    loadedCartSigRef.current = cartSig;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId, existing, cartSig]);
  const cartUntouched = !!editId && loadedCartSigRef.current !== null && loadedCartSigRef.current === cartSig;
  const matchEnabled = isInvoice && !!user && !!customerId && cartSig.length > 0 && !cartUntouched;
  const matchCartQuery = useQuery({
    queryKey: ["offers-match-cart", cid, customerId, salesRepId, cartSig],
    queryFn: async () => {
      const cartLines = lines
        .filter(l => l.itemId && Number(l.qty) > 0 && Number(l.baseUnitPrice) > 0)
        .map(l => ({
          lineKey:   l._id,
          itemId:    Number(l.itemId),
          qty:       Number(l.qty),
          // ALWAYS send the base (pre-engine) unit price — never the current
          // displayed unitPrice, which may have been overwritten by a
          // previous price-mode match. Sending the post-mutation price would
          // let the engine re-evaluate against its own output and stack a
          // percent discount on top of an already-reduced price.
          unitPrice: Number(l.baseUnitPrice),
        }));
      return offersApi.matchCart({
        companyId:  cid,
        customerId: Number(customerId),
        salesRepId: salesRepId ? Number(salesRepId) : null,
        applyTo:    "invoice",
        lines:      cartLines,
      });
    },
    enabled: matchEnabled,
    // Small stale window so rapid edits batch into one network round-trip
    // instead of firing on every keystroke.
    staleTime: 800,
  });

  // Apply matches whenever the engine returns fresh data. The setLines
  // callback compares each line against the proposed update and skips the
  // setState when nothing changed — that's what keeps us out of an infinite
  // re-fire loop (the cache key includes unitPrice, which line_pricing may
  // overwrite, so without the no-op guard we'd loop forever).
  useEffect(() => {
    const data = matchCartQuery.data;
    if (!data) return;

    setLines(prev => {
      let changed = false;
      const next = prev.map(l => {
        const m = data.lineMatches[l._id];
        if (m) {
          // Trust the engine's `appliedMode` to decide which field this
          // offer owns — never write both unitPrice AND discount, that's
          // the double-discount oscillation bug. "price" mode means the
          // line_pricing offer beat the % lever and the unit price drop
          // already encodes the saving, so discount must be zeroed.
          // In price mode we replace unitPrice with the offer's price; in
          // every other mode (percent / bxgy / no-price-on-offer) the
          // unitPrice should snap back to the base so a previous price-mode
          // overwrite is undone before the percent discount is applied.
          const targetPrice =
            m.appliedMode === "price" && m.suggestedPrice
              ? trimTrailingZeros(m.suggestedPrice)
              : l.baseUnitPrice;
          const targetDiscount =
            m.appliedMode === "price" ? "0" : String(m.effectiveDiscountPct);
          if (l.appliedOfferId === m.offerId
              && l.discount === targetDiscount
              && l.unitPrice === targetPrice) return l;
          changed = true;
          const updated: DocLine = {
            ...l,
            appliedOfferId:   m.offerId,
            appliedOfferName: m.nameAr ?? m.offerNumber,
            discount:         targetDiscount,
            unitPrice:        targetPrice,
            // Snapshot the values we just wrote — used by updateLine to
            // detect manual overrides and by the no-match branch below to
            // know what's safe to revert.
            engineUnitPrice:  m.appliedMode === "price" ? targetPrice : null,
            engineDiscount:   m.appliedMode === "price" ? null : targetDiscount,
          };
          const { lineTotal } = calcLine(updated, priceIncludesVat);
          return { ...updated, lineTotal: lineTotal.toFixed(2) };
        }
        // No match this cycle — only revert fields the engine actually
        // owned, leaving any manual overrides intact. If the user already
        // edited away from the engine value, those engine-owned snapshots
        // are already null (cleared in updateLine), so we'd skip the field.
        if (l.appliedOfferId) {
          changed = true;
          const updated: DocLine = {
            ...l,
            appliedOfferId: null,
            appliedOfferName: null,
            // Only zero the discount if the engine owned it AND user didn't
            // touch it (engineDiscount === current discount).
            discount: l.engineDiscount !== null && l.engineDiscount === l.discount
              ? "0"
              : l.discount,
            // If the engine owned unitPrice (price-mode line_pricing) and
            // the user didn't override it since, snap back to baseUnitPrice
            // — restores the original catalog price when the offer expires.
            unitPrice: l.engineUnitPrice !== null && l.engineUnitPrice === l.unitPrice
              ? l.baseUnitPrice
              : l.unitPrice,
            engineUnitPrice: null,
            engineDiscount: null,
          };
          const { lineTotal } = calcLine(updated, priceIncludesVat);
          return { ...updated, lineTotal: lineTotal.toFixed(2) };
        }
        return l;
      });
      return changed ? next : prev;
    });

    // Document-level discount: same "only touch what we own" guard.
    if (data.documentMatch) {
      setDocumentOfferId(data.documentMatch.offerId);
      setDocumentOfferName(data.documentMatch.nameAr ?? data.documentMatch.offerNumber);
      setDocDiscount(String(data.documentMatch.documentDiscountAmount));
    } else if (documentOfferIdRef.current !== null) {
      setDocumentOfferId(null);
      setDocumentOfferName(null);
      setDocDiscount("0");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchCartQuery.data, priceIncludesVat]);

  // Company-wide tax-calc preference. Falls back to "after_discount" so
  // legacy rows without the column behave exactly as before.
  const taxMode: TaxMode = (user?.company?.taxCalculationMode === "before_discount")
    ? "before_discount" : "after_discount";
  const subtotal    = lines.reduce((s, l) => s + calcLine(l, priceIncludesVat, taxMode).subtotal, 0);
  const vatAmount   = lines.reduce((s, l) => s + calcLine(l, priceIncludesVat, taxMode).vat,      0);
  const lineDiscountTotal = lines.reduce((s, l) => {
    const noDisc = calcLine({ ...l, discount: "0", discountAmount: "0" }, priceIncludesVat, taxMode).lineTotal;
    const withDisc = calcLine(l, priceIncludesVat, taxMode).lineTotal;
    return s + Math.max(0, noDisc - withDisc);
  }, 0);
  const grossTotal  = subtotal + vatAmount;
  const discountAmt = Math.max(0, Math.min(grossTotal, Number(docDiscount) || 0));
  const totalAmount = grossTotal - discountAmt;

  // Per-doc-type auto-posting flag with global fallback. The new
  // `autoPostSales` column was added later, so older companies (or new
  // ones that haven't touched the per-type toggles) fall back to the
  // legacy `autoPostingEnabled` master switch. Only an explicit `false`
  // disables auto-posting for sales invoices.
  const _co = (user as any)?.company;
  const _gl = _co?.autoPostingEnabled !== false;
  const autoPostingEnabled = _co?.autoPostSales === undefined || _co?.autoPostSales === null
    ? _gl
    : _co.autoPostSales !== false;

  // Per-doc-type print preferences for sales invoices. We don't open
  // the popup directly here — the list page (SalesInvoices) owns the
  // SalesPrintModal, so we redirect there with a hint in window.history
  // state and let it pick up `defaultTemplate` + `autoPrintOnOpen`.
  // This only applies to invoices (not quotations / orders).
  const autoPrintSalesInvoice = isInvoice && !!(user as any)?.company?.printAutoAfterSaveSales;
  const salesTemplate: "a4" | "thermal" =
    ((user as any)?.company?.printTemplateSales === "thermal") ? "thermal" : "a4";

  const saveMut = useMutation({
    mutationFn: async (data: any) => {
      const url = editId ? `${API}/api/sales/${apiPath}/${editId}` : `${API}/api/sales/${apiPath}`;
      const res = await fetch(url, { method: editId ? "PUT" : "POST", headers, body: JSON.stringify(data) });
      const j = await res.json(); if (!res.ok) throw new Error(j.error);

      // Auto-post immediately after save for invoices only (not quotations) — only when enabled system-wide
      if (autoPostingEnabled && isInvoice && j?.id && (j.status ?? "draft") === "draft") {
        const postRes = await fetch(`${API}/api/sales/${apiPath}/${j.id}/post`, {
          method: "PATCH", headers,
        });
        const postJson = await postRes.json().catch(() => ({}));
        if (!postRes.ok) {
          throw new Error(postJson.error || postRes.statusText);
        }
        return postJson;
      }
      return j;
    },
    onSuccess: (saved: any) => {
      qc.invalidateQueries({ queryKey: [isInvoice ? "sales-invoices" : isOrder ? "sales-orders" : "sales-quotations"] });
      // Reflect what actually happened: invoices auto-post when the
      // company has auto-posting enabled, and they auto-print when the
      // per-doc-type print preference is on. Quotations and orders
      // never auto-post (no journal entry), so for them `posted` stays
      // false. The toast wording falls back to the defaults baked into
      // the helper if the i18n keys are missing.
      const didPost   = isInvoice && autoPostingEnabled;
      const didPrint  = autoPrintSalesInvoice && !!saved?.id;
      toast({ title: getSaveToastTitle(t, { posted: didPost, printed: didPrint }) });
      // If auto-print is on for sales invoices, hand the just-saved id
      // and chosen template to the list page via history.state. The
      // list page reads it once on mount and triggers the print modal.
      if (autoPrintSalesInvoice && saved?.id) {
        // Use sessionStorage instead of window.history.state because
        // `wouter`'s navigate() pushes a fresh history entry whose state
        // would otherwise overwrite ours, causing the auto-print hint
        // to be lost before the list page can read it.
        try {
          sessionStorage.setItem(
            "autoPrintSalesInvoice",
            JSON.stringify({ id: saved.id, template: salesTemplate, ts: Date.now() }),
          );
        } catch { /* ignore storage failures */ }
      }
      navigate(basePath);
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // ── ZATCA validators (B2B / فاتورة ضريبية) ────────────────────────────
  // الرقم الضريبي السعودي: 15 رقم، يبدأ وينتهي بـ "3"، الرقمان قبل الأخير
  // يمثلان رمز نوع المنشأة. هذه القاعدة من زاتكا (TIN format).
  function isValidSaudiVat(v: string | null | undefined): boolean {
    const s = String(v ?? "").trim();
    return /^3\d{13}3$/.test(s);
  }
  // العنوان الوطني (Saudi Post / National Address Standard) — لزاتكا في
  // الفواتير الضريبية B2B تتطلب الحقول التالية بصيغ صارمة:
  //   • رقم المبنى: 4 أرقام بالضبط          (^\d{4}$)
  //   • اسم الشارع: نص غير فارغ              (مطلوب من زاتكا — ليس مجرّد مستحب)
  //   • الحي:        نص غير فارغ
  //   • المدينة:     نص غير فارغ
  //   • الرمز البريدي: 5 أرقام بالضبط         (^\d{5}$)
  // الحقول الناقصة *أو غير المطابقة للصيغة* تُعاد كلها بنفس القائمة حتى
  // يرى المستخدم بالضبط ما يحتاج إلى تصحيحه قبل الحفظ.
  function missingNationalAddress(c: any): string[] {
    const out: string[] = [];
    const bn = String(c?.buildingNumber ?? "").trim();
    if (!bn) out.push("رقم المبنى");
    else if (!/^\d{4}$/.test(bn)) out.push("رقم المبنى (4 أرقام بالضبط)");
    if (!String(c?.street   ?? "").trim()) out.push("اسم الشارع");
    if (!String(c?.district ?? "").trim()) out.push("الحي");
    if (!String(c?.city     ?? "").trim()) out.push("المدينة");
    const pc = String(c?.postalCode ?? "").trim();
    if (!pc) out.push("الرمز البريدي");
    else if (!/^\d{5}$/.test(pc)) out.push("الرمز البريدي (5 أرقام بالضبط)");
    return out;
  }

  function handleSave() {
    // Required-fields gate (mirrors the server's 400 in /sales-invoices):
    // every sales invoice must carry an explicit customer + branch. We
    // surface this as an attractive destructive toast BEFORE the network
    // round-trip so the user sees the failure instantly. Quotations don't
    // use a branch field, so the branch check is gated on isInvoice/isOrder
    // (i.e. the `usesOps` modes that actually render the picker).
    if (isInvoice || isOrder) {
      const missing: string[] = [];
      if (!customerId) missing.push(t("salesDocForm.customer", { defaultValue: "العميل" }));
      if (!branchId)   missing.push(t("salesDocForm.branch",   { defaultValue: "الفرع" }));
      if (missing.length) {
        toast({
          title: "⚠️ بيانات ناقصة — لا يمكن حفظ الفاتورة",
          description: `الحقول التالية مطلوبة: ${missing.join("، ")}`,
          variant: "destructive",
        });
        return;
      }
      // ── متطلبات زاتكا للفاتورة الضريبية (Standard / B2B) ────────────────
      // المبسطة (Simplified / B2C) لا تحتاج إلى أي بيانات إضافية للعميل.
      if (isInvoice && invoiceType === "standard") {
        const cust = (customers as any[]).find((c: any) => String(c.id) === String(customerId));
        const reasons: string[] = [];
        if (!cust) {
          reasons.push("بيانات العميل غير محمَّلة");
        } else {
          if (!isValidSaudiVat(cust.vatNumber)) {
            reasons.push("رقم ضريبي سعودي صحيح (15 رقم يبدأ وينتهي بـ 3)");
          }
          // ملاحظة: رقم السجل التجاري لم يعد إجبارياً لحفظ الفاتورة الضريبية —
          // الرقم الضريبي للعميل يكفي لتعريف المشتري في زاتكا (B2B). يُطبع
          // السجل التجاري إن وُجد فقط.
          const addrMissing = missingNationalAddress(cust);
          if (addrMissing.length) {
            reasons.push(`العنوان الوطني (${addrMissing.join("، ")})`);
          }
        }
        if (reasons.length) {
          toast({
            title: "⛔ الفاتورة الضريبية تتطلّب بيانات زاتكا الكاملة",
            description: `بيانات العميل الناقصة: ${reasons.join(" — ")}. يمكنك تعديل بيانات العميل من شاشة العملاء، أو تحويل الفاتورة إلى «فاتورة ضريبية مبسّطة» إذا كان البيع للأفراد.`,
            variant: "destructive",
          });
          return;
        }
      }
    } else {
      // Quotation mode: require a customer (a quotation without an addressed
      // party isn't meaningful) AND a branch (so it can be branch-scoped like
      // invoices/orders).
      const missing: string[] = [];
      if (!customerId) missing.push(t("salesDocForm.customer", { defaultValue: "العميل" }));
      if (!branchId)   missing.push(t("salesDocForm.branch",   { defaultValue: "الفرع" }));
      if (missing.length) {
        toast({
          title: "⚠️ بيانات ناقصة — لا يمكن حفظ المستند",
          description: `الحقول التالية مطلوبة: ${missing.join("، ")}`,
          variant: "destructive",
        });
        return;
      }
    }
    // Per-line gate: item name + unit + qty + sale price must be filled
    // on every populated row. Skips completely empty rows. Mirrors the
    // server-side gate so the user sees the failure instantly.
    const lineCheck = validateInvoiceLines(lines);
    if (!lineCheck.ok) {
      toast({ title: lineCheck.title, description: lineCheck.description, variant: "destructive" });
      return;
    }
    const base: any = {
      companyId: cid, docNumber: docNumber || null,
      taxId: headerTaxId ? Number(headerTaxId) : null,
      customerId: customerId || null, currencyCode, exchangeRate,
      subtotal: subtotal.toFixed(2), vatAmount: vatAmount.toFixed(2),
      discountAmount: discountAmt.toFixed(2), totalAmount: totalAmount.toFixed(2),
      priceIncludesVat,
      // نوع الفاتورة (ZATCA): "standard" أو "simplified" — يُرسل فقط
      // لفواتير المبيعات حتى يظهر في الطباعة والتقارير ويتحكم في مسار
      // التقديم لزاتكا (Clearance vs Reporting).
      ...(isInvoice ? { invoiceType } : {}),
      notes: notes || null,
      // Header-level cost center — when set, the /post handler tags every
      // generated JE line with this code so cost-center reports pick it up.
      costCenter: isInvoice ? (costCenter || null) : undefined,
      // Strip the local-only `_id` and `appliedOfferName` (display-only) but
      // keep `appliedOfferId` so the server persists the audit-trail FK.
      lines: lines.filter(l => l.itemName).map(l => ({
        ...l,
        _id: undefined,
        appliedOfferName: undefined,
      })),
    };
    if (isInvoice) {
      base.invoiceDate = docDate;
      // Header-level offer FK — sent on every save (including null) so the
      // engine can clear a previously-applied doc offer when conditions
      // change. Quotations + orders don't run offers.
      base.documentOfferId = documentOfferId || null;
      // Source-quotation back-link — only carried on the new-invoice POST;
      // the PUT path doesn't accept it (you can't retroactively re-source
      // an existing invoice from a different quotation). Backend revalidates
      // tenancy/status/converted gates before mutating the quotation.
      if (isNew && sourceQuotationId) base.sourceQuotationId = Number(sourceQuotationId);
      base.paymentType = paymentType;
      base.cashBoxId = paymentType === "cash" ? (cashBoxId || null) : null;
      base.bankAccountId = paymentType === "bank" ? (bankAccountId || null) : null;
      base.branchId = branchId || null;
      base.salesRepId         = salesRepId         ? Number(salesRepId)         : null;
      base.cogsAccountId      = cogsAccountId      ? Number(cogsAccountId)      : null;
      base.inventoryAccountId = inventoryAccountId ? Number(inventoryAccountId) : null;
      base.salesAccountId     = salesAccountId     ? Number(salesAccountId)     : null;
      base.taxAccountId       = taxAccountId       ? Number(taxAccountId)       : null;
      base.discountAccountId  = discountAccountId  ? Number(discountAccountId)  : null;
    } else if (isOrder) {
      // Sales order payload — operational fields ride along but the server
      // route stores them informationally and never posts a journal entry,
      // moves stock, creates a voucher, or submits to ZATCA.
      base.orderDate            = docDate;
      base.expectedDeliveryDate = validUntil || null;
      base.paymentType          = paymentType;
      base.cashBoxId            = paymentType === "cash" ? (cashBoxId || null) : null;
      base.bankAccountId        = paymentType === "bank" ? (bankAccountId || null) : null;
      base.branchId             = branchId || null;
      base.salesRepId           = salesRepId ? Number(salesRepId) : null;
    } else {
      base.quotationDate = docDate;
      base.validUntil = validUntil || null;
      base.branchId = branchId || null;
    }
    saveMut.mutate(base);
  }

  // NOTE: We deliberately do NOT early-return for `loadingEdit` here, even
  // though it would be the natural place. A bunch of hooks (useRef/useMemo/
  // useRegisterScreenActions for the voice-AI assistant) live further down
  // in this component — bailing out before them would render a different
  // hook count on the first vs. subsequent render and trip the "Rendered
  // more hooks than during the previous render" invariant. Instead, we
  // capture the loading flag and gate the JSX return at the very bottom
  // so every hook always runs in the same order.
  const showLoadingPlaceholder = !isNew && loadingEdit;

  const customerComboItems = [
    { value: "", label: t("salesDocForm.noCustomer") },
    ...customers.map((c: any) => ({ value: String(c.id), label: c.nameAr ?? c.nameEn ?? `#${c.id}` })),
  ];
  const salesRepComboItems = repLocked
    // When the user is locked to their own rep, hide every other entry so the
    // combobox visually communicates "this is you, can't change it".
    ? [{
        value: String(myRep.id),
        label: myRep.code ? `${myRep.code} — ${myRep.nameAr ?? myRep.nameEn ?? `#${myRep.id}`}` : (myRep.nameAr ?? myRep.nameEn ?? `#${myRep.id}`),
      }]
    : [
        { value: "", label: t("salesDocForm.noSalesRep") },
        ...(salesReps as any[])
          .filter((r: any) => r.isActive !== false)
          .map((r: any) => ({
            value: String(r.id),
            label: r.code ? `${r.code} — ${r.nameAr ?? r.nameEn ?? `#${r.id}`}` : (r.nameAr ?? r.nameEn ?? `#${r.id}`),
          })),
      ];
  const itemComboItems = [
    { value: "", label: t("salesDocForm.selectItem") },
    ...inventoryItems.map((i: any) => ({ value: String(i.id), code: i.code ?? undefined, label: i.nameAr ?? i.nameEn ?? `#${i.id}` })),
  ];
  const unitItems = units.map((u: any) => ({ value: String(u.id), label: u.nameAr }));

  const Icon  = isInvoice ? ShoppingBag : isOrder ? ClipboardList : FileSignature;
  const title = isNew
    ? (isInvoice
        ? t("salesDocForm.newInvoice")
        : isOrder
          ? t("salesDocForm.newOrder")
          : t("salesDocForm.newQuotation"))
    : (isInvoice
        ? t("salesDocForm.editInvoice", { id: editId })
        : isOrder
          ? t("salesDocForm.editOrder", { id: editId })
          : t("salesDocForm.editQuotation", { id: editId }));
  const subtitle = isInvoice
    ? t("salesDocForm.subtitleInvoice")
    : isOrder
      ? t("salesDocForm.subtitleOrder")
      : t("salesDocForm.subtitleQuotation");

  const linesSection = (
    <div className="pt-2 space-y-3">
              {(() => {
                // Warehouse column is now rendered for all 3 doc modes
                // (invoice, order, quotation) — the order matches the sales
                // invoice layout per the user's request: code · name ·
                // warehouse · unit · qty · … The header-level warehouse
                // picker + auto-fill effects (defined earlier) already work
                // identically across modes, so a newly added line inherits
                // the default warehouse without any extra wiring here.
                const gridCols = "110px minmax(260px,1.4fr) 160px 120px 90px 80px 110px 80px 100px 80px 130px 180px 40px";
                const totalLabel = t("salesDocForm.colTotal");
                const headers = [
                  t("salesDocForm.colItemCode"),
                  t("salesDocForm.colItem"),
                  t("salesDocForm.colWarehouse"),
                  t("salesDocForm.colUnit"),
                  t("salesDocForm.colQty"),
                  t("salesDocForm.colFreeQty"),
                  t("salesDocForm.colPrice"),
                  t("salesDocForm.colDiscPct"),
                  t("salesDocForm.colDiscAmount"),
                  t("salesDocForm.colVatPct"),
                  totalLabel,
                  t("salesDocForm.colNotes"),
                  "",
                ];
                return (
              <div data-enter-nav-container="lines" className="rounded-xl border bg-card overflow-x-auto">
                <div className="min-w-max">
                <div className="grid gap-2 px-3 py-2 border-b bg-muted/40 sticky top-0" style={{ gridTemplateColumns: gridCols }}>
                  {headers.map((h, i) => (
                    <p key={i} className={cn("text-[11px] font-medium truncate", h === totalLabel ? "font-semibold text-primary" : "text-muted-foreground")} title={h}>{h}</p>
                  ))}
                </div>
                <div className="divide-y">
                {lines.map(l => (
                  <div key={l._id} className="px-3 py-2 hover:bg-muted/30 transition-colors">
                    <div
                      className="grid gap-2 items-center"
                      style={{ gridTemplateColumns: gridCols }}
                    >
                      <Input className="h-8 text-xs bg-muted/40 font-mono" readOnly={!!l.itemId} placeholder={t("common.auto")} value={l.itemCode}
                        onChange={e => updateLine(l._id, "itemCode", e.target.value)} />
                      {inventoryItems.length > 0 ? (
                        <SearchCombobox items={itemComboItems} value={l.itemId} onValueChange={v => selectItem(l._id, v)} placeholder={t("salesDocForm.itemPlaceholder")} searchPlaceholder="ابحث بالكود أو الاسم..." />
                      ) : (
                        <Input className="h-8 text-xs" placeholder={t("salesDocForm.itemNamePlaceholder")} value={l.itemName}
                          onChange={e => updateLine(l._id, "itemName", e.target.value)} />
                      )}
                      {isServiceLine(l) ? (
                        <div className="h-8 flex items-center justify-center rounded-md bg-muted/40 text-[11px] text-muted-foreground" title={t("inventoryMaster.items.serviceNoStockHint") as string}>
                          {t("salesDocForm.serviceNoWarehouse")}
                        </div>
                      ) : warehouses.length > 0 ? (
                        <div className={cn("rounded-md", l.itemId && !l.warehouseId && "ring-1 ring-amber-400")}>
                          <SearchCombobox
                            items={(warehouses as any[]).map((w: any) => ({ value: String(w.id), code: w.code, label: w.nameAr, labelEn: w.nameEn }))}
                            value={l.warehouseId}
                            onValueChange={v => updateLine(l._id, "warehouseId", v)}
                            placeholder={t("salesDocForm.warehousePlaceholder")}
                            searchPlaceholder="ابحث بالكود أو الاسم..."
                            disabled={fp.isReadOnly("warehouse")}
                            className="h-8 text-xs"
                          />
                        </div>
                      ) : (
                        <Input className="h-8 text-xs" placeholder="—" readOnly />
                      )}
                      {(() => {
                        const itemUnits = (l.itemId && itemUnitsMap[l.itemId]) ? itemUnitsMap[l.itemId] : [];
                        const opts = itemUnits.length > 0
                          ? itemUnits.map((iu: any) => ({
                              value: String(iu.unitId),
                              label: `${iu.unit?.nameAr ?? ""}${Number(iu.conversionFactor) !== 1 ? ` (×${trimTrailingZeros(iu.conversionFactor)})` : ""}`,
                            }))
                          : unitItems;
                        return units.length > 0 ? (
                          <Select value={l.unitId || undefined} onValueChange={v => changeLineUnit(l._id, v)}>
                            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder={t("salesDocForm.colUnit")} /></SelectTrigger>
                            <SelectContent>
                              {opts.map((u: any) => <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input className="h-8 text-xs" placeholder={t("salesDocForm.colUnit")} value={l.unit}
                            onChange={e => updateLine(l._id, "unit", e.target.value)} />
                        );
                      })()}
                      <Input className="h-8 text-xs" type="text" inputMode="numeric" dir="ltr" value={l.qty}
                        onChange={e => updateLine(l._id, "qty", e.target.value.replace(/[^0-9]/g, ""))} />
                      <Input className={cn(
                          "h-8 text-xs bg-amber-50 border-amber-200 text-amber-900 font-mono",
                          fp.isReadOnly("freeQty") && "bg-muted/40 cursor-not-allowed"
                        )}
                        type="text" inputMode="numeric" dir="ltr" value={l.freeQty}
                        readOnly={fp.isReadOnly("freeQty")}
                        title={fp.isReadOnly("freeQty") ? "للقراءة فقط حسب السياسة" : (t("salesDocForm.colFreeQtyHint") as string)}
                        onChange={e => updateLine(l._id, "freeQty", e.target.value.replace(/[^0-9]/g, ""))} />
                      <Input
                        className={cn(
                          "h-8 text-xs",
                          l.appliedOfferId && l.appliedOfferName && "bg-emerald-50 border-emerald-300 text-emerald-800",
                          fp.isReadOnly("unitPrice") && "bg-muted/40 cursor-not-allowed"
                        )}
                        type="text" inputMode="decimal" dir="ltr" value={l.unitPrice}
                        readOnly={fp.isReadOnly("unitPrice")}
                        title={fp.isReadOnly("unitPrice") ? "للقراءة فقط حسب السياسة" : undefined}
                        onChange={e => updateLine(l._id, "unitPrice", e.target.value.replace(/[^0-9.]/g, ""))} />
                      {/* خصم% — نسبة مئوية تُطبَّق على (الكمية × سعر البيع). */}
                      <Input
                        className={cn(
                          "h-8 text-xs",
                          l.appliedOfferId && "bg-emerald-50 border-emerald-300 text-emerald-800 font-semibold",
                          fp.isReadOnly("discount") && "bg-muted/40 cursor-not-allowed"
                        )}
                        type="text" inputMode="decimal" dir="ltr" value={l.discount}
                        readOnly={fp.isReadOnly("discount")}
                        title={fp.isReadOnly("discount") ? "للقراءة فقط حسب السياسة" : "النسبة المئوية للخصم على هذا السطر"}
                        onChange={e => updateLine(l._id, "discount", e.target.value.replace(/[^0-9.]/g, ""))} />
                      {/* قيمة الخصم — مبلغ ثابت بالعملة يُطرح بعد الخصم بالنسبة.
                          الصيغة: الإجمالي = الكمية × سعر البيع × (1 − خصم%/100) − قيمة الخصم
                          يُرحَّل على نفس حساب "الخصم المسموح به" في شجرة الحسابات
                          تمامًا كما يُرحَّل الخصم بالنسبة. */}
                      <Input
                        className={cn(
                          "h-8 text-xs font-mono tabular-nums",
                          fp.isReadOnly("discount") && "bg-muted/40 cursor-not-allowed"
                        )}
                        type="text" inputMode="decimal" dir="ltr" value={l.discountAmount}
                        readOnly={fp.isReadOnly("discount")}
                        title={fp.isReadOnly("discount") ? "للقراءة فقط حسب السياسة" : `قيمة الخصم بالعملة — تُطرح بعد الخصم بالنسبة وتُرحَّل على حساب الخصم المسموح به`}
                        data-testid={`line-discount-amount-${l._id}`}
                        onChange={e => updateLine(l._id, "discountAmount", e.target.value.replace(/[^0-9.]/g, ""))} />
                      <Input
                        className={cn("h-8 text-xs", fp.isReadOnly("taxRate") && "bg-muted/40 cursor-not-allowed")}
                        type="text" inputMode="decimal" dir="ltr" value={l.vatRate}
                        readOnly={fp.isReadOnly("taxRate")}
                        title={fp.isReadOnly("taxRate") ? "للقراءة فقط حسب السياسة" : undefined}
                        onChange={e => updateLine(l._id, "vatRate", e.target.value.replace(/[^0-9.]/g, ""))} />
                      <Input className="h-8 text-xs bg-primary/5 font-semibold text-primary font-mono" dir="ltr" readOnly value={fmt(l.lineTotal)} />
                      <Input className="h-8 text-xs" value={l.notes}
                        onChange={e => updateLine(l._id, "notes", e.target.value)} />
                      <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-destructive"
                        onClick={() => setLines(p => p.filter(x => x._id !== l._id))} disabled={lines.length <= 1}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    {l.appliedOfferId && l.appliedOfferName && (
                      <div className="mt-1 ms-1 flex items-center gap-1.5 text-[10px] text-emerald-700" data-testid={`applied-offer-${l._id}`}>
                        <Tag className="h-3 w-3" />
                        <span>
                          {t("salesDocForm.appliedOfferLine", { name: l.appliedOfferName, discount: l.discount })}
                        </span>
                      </div>
                    )}
                  </div>
                ))}
                </div>
                </div>
              </div>
                );
              })()}

              <Button type="button" variant="outline" size="sm" className="gap-2" onClick={addLine}>
                <Plus className="h-4 w-4" />{t("salesDocForm.addLine")}
              </Button>

              <div className="mt-5 flex flex-wrap justify-between gap-4">
                {/* Toggle ‹السعر شامل الضريبة› — يخضع الآن لسياسة الحقول
                    (Field Policy / الحوكمة): إذا أخفاه المسؤول للمستخدم
                    تختفي البطاقة وتسقط من الصفّ بالكامل، وإذا جعله للقراءة
                    فقط لا يستطيع المستخدم تبديله. مفتاح القاموس: priceIncludesVat */}
                {fp.isVisible("priceIncludesVat") ? (
                <label
                  data-testid="price-includes-vat-toggle"
                  className={cn(
                    "flex items-start gap-2.5 rounded-xl border-2 p-3 select-none transition-colors max-w-sm",
                    fp.isReadOnly("priceIncludesVat") ? "cursor-not-allowed opacity-70" : "cursor-pointer",
                    priceIncludesVat ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"
                  )}
                  title={fp.isReadOnly("priceIncludesVat") ? "للقراءة فقط حسب سياسة الحقول" : undefined}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-primary cursor-pointer disabled:cursor-not-allowed"
                    checked={priceIncludesVat}
                    disabled={fp.isReadOnly("priceIncludesVat")}
                    onChange={e => {
                      if (fp.isReadOnly("priceIncludesVat")) return;
                      setPriceIncludesVat(e.target.checked);
                      stickyPriceIncl.persist(e.target.checked);
                    }}
                  />
                  <div className="space-y-0.5">
                    <p className="text-xs font-semibold">{t("salesDocForm.priceInclusiveTitle")}</p>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      {priceIncludesVat
                        ? t("salesDocForm.priceInclusiveYes")
                        : t("salesDocForm.priceInclusiveNo")}
                    </p>
                  </div>
                </label>
                ) : <span /> /* keeps justify-between layout when hidden */}

                <div className="w-72 space-y-2 text-sm border rounded-xl p-4 bg-muted/30">
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground -mt-1">
                    <span>{t("salesDocForm.calcMethod")}</span>
                    <span className={cn("font-semibold px-2 py-0.5 rounded", priceIncludesVat ? "bg-primary/10 text-primary" : "bg-muted text-foreground/70")}>
                      {priceIncludesVat ? t("salesDocForm.calcInclusive") : t("salesDocForm.calcExclusive")}
                    </span>
                  </div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t("salesDocForm.subtotalLabel")}</span><span className="font-mono">{fmt(subtotal)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t("salesDocForm.vatLabel")}</span><span className="font-mono text-amber-700">{fmt(vatAmount)}</span></div>
                  {lineDiscountTotal > 0 && (
                    <div className="flex justify-between text-rose-700" data-testid="line-discount-total">
                      <span className="text-muted-foreground">{t("salesDocForm.lineDiscountTotal")}</span>
                      <span className="font-mono">−{fmt(lineDiscountTotal)}</span>
                    </div>
                  )}
                  <DiscountRow gross={grossTotal} value={docDiscount} onChange={setDocDiscount} currencySymbol={currencySymbol(currencyCode || defaultCurrency?.code, currencies)} />
                  {documentOfferId && documentOfferName && (
                    <div
                      className="flex items-start gap-1.5 -mt-1 px-2 py-1.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-800"
                      data-testid="applied-document-offer"
                    >
                      <Tag className="h-3 w-3 mt-0.5 shrink-0" />
                      <div className="flex-1 text-[10px] leading-relaxed">
                        <p className="font-semibold">{t("salesDocForm.appliedOffer")}: {documentOfferName}</p>
                        <p>{t("salesDocForm.appliedOfferDocumentHint", { name: documentOfferName })}</p>
                      </div>
                    </div>
                  )}
                  <div className="flex justify-between font-bold border-t pt-2 text-base">
                    <span>{priceIncludesVat ? t("salesDocForm.totalLabelInclusive") : t("salesDocForm.totalLabel")}</span>
                    <span className="font-mono text-primary">{fmt(totalAmount)}</span>
                  </div>
                  {currencyCode && currencyCode !== (defaultCurrency?.code ?? "SAR") && Number(exchangeRate) > 0 && (
                    <p className="text-[10px] text-muted-foreground border-t pt-1">
                      {t("salesDocForm.equivalentIn", { currency: defaultCurrency?.code ?? "SAR", value: fmt(totalAmount * Number(exchangeRate)) })}
                    </p>
                  )}
                </div>
              </div>
    </div>
  );

  // ── Smart document navigator data ──────────────────────────────────
  // Build the rich combobox/prev-next items for the current mode. Customer
  // + date + total in the searchable label lets the user find a doc by
  // typing any recognizable fragment (e.g. "أحمد", "04-26", "1500").
  // The date column differs per mode (invoiceDate / orderDate / quotationDate).
  const customerNameById = (id: any) => {
    const c = (customers as any[]).find((c: any) => Number(c.id) === Number(id));
    return c ? (c.nameAr ?? c.nameEn ?? `#${c.id}`) : "—";
  };
  const navDateField = isInvoice ? "invoiceDate" : isOrder ? "orderDate" : "quotationDate";
  const navFallbackPrefix = isInvoice ? "INV-" : isOrder ? "SO-" : "SQ-";
  const docNavItems = (allDocs as any[]).map((d: any) => ({
    id: d.id,
    docNumber: d.docNumber,
    partyName: customerNameById(d.customerId),
    date: d[navDateField] ?? "",
    total: d.totalAmount ?? 0,
    currencyCode: d.currencyCode ?? "",
  }));

  // ── Voice / AI screen-action registration ───────────────────────────
  // Lets the global ScreenAssistant drive this form via spoken or typed
  // commands. The AI plans a sequence of {set_field|call_action} commands
  // and we apply them through the callbacks below.
  //
  // We rebuild the registration object every render — the context stores
  // it in a REF (not React state) so this is cheap and the AI always sees
  // the freshest customer/item/state values when it plans.
  // ────────────────────────────────────────────────────────────────────
  // Capture handleSave + the lookup arrays in refs so the registration's
  // callbacks always see the latest closures even when the registration
  // object is reused across renders (saves us from re-publishing the entire
  // ref on every keystroke while still avoiding stale state).
  const handleSaveRef = useRef<() => void>(() => {});
  // handleSave is hoisted via function-declaration semantics so it's safe
  // to reference here even though it's declared further down in the file.
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  handleSaveRef.current = handleSave;

  const screenActionsCtx = useMemo(() => {
    const screenContext = isInvoice
      ? "sales.invoices.new"
      : isOrder
        ? "sales.orders.new"
        : "sales.quotations.new";

    const findItem = (idOrName: string | number | undefined | null) => {
      if (idOrName === null || idOrName === undefined || idOrName === "") return null;
      const s = String(idOrName).trim().toLowerCase();
      const list = inventoryItems as any[];
      // Try id match first (most reliable when AI sent a lookup id).
      const byId = list.find((it: any) => String(it.id) === String(idOrName));
      if (byId) return byId;
      // Then code match.
      const byCode = list.find((it: any) => String(it.code ?? "").trim().toLowerCase() === s);
      if (byCode) return byCode;
      // Then exact name match (Arabic or English).
      const byName = list.find(
        (it: any) =>
          String(it.nameAr ?? "").trim().toLowerCase() === s ||
          String(it.nameEn ?? "").trim().toLowerCase() === s,
      );
      if (byName) return byName;
      // Last resort: partial name match.
      const byPartial = list.find(
        (it: any) =>
          String(it.nameAr ?? "").toLowerCase().includes(s) ||
          String(it.nameEn ?? "").toLowerCase().includes(s),
      );
      return byPartial ?? null;
    };

    const buildLineFromItem = (
      item: any,
      qty: number | string,
      unitPrice?: number | string | null,
      discount?: number | string | null,
    ): DocLine => {
      const finalPrice = unitPrice !== undefined && unitPrice !== null && unitPrice !== ""
        ? String(unitPrice)
        : String(item.salePrice ?? "0");
      // PRO Extension #3 — auto-apply the item's per-item default discount when
      // the caller didn't pass one. "percent" is converted to an absolute
      // currency amount so it lands cleanly in the line's `discount` column
      // (which is stored as currency, not a percentage).
      //
      // Hardened against bad numeric inputs: qty/unitPrice can arrive as empty
      // strings or NaN from the form, so we coerce + isFinite-guard each value
      // before multiplying. Without this, `Number("")` (→0) silently zeros the
      // discount and `Number("foo")` (→NaN) would persist `discount:"NaN"`.
      let resolvedDiscount = discount;
      if (resolvedDiscount === undefined || resolvedDiscount === null || resolvedDiscount === "") {
        const dt = String(item.discountType ?? "none");
        const dvRaw = Number(item.discountValue ?? 0);
        const dv = isFinite(dvRaw) && dvRaw > 0 ? dvRaw : 0;
        const qtyN  = (() => { const n = Number(qty); return isFinite(n) && n > 0 ? n : 1; })();
        const priceN = (() => { const n = Number(finalPrice); return isFinite(n) && n >= 0 ? n : 0; })();
        if (dt === "amount" && dv > 0) {
          resolvedDiscount = String(dv * qtyN);
        } else if (dt === "percent" && dv > 0) {
          resolvedDiscount = String(priceN * qtyN * dv / 100);
        }
      }
      return {
        _id: crypto.randomUUID(),
        itemId: String(item.id),
        itemName: item.nameAr ?? item.nameEn ?? "",
        itemCode: String(item.code ?? ""),
        unitId: item.unitId ? String(item.unitId) : "",
        unit: item.unit?.nameAr ?? item.unit?.code ?? "",
        conversionFactor: "1",
        warehouseId: "",
        qty: String(qty ?? 1),
        freeQty: "0",
        unitPrice: finalPrice,
        discount: String(resolvedDiscount ?? "0"),
        discountAmount: "0",
        vatRate: String(item.vatRate ?? "15"),
        lineTotal: "0",
        notes: "",
        appliedOfferId: null,
        appliedOfferName: null,
        engineUnitPrice: null,
        engineDiscount: null,
        baseUnitPrice: finalPrice,
      };
    };

    const reg: ScreenActionsRegistration = {
      screenContext,
      description: isInvoice
        ? "نموذج إنشاء فاتورة مبيعات: العميل، نوع الدفع، الأصناف، ثم الحفظ والترحيل."
        : isOrder
          ? "نموذج أمر بيع: العميل، الأصناف، نوع الدفع، ثم الحفظ."
          : "نموذج عرض سعر مبيعات: العميل، الأصناف، الصلاحية، ثم الحفظ.",
      fields: [
        {
          name: "customerId",
          label: t("salesDocForm.customer"),
          type: "lookup",
          lookup: "customers",
          description: "معرّف العميل (يجب اختياره من قائمة customers).",
        },
        ...(usesOps
          ? ([
              {
                name: "paymentType",
                label: t("salesDocForm.paymentType"),
                type: "select",
                options: [
                  { value: "credit", label: "آجل / Credit" },
                  { value: "cash", label: "نقدي / Cash" },
                  { value: "bank", label: "بنكي / Bank" },
                ],
                description:
                  "credit = آجل (اعتماد على الذمة)، cash = نقدي (يحتاج cashBoxId)، bank = بنكي (يحتاج bankAccountId).",
              },
              {
                name: "cashBoxId",
                label: t("salesDocForm.cashBox") ?? "صندوق النقدية",
                type: "lookup",
                lookup: "cashBoxes",
                description: "اختياري — استخدمه فقط عندما paymentType=cash.",
              },
              {
                name: "bankAccountId",
                label: t("salesDocForm.bankAccount") ?? "حساب البنك",
                type: "lookup",
                lookup: "bankAccounts",
                description: "اختياري — استخدمه فقط عندما paymentType=bank.",
              },
              {
                name: "salesRepId",
                label: t("salesDocForm.salesRep") ?? "المندوب",
                type: "lookup",
                lookup: "salesReps",
              },
            ] as ScreenFieldDef[])
          : []),
        {
          name: "docDate",
          label: t("salesDocForm.docDate") ?? "تاريخ المستند",
          type: "date",
          description: "بصيغة YYYY-MM-DD.",
        },
        {
          name: "notes",
          label: t("salesDocForm.notes") ?? "ملاحظات",
          type: "text",
        },
        {
          name: "priceIncludesVat",
          label: t("salesDocForm.priceIncludesVat") ?? "السعر شامل الضريبة",
          type: "boolean",
        },
      ],
      actions: [
        {
          name: "addLine",
          label: t("salesDocForm.addLine") ?? "إضافة بند",
          description:
            "يضيف بند فاتورة. يجب تمرير item (id من lookup items أو الاسم) و qty (كمية رقمية). unitPrice و discount اختياريان.",
          params: [
            { name: "item", type: "string", required: true, lookup: "items" },
            { name: "qty", type: "number", required: true },
            { name: "unitPrice", type: "number", required: false },
            { name: "discount", type: "number", required: false },
          ],
        },
        {
          name: "clearLines",
          label: "مسح كل البنود",
          description: "يحذف كل البنود ويترك سطراً فارغاً.",
        },
        {
          name: "removeLine",
          label: "حذف بند",
          description: "يحذف بنداً واحداً عبر لـ index صفري (lineIndex) أو item (id/اسم).",
          params: [
            { name: "lineIndex", type: "number", required: false },
            { name: "item", type: "string", required: false, lookup: "items" },
          ],
        },
        {
          name: "save",
          label: isInvoice
            ? t("salesDocForm.saveInvoice") ?? "حفظ الفاتورة"
            : isOrder
              ? t("salesDocForm.saveOrder") ?? "حفظ الأمر"
              : t("salesDocForm.saveQuotation") ?? "حفظ العرض",
          description: isInvoice
            ? "يحفظ الفاتورة ويرحلها تلقائياً (إذا كان الترحيل التلقائي مفعلاً على مستوى الشركة)."
            : "يحفظ المستند.",
          destructive: true,
        },
      ],
      lookups: {
        customers: (customers as any[]).map((c: any) => ({
          id: String(c.id),
          name: c.nameAr ?? c.nameEn ?? `#${c.id}`,
          meta: { code: c.code, vatNumber: c.vatNumber },
        })),
        items: (inventoryItems as any[]).map((it: any) => ({
          id: String(it.id),
          name: it.nameAr ?? it.nameEn ?? `#${it.id}`,
          meta: {
            code: it.code,
            salePrice: it.salePrice,
            vatRate: it.vatRate,
            unit: it.unit?.nameAr ?? it.unit?.code ?? null,
          },
        })),
        ...(usesOps
          ? {
              salesReps: (salesReps as any[]).map((r: any) => ({
                id: String(r.id),
                name: r.nameAr ?? r.nameEn ?? `#${r.id}`,
              })),
              cashBoxes: (cashBoxes as any[]).map((b: any) => ({
                id: String(b.id),
                name: b.nameAr ?? b.nameEn ?? `#${b.id}`,
              })),
              bankAccounts: (bankAccounts as any[]).map((b: any) => ({
                id: String(b.id),
                name: b.nameAr ?? b.nameEn ?? b.accountNumber ?? `#${b.id}`,
              })),
            }
          : {}),
      },
      getState: () => ({
        customerId,
        paymentType: usesOps ? paymentType : undefined,
        cashBoxId: usesOps ? cashBoxId : undefined,
        bankAccountId: usesOps ? bankAccountId : undefined,
        salesRepId: usesOps ? salesRepId : undefined,
        docDate,
        notes,
        priceIncludesVat,
        lineCount: lines.length,
        // Trim to first 20 lines so even large carts don't bloat the prompt.
        lines: lines.slice(0, 20).map((l) => ({
          itemId: l.itemId,
          itemName: l.itemName,
          qty: l.qty,
          unitPrice: l.unitPrice,
          discount: l.discount,
          lineTotal: l.lineTotal,
        })),
      }),
      setField: (name: string, value: any) => {
        switch (name) {
          case "customerId":
            setCustomerId(value === null || value === undefined ? "" : String(value));
            break;
          case "paymentType": {
            if (!usesOps) break;
            const v = String(value ?? "credit");
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
            break;
          }
          case "cashBoxId":
            if (usesOps) setCashBoxId(value === null || value === undefined ? "" : String(value));
            break;
          case "bankAccountId":
            if (usesOps)
              setBankAccountId(value === null || value === undefined ? "" : String(value));
            break;
          case "salesRepId":
            if (usesOps)
              setSalesRepId(value === null || value === undefined ? "" : String(value));
            break;
          case "docDate":
            if (value) setDocDate(String(value));
            break;
          case "notes":
            setNotes(String(value ?? ""));
            break;
          case "priceIncludesVat":
            setPriceIncludesVat(Boolean(value));
            break;
          default:
            throw new Error(`Unknown field: ${name}`);
        }
      },
      callAction: async (name: string, params: Record<string, any>) => {
        switch (name) {
          case "addLine": {
            const itemKey = params.item ?? params.itemId ?? params.itemName;
            const item = findItem(itemKey);
            if (!item) {
              throw new Error(`الصنف غير موجود: ${itemKey}`);
            }
            const qty = Number(params.qty ?? 1) || 1;
            const newL = buildLineFromItem(
              item,
              qty,
              params.unitPrice ?? params.price,
              params.discount,
            );
            setLines((prev) => {
              // If only an empty placeholder line exists, replace it.
              if (prev.length === 1 && !prev[0].itemId) return [newL];
              return [...prev, newL];
            });
            setFocusLineId(newL._id);
            break;
          }
          case "clearLines": {
            const fresh = newLine();
            setLines([fresh]);
            setFocusLineId(fresh._id);
            break;
          }
          case "removeLine": {
            if (params.lineIndex !== undefined && params.lineIndex !== null) {
              const idx = Number(params.lineIndex);
              setLines((prev) => {
                if (prev.length <= 1) return prev;
                return prev.filter((_, i) => i !== idx);
              });
            } else if (params.item !== undefined) {
              const item = findItem(params.item);
              if (!item) throw new Error(`الصنف غير موجود: ${params.item}`);
              setLines((prev) => {
                if (prev.length <= 1) return prev;
                const filtered = prev.filter((l) => String(l.itemId) !== String(item.id));
                return filtered.length > 0 ? filtered : prev;
              });
            }
            break;
          }
          case "save": {
            handleSaveRef.current();
            break;
          }
          default:
            throw new Error(`Unknown action: ${name}`);
        }
      },
    };
    return reg;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isInvoice,
    isOrder,
    usesOps,
    t,
    customers,
    inventoryItems,
    salesReps,
    cashBoxes,
    bankAccounts,
    customerId,
    paymentType,
    cashBoxId,
    bankAccountId,
    salesRepId,
    docDate,
    notes,
    priceIncludesVat,
    lines,
  ]);
  // While the existing-doc fetch is in flight we register `null` instead
  // of the live context. This keeps the hook order stable (always called)
  // but prevents the global voice/AI assistant from acting on a half-
  // hydrated form — e.g. firing `save` against an editId whose state has
  // not been populated yet would PUT default/empty values.
  useRegisterScreenActions(showLoadingPlaceholder ? null : screenActionsCtx);

  // Defer the loading placeholder until AFTER all hooks above have run, so
  // the hook count is identical between the loading and loaded renders
  // (see the note next to `showLoadingPlaceholder` for full context).
  if (showLoadingPlaceholder) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        {t("common.loadingShort")}
      </div>
    );
  }

  return (
    <div ref={enterNavRef} onKeyDown={enterNavKey} className="space-y-5 max-w-6xl mx-auto">
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate(basePath)}>
          <BackIcon className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
            <Icon className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold">{title}</h1>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        {isInvoice && (
          <JournalScanArchive
            jeKey={(existing as any)?.code ?? (editId ? `SI-${editId}` : "SI-new-draft")}
            companyName={user?.company?.nameAr ?? null}
          />
        )}
        {/* Status pill — visible whenever editing an existing doc (any mode).
            Status enum varies per mode; <DocStatusBadge> handles them all. */}
        {editId && (existing as any) && (
          <DocStatusBadge status={(existing as any).status} />
        )}
        {/* Smart prev/next + search navigator — shown for every mode.
            Visible on /new as well so the user can jump to any existing
            doc; prev/next arrows just disable when there's no current
            anchor. */}
        <DocNavigator
          items={docNavItems}
          currentId={editId}
          basePath={basePath}
          fallbackPrefix={navFallbackPrefix}
          className="ms-auto"
        />
      </div>

      {isInvoice && !isNew && (existing as any)?.status === "posted" && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 text-sm flex items-center gap-2">
          <Lock className="h-4 w-4" />
          <span>{t("salesDocForm.postedReadOnly", "هذه الفاتورة مُرحَّلة — للعرض فقط. لتعديلها قم بفك الترحيل أولاً من شاشة قائمة الفواتير.")}</span>
        </div>
      )}

      {/* ── نوع الفاتورة (ZATCA) ──────────────────────────────────────────
          مفتاح اختيار جذاب بين «فاتورة ضريبية» (B2B / Standard) و«فاتورة
          ضريبية مبسطة» (B2C / Simplified). يظهر فقط في وضع الفاتورة
          (لا للعروض/الطلبات). يحدِّد قواعد التحقق قبل الحفظ:
          - الضريبية: يلزم رقم ضريبي صحيح + سجل تجاري + عنوان وطني كامل
          - المبسطة: يكفي اختيار اسم العميل
          القاعدة الذهبية من زاتكا: تستخدم الفاتورة الضريبية عند البيع
          لشركات (B2B) ⩾ 1000 ريال، والمبسّطة لمبيعات التجزئة (B2C). */}
      {isInvoice && (() => {
        const cust = (customers as any[]).find((c: any) => String(c.id) === String(customerId)) ?? null;
        const vatOk = cust ? isValidSaudiVat(cust.vatNumber) : false;
        const crOk = cust ? !!String(cust.crNumber ?? "").trim() : false;
        const addrMissing = cust ? missingNationalAddress(cust) : ["العميل غير مختار"];
        // رقم السجل التجاري اختياري — لا يدخل في جاهزية الإرسال إلى زاتكا.
        const standardReady = vatOk && addrMissing.length === 0;
        const isStd = invoiceType === "standard";
        const isSimp = invoiceType === "simplified";
        return (
          <div className="rounded-2xl border-2 border-primary/20 bg-gradient-to-br from-primary/5 via-background to-background p-3 shadow-sm">
            <div className="flex items-center gap-2 mb-2.5 px-1">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10">
                <Receipt className="h-4 w-4 text-primary" />
              </div>
              <div className="flex-1">
                <p className="text-xs font-bold text-foreground">نوع الفاتورة</p>
                <p className="text-[10px] text-muted-foreground">اختر نوع الفاتورة وفق متطلّبات هيئة الزكاة والضريبة (ZATCA)</p>
              </div>
              {standardReady && isStd && (
                <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 text-[10px] gap-1">
                  <ShieldCheck className="h-3 w-3" />جاهز للإرسال إلى زاتكا
                </Badge>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {/* ── فاتورة ضريبية (Standard / B2B) ── */}
              <button
                type="button"
                data-testid="invoice-type-standard"
                onClick={() => { setInvoiceType("standard"); invoiceTypeUserPickedRef.current = true; }}
                className={cn(
                  "group relative text-right rounded-xl border-2 p-3 transition-all duration-150",
                  isStd
                    ? "border-primary bg-primary/10 shadow-md ring-1 ring-primary/20"
                    : "border-border bg-background hover:border-primary/40 hover:bg-primary/5"
                )}
              >
                <div className="flex items-start gap-2">
                  <div className={cn(
                    "mt-0.5 h-4 w-4 rounded-full border-2 shrink-0 transition-colors",
                    isStd ? "border-primary bg-primary" : "border-muted-foreground/30"
                  )}>
                    {isStd && <div className="h-full w-full rounded-full bg-background scale-[0.4]" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-bold text-foreground">فاتورة ضريبية</span>
                      <Badge variant="outline" className="text-[9px] py-0 px-1.5 h-4 border-primary/30 text-primary">B2B · Standard</Badge>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">
                      للبيع لشركات/منشآت مسجَّلة بضريبة القيمة المضافة. تتطلّب اعتماد زاتكا (Clearance).
                    </p>
                    {isStd && cust && (
                      <div className="mt-2 space-y-0.5 text-[10px]">
                        <div className={cn("flex items-center gap-1", vatOk ? "text-emerald-700" : "text-rose-700")}>
                          <span>{vatOk ? "✓" : "✗"}</span><span>رقم ضريبي سعودي صحيح (15 رقم)</span>
                        </div>
                        <div className={cn("flex items-center gap-1", crOk ? "text-emerald-700" : "text-muted-foreground")}>
                          <span>{crOk ? "✓" : "•"}</span><span>رقم السجل التجاري (اختياري)</span>
                        </div>
                        <div className={cn("flex items-center gap-1", addrMissing.length === 0 ? "text-emerald-700" : "text-rose-700")}>
                          <span>{addrMissing.length === 0 ? "✓" : "✗"}</span>
                          <span>العنوان الوطني{addrMissing.length > 0 ? ` (ينقص: ${addrMissing.join("، ")})` : ""}</span>
                        </div>
                      </div>
                    )}
                    {isStd && !cust && (
                      <p className="mt-2 text-[10px] text-amber-700 flex items-center gap-1">
                        <span>⚠</span><span>اختر العميل أولاً للتحقق من اكتمال البيانات</span>
                      </p>
                    )}
                  </div>
                </div>
              </button>

              {/* ── فاتورة ضريبية مبسّطة (Simplified / B2C) ── */}
              <button
                type="button"
                data-testid="invoice-type-simplified"
                onClick={() => { setInvoiceType("simplified"); invoiceTypeUserPickedRef.current = true; }}
                className={cn(
                  "group relative text-right rounded-xl border-2 p-3 transition-all duration-150",
                  isSimp
                    ? "border-primary bg-primary/10 shadow-md ring-1 ring-primary/20"
                    : "border-border bg-background hover:border-primary/40 hover:bg-primary/5"
                )}
              >
                <div className="flex items-start gap-2">
                  <div className={cn(
                    "mt-0.5 h-4 w-4 rounded-full border-2 shrink-0 transition-colors",
                    isSimp ? "border-primary bg-primary" : "border-muted-foreground/30"
                  )}>
                    {isSimp && <div className="h-full w-full rounded-full bg-background scale-[0.4]" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-bold text-foreground">فاتورة ضريبية مبسّطة</span>
                      <Badge variant="outline" className="text-[9px] py-0 px-1.5 h-4 border-sky-300 text-sky-700">B2C · Simplified</Badge>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">
                      لمبيعات التجزئة والأفراد. يكفي اسم العميل فقط، ويتم الإبلاغ عنها لزاتكا (Reporting).
                    </p>
                    {isSimp && (
                      <p className="mt-2 text-[10px] text-emerald-700 flex items-center gap-1">
                        <span>✓</span><span>{customerId ? "تم اختيار العميل — جاهزة للحفظ" : "اختر اسم العميل لإكمال الحفظ"}</span>
                      </p>
                    )}
                  </div>
                </div>
              </button>
            </div>
          </div>
        );
      })()}

      <fieldset disabled={isInvoice && !isNew && (existing as any)?.status === "posted"} className="contents">
      <Tabs value={activeTab} onValueChange={setActiveTab} dir={isRtl ? "rtl" : "ltr"}>
        <Card className="border-2">
          <CardHeader className="p-0">
            <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/20">
              <p className="text-[11px] text-muted-foreground">
                {activeTab === "header"
                  ? t("salesDocForm.headerHint")
                  : t("salesDocForm.summaryHint", { count: lines.filter(l => l.itemName).length, total: fmt(totalAmount) })}
              </p>
              <TabsList className="h-8 bg-background border gap-1">
                <TabsTrigger value="header" className="h-7 px-3 text-xs gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                  <FileText className="h-3.5 w-3.5" />{t("salesDocForm.tabHeader")}
                </TabsTrigger>
              </TabsList>
            </div>
          </CardHeader>

          <TabsContent value="header" className="mt-0">
            <CardContent className="pt-5 pb-5 space-y-4">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {fp.isVisible("docNumber") && (
                <div className="space-y-1.5">
                  <Label className="text-xs">{isInvoice ? t("salesDocForm.invoiceNumber") : isOrder ? t("salesDocForm.orderNumber") : t("salesDocForm.quotationNumber")}{fp.isRequired("docNumber") && <span className="text-destructive"> *</span>}</Label>
                  {(() => {
                    const lockOnEdit = !!editId;
                    // Lock the number field whenever the central sequence
                    // engine is authoritative for this document type.
                    const lockOnSeq  = !!sequenceType && seqPeek.hasSequence;
                    const lockOnPol  = fp.isReadOnly("docNumber");
                    const locked     = lockOnEdit || lockOnSeq || lockOnPol;
                    return (
                      <Input
                        ref={docNumberRef}
                        className={cn("h-9 text-sm", locked && "bg-muted/40 cursor-not-allowed")}
                        placeholder={!!sequenceType && seqPeek.loading ? "…" : t("common.auto")}
                        dir="ltr"
                        value={docNumber}
                        onChange={e => { if (!locked) setDocNumber(e.target.value); }}
                        readOnly={locked}
                        title={lockOnEdit ? "الرقم محفوظ — لا يمكن تعديله" : (lockOnSeq ? `مسلسل: ${seqPeek.sequenceCode ?? ""}` : (lockOnPol ? "للقراءة فقط حسب السياسة" : undefined))}
                      />
                    );
                  })()}
                </div>
                )}
                {fp.isVisible("date") && (
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("salesDocForm.date")}{fp.isRequired("date") && <span className="text-destructive"> *</span>}</Label>
                  <DateField className="h-9 text-sm" value={docDate}
                    onChange={e => setDocDate(e.target.value)}
                    required
                    readOnly={fp.isReadOnly("date") || !!dateBounds.min}
                    min={dateBounds.min}
                    max={dateBounds.max}
                    title={dateBounds.min ? "مقيّد بتاريخ اليوم حسب السياسة" : (fp.isReadOnly("date") ? "للقراءة فقط حسب السياسة" : undefined)}
                  />
                </div>
                )}
                {!isInvoice && fp.isVisible("validUntil") && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">{isOrder ? t("salesDocForm.expectedDeliveryDate") : t("salesDocForm.validUntil")}{fp.isRequired("validUntil") && <span className="text-destructive"> *</span>}</Label>
                    <DateField className="h-9 text-sm" value={validUntil} onChange={e => setValidUntil(e.target.value)} readOnly={fp.isReadOnly("validUntil")} />
                  </div>
                )}
                {fp.isVisible("customer") && (
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("salesDocForm.customer")}{fp.isRequired("customer") && <span className="text-destructive"> *</span>}</Label>
                  <div className={fp.isReadOnly("customer") ? "pointer-events-none opacity-70" : ""} title={fp.isReadOnly("customer") ? "للقراءة فقط حسب السياسة" : undefined}>
                    <SearchCombobox items={customerComboItems} value={customerId} onValueChange={setCustomerId} placeholder={t("salesDocForm.customerPlaceholder")} />
                  </div>
                </div>
                )}
                <CustomerVatControl customers={customers} customerId={customerId} onCustomerChange={setCustomerId} hidden={!fp.isVisible("addCustomerTool")} readOnly={fp.isReadOnly("addCustomerTool")} />
                {isInvoice && isNew && (
                  <div className="space-y-1.5">
                    <Label className="text-xs flex items-center gap-1.5">
                      <FileSignature className="h-3.5 w-3.5 text-muted-foreground" />
                      {t("salesDocForm.basedOnQuotation")}
                    </Label>
                    <SearchCombobox
                      items={[
                        { value: "", label: t("salesDocForm.basedOnQuotationNone") },
                        ...eligibleQuotationsForLink.map((q: any) => {
                          const cust = (customers as any[]).find((c: any) => Number(c.id) === Number(q.customerId));
                          const custName = cust ? (cust.nameAr ?? cust.nameEn ?? `#${cust.id}`) : t("salesDocForm.noCustomer");
                          const num = q.docNumber ?? `SQ-${q.id}`;
                          return {
                            value: String(q.id),
                            code:  num,
                            label: `${custName} — ${q.quotationDate ?? ""} — ${Number(q.totalAmount ?? 0).toFixed(2)}`,
                          };
                        }),
                      ]}
                      value={sourceQuotationId}
                      onValueChange={loadFromQuotation}
                      placeholder={t("salesDocForm.basedOnQuotationPlaceholder")}
                      emptyText={t("salesDocForm.basedOnQuotationEmpty")}
                      data-testid="combo-source-quotation"
                    />
                  </div>
                )}
                {usesBranch && fp.isVisible("branch") && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t("salesDocForm.branch")}<span className="text-destructive"> *</span></Label>
                    <Select value={branchId || undefined} onValueChange={setBranchId} disabled={fp.isReadOnly("branch")}>
                      <SelectTrigger className="h-9 text-sm"><SelectValue placeholder={t("salesDocForm.branchPlaceholder")} /></SelectTrigger>
                      <SelectContent>
                        {(branches as any[]).map((b: any) => (
                          <SelectItem key={b.id} value={String(b.id)}>{b.nameAr ?? b.nameEn ?? `#${b.id}`}{b.isMain ? ` (${t("common.main")})` : ""}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {usesOps && fp.isVisible("paymentMethod") && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t("salesDocForm.paymentType")}{fp.isRequired("paymentMethod") && <span className="text-destructive"> *</span>}</Label>
                    <Select value={paymentType} disabled={fp.isReadOnly("paymentMethod")} onValueChange={(v) => {
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
                        <SelectItem value="credit">{t("salesDocForm.paymentCredit")}</SelectItem>
                        <SelectItem value="cash">{t("salesDocForm.paymentCash")}</SelectItem>
                        <SelectItem value="bank">{t("salesDocForm.paymentBank")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {usesOps && paymentType === "cash" && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t("salesDocForm.cashBox")}</Label>
                    <Select value={cashBoxId || undefined} onValueChange={setCashBoxId}>
                      <SelectTrigger className="h-9 text-sm"><SelectValue placeholder={t("salesDocForm.cashBoxPlaceholder")} /></SelectTrigger>
                      <SelectContent>
                        {(cashBoxes as any[]).map((b: any) => (
                          <SelectItem key={b.id} value={String(b.id)}>{b.nameAr ?? b.nameEn ?? `#${b.id}`}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {usesOps && paymentType === "bank" && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t("salesDocForm.bankAccount")}</Label>
                    <Select value={bankAccountId || undefined} onValueChange={setBankAccountId}>
                      <SelectTrigger className="h-9 text-sm"><SelectValue placeholder={t("salesDocForm.bankAccountPlaceholder")} /></SelectTrigger>
                      <SelectContent>
                        {(bankAccounts as any[]).map((b: any) => (
                          <SelectItem key={b.id} value={String(b.id)}>{b.nameAr ?? b.nameEn ?? `#${b.id}`}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {fp.isVisible("currency") && (
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("salesDocForm.currency")}{fp.isRequired("currency") && <span className="text-destructive"> *</span>}</Label>
                  {currencies.length > 0 ? (
                    <Select value={currencyCode || undefined} onValueChange={handleCurrencyChange} disabled={fp.isReadOnly("currency")}>
                      <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="..." /></SelectTrigger>
                      <SelectContent>
                        {currencies.map((c: any) => (
                          <SelectItem key={c.id} value={c.code}>{c.code}{c.nameAr ? ` — ${c.nameAr}` : ""}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input className="h-9 text-sm" dir="ltr" value={currencyCode} onChange={e => setCurrencyCode(e.target.value)} readOnly={fp.isReadOnly("currency")} />
                  )}
                </div>
                )}
                {fp.isVisible("exchangeRate") && (
                <div className="space-y-1.5">
                  <Label className="text-xs flex items-center justify-between gap-2">
                    <span>{t("salesDocForm.exchangeRate")}{fp.isRequired("exchangeRate") && <span className="text-destructive"> *</span>}</span>
                    {currencyCode && currencyCode !== (defaultCurrency?.code ?? "SAR") && (
                      <span className="text-[10px] text-muted-foreground font-normal" dir="ltr">
                        1 {currencyCode} = {Number(exchangeRate) > 0 ? Number(exchangeRate).toFixed(4) : "—"} {defaultCurrency?.code ?? "SAR"}
                      </span>
                    )}
                  </Label>
                  <Input type="text" inputMode="decimal" className="h-9 text-sm" dir="ltr" value={exchangeRate}
                    readOnly={fp.isReadOnly("exchangeRate")}
                    onChange={e => setExchangeRate(e.target.value.replace(/[^0-9.]/g, ""))} />
                </div>
                )}
                {usesOps && fp.isVisible("salesperson") && (
                  <div className="space-y-1.5">
                    <Label className="text-xs flex items-center gap-1">
                      <span>{t("salesDocForm.salesRep")}{fp.isRequired("salesperson") && <span className="text-destructive"> *</span>}</span>
                      {repLocked && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                          مُعيَّن تلقائياً (هويتك كمندوب)
                        </span>
                      )}
                    </Label>
                    <div className={(repLocked || fp.isReadOnly("salesperson")) ? "opacity-90 pointer-events-none" : ""} title={repLocked ? "لا يمكنك إسناد فاتورتك لمندوب آخر" : (fp.isReadOnly("salesperson") ? "للقراءة فقط حسب السياسة" : undefined)}>
                      <SearchCombobox
                        items={salesRepComboItems}
                        value={salesRepId}
                        onValueChange={setSalesRepId}
                        placeholder={t("salesDocForm.salesRepPlaceholder")}
                      />
                    </div>
                  </div>
                )}
                {fp.isVisible("notes") && (
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("salesDocForm.notes")}{fp.isRequired("notes") && <span className="text-destructive"> *</span>}</Label>
                  <Input className="h-9 text-sm" value={notes} onChange={e => setNotes(e.target.value)} readOnly={fp.isReadOnly("notes")} />
                </div>
                )}
                {isInvoice && fp.isVisible("costCenter") && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">مركز التكلفة{fp.isRequired("costCenter") && <span className="text-destructive"> *</span>}</Label>
                    <select
                      value={costCenter}
                      onChange={e => setCostCenter(e.target.value)}
                      disabled={fp.isReadOnly("costCenter")}
                      data-testid="sales-cost-center"
                      className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background disabled:bg-muted/40 disabled:cursor-not-allowed"
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
                )}
                <div className="space-y-1.5">
                  <Label className="text-xs">المستودع</Label>
                  <SearchCombobox
                    items={(warehouses as any[]).map((w: any) => ({
                      value: String(w.id),
                      label: isRtl ? (w.nameAr ?? w.nameEn ?? `#${w.id}`) : (w.nameEn ?? w.nameAr ?? `#${w.id}`),
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

              <div className="border-t pt-4 mt-2 flex items-center gap-2 text-sm font-semibold text-foreground/80">
                <ListOrdered className="h-4 w-4" />
                <span>{t("salesDocForm.tabLines", { count: lines.filter(l => l.itemName).length })}</span>
              </div>
              {linesSection}
            </CardContent>
          </TabsContent>

        </Card>
      </Tabs>
      </fieldset>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => navigate(basePath)}>
          {isInvoice && !isNew && (existing as any)?.status === "posted" ? t("common.back", "رجوع") : t("common.cancel")}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            // Print-only path: skips save entirely, hands the existing
            // doc id off to the list page which already owns the print
            // modal + template flow. For an unsaved/new doc there is
            // nothing to print yet, so we surface the same hint we use
            // elsewhere instead of disabling the button silently.
            if (!editId) {
              toast({
                title: "احفظ المستند أولاً قبل الطباعة",
                description: "يصبح زر الطباعة فعّالاً بعد حفظ المستند مرة واحدة.",
              });
              return;
            }
            // No preferred-printer gate: the browser's system print
            // dialog is the real selector. The localStorage "preferred
            // printer name" is just a UX hint (browsers cannot
            // enumerate physical printers anyway), so gating on it
            // silently blocked users who never set a name.
            // Use sessionStorage so the hint survives wouter's navigate()
            // (which would otherwise overwrite window.history.state).
            try {
              sessionStorage.setItem(
                "autoPrintSalesInvoice",
                JSON.stringify({ id: editId, template: salesTemplate, ts: Date.now() }),
              );
            } catch { /* ignore storage failures */ }
            navigate(basePath);
          }}
          disabled={saveMut.isPending}
          className="gap-1.5"
          data-testid="button-print"
        >
          <Printer className="h-4 w-4" />
          طباعة
        </Button>
        {!(isInvoice && !isNew && (existing as any)?.status === "posted") && (
          <Button onClick={handleSave} disabled={saveMut.isPending}>
            {saveMut.isPending ? t("common.saving") : isNew ? (isInvoice ? t("salesDocForm.saveInvoice") : isOrder ? t("salesDocForm.saveOrder") : t("salesDocForm.saveQuotation")) : t("salesDocForm.saveEdit")}
          </Button>
        )}
      </div>
    </div>
  );
}
