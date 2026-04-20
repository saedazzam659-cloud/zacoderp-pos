import { useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Plus, Search, Truck, Phone, Mail, MapPin, BadgeCheck, Building2, Package,
  Pencil, Trash2, Save, X, TrendingUp, TrendingDown, Minus,
} from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import ExportButtons from "@/components/ExportButtons";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter,
} from "@/components/ui/sheet";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";

const SUPPLIER_EXPORT_COLS = [
  { key: "nameAr",     header: "الاسم (عربي)",        width: 28 },
  { key: "nameEn",     header: "الاسم (إنجليزي)",     width: 28 },
  { key: "vatNumber",  header: "الرقم الضريبي",       width: 20 },
  { key: "crNumber",   header: "السجل التجاري",       width: 18 },
  { key: "phone",      header: "الهاتف",              width: 18 },
  { key: "email",      header: "البريد الإلكتروني",  width: 28 },
  { key: "city",       header: "المدينة",             width: 16 },
  { key: "balance",    header: "الرصيد",              width: 16 },
];

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const TYPE_TABS = [
  { key: "all",     label: "الكل" },
  { key: "withVat", label: "مسجّلو الضريبة" },
  { key: "noVat",   label: "غير مسجّلين" },
];

const EMPTY_FORM = {
  nameAr: "", nameEn: "", vatNumber: "", crNumber: "",
  email: "", phone: "", city: "", district: "",
  street: "", buildingNumber: "", postalCode: "", country: "SA",
};

