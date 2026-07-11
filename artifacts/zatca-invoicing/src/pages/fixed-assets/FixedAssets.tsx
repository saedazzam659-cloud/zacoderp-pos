import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormPanel } from "@/components/FormPanel";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Pencil, Trash2, Search, Package, QrCode,
  Info, ShoppingCart, Cog, TrendingDown, Shield, FileText, Receipt, Calculator } from "lucide-react";
import { YearMonthInput } from "@/components/YearMonthInput";
import { DateField } from "@/components/ui/date-field";
import DepreciationScheduleTimeline from "./DepreciationScheduleTimeline";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Asset = {
  id: number; code: string; nameAr: string; nameEn: string | null;
  status: string; categoryId: number | null; groupId: number | null; branchId: number | null;
  costCenterId: number | null;
  purchaseDate: string | null; purchaseValue: string;
  supplierName: string | null; supplierId: number | null;
  invoiceNo: string | null; acquisitionJeNo: string | null; paymentMethod: string | null;
  cashBoxId: number | null; bankAccountId: number | null;
  model: string | null; brand: string | null; serialNo: string | null;
  serialNumber: string | null; skipAcquisitionJe: boolean;
  plateNumber: string | null; color: string | null;
  initialKm: number | null; currentKm: number | null;
  lifeYears: number; depreciationMethod: string;
  vatRate: string; priceIncludesVat: boolean;
  scrapValue: string; depreciationStart: string | null;
  accumulatedDepreciation: string; bookValue: string;
  insuranceCompany: string | null; insurancePolicyNo: string | null;
  insuranceStart: string | null; insuranceEnd: string | null; insuranceValue: string;
  custodianEmployeeId: number | null; location: string | null;
  riskLevel: string | null; aiRecommendation: string | null;
  qrPayload: string | null; notes: string | null;
};
type Category = {
  id: number; nameAr: string;
  defaultLifeYears?: number | string; defaultDepreciationMethod?: string;
  defaultScrapRate?: string; defaultScrapType?: string;
};

const STATUSES = [
  ["active","نشط"],["in_maintenance","تحت الصيانة"],["transferred","منقول"],
  ["sold","مباع"],["scrapped","مخرّد"],["fully_depreciated","مهلك بالكامل"],
] as const;
const METHODS = [
  ["straight_line","قسط ثابت"],["declining_balance","قسط متناقص"],["units_of_production","وحدات الإنتاج"],
] as const;

const EMPTY = {
  code:"", nameAr:"", nameEn:"", status:"active",
  categoryId:"", groupId:"", branchId:"", costCenterId:"",
  purchaseDate:"", purchaseValue:"0", supplierName:"", supplierId:"",
  invoiceNo:"", acquisitionJeNo:"", paymentMethod:"cash", cashBoxId:"", bankAccountId:"",
  model:"", brand:"", serialNo:"", serialNumber:"", skipAcquisitionJe:false,
  plateNumber:"", color:"",
  initialKm:"", currentKm:"",
  lifeYears:"5", depreciationMethod:"straight_line",
  vatRate:"15", priceIncludesVat:false,
  scrapValue:"0", depreciationStart:"",
  accumulatedDepreciation:"0", bookValue:"0",
  insuranceCompany:"", insurancePolicyNo:"",
  insuranceStart:"", insuranceEnd:"", insuranceValue:"0",
  custodianEmployeeId:"", location:"", notes:"",
};

