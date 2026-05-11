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
import { Plus, Pencil, Trash2, Search, Package, QrCode } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Asset = {
  id: number; code: string; nameAr: string; nameEn: string | null;
  status: string; categoryId: number | null; branchId: number | null;
  purchaseDate: string | null; purchaseValue: string;
  supplierName: string | null; supplierId: number | null;
  invoiceNo: string | null; paymentMethod: string | null;
  cashBoxId: number | null; bankAccountId: number | null;
  model: string | null; brand: string | null; serialNo: string | null;
  plateNumber: string | null; color: string | null;
  initialKm: number | null; currentKm: number | null;
  lifeYears: number; depreciationMethod: string;
  scrapValue: string; depreciationStart: string | null;
  accumulatedDepreciation: string; bookValue: string;
  insuranceCompany: string | null; insurancePolicyNo: string | null;
  insuranceStart: string | null; insuranceEnd: string | null; insuranceValue: string;
  custodianEmployeeId: number | null; location: string | null;
  riskLevel: string | null; aiRecommendation: string | null;
  qrPayload: string | null; notes: string | null;
};
type Category = { id: number; nameAr: string };

const STATUSES = [
  ["active","نشط"],["in_maintenance","تحت الصيانة"],["transferred","منقول"],
  ["sold","مباع"],["scrapped","مخرّد"],["fully_depreciated","مهلك بالكامل"],
] as const;
const METHODS = [
  ["straight_line","قسط ثابت"],["declining_balance","قسط متناقص"],["units_of_production","وحدات الإنتاج"],
] as const;