export default function Suppliers() {
  const { user, token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [search,    setSearch]    = useState("");
  const [activeTab, setActiveTab] = useState("all");
  const [editSup,   setEditSup]   = useState<any>(null);
  const [editForm,  setEditForm]  = useState<typeof EMPTY_FORM>(EMPTY_FORM);
  const [deleteSup, setDeleteSup] = useState<any>(null);

  const headers = { Authorization: `Bearer ${token}` };

  const { data: suppliers = [], isLoading } = useQuery({
    queryKey: ["suppliers", user?.companyId],
    queryFn: async () => {
      const url = user?.companyId
        ? `${API}/api/suppliers?companyId=${user.companyId}`
        : `${API}/api/suppliers`;
      const res = await fetch(url, { headers });
      return res.json();
    },
    enabled: !!user,
  });

  const { data: balances = [] } = useQuery({
    queryKey: ["supplier-balances", user?.companyId],
    queryFn: async () => {
      const res = await fetch(
        `${API}/api/suppliers/balances?companyId=${user!.companyId}`,
        { headers }
      );
      return res.json();
    },
    enabled: !!user?.companyId,
  });

  const balanceMap: Record<number, number> = Object.fromEntries(
    (balances as any[]).map((b: any) => [b.supplierId, b.balance])
  );

  const filtered = suppliers.filter((s: any) => {
    const matchSearch =
      s.nameAr?.includes(search) ||
      s.nameEn?.toLowerCase().includes(search.toLowerCase()) ||
      s.vatNumber?.includes(search) ||
      s.city?.includes(search) ||
      s.email?.includes(search);
    const matchTab =
      activeTab === "all" ||
      (activeTab === "withVat" && s.vatNumber) ||
      (activeTab === "noVat"   && !s.vatNumber);
    return matchSearch && matchTab;
  });

  const withVat = suppliers.filter((s: any) => s.vatNumber).length;

  function openEdit(sup: any) {
    setEditSup(sup);
    setEditForm({
      nameAr:         sup.nameAr         ?? "",
      nameEn:         sup.nameEn         ?? "",
      vatNumber:      sup.vatNumber      ?? "",
      crNumber:       sup.crNumber       ?? "",
      email:          sup.email          ?? "",
      phone:          sup.phone          ?? "",
      city:           sup.city           ?? "",
      district:       sup.district       ?? "",
      street:         sup.street         ?? "",
      buildingNumber: sup.buildingNumber ?? "",
      postalCode:     sup.postalCode     ?? "",
      country:        sup.country        ?? "SA",
    });
  }

  const updateMutation = useMutation({
    mutationFn: async (values: typeof EMPTY_FORM) => {
      const res = await fetch(`${API}/api/suppliers/${editSup.id}`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!res.ok) throw new Error("فشل التحديث");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "تم تحديث بيانات المورد" });
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      setEditSup(null);
    },
    onError: () => toast({ title: "حدث خطأ أثناء التحديث", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/suppliers/${id}`, {
        method: "DELETE", headers,
      });
      if (!res.ok) throw new Error("فشل الحذف");
    },
    onSuccess: () => {
      toast({ title: "تم حذف المورد" });
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      qc.invalidateQueries({ queryKey: ["supplier-balances"] });
      setDeleteSup(null);
    },
    onError: () => toast({ title: "تعذّر الحذف — قد يكون مرتبطاً بفواتير", variant: "destructive" }),
  });

  function BalanceBadge({ supplierId }: { supplierId: number }) {
    const bal = balanceMap[supplierId] ?? 0;
    if (bal === 0) return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Minus className="h-3 w-3" />—
      </span>
    );
    if (bal > 0) return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200 whitespace-nowrap" dir="ltr">
        <TrendingUp className="h-3 w-3 shrink-0" />
        {bal.toLocaleString("ar-SA-u-nu-latn", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} مدين
      </span>
    );
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full border border-green-200 whitespace-nowrap" dir="ltr">
        <TrendingDown className="h-3 w-3 shrink-0" />
        {Math.abs(bal).toLocaleString("ar-SA-u-nu-latn", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} دائن
      </span>
    );
  }

  function Field({ label, name, placeholder, dir: d }: { label: string; name: keyof typeof EMPTY_FORM; placeholder?: string; dir?: string }) {
    return (
      <div className="space-y-1.5">
        <label className="text-sm font-medium">{label}</label>
        <Input
          placeholder={placeholder}
          dir={d}
          className={d === "ltr" ? "text-left font-mono" : undefined}
          value={(editForm as any)[name]}
          onChange={e => setEditForm(f => ({ ...f, [name]: e.target.value }))}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6" dir="rtl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Truck className="h-6 w-6 text-primary" />الموردون
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">إدارة بيانات الموردين والموزعين</p>
        </div>
        <div className="flex items-center gap-2">
          <ExportButtons
            rows={filtered.map((s: any) => ({
              nameAr:     s.nameAr     ?? "",
              nameEn:     s.nameEn     ?? "",
              vatNumber:  s.vatNumber  ?? "",
              crNumber:   s.crNumber   ?? "",
              phone:      s.phone      ?? "",
              email:      s.email      ?? "",
              city:       s.city       ?? "",
              balance:    (balanceMap[s.id] ?? 0).toFixed(2),
            }))}
            columns={SUPPLIER_EXPORT_COLS}
            filename={`موردون-${new Date().toISOString().slice(0, 10)}`}
            title="قائمة الموردين"
            subtitle={`نظام الفاتورة الإلكترونية — ${new Date().toLocaleDateString("ar-SA-u-nu-latn")}`}
          />
          <Button asChild className="gap-2">
            <Link href="/suppliers/new"><Plus className="h-4 w-4" />إضافة مورد</Link>
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-card p-4 flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Truck className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="text-2xl font-bold">{isLoading ? "—" : suppliers.length}</p>
            <p className="text-xs text-muted-foreground">إجمالي الموردين</p>
          </div>
        </div>
        <div className="rounded-xl border bg-card p-4 flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-green-100 flex items-center justify-center shrink-0">
            <BadgeCheck className="h-5 w-5 text-green-600" />
          </div>
          <div>
            <p className="text-2xl font-bold">{isLoading ? "—" : withVat}</p>
            <p className="text-xs text-muted-foreground">مسجّلو ضريبة</p>
          </div>
        </div>
        <div className="rounded-xl border bg-card p-4 flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
            <Package className="h-5 w-5 text-amber-600" />
          </div>
          <div>
            <p className="text-2xl font-bold">{isLoading ? "—" : suppliers.length - withVat}</p>
            <p className="text-xs text-muted-foreground">غير مسجّلين</p>
          </div>
        </div>
      </div>

      {/* Table card */}
      <div className="rounded-xl border bg-card overflow-hidden">
        {/* Tabs + Search */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b">
          <div className="flex overflow-x-auto">
            {TYPE_TABS.map(tab => (
              <button key={tab.key} onClick={() => setActiveTab(tab.key)}
                className={`px-5 py-3.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px ${
                  activeTab === tab.key
                    ? "border-primary text-primary bg-primary/5"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40"
                }`}>
                {tab.label}
                {!isLoading && (
                  <span className="mr-1.5 text-xs bg-muted px-1.5 py-0.5 rounded-full">
                    {tab.key === "all" ? suppliers.length : tab.key === "withVat" ? withVat : suppliers.length - withVat}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="relative px-4 py-3">
            <Search className="absolute right-7 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="بحث بالاسم أو الرقم الضريبي..."
              className="pl-4 pr-10 w-full sm:w-64 h-9"
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/20">
                <th className="h-10 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide">المورد</th>
                <th className="h-10 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide hidden sm:table-cell">الرقم الضريبي</th>
                <th className="h-10 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide hidden md:table-cell">المدينة</th>
                <th className="h-10 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide hidden lg:table-cell">الهاتف / البريد</th>
                <th className="h-10 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide hidden md:table-cell">الفئة</th>
                <th className="h-10 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide">حالة الضريبة</th>
                <th className="h-10 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide hidden sm:table-cell">الرصيد</th>
                <th className="h-10 px-4 text-center font-medium text-muted-foreground text-xs tracking-wide w-20">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b">
                    {Array.from({ length: 8 }).map((_, j) => (
                      <td key={j} className="px-5 py-4"><Skeleton className="h-4 w-full max-w-32" /></td>
                    ))}
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-16 text-center text-muted-foreground">
                    <Truck className="h-10 w-10 mx-auto mb-3 opacity-30" />
                    <p className="text-sm">{search ? "لا توجد نتائج مطابقة" : "لا يوجد موردون بعد"}</p>
                    {!search && (
                      <Button asChild variant="outline" size="sm" className="mt-4 gap-2">
                        <Link href="/suppliers/new"><Plus className="h-3.5 w-3.5" />إضافة مورد</Link>
                      </Button>
                    )}
                  </td>
                </tr>
              ) : (
                filtered.map((supplier: any) => (
                  <tr key={supplier.id}
                    className="border-b transition-colors hover:bg-muted/30 cursor-pointer group">
                    {/* Name — double-click to edit */}
                    <td className="px-5 py-3.5"
                      onDoubleClick={() => openEdit(supplier)}
                      title="انقر مرتين للتعديل">
                      <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary font-bold text-sm flex items-center justify-center shrink-0">
                          {supplier.nameAr?.[0] ?? "م"}
                        </div>
                        <div>
                          <p className="font-medium text-foreground group-hover:text-primary transition-colors">
                            {supplier.nameAr}
                          </p>
                          {supplier.nameEn && <p className="text-xs text-muted-foreground">{supplier.nameEn}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 hidden sm:table-cell">
                      {supplier.vatNumber
                        ? <span className="font-mono text-xs text-foreground flex items-center gap-1"><BadgeCheck className="h-3.5 w-3.5 text-green-600" />{supplier.vatNumber}</span>
                        : <span className="text-muted-foreground/50 text-xs">—</span>}
                    </td>
                    <td className="px-5 py-3.5 hidden md:table-cell text-sm text-muted-foreground">
                      {supplier.city
                        ? <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5 shrink-0" />{supplier.city}</span>
                        : "—"}
                    </td>
                    <td className="px-5 py-3.5 hidden lg:table-cell">
                      <div className="space-y-0.5">
                        {supplier.phone && <p className="text-xs text-muted-foreground flex items-center gap-1" dir="ltr"><Phone className="h-3 w-3" />{supplier.phone}</p>}
                        {supplier.email && <p className="text-xs text-muted-foreground flex items-center gap-1"><Mail className="h-3 w-3" />{supplier.email}</p>}
                        {!supplier.phone && !supplier.email && <span className="text-muted-foreground/50 text-xs">—</span>}
                      </div>
                    </td>
                    <td className="px-5 py-3.5 hidden md:table-cell text-xs text-muted-foreground">
                      {supplier.category || "—"}
                    </td>
                    <td className="px-5 py-3.5">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${
                        supplier.vatNumber
                          ? "bg-green-50 text-green-700 border-green-200"
                          : "bg-amber-50 text-amber-700 border-amber-200"
                      }`}>
                        {supplier.vatNumber
                          ? <><BadgeCheck className="h-3 w-3" />مسجّل</>
                          : <><Building2 className="h-3 w-3" />غير مسجّل</>}
                      </span>
                    </td>
                    {/* Balance column */}
                    <td className="px-5 py-3.5 hidden sm:table-cell">
                      <BalanceBadge supplierId={supplier.id} />
                    </td>
                    {/* Actions */}
                    <td className="px-4 py-3.5 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={e => { e.stopPropagation(); openEdit(supplier); }}
                          className="p-1.5 rounded-md hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"
                          title="تعديل">
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); setDeleteSup(supplier); }}
                          className="p-1.5 rounded-md hover:bg-red-50 text-muted-foreground hover:text-red-600 transition-colors"
                          title="حذف">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        {!isLoading && filtered.length > 0 && (
          <div className="border-t bg-muted/20 px-5 py-2.5 text-xs text-muted-foreground">
            عدد النتائج: <strong>{filtered.length}</strong>
          </div>
        )}
      </div>

      {/* ────────── Edit Sheet (slide-in from right) ────────── */}
      <Sheet open={!!editSup} onOpenChange={open => { if (!open) setEditSup(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto" dir="rtl">
          <SheetHeader className="border-b pb-4 mb-5">
            <SheetTitle className="flex items-center gap-2 text-base">
              <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary font-bold text-sm flex items-center justify-center shrink-0">
                {editSup?.nameAr?.[0] ?? "م"}
              </div>
              <div>
                <p className="font-semibold">{editSup?.nameAr}</p>
                <p className="text-xs text-muted-foreground font-normal">تعديل بيانات المورد</p>
              </div>
            </SheetTitle>
          </SheetHeader>

          <div className="space-y-6 pb-6">
            {/* Identity */}
            <div className="space-y-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5 border-b pb-2">
                <Truck className="h-3.5 w-3.5" />بيانات الهوية التجارية
              </p>
              <Field label="اسم المورد (عربي) *" name="nameAr" placeholder="شركة التوريدات الوطنية" />
              <Field label="الاسم (إنجليزي)" name="nameEn" placeholder="National Supply Co." dir="ltr" />
              <div className="grid grid-cols-2 gap-3">
                <Field label="الرقم الضريبي" name="vatNumber" placeholder="310000000000003" dir="ltr" />
                <Field label="السجل التجاري" name="crNumber" placeholder="1010000001" dir="ltr" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="البريد الإلكتروني" name="email" placeholder="info@supplier.com" dir="ltr" />
                <Field label="الهاتف" name="phone" placeholder="0500000000" dir="ltr" />
              </div>
            </div>

            {/* Address */}
            <div className="space-y-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5 border-b pb-2">
                <MapPin className="h-3.5 w-3.5" />العنوان الوطني
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="اسم الشارع" name="street" placeholder="شارع الملك فهد" />
                <Field label="رقم المبنى" name="buildingNumber" placeholder="1234" dir="ltr" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="الحي / المنطقة" name="district" placeholder="حي العليا" />
                <Field label="المدينة" name="city" placeholder="الرياض" />
              </div>
              <Field label="الرمز البريدي" name="postalCode" placeholder="12345" dir="ltr" />
            </div>
          </div>

          <SheetFooter className="border-t pt-4 flex flex-row gap-2 justify-end">
            <Button variant="outline" onClick={() => setEditSup(null)}>
              <X className="h-4 w-4 ml-1" />إلغاء
            </Button>
            <Button
              onClick={() => updateMutation.mutate(editForm)}
              disabled={updateMutation.isPending || !editForm.nameAr.trim()}>
              <Save className="h-4 w-4 ml-1" />
              {updateMutation.isPending ? "جاري الحفظ..." : "حفظ التعديلات"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* ────────── Delete Confirm ────────── */}
      <AlertDialog open={!!deleteSup} onOpenChange={open => { if (!open) setDeleteSup(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-destructive" />حذف المورد
            </AlertDialogTitle>
            <AlertDialogDescription>
              هل أنت متأكد من حذف المورد <strong>{deleteSup?.nameAr}</strong>؟
              لا يمكن التراجع عن هذا الإجراء. إذا كان المورد مرتبطاً بفواتير لن يتم حذفه.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => deleteMutation.mutate(deleteSup.id)}
              disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? "جاري الحذف..." : "تأكيد الحذف"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