export default function FixedAssets() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Asset | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  // Track which depreciation fields the user manually touched, so picking a
  // category only auto-fills UNTOUCHED fields (never clobbers a manual edit,
  // even if the manual value happens to equal an initial default).
  const [depTouched, setDepTouched] = useState({ lifeYears:false, depreciationMethod:false, scrapValue:false });
  const [del, setDel] = useState<Asset | null>(null);
  const [showQr, setShowQr] = useState<Asset | null>(null);
  const [activeTab, setActiveTab] = useState<"basic"|"purchase"|"tech"|"depreciation"|"insurance"|"extra"|"tax">("basic");

  // ── Import-from-source: pull the purchase data from an already-recorded
  //    purchase invoice OR journal entry (looked up by its number) so the
  //    user never retypes an asset that is already in the books. Applying a
  //    result also auto-enables skipAcquisitionJe to prevent double-posting.
  const [impSource, setImpSource] = useState<"invoice"|"je">("invoice");
  const [impNumber, setImpNumber] = useState("");
  const [impBusy, setImpBusy] = useState(false);
  const [impErr, setImpErr] = useState("");
  const [impInvoice, setImpInvoice] = useState<any|null>(null);
  const [impJe, setImpJe] = useState<any|null>(null);
  function resetImport() { setImpNumber(""); setImpErr(""); setImpInvoice(null); setImpJe(null); }

  const { data: rows = [], isLoading } = useQuery<Asset[]>({
    queryKey:["fa/assets", cid],
    queryFn: async () => (await fetch(`${API}/api/fixed-assets/assets?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });
  const { data: cats = [] } = useQuery<Category[]>({
    queryKey:["fa/categories", cid],
    queryFn: async () => (await fetch(`${API}/api/fixed-assets/categories?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });
  const { data: groups = [] } = useQuery<{ id:number; nameAr:string; parentId:number|null; isActive?:boolean }[]>({
    queryKey:["fa/groups", cid],
    queryFn: async () => {
      const j = await (await fetch(`${API}/api/fixed-assets/groups?companyId=${cid}`, { headers })).json();
      return Array.isArray(j) ? j : [];
    },
    enabled: !!cid,
  });
  const { data: suppliers = [] } = useQuery<any[]>({
    queryKey:["suppliers", cid],
    queryFn: async () => (await fetch(`${API}/api/suppliers?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });
  const { data: cashBoxes = [] } = useQuery<any[]>({
    queryKey:["cash-boxes", cid],
    queryFn: async () => (await fetch(`${API}/api/cash-boxes?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });
  const { data: bankAccounts = [] } = useQuery<any[]>({
    queryKey:["bank-accounts", cid],
    queryFn: async () => (await fetch(`${API}/api/bank-accounts?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });
  const { data: costCenters = [] } = useQuery<any[]>({
    queryKey:["cost-centers", cid],
    queryFn: async () => (await fetch(`${API}/api/cost-centers?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });
  // Chart of accounts — used only to label the debit lines of a fetched
  // journal entry in the import preview (so the user can pick the asset line).
  const { data: accounts = [] } = useQuery<any[]>({
    queryKey:["accounts", cid],
    queryFn: async () => { const j = await (await fetch(`${API}/api/accounts?companyId=${cid}`, { headers })).json(); return Array.isArray(j) ? j : []; },
    enabled: !!cid,
  });
  const acctName = (id:number|null) => {
    if (id == null) return "—";
    const a = accounts.find((x:any)=>String(x.id)===String(id));
    return a ? `${a.code ? a.code+" · " : ""}${a.nameAr ?? a.nameEn ?? "#"+id}` : `#${id}`;
  };

  const filtered = rows.filter(a => !search.trim() ||
    a.nameAr?.toLowerCase().includes(search.toLowerCase()) ||
    a.code?.toLowerCase().includes(search.toLowerCase()) ||
    a.serialNo?.toLowerCase().includes(search.toLowerCase()) ||
    a.plateNumber?.toLowerCase().includes(search.toLowerCase()));

  function openNew() { setEditing(null); setForm(EMPTY); setDepTouched({ lifeYears:false, depreciationMethod:false, scrapValue:false }); resetImport(); setActiveTab("basic"); setShowForm(true); }
  function openEdit(a: Asset) {
    setEditing(a);
    setForm({
      code:a.code??"", nameAr:a.nameAr??"", nameEn:a.nameEn??"", status:a.status??"active",
      categoryId:a.categoryId?String(a.categoryId):"", groupId:a.groupId?String(a.groupId):"", branchId:a.branchId?String(a.branchId):"",
      costCenterId:a.costCenterId?String(a.costCenterId):"",
      purchaseDate:a.purchaseDate??"", purchaseValue:String(a.purchaseValue??"0"),
      supplierName:a.supplierName??"", supplierId:a.supplierId?String(a.supplierId):"",
      invoiceNo:a.invoiceNo??"", acquisitionJeNo:a.acquisitionJeNo??"", paymentMethod:a.paymentMethod??"cash",
      cashBoxId:a.cashBoxId?String(a.cashBoxId):"", bankAccountId:a.bankAccountId?String(a.bankAccountId):"",
      model:a.model??"", brand:a.brand??"", serialNo:a.serialNo??"",
      serialNumber:a.serialNumber??"", skipAcquisitionJe:!!a.skipAcquisitionJe,
      plateNumber:a.plateNumber??"", color:a.color??"",
      initialKm:a.initialKm?String(a.initialKm):"", currentKm:a.currentKm?String(a.currentKm):"",
      lifeYears:String(a.lifeYears??5), depreciationMethod:a.depreciationMethod??"straight_line",
      vatRate:String((a as any).vatRate??"15"), priceIncludesVat:!!(a as any).priceIncludesVat,
      scrapValue:String(a.scrapValue??"0"), depreciationStart:a.depreciationStart??"",
      accumulatedDepreciation:String(a.accumulatedDepreciation??"0"),
      bookValue:String(a.bookValue??"0"),
      insuranceCompany:a.insuranceCompany??"", insurancePolicyNo:a.insurancePolicyNo??"",
      insuranceStart:a.insuranceStart??"", insuranceEnd:a.insuranceEnd??"",
      insuranceValue:String(a.insuranceValue??"0"),
      custodianEmployeeId:a.custodianEmployeeId?String(a.custodianEmployeeId):"",
      location:a.location??"", notes:a.notes??"",
    });
    setDepTouched({ lifeYears:true, depreciationMethod:true, scrapValue:true });
    resetImport(); setActiveTab("basic"); setShowForm(true);
  }

  // Pick a category in Basic Data → auto-populate the Depreciation tab
  // defaults (life / method / scrap) from the category. Fill EMPTY (or
  // still-at-initial-default) fields ONLY — never clobber a manual edit.
  function selectCategory(catId: string) {
    const cat = cats.find(c => String(c.id) === String(catId));
    setForm(f => {
      const next: typeof f = { ...f, categoryId: catId };
      if (!cat) return next;
      if (!depTouched.lifeYears && cat.defaultLifeYears != null && cat.defaultLifeYears !== "")
        next.lifeYears = String(cat.defaultLifeYears);
      if (!depTouched.depreciationMethod && cat.defaultDepreciationMethod)
        next.depreciationMethod = cat.defaultDepreciationMethod;
      if (!depTouched.scrapValue) {
        const rate = Number(cat.defaultScrapRate ?? 0);
        const scrap = cat.defaultScrapType === "value"
          ? rate
          : (Number(f.purchaseValue || 0) * rate) / 100;
        if (scrap > 0) next.scrapValue = String(+scrap.toFixed(2));
      }
      return next;
    });
  }

  // Percent-scrap categories compute scrap from purchase value; if the user
  // picks the category before entering the purchase value, recompute the scrap
  // default when the purchase value changes — but only while it's untouched.
  function updatePurchaseValue(v: string) {
    setForm(f => {
      const next: typeof f = { ...f, purchaseValue: v };
      if (depTouched.scrapValue || !f.categoryId) return next;
      const cat = cats.find(c => String(c.id) === String(f.categoryId));
      if (!cat || cat.defaultScrapType === "value") return next;
      const rate = Number(cat.defaultScrapRate ?? 0);
      const scrap = (Number(v || 0) * rate) / 100;
      if (scrap > 0) next.scrapValue = String(+scrap.toFixed(2));
      return next;
    });
  }

  // Look up a purchase invoice / journal entry by its number, company-scoped,
  // and stash the full document (with lines) for preview before applying.
  async function runImport() {
    const num = impNumber.trim();
    if (!num) { setImpErr("أدخل رقم الفاتورة أو القيد أولاً"); return; }
    setImpBusy(true); setImpErr(""); setImpInvoice(null); setImpJe(null);
    // Fetch JSON but fail loudly on a non-2xx response — otherwise an error
    // envelope ({error:"…"}) would be treated as a valid document and the user
    // could "apply" garbage (value → 0) with skipAcquisitionJe silently on.
    const getJson = async (url:string) => {
      const r = await fetch(url, { headers });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error((body && (body.error || body.message)) || `HTTP ${r.status}`);
      return body;
    };
    try {
      if (impSource === "invoice") {
        const list = await getJson(`${API}/api/purchasing/purchase-invoices?companyId=${cid}`);
        const arr = Array.isArray(list) ? list : [];
        const hit = arr.find((r:any)=> String(r.supplierInvoiceNumber ?? "").trim()===num || String(r.docNumber ?? "").trim()===num);
        if (!hit) { setImpErr("لا توجد فاتورة مشتريات بهذا الرقم"); return; }
        const full = await getJson(`${API}/api/purchasing/purchase-invoices/${hit.id}?companyId=${cid}`);
        if (!full || full.id == null) { setImpErr("تعذّر تحميل تفاصيل الفاتورة"); return; }
        setImpInvoice(full);
      } else {
        const list = await getJson(`${API}/api/journal-entries?companyId=${cid}`);
        const arr = Array.isArray(list) ? list : [];
        const hit = arr.find((r:any)=> String(r.docNumber ?? "").trim()===num);
        if (!hit) { setImpErr("لا يوجد قيد محاسبي بهذا الرقم"); return; }
        const full = await getJson(`${API}/api/journal-entries/${hit.id}?companyId=${cid}`);
        if (!full || full.id == null) { setImpErr("تعذّر تحميل تفاصيل القيد"); return; }
        setImpJe(full);
      }
    } catch (e:any) {
      setImpErr(e?.message || "تعذّر جلب البيانات");
    } finally { setImpBusy(false); }
  }

  // Map a fetched purchase invoice onto the purchase fields. Asset cost is the
  // NET subtotal (VAT lives in the tax tab); payment method + settlement box
  // carry over. Auto-enables skipAcquisitionJe (asset already in the books).
  function applyInvoice(inv:any) {
    const net   = Number(inv.subtotal ?? 0);
    const vat   = Number(inv.vatAmount ?? 0);
    const total = Number(inv.totalAmount ?? 0);
    const val   = net > 0 ? net : total;
    const pType = ["cash","bank","credit"].includes(inv.paymentType) ? inv.paymentType : null;
    setForm(f => ({ ...f,
      purchaseDate:  inv.invoiceDate || f.purchaseDate,
      purchaseValue: String(+Number(val).toFixed(2)),
      invoiceNo:     String(inv.supplierInvoiceNumber || inv.docNumber || f.invoiceNo || ""),
      acquisitionJeNo: "",
      supplierId:    inv.supplierId ? String(inv.supplierId) : f.supplierId,
      paymentMethod: pType ?? f.paymentMethod,
      cashBoxId:     (pType ?? f.paymentMethod) === "cash" && inv.cashBoxId    ? String(inv.cashBoxId)     : "",
      bankAccountId: (pType ?? f.paymentMethod) === "bank" && inv.bankAccountId ? String(inv.bankAccountId) : "",
      vatRate:       net > 0 ? String(+(vat / net * 100).toFixed(2)) : f.vatRate,
      priceIncludesVat: false,
      skipAcquisitionJe: true,
    }));
    setDepTouched(d => ({ ...d, scrapValue: true }));
    toast({ title:"تم جلب بيانات الفاتورة", description:"روجعت حقول الشراء تلقائياً — فُعّل «الأصل مُسجّل مسبقاً»" });
  }

  // Map a fetched journal entry. entryDate → purchase date, docNumber → ref,
  // description appended to notes. Value is optional: pass it from the debit
  // line the user picks (or the total). Supplier/payment can't be inferred.
  function applyJe(je:any, opts:{ value?: number }) {
    setForm(f => ({ ...f,
      purchaseDate:  je.entryDate || f.purchaseDate,
      // The JE number goes into its OWN field (رقم القيد المحاسبي), never into
      // رقم الفاتورة — a JE reference is not a purchase-invoice number.
      acquisitionJeNo: String(je.docNumber || f.acquisitionJeNo || ""),
      purchaseValue: opts.value != null ? String(+Number(opts.value).toFixed(2)) : f.purchaseValue,
      notes:         je.description ? (f.notes ? `${f.notes} — ${je.description}` : je.description) : f.notes,
      skipAcquisitionJe: true,
    }));
    if (opts.value != null) setDepTouched(d => ({ ...d, scrapValue: true }));
    toast({ title:"تم جلب بيانات القيد",
      description: opts.value != null ? "تم ضبط قيمة الأصل من السطر المختار — فُعّل «الأصل مُسجّل مسبقاً»" : "تم ضبط التاريخ والمرجع" });
  }

  const TABS = [
    { id:"basic",        label:"البيانات الأساسية", icon: Info,          grad:"from-emerald-500 to-emerald-600", text:"text-emerald-700",  border:"border-emerald-200" },
    { id:"purchase",     label:"بيانات الشراء",      icon: ShoppingCart,  grad:"from-blue-500 to-blue-600",       text:"text-blue-700",     border:"border-blue-200" },
    { id:"tech",         label:"بيانات فنية",        icon: Cog,           grad:"from-amber-500 to-amber-600",     text:"text-amber-700",    border:"border-amber-200" },
    { id:"tax",          label:"الضرائب",           icon: Receipt,       grad:"from-teal-500 to-teal-600",        text:"text-teal-700",    border:"border-teal-200" },
    { id:"depreciation", label:"الإهلاك",            icon: TrendingDown,  grad:"from-violet-500 to-violet-600",   text:"text-violet-700",   border:"border-violet-200" },
    { id:"insurance",    label:"التأمين",            icon: Shield,        grad:"from-pink-500 to-pink-600",        text:"text-pink-700",    border:"border-pink-200" },
    { id:"extra",        label:"إضافي / ملاحظات",   icon: FileText,      grad:"from-slate-500 to-slate-600",      text:"text-slate-700",   border:"border-slate-200" },
  ] as const;

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.nameAr.trim()) throw new Error("اسم الأصل مطلوب");
      const sup = suppliers.find((s: any) => String(s.id) === String(form.supplierId));
      const body: any = { ...form, companyId: cid,
        categoryId: form.categoryId ? Number(form.categoryId) : null,
        groupId:    form.groupId    ? Number(form.groupId)    : null,
        branchId:   form.branchId   ? Number(form.branchId)   : null,
        costCenterId: form.costCenterId ? Number(form.costCenterId) : null,
        custodianEmployeeId: form.custodianEmployeeId ? Number(form.custodianEmployeeId) : null,
        initialKm:  form.initialKm  ? Number(form.initialKm)  : null,
        currentKm:  form.currentKm  ? Number(form.currentKm)  : null,
        lifeYears:  Number(form.lifeYears || 5),
        vatRate:    String(form.vatRate || "15"),
        priceIncludesVat: !!form.priceIncludesVat,
        purchaseDate: form.purchaseDate || null,
        depreciationStart: form.depreciationStart || null,
        insuranceStart: form.insuranceStart || null,
        insuranceEnd:   form.insuranceEnd   || null,
        supplierId:    form.supplierId    ? Number(form.supplierId)    : null,
        // Snapshot supplier name for display continuity
        supplierName:  sup ? (sup.nameAr ?? sup.nameEn ?? form.supplierName ?? null) : (form.supplierName || null),
        cashBoxId:     form.paymentMethod === "cash" && form.cashBoxId    ? Number(form.cashBoxId)    : null,
        bankAccountId: form.paymentMethod === "bank" && form.bankAccountId ? Number(form.bankAccountId) : null,
      };
      const url = editing ? `${API}/api/fixed-assets/assets/${editing.id}` : `${API}/api/fixed-assets/assets`;
      const r = await fetch(url, { method: editing ? "PUT" : "POST",
        headers: { ...headers, "Content-Type":"application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey:["fa/assets", cid] });
      toast({ title: editing ? "تم التحديث" : "تم الإضافة" });
      setShowForm(false); setEditing(null); setForm(EMPTY);
    },
    onError: (e:any) => toast({ title:"خطأ", description: e?.message, variant:"destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      const r = await fetch(`${API}/api/fixed-assets/assets/${del.id}?companyId=${cid}`, { method:"DELETE", headers });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "تعذّر الحذف"); }
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey:["fa/assets", cid] }); toast({ title:"تم الحذف" }); setDel(null); },
    onError: (e:any) => { toast({ title:"تعذّر الحذف", description: e?.message, variant:"destructive" }); setDel(null); },
  });

  const statusLabel = (s:string) => STATUSES.find(x=>x[0]===s)?.[1] ?? s;
  const statusBadge = (s:string) => {
    const map: Record<string,string> = {
      active:"bg-emerald-100 text-emerald-800",
      in_maintenance:"bg-orange-100 text-orange-800",
      transferred:"bg-indigo-100 text-indigo-800",
      sold:"bg-blue-100 text-blue-800",
      scrapped:"bg-rose-100 text-rose-800",
      fully_depreciated:"bg-slate-200 text-slate-700",
    };
    return map[s] || "bg-slate-100 text-slate-700";
  };
  const riskBadge = (r: string | null) => {
    if (r === "high")   return "bg-rose-100 text-rose-800";
    if (r === "medium") return "bg-amber-100 text-amber-800";
    if (r === "low")    return "bg-emerald-100 text-emerald-800";
    return "bg-slate-100 text-slate-600";
  };

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Package className="h-6 w-6 text-emerald-600" />
            سجل الأصول الثابتة
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            جميع الأصول مع الإهلاك والتأمين والحالة — {rows.length} أصل
          </p>
        </div>
        <Button onClick={openNew} data-testid="btn-new-asset" className="bg-emerald-600 hover:bg-emerald-700">
          <Plus className="h-4 w-4 ms-2" />أصل جديد
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="بحث بالاسم/الكود/الشاسيه/اللوحة…" value={search}
            onChange={(e)=>setSearch(e.target.value)} className="pe-8" data-testid="input-search" />
        </div>
        <span className="text-sm text-muted-foreground">{filtered.length} من {rows.length}</span>
      </div>

      {showForm && (
        <FormPanel icon={editing?Pencil:Plus}
          title={editing?`تعديل: ${editing.nameAr}`:"أصل جديد"}
          subtitle={editing?`الكود: ${editing.code}`:"الكود يُولَّد تلقائياً (AST0001)"}
          width="6xl"
          onClose={()=>{ setShowForm(false); setEditing(null); resetImport(); }}
          onSave={()=>saveMut.mutate()} saving={saveMut.isPending}
          saveLabel="حفظ" cancelLabel="إلغاء"
        >
          <div className="space-y-4">
            {/* ─── Tab strip ─── */}
            <div className="flex flex-wrap gap-2 p-1.5 bg-gradient-to-l from-slate-50 to-slate-100 rounded-xl border border-slate-200 shadow-inner">
              {TABS.map(t => {
                const Icon = t.icon;
                const active = activeTab === t.id;
                return (
                  <button key={t.id} type="button" onClick={()=>setActiveTab(t.id as any)}
                    data-testid={`tab-${t.id}`}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-200 ${
                      active
                        ? `bg-gradient-to-l ${t.grad} text-white shadow-md scale-[1.02]`
                        : `bg-white ${t.text} border border-slate-200 hover:shadow-sm hover:scale-[1.01]`
                    }`}>
                    <Icon className="h-4 w-4" />
                    <span>{t.label}</span>
                  </button>
                );
              })}
            </div>

            {activeTab === "basic" && (
            <fieldset className="border border-emerald-200 rounded-lg p-4 bg-emerald-50/20">
              <legend className="px-2 text-sm font-bold text-emerald-700 flex items-center gap-1">
                <Info className="h-4 w-4" /> البيانات الأساسية
              </legend>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div><Label>الكود</Label>
                  <Input value={form.code} onChange={(e)=>setForm({...form,code:e.target.value})} placeholder="تلقائي AST0001" /></div>
                <div><Label>اسم الأصل (عربي) *</Label>
                  <Input value={form.nameAr} onChange={(e)=>setForm({...form,nameAr:e.target.value})} data-testid="input-nameAr" /></div>
                <div><Label>اسم الأصل (إنجليزي)</Label>
                  <Input value={form.nameEn} onChange={(e)=>setForm({...form,nameEn:e.target.value})} /></div>
                <div><Label>الفئة</Label>
                  <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                    value={form.categoryId} onChange={(e)=>selectCategory(e.target.value)}>
                    <option value="">— بدون —</option>
                    {cats.map(c => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
                  </select>
                  <p className="text-[11px] text-muted-foreground mt-1">اختيار الفئة يملأ بيانات الإهلاك (العمر / الطريقة / الخردة) تلقائياً في تبويب «الإهلاك».</p></div>
                <div><Label>المجموعة</Label>
                  <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                    value={form.groupId} onChange={(e)=>setForm({...form,groupId:e.target.value})}>
                    <option value="">— بدون —</option>
                    {groups.filter(g=>g.isActive!==false).map(g => <option key={g.id} value={g.id}>{g.nameAr}</option>)}
                  </select>
                  <p className="text-[11px] text-muted-foreground mt-1">تصنيف تنظيمي هرمي للأصل (يُدار من شاشة «مجموعات الأصول»).</p></div>
                <div><Label>الحالة</Label>
                  <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                    value={form.status} onChange={(e)=>setForm({...form,status:e.target.value})}>
                    {STATUSES.map(([v,l])=> <option key={v} value={v}>{l}</option>)}
                  </select></div>
                <div><Label>مركز التكلفة</Label>
                  <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                    value={form.costCenterId} onChange={(e)=>setForm({...form,costCenterId:e.target.value})}
                    data-testid="select-cost-center">
                    <option value="">— بدون —</option>
                    {costCenters.filter((c:any)=>c.isActive!==false).map((c:any) =>
                      <option key={c.id} value={c.id}>{c.code ? `${c.code} — ${c.nameAr}` : c.nameAr}</option>)}
                  </select>
                  <p className="text-[11px] text-muted-foreground mt-1">يُستخدم في توزيع مصروف الإهلاك على مراكز التكلفة.</p></div>
                <div><Label>الموقع</Label>
                  <Input value={form.location} onChange={(e)=>setForm({...form,location:e.target.value})} /></div>
              </div>
            </fieldset>
            )}

            {activeTab === "purchase" && (
            <fieldset className="border border-blue-200 rounded-lg p-4 bg-blue-50/20">
              <legend className="px-2 text-sm font-bold text-blue-700 flex items-center gap-1">
                <ShoppingCart className="h-4 w-4" /> بيانات الشراء
              </legend>

              {/* ── أداة سحب البيانات من فاتورة مشتريات أو قيد محاسبي ── */}
              <div className="mb-4 rounded-xl border-2 border-indigo-200 bg-indigo-50/40 p-3">
                <div className="flex items-center gap-2 mb-1">
                  <Search className="h-4 w-4 text-indigo-600" />
                  <p className="text-sm font-bold text-indigo-800">جلب البيانات من مستند موجود</p>
                </div>
                <p className="text-[11px] text-slate-500 mb-3">
                  ابحث برقم فاتورة المشتريات أو رقم القيد المحاسبي لسحب تاريخ الشراء والقيمة والمورد ورقم الفاتورة وطريقة الدفع تلقائياً — دون إعادة إدخال. سيُفعَّل «الأصل مُسجّل مسبقاً» تلقائياً لتفادي ازدواج التسجيل في الدفاتر.
                </p>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex rounded-md border border-indigo-200 overflow-hidden">
                    <button type="button" onClick={()=>{ setImpSource("invoice"); resetImport(); }}
                      data-testid="imp-source-invoice"
                      className={`px-3 py-2 text-xs font-semibold ${impSource==="invoice" ? "bg-indigo-600 text-white" : "bg-white text-indigo-700"}`}>
                      فاتورة مشتريات
                    </button>
                    <button type="button" onClick={()=>{ setImpSource("je"); resetImport(); }}
                      data-testid="imp-source-je"
                      className={`px-3 py-2 text-xs font-semibold border-s border-indigo-200 ${impSource==="je" ? "bg-indigo-600 text-white" : "bg-white text-indigo-700"}`}>
                      قيد محاسبي
                    </button>
                  </div>
                  <div className="flex-1 min-w-[180px]">
                    <Input value={impNumber} onChange={(e)=>setImpNumber(e.target.value)}
                      onKeyDown={(e)=>{ if (e.key==="Enter"){ e.preventDefault(); runImport(); } }}
                      placeholder={impSource==="invoice" ? "رقم فاتورة المشتريات / رقم فاتورة المورد…" : "رقم القيد المحاسبي…"}
                      data-testid="imp-number" />
                  </div>
                  <Button type="button" onClick={runImport} disabled={impBusy}
                    className="bg-indigo-600 hover:bg-indigo-700" data-testid="imp-fetch">
                    {impBusy ? "جارٍ الجلب…" : "جلب البيانات"}
                  </Button>
                </div>
                {impErr && <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2 mt-2" data-testid="imp-error">{impErr}</p>}

                {impInvoice && (
                  <div className="mt-3 rounded-lg border border-emerald-200 bg-white p-3" data-testid="imp-invoice-result">
                    <p className="text-xs font-bold text-emerald-700 mb-1">فاتورة مشتريات #{impInvoice.docNumber ?? impInvoice.id}</p>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-x-3 gap-y-1 text-[11px] text-slate-600">
                      <div>التاريخ: <span className="font-mono">{impInvoice.invoiceDate ?? "—"}</span></div>
                      <div>المورد: {suppliers.find((s:any)=>String(s.id)===String(impInvoice.supplierId))?.nameAr ?? impInvoice.supplierId ?? "—"}</div>
                      <div>الصافي: <span className="font-mono">{Number(impInvoice.subtotal ?? 0).toLocaleString("ar-EG-u-ca-gregory-nu-latn")}</span></div>
                      <div>الضريبة: <span className="font-mono">{Number(impInvoice.vatAmount ?? 0).toLocaleString("ar-EG-u-ca-gregory-nu-latn")}</span></div>
                      <div>الإجمالي: <span className="font-mono">{Number(impInvoice.totalAmount ?? 0).toLocaleString("ar-EG-u-ca-gregory-nu-latn")}</span></div>
                      <div>رقم فاتورة المورد: {impInvoice.supplierInvoiceNumber ?? "—"}</div>
                      <div>الدفع: {({cash:"نقدي",bank:"بنك",credit:"آجل"} as any)[impInvoice.paymentType] ?? impInvoice.paymentType ?? "—"}</div>
                    </div>
                    <Button type="button" size="sm" onClick={()=>applyInvoice(impInvoice)}
                      className="mt-2 bg-emerald-600 hover:bg-emerald-700" data-testid="imp-apply-invoice">
                      تطبيق البيانات على النموذج
                    </Button>
                  </div>
                )}

                {impJe && (()=>{
                  const dLines = (impJe.lines ?? []).filter((l:any)=>Number(l.debit ?? 0) > 0);
                  const totDebit = (impJe.lines ?? []).reduce((s:number,l:any)=>s+Number(l.debit ?? 0), 0);
                  return (
                  <div className="mt-3 rounded-lg border border-violet-200 bg-white p-3" data-testid="imp-je-result">
                    <p className="text-xs font-bold text-violet-700 mb-1">قيد محاسبي #{impJe.docNumber ?? impJe.id}</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-600 mb-2">
                      <div>التاريخ: <span className="font-mono">{impJe.entryDate ?? "—"}</span></div>
                      <div>البيان: {impJe.description ?? "—"}</div>
                    </div>
                    <p className="text-[11px] text-slate-500 mb-1">اختر السطر (المدين) الذي يمثل قيمة الأصل، أو طبّق إجمالي المدين. لا يمكن استنتاج المورد وطريقة الدفع من القيد — أدخلهما يدوياً إن لزم.</p>
                    <div className="border border-slate-200 rounded overflow-hidden">
                      <table className="w-full text-[11px]">
                        <thead className="bg-slate-50 text-slate-600">
                          <tr><th className="px-2 py-1 text-start">الحساب</th><th className="px-2 py-1 text-start">البيان</th><th className="px-2 py-1 text-end">مدين</th><th className="px-2 py-1"></th></tr>
                        </thead>
                        <tbody>
                          {dLines.map((l:any,i:number)=>(
                            <tr key={i} className="border-t border-slate-100">
                              <td className="px-2 py-1">{acctName(l.accountId)}</td>
                              <td className="px-2 py-1 text-slate-500">{l.description ?? "—"}</td>
                              <td className="px-2 py-1 text-end font-mono">{Number(l.debit ?? 0).toLocaleString("ar-EG-u-ca-gregory-nu-latn")}</td>
                              <td className="px-2 py-1 text-end">
                                <button type="button" onClick={()=>applyJe(impJe,{ value: Number(l.debit ?? 0) })}
                                  className="text-[11px] font-semibold text-violet-700 hover:underline" data-testid={`imp-use-line-${i}`}>
                                  استخدم كقيمة الأصل
                                </button>
                              </td>
                            </tr>
                          ))}
                          {dLines.length===0 && <tr><td colSpan={4} className="px-2 py-2 text-center text-slate-400">لا توجد سطور مدينة</td></tr>}
                        </tbody>
                      </table>
                    </div>
                    <div className="flex flex-wrap gap-2 mt-2">
                      <Button type="button" size="sm" onClick={()=>applyJe(impJe,{ value: totDebit })}
                        className="bg-violet-600 hover:bg-violet-700" data-testid="imp-apply-je-total">
                        تطبيق إجمالي المدين ({Number(totDebit).toLocaleString("ar-EG-u-ca-gregory-nu-latn")})
                      </Button>
                      <Button type="button" size="sm" variant="outline" onClick={()=>applyJe(impJe,{})}
                        data-testid="imp-apply-je-meta">
                        التاريخ والمرجع فقط
                      </Button>
                    </div>
                  </div>
                  );
                })()}
              </div>

              <label className={`flex items-center gap-3 p-3 mb-4 rounded-xl border-2 cursor-pointer transition-all ${
                form.skipAcquisitionJe ? "border-amber-500 bg-amber-50 shadow-sm" : "border-slate-200 bg-white hover:border-slate-300"
              }`}>
                <input type="checkbox" checked={form.skipAcquisitionJe}
                  onChange={(e)=>setForm({...form,skipAcquisitionJe:e.target.checked})}
                  className="h-5 w-5 rounded accent-amber-600" data-testid="check-skip-acquisition-je" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-slate-800">الأصل مُسجّل مسبقاً (قيد يومية أو فاتورة مشتريات)</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    فعّلها لتتبّع الإهلاك فقط بدون إنشاء قيد اقتناء جديد — يمنع ازدواج تسجيل قيمة الأصل في الدفاتر.
                  </p>
                </div>
                <span className={`text-xs font-bold px-2 py-0.5 rounded ${form.skipAcquisitionJe ? "bg-amber-600 text-white" : "bg-slate-200 text-slate-600"}`}>
                  {form.skipAcquisitionJe ? "إهلاك فقط" : "شراء جديد"}
                </span>
              </label>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div><Label>تاريخ الشراء</Label>
                  <DateField value={form.purchaseDate} onChange={(e)=>setForm({...form,purchaseDate:e.target.value})} /></div>
                <div><Label>قيمة الشراء</Label>
                  <Input type="text" inputMode="decimal" dir="ltr" value={form.purchaseValue} onChange={(e)=>updatePurchaseValue(e.target.value.replace(/[^0-9.]/g,""))} /></div>
                <div><Label>المورد</Label>
                  <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                    value={form.supplierId} onChange={(e)=>setForm({...form,supplierId:e.target.value})}
                    data-testid="select-supplier">
                    <option value="">— بدون / مورد عابر —</option>
                    {suppliers.map((s:any)=>(
                      <option key={s.id} value={s.id}>{s.nameAr ?? s.nameEn ?? `#${s.id}`}</option>
                    ))}
                  </select></div>
                <div><Label>رقم الفاتورة</Label>
                  <Input value={form.invoiceNo} onChange={(e)=>setForm({...form,invoiceNo:e.target.value})} /></div>
                {(form.acquisitionJeNo || impSource === "je") && (
                  <div><Label>رقم القيد المحاسبي</Label>
                    <Input value={form.acquisitionJeNo} onChange={(e)=>setForm({...form,acquisitionJeNo:e.target.value})}
                      placeholder="يُملأ تلقائياً عند جلب قيد محاسبي" data-testid="input-acquisition-je-no" /></div>
                )}
                <div><Label>طريقة الدفع</Label>
                  <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                    value={form.paymentMethod}
                    onChange={(e)=>setForm({...form,paymentMethod:e.target.value, cashBoxId:"", bankAccountId:""})}
                    data-testid="select-payment-method">
                    <option value="cash">نقدي</option><option value="bank">بنك</option><option value="credit">آجل (على المورد)</option>
                  </select></div>
                {form.paymentMethod === "cash" && (
                  <div><Label>الصندوق النقدي *</Label>
                    <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                      value={form.cashBoxId} onChange={(e)=>setForm({...form,cashBoxId:e.target.value})}
                      data-testid="select-cash-box">
                      <option value="">— اختر —</option>
                      {cashBoxes.filter((c:any)=>c.isActive!==false).map((c:any)=>(
                        <option key={c.id} value={c.id}>{c.nameAr ?? c.nameEn ?? `#${c.id}`}</option>
                      ))}
                    </select></div>
                )}
                {form.paymentMethod === "bank" && (
                  <div><Label>الحساب البنكي *</Label>
                    <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                      value={form.bankAccountId} onChange={(e)=>setForm({...form,bankAccountId:e.target.value})}
                      data-testid="select-bank-account">
                      <option value="">— اختر —</option>
                      {bankAccounts.filter((b:any)=>b.isActive!==false).map((b:any)=>(
                        <option key={b.id} value={b.id}>{b.nameAr ?? b.nameEn ?? `#${b.id}`}</option>
                      ))}
                    </select></div>
                )}
                {form.paymentMethod === "credit" && form.supplierId && (
                  <div className="md:col-span-2 self-end">
                    <p className="text-xs text-muted-foreground bg-amber-50 border border-amber-200 rounded p-2">
                      سيتم قيد المبلغ على ذمة المورد المختار (دائن لحساب المورد)
                    </p>
                  </div>
                )}
                {form.paymentMethod === "credit" && !form.supplierId && (
                  <div className="md:col-span-2 self-end">
                    <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">
                      اختر المورد أعلاه أو سيتم استخدام حساب وسيط اقتناء الأصول
                    </p>
                  </div>
                )}
              </div>
            </fieldset>
            )}

            {activeTab === "tech" && (
            <fieldset className="border border-amber-200 rounded-lg p-4 bg-amber-50/20">
              <legend className="px-2 text-sm font-bold text-amber-700 flex items-center gap-1">
                <Cog className="h-4 w-4" /> بيانات فنية / مركبة
              </legend>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div><Label>الموديل</Label>
                  <Input value={form.model} onChange={(e)=>setForm({...form,model:e.target.value})} placeholder="2023" /></div>
                <div><Label>الماركة</Label>
                  <Input value={form.brand} onChange={(e)=>setForm({...form,brand:e.target.value})} placeholder="Toyota" /></div>
                <div><Label>رقم الشاسيه</Label>
                  <Input value={form.serialNo} onChange={(e)=>setForm({...form,serialNo:e.target.value})} /></div>
                <div><Label>المسلسل</Label>
                  <Input value={form.serialNumber} onChange={(e)=>setForm({...form,serialNumber:e.target.value})} /></div>
                <div><Label>رقم اللوحة</Label>
                  <Input value={form.plateNumber} onChange={(e)=>setForm({...form,plateNumber:e.target.value})} /></div>
                <div><Label>اللون</Label>
                  <Input value={form.color} onChange={(e)=>setForm({...form,color:e.target.value})} /></div>
                <div><Label>كم عند الشراء</Label>
                  <Input type="text" inputMode="numeric" dir="ltr" value={form.initialKm} onChange={(e)=>setForm({...form,initialKm:e.target.value.replace(/[^0-9]/g,"")})} /></div>
                <div><Label>الكم الحالي</Label>
                  <Input type="text" inputMode="numeric" dir="ltr" value={form.currentKm} onChange={(e)=>setForm({...form,currentKm:e.target.value.replace(/[^0-9]/g,"")})} /></div>
              </div>
            </fieldset>
            )}

            {activeTab === "tax" && (() => {
              const rate = Math.max(0, Number(form.vatRate || 0));
              const incl = !!form.priceIncludesVat;
              const stored = Math.max(0, Number(form.purchaseValue || 0));
              const net   = stored;
              const vatAmt = +(net * rate / 100).toFixed(2);
              const gross  = +(net + vatAmt).toFixed(2);
              const setNet = (n: number) => setForm({ ...form, purchaseValue: String(Math.max(0, +n.toFixed(2))) });
              const setGross = (g: number) => {
                const newNet = rate > 0 ? +(g / (1 + rate / 100)).toFixed(2) : g;
                setNet(newNet);
              };
              return (
              <fieldset className="border border-teal-200 rounded-lg p-4 bg-teal-50/20">
                <legend className="px-2 text-sm font-bold text-teal-700 flex items-center gap-1">
                  <Receipt className="h-4 w-4" /> الضرائب
                </legend>

                {/* Inclusive checkbox card */}
                <label className={`flex items-center gap-3 p-3 mb-4 rounded-xl border-2 cursor-pointer transition-all ${
                  incl ? "border-teal-500 bg-teal-50 shadow-sm" : "border-slate-200 bg-white hover:border-slate-300"
                }`}>
                  <input type="checkbox" checked={incl}
                    onChange={(e) => {
                      const nowIncl = e.target.checked;
                      const v = Number(form.purchaseValue || 0);
                      // Re-interpret the currently-entered figure when toggling:
                      //   off→on: user's number was a NET, now treat it as GROSS → back-out new net
                      //   on→off: user's number was a NET (unchanged storage), no recalc needed
                      // Symmetric reinterpretation so toggling is fully reversible:
                      //   off→on: previously-entered figure was a NET → treat as GROSS, back-out new net
                      //   on→off: stored value is the back-calculated net → multiply back to restore the figure the user originally typed
                      let newNet = v;
                      if (rate > 0 && v > 0) {
                        if (nowIncl && !incl) newNet = +(v / (1 + rate / 100)).toFixed(2);
                        else if (!nowIncl && incl) newNet = +(v * (1 + rate / 100)).toFixed(2);
                      }
                      setForm({ ...form, priceIncludesVat: nowIncl, purchaseValue: String(newNet) });
                    }}
                    className="h-5 w-5 rounded accent-teal-600" />
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-slate-800">الإجمالي شامل الضريبة</p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {incl
                        ? "أدخل المبلغ الإجمالي شاملاً الضريبة وسيتم حساب الصافي تلقائياً"
                        : "أدخل قيمة الأصل قبل الضريبة وسيتم حساب الإجمالي تلقائياً"}
                    </p>
                  </div>
                  <span className={`text-xs font-bold px-2 py-0.5 rounded ${incl ? "bg-teal-600 text-white" : "bg-slate-200 text-slate-600"}`}>
                    {incl ? "شامل" : "غير شامل"}
                  </span>
                </label>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {/* قيمة الأصل قبل الضريبة */}
                  <div>
                    <Label className="text-slate-700">قيمة الأصل قبل الضريبة</Label>
                    <Input type="text" inputMode="decimal" dir="ltr"
                      value={form.purchaseValue}
                      readOnly={incl}
                      onChange={(e) => setNet(Number(e.target.value.replace(/[^0-9.]/g, "")) || 0)}
                      className={`mt-1 font-mono text-base ${incl ? "bg-slate-100 text-slate-600 cursor-not-allowed" : "bg-white"}`} />
                  </div>

                  {/* نسبة الضريبة */}
                  <div>
                    <Label className="text-slate-700">نسبة الضريبة %</Label>
                    <div className="mt-1 relative">
                      <Input type="text" inputMode="decimal" dir="ltr"
                        value={form.vatRate}
                        onChange={(e) => setForm({ ...form, vatRate: e.target.value.replace(/[^0-9.]/g, "") })}
                        className="font-mono text-base pl-9" />
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-teal-600 pointer-events-none">%</span>
                    </div>
                  </div>

                  {/* قيمة الضريبة (مشتقة) */}
                  <div>
                    <Label className="text-amber-700 flex items-center gap-1">
                      <Calculator className="h-3.5 w-3.5" /> قيمة الضريبة (محسوبة)
                    </Label>
                    <div className="mt-1 h-10 px-3 flex items-center justify-end rounded-md border-2 border-amber-200 bg-amber-50 font-mono text-base font-bold text-amber-800">
                      {vatAmt.toLocaleString("ar-SA-u-ca-gregory-nu-latn", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  </div>

                  {/* الإجمالي بعد الضريبة */}
                  <div>
                    <Label className="text-emerald-700 font-bold">الإجمالي بعد الضريبة</Label>
                    <Input type="text" inputMode="decimal" dir="ltr"
                      value={incl ? form.purchaseValue && rate >= 0 ? gross.toFixed(2) : "0" : gross.toFixed(2)}
                      readOnly={!incl}
                      onChange={(e) => incl && setGross(Number(e.target.value.replace(/[^0-9.]/g, "")) || 0)}
                      className={`mt-1 font-mono text-base font-bold ${incl ? "bg-white text-emerald-900 border-2 border-emerald-300" : "bg-emerald-50 text-emerald-800 border-emerald-200 cursor-not-allowed"}`} />
                  </div>
                </div>

                {/* Summary footer */}
                <div className="mt-4 p-3 rounded-xl bg-gradient-to-l from-teal-50 to-emerald-50 border border-teal-200">
                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <div>
                      <div className="text-slate-500">الصافي</div>
                      <div className="font-mono font-bold text-slate-800 text-sm mt-0.5">
                        {net.toLocaleString("ar-SA-u-ca-gregory-nu-latn", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </div>
                    </div>
                    <div className="border-x border-teal-200">
                      <div className="text-amber-600">+ ضريبة {rate}%</div>
                      <div className="font-mono font-bold text-amber-700 text-sm mt-0.5">
                        {vatAmt.toLocaleString("ar-SA-u-ca-gregory-nu-latn", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </div>
                    </div>
                    <div>
                      <div className="text-emerald-600">= الإجمالي</div>
                      <div className="font-mono font-bold text-emerald-800 text-sm mt-0.5">
                        {gross.toLocaleString("ar-SA-u-ca-gregory-nu-latn", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </div>
                    </div>
                  </div>
                  <p className="mt-2 text-[11px] text-slate-500 text-center">
                    💡 قيمة الإهلاك تُحسب على أساس <span className="font-bold text-slate-700">الصافي قبل الضريبة</span> وفقاً لمعايير المحاسبة
                  </p>
                </div>
              </fieldset>
              );
            })()}

            {activeTab === "depreciation" && (
            <fieldset className="border border-violet-200 rounded-lg p-4 bg-violet-50/20">
              <legend className="px-2 text-sm font-bold text-violet-700 flex items-center gap-1">
                <TrendingDown className="h-4 w-4" /> بيانات الإهلاك
              </legend>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <YearMonthInput value={form.lifeYears} onChange={(v)=>{setDepTouched(t=>({...t,lifeYears:true}));setForm({...form,lifeYears:v});}} />
                <div><Label>طريقة الإهلاك</Label>
                  <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                    value={form.depreciationMethod} onChange={(e)=>{setDepTouched(t=>({...t,depreciationMethod:true}));setForm({...form,depreciationMethod:e.target.value});}}>
                    {METHODS.map(([v,l])=> <option key={v} value={v}>{l}</option>)}
                  </select></div>
                <div><Label>قيمة الخردة</Label>
                  <Input type="text" inputMode="decimal" dir="ltr" value={form.scrapValue} onChange={(e)=>{setDepTouched(t=>({...t,scrapValue:true}));setForm({...form,scrapValue:e.target.value.replace(/[^0-9.]/g,"")});}} /></div>
                <div><Label>تاريخ بداية الإهلاك</Label>
                  <DateField value={form.depreciationStart} onChange={(e)=>setForm({...form,depreciationStart:e.target.value})} /></div>
                <div><Label>الإهلاك المتراكم</Label>
                  <Input type="text" inputMode="decimal" dir="ltr" value={form.accumulatedDepreciation} onChange={(e)=>setForm({...form,accumulatedDepreciation:e.target.value.replace(/[^0-9.]/g,"")})} /></div>
                <div><Label>القيمة الدفترية</Label>
                  <Input type="text" inputMode="decimal" dir="ltr" value={form.bookValue} onChange={(e)=>setForm({...form,bookValue:e.target.value.replace(/[^0-9.]/g,"")})} /></div>
              </div>

              <div className="mt-4 border-t border-violet-200 pt-3">
                <DepreciationScheduleTimeline
                  assetId={editing?.id}
                  projection={!editing}
                  title={editing ? "الجدول الزمني للإهلاك (المُرحَّل والمتبقّي)" : "الجدول الزمني المتوقع للإهلاك"}
                  purchaseValue={form.purchaseValue}
                  scrapValue={form.scrapValue}
                  lifeYears={form.lifeYears}
                  depreciationMethod={form.depreciationMethod}
                  depreciationStart={form.depreciationStart || form.purchaseDate}
                  purchaseDate={form.purchaseDate}
                />
              </div>
            </fieldset>
            )}

            {activeTab === "insurance" && (
            <fieldset className="border border-pink-200 rounded-lg p-4 bg-pink-50/20">
              <legend className="px-2 text-sm font-bold text-pink-700 flex items-center gap-1">
                <Shield className="h-4 w-4" /> بيانات التأمين
              </legend>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div><Label>شركة التأمين</Label>
                  <Input value={form.insuranceCompany} onChange={(e)=>setForm({...form,insuranceCompany:e.target.value})} /></div>
                <div><Label>رقم الوثيقة</Label>
                  <Input value={form.insurancePolicyNo} onChange={(e)=>setForm({...form,insurancePolicyNo:e.target.value})} /></div>
                <div><Label>قيمة التأمين</Label>
                  <Input type="text" inputMode="decimal" dir="ltr" value={form.insuranceValue} onChange={(e)=>setForm({...form,insuranceValue:e.target.value.replace(/[^0-9.]/g,"")})} /></div>
                <div><Label>تاريخ البداية</Label>
                  <DateField value={form.insuranceStart} onChange={(e)=>setForm({...form,insuranceStart:e.target.value})} /></div>
                <div><Label>تاريخ الانتهاء</Label>
                  <DateField value={form.insuranceEnd} onChange={(e)=>setForm({...form,insuranceEnd:e.target.value})} /></div>
              </div>
            </fieldset>
            )}

            {activeTab === "extra" && (
            <fieldset className="border border-slate-200 rounded-lg p-4 bg-slate-50/40">
              <legend className="px-2 text-sm font-bold text-slate-700 flex items-center gap-1">
                <FileText className="h-4 w-4" /> بيانات إضافية / ملاحظات
              </legend>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div><Label>المسؤول عن الأصل (رقم الموظف)</Label>
                  <Input type="text" inputMode="numeric" dir="ltr" value={form.custodianEmployeeId} onChange={(e)=>setForm({...form,custodianEmployeeId:e.target.value.replace(/[^0-9]/g,"")})} /></div>
                <div><Label>ملاحظات</Label>
                  <Input value={form.notes} onChange={(e)=>setForm({...form,notes:e.target.value})} /></div>
              </div>
            </fieldset>
            )}
          </div>
        </FormPanel>
      )}

      {/* Mobile cards (md-hidden) */}
      <div className="md:hidden space-y-3">
        {isLoading && <div className="text-center py-8 text-muted-foreground text-sm">جاري التحميل…</div>}
        {!isLoading && filtered.length === 0 && <div className="text-center py-8 text-muted-foreground text-sm">لا توجد أصول</div>}
        {filtered.map(a => (
          <div key={a.id} className="rounded-2xl bg-white border border-teal-100 shadow-sm overflow-hidden">
            <div className="bg-gradient-to-r from-teal-500 to-teal-600 px-4 py-2.5 flex items-center justify-between">
              <span className="text-white font-mono text-sm font-bold">{a.code}</span>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full bg-white/95 ${statusBadge(a.status).replace(/bg-\w+-\d+/g,'').trim()}`}>{statusLabel(a.status)}</span>
            </div>
            <div className="p-3 space-y-2">
              <div className="flex items-start gap-2">
                <div className="h-10 w-10 rounded-lg bg-teal-100 grid place-items-center text-teal-700 shrink-0"><Package className="h-5 w-5" /></div>
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-sm truncate">{a.nameAr}</p>
                  <p className="text-[11px] text-muted-foreground truncate">{[a.brand, a.model].filter(Boolean).join(" — ") || "—"}</p>
                </div>
                {a.riskLevel && (
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${riskBadge(a.riskLevel)}`}>
                    {a.riskLevel === "high" ? "عالي" : a.riskLevel === "medium" ? "متوسط" : "منخفض"}
                  </span>
                )}
              </div>
              {a.plateNumber && <div className="text-xs bg-slate-50 rounded p-1.5 px-2 font-mono"><span className="text-muted-foreground">اللوحة: </span>{a.plateNumber}</div>}
              <div className="grid grid-cols-2 gap-2 text-center text-xs">
                <div className="bg-slate-50 rounded-lg p-1.5"><div className="text-[10px] text-muted-foreground">قيمة الشراء</div><div className="font-mono font-bold text-slate-800">{Number(a.purchaseValue).toLocaleString("ar-EG-u-ca-gregory-nu-latn")}</div></div>
                <div className="bg-teal-50 rounded-lg p-1.5"><div className="text-[10px] text-muted-foreground">القيمة الدفترية</div><div className="font-mono font-bold text-teal-800">{Number(a.bookValue).toLocaleString("ar-EG-u-ca-gregory-nu-latn")}</div></div>
              </div>
            </div>
            <div className="grid grid-cols-3 border-t divide-x divide-slate-100 [direction:ltr]">
              <button onClick={()=>setDel(a)} className="py-2.5 text-rose-600 text-xs font-semibold hover:bg-rose-50 flex items-center justify-center gap-1"><Trash2 className="h-3.5 w-3.5" />حذف</button>
              <button onClick={()=>setShowQr(a)} className="py-2.5 text-slate-700 text-xs font-semibold hover:bg-slate-50 flex items-center justify-center gap-1"><QrCode className="h-3.5 w-3.5" />QR</button>
              <button onClick={()=>openEdit(a)} className="py-2.5 text-teal-700 text-xs font-semibold hover:bg-teal-50 flex items-center justify-center gap-1"><Pencil className="h-3.5 w-3.5" />تعديل</button>
            </div>
          </div>
        ))}
      </div>

      {/* Mobile FAB */}
      <button onClick={openNew} className="md:hidden fixed bottom-6 end-6 z-40 group" aria-label="أصل جديد">
        <span className="absolute inset-0 rounded-full bg-teal-400/40 animate-ping" />
        <span className="relative h-14 w-14 rounded-full bg-gradient-to-br from-teal-500 to-teal-600 ring-4 ring-white shadow-2xl grid place-items-center text-white">
          <Plus className="h-7 w-7" />
        </span>
      </button>

      <div className="hidden md:block border rounded-lg bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-xs" dir="rtl">
            <thead className="bg-gradient-to-b from-emerald-50 to-emerald-100 text-emerald-900 border-b">
              <tr>
                <th className="px-3 py-2 text-start font-semibold">الكود</th>
                <th className="px-3 py-2 text-start font-semibold">الاسم</th>
                <th className="px-3 py-2 text-start font-semibold">الماركة/الموديل</th>
                <th className="px-3 py-2 text-start font-semibold">اللوحة</th>
                <th className="px-3 py-2 text-start font-semibold">قيمة الشراء</th>
                <th className="px-3 py-2 text-start font-semibold">القيمة الدفترية</th>
                <th className="px-3 py-2 text-start font-semibold">الحالة</th>
                <th className="px-3 py-2 text-start font-semibold">المخاطر</th>
                <th className="px-3 py-2 text-center font-semibold w-32">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && <tr><td colSpan={9} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>}
              {!isLoading && filtered.length===0 && <tr><td colSpan={9} className="text-center py-8 text-muted-foreground">لا توجد أصول</td></tr>}
              {filtered.map(a => (
                <tr key={a.id} className="hover:bg-emerald-50/40" data-testid={`row-asset-${a.id}`}>
                  <td className="px-3 py-2 font-mono">{a.code}</td>
                  <td className="px-3 py-2 font-semibold">{a.nameAr}</td>
                  <td className="px-3 py-2">{[a.brand, a.model].filter(Boolean).join(" — ")}</td>
                  <td className="px-3 py-2 font-mono">{a.plateNumber || "—"}</td>
                  <td className="px-3 py-2 font-mono">{Number(a.purchaseValue).toLocaleString("ar-EG-u-ca-gregory-nu-latn")}</td>
                  <td className="px-3 py-2 font-mono">{Number(a.bookValue).toLocaleString("ar-EG-u-ca-gregory-nu-latn")}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${statusBadge(a.status)}`}>
                      {statusLabel(a.status)}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${riskBadge(a.riskLevel)}`}>
                      {a.riskLevel === "high" ? "عالي" : a.riskLevel === "medium" ? "متوسط" : a.riskLevel === "low" ? "منخفض" : "—"}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={()=>setShowQr(a)} title="QR">
                        <QrCode className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={()=>openEdit(a)} data-testid={`btn-edit-${a.id}`}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50" onClick={()=>setDel(a)} data-testid={`btn-delete-${a.id}`}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <AlertDialog open={!!del} onOpenChange={(o)=>!o && setDel(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف الأصل</AlertDialogTitle>
            <AlertDialogDescription>هل تريد حذف «{del?.nameAr}» نهائياً؟ سيتم حذف كل سجلات الصيانة والنقل والتخلص المرتبطة.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction onClick={()=>delMut.mutate()} className="bg-rose-600 hover:bg-rose-700">حذف</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!showQr} onOpenChange={(o)=>!o && setShowQr(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>QR Code للأصل</AlertDialogTitle>
            <AlertDialogDescription>
              يحتوي الكود على بيانات الأصل ({showQr?.code} — {showQr?.nameAr}).
            </AlertDialogDescription>
          </AlertDialogHeader>
          {showQr && (
            <div className="flex justify-center my-4">
              <img
                alt="QR"
                src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(showQr.qrPayload || showQr.code)}`}
                className="border rounded-lg p-2 bg-white"
              />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>إغلاق</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