const EMPTY = {
  code:"", nameAr:"", nameEn:"", status:"active",
  categoryId:"", branchId:"", costCenterId:"",
  purchaseDate:"", purchaseValue:"0", supplierName:"", supplierId:"",
  invoiceNo:"", paymentMethod:"cash", cashBoxId:"", bankAccountId:"",
  model:"", brand:"", serialNo:"", plateNumber:"", color:"",
  initialKm:"", currentKm:"",
  lifeYears:"5", depreciationMethod:"straight_line",
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
  const [del, setDel] = useState<Asset | null>(null);
  const [showQr, setShowQr] = useState<Asset | null>(null);

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

  const filtered = rows.filter(a => !search.trim() ||
    a.nameAr?.toLowerCase().includes(search.toLowerCase()) ||
    a.code?.toLowerCase().includes(search.toLowerCase()) ||
    a.serialNo?.toLowerCase().includes(search.toLowerCase()) ||
    a.plateNumber?.toLowerCase().includes(search.toLowerCase()));

  function openNew() { setEditing(null); setForm(EMPTY); setShowForm(true); }
  function openEdit(a: Asset) {
    setEditing(a);
    setForm({
      code:a.code??"", nameAr:a.nameAr??"", nameEn:a.nameEn??"", status:a.status??"active",
      categoryId:a.categoryId?String(a.categoryId):"", branchId:a.branchId?String(a.branchId):"",
      costCenterId:"",
      purchaseDate:a.purchaseDate??"", purchaseValue:String(a.purchaseValue??"0"),
      supplierName:a.supplierName??"", supplierId:a.supplierId?String(a.supplierId):"",
      invoiceNo:a.invoiceNo??"", paymentMethod:a.paymentMethod??"cash",
      cashBoxId:a.cashBoxId?String(a.cashBoxId):"", bankAccountId:a.bankAccountId?String(a.bankAccountId):"",
      model:a.model??"", brand:a.brand??"", serialNo:a.serialNo??"",
      plateNumber:a.plateNumber??"", color:a.color??"",
      initialKm:a.initialKm?String(a.initialKm):"", currentKm:a.currentKm?String(a.currentKm):"",
      lifeYears:String(a.lifeYears??5), depreciationMethod:a.depreciationMethod??"straight_line",
      scrapValue:String(a.scrapValue??"0"), depreciationStart:a.depreciationStart??"",
      accumulatedDepreciation:String(a.accumulatedDepreciation??"0"),
      bookValue:String(a.bookValue??"0"),
      insuranceCompany:a.insuranceCompany??"", insurancePolicyNo:a.insurancePolicyNo??"",
      insuranceStart:a.insuranceStart??"", insuranceEnd:a.insuranceEnd??"",
      insuranceValue:String(a.insuranceValue??"0"),
      custodianEmployeeId:a.custodianEmployeeId?String(a.custodianEmployeeId):"",
      location:a.location??"", notes:a.notes??"",
    });
    setShowForm(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.nameAr.trim()) throw new Error("اسم الأصل مطلوب");
      const sup = suppliers.find((s: any) => String(s.id) === String(form.supplierId));
      const body: any = { ...form, companyId: cid,
        categoryId: form.categoryId ? Number(form.categoryId) : null,
        branchId:   form.branchId   ? Number(form.branchId)   : null,
        custodianEmployeeId: form.custodianEmployeeId ? Number(form.custodianEmployeeId) : null,
        initialKm:  form.initialKm  ? Number(form.initialKm)  : null,
        currentKm:  form.currentKm  ? Number(form.currentKm)  : null,
        lifeYears:  Number(form.lifeYears || 5),
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
          onClose={()=>{ setShowForm(false); setEditing(null); }}
          onSave={()=>saveMut.mutate()} saving={saveMut.isPending}
          saveLabel="حفظ" cancelLabel="إلغاء"
        >
          <div className="space-y-5">
            <fieldset className="border border-emerald-200 rounded-lg p-4">
              <legend className="px-2 text-sm font-bold text-emerald-700">البيانات الأساسية</legend>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div><Label>الكود</Label>
                  <Input value={form.code} onChange={(e)=>setForm({...form,code:e.target.value})} placeholder="تلقائي AST0001" /></div>
                <div><Label>اسم الأصل (عربي) *</Label>
                  <Input value={form.nameAr} onChange={(e)=>setForm({...form,nameAr:e.target.value})} data-testid="input-nameAr" /></div>
                <div><Label>اسم الأصل (إنجليزي)</Label>
                  <Input value={form.nameEn} onChange={(e)=>setForm({...form,nameEn:e.target.value})} /></div>
                <div><Label>الفئة</Label>
                  <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                    value={form.categoryId} onChange={(e)=>setForm({...form,categoryId:e.target.value})}>
                    <option value="">— بدون —</option>
                    {cats.map(c => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
                  </select></div>
                <div><Label>الحالة</Label>
                  <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                    value={form.status} onChange={(e)=>setForm({...form,status:e.target.value})}>
                    {STATUSES.map(([v,l])=> <option key={v} value={v}>{l}</option>)}
                  </select></div>
                <div><Label>الموقع</Label>
                  <Input value={form.location} onChange={(e)=>setForm({...form,location:e.target.value})} /></div>
              </div>
            </fieldset>

            <fieldset className="border border-blue-200 rounded-lg p-4">
              <legend className="px-2 text-sm font-bold text-blue-700">بيانات الشراء</legend>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div><Label>تاريخ الشراء</Label>
                  <Input type="date" value={form.purchaseDate} onChange={(e)=>setForm({...form,purchaseDate:e.target.value})} /></div>
                <div><Label>قيمة الشراء</Label>
                  <Input type="number" step="0.01" value={form.purchaseValue} onChange={(e)=>setForm({...form,purchaseValue:e.target.value})} /></div>
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

            <fieldset className="border border-amber-200 rounded-lg p-4">
              <legend className="px-2 text-sm font-bold text-amber-700">بيانات فنية / مركبة</legend>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div><Label>الموديل</Label>
                  <Input value={form.model} onChange={(e)=>setForm({...form,model:e.target.value})} placeholder="2023" /></div>
                <div><Label>الماركة</Label>
                  <Input value={form.brand} onChange={(e)=>setForm({...form,brand:e.target.value})} placeholder="Toyota" /></div>
                <div><Label>رقم الشاسيه / المسلسل</Label>
                  <Input value={form.serialNo} onChange={(e)=>setForm({...form,serialNo:e.target.value})} /></div>
                <div><Label>رقم اللوحة</Label>
                  <Input value={form.plateNumber} onChange={(e)=>setForm({...form,plateNumber:e.target.value})} /></div>
                <div><Label>اللون</Label>
                  <Input value={form.color} onChange={(e)=>setForm({...form,color:e.target.value})} /></div>
                <div><Label>كم عند الشراء</Label>
                  <Input type="number" value={form.initialKm} onChange={(e)=>setForm({...form,initialKm:e.target.value})} /></div>
                <div><Label>الكم الحالي</Label>
                  <Input type="number" value={form.currentKm} onChange={(e)=>setForm({...form,currentKm:e.target.value})} /></div>
              </div>
            </fieldset>

            <fieldset className="border border-violet-200 rounded-lg p-4">
              <legend className="px-2 text-sm font-bold text-violet-700">بيانات الإهلاك</legend>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div><Label>العمر الافتراضي (سنوات)</Label>
                  <Input type="number" value={form.lifeYears} onChange={(e)=>setForm({...form,lifeYears:e.target.value})} /></div>
                <div><Label>طريقة الإهلاك</Label>
                  <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                    value={form.depreciationMethod} onChange={(e)=>setForm({...form,depreciationMethod:e.target.value})}>
                    {METHODS.map(([v,l])=> <option key={v} value={v}>{l}</option>)}
                  </select></div>
                <div><Label>قيمة الخردة</Label>
                  <Input type="number" step="0.01" value={form.scrapValue} onChange={(e)=>setForm({...form,scrapValue:e.target.value})} /></div>
                <div><Label>تاريخ بداية الإهلاك</Label>
                  <Input type="date" value={form.depreciationStart} onChange={(e)=>setForm({...form,depreciationStart:e.target.value})} /></div>
                <div><Label>الإهلاك المتراكم</Label>
                  <Input type="number" step="0.01" value={form.accumulatedDepreciation} onChange={(e)=>setForm({...form,accumulatedDepreciation:e.target.value})} /></div>
                <div><Label>القيمة الدفترية</Label>
                  <Input type="number" step="0.01" value={form.bookValue} onChange={(e)=>setForm({...form,bookValue:e.target.value})} /></div>
              </div>
            </fieldset>

            <fieldset className="border border-pink-200 rounded-lg p-4">
              <legend className="px-2 text-sm font-bold text-pink-700">بيانات التأمين</legend>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div><Label>شركة التأمين</Label>
                  <Input value={form.insuranceCompany} onChange={(e)=>setForm({...form,insuranceCompany:e.target.value})} /></div>
                <div><Label>رقم الوثيقة</Label>
                  <Input value={form.insurancePolicyNo} onChange={(e)=>setForm({...form,insurancePolicyNo:e.target.value})} /></div>
                <div><Label>قيمة التأمين</Label>
                  <Input type="number" step="0.01" value={form.insuranceValue} onChange={(e)=>setForm({...form,insuranceValue:e.target.value})} /></div>
                <div><Label>تاريخ البداية</Label>
                  <Input type="date" value={form.insuranceStart} onChange={(e)=>setForm({...form,insuranceStart:e.target.value})} /></div>
                <div><Label>تاريخ الانتهاء</Label>
                  <Input type="date" value={form.insuranceEnd} onChange={(e)=>setForm({...form,insuranceEnd:e.target.value})} /></div>
              </div>
            </fieldset>

            <fieldset className="border border-slate-200 rounded-lg p-4">
              <legend className="px-2 text-sm font-bold text-slate-700">بيانات إضافية</legend>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div><Label>المسؤول عن الأصل (رقم الموظف)</Label>
                  <Input type="number" value={form.custodianEmployeeId} onChange={(e)=>setForm({...form,custodianEmployeeId:e.target.value})} /></div>
                <div><Label>ملاحظات</Label>
                  <Input value={form.notes} onChange={(e)=>setForm({...form,notes:e.target.value})} /></div>
              </div>
            </fieldset>
          </div>
        </FormPanel>
      )}

      <div className="border rounded-lg bg-white overflow-hidden shadow-sm">
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
                  <td className="px-3 py-2 font-mono">{Number(a.purchaseValue).toLocaleString("ar-EG")}</td>
                  <td className="px-3 py-2 font-mono">{Number(a.bookValue).toLocaleString("ar-EG")}</td>
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
