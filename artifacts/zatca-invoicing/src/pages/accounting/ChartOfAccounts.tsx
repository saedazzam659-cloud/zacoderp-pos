import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from "@/components/ui/sheet";
import { SearchCombobox } from "@/components/ui/search-combobox";
import ExportButtons from "@/components/ExportButtons";
import { Plus, Pencil, Trash2, BookOpen, Search, Save, X, ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const ACCOUNT_TYPES = [
  { value: "asset",     label: "أصول",          badgeClass: "bg-blue-50 text-blue-700 border-blue-200" },
  { value: "liability", label: "التزامات",       badgeClass: "bg-red-50 text-red-700 border-red-200" },
  { value: "equity",    label: "حقوق ملكية",     badgeClass: "bg-purple-50 text-purple-700 border-purple-200" },
  { value: "revenue",   label: "إيرادات",        badgeClass: "bg-green-50 text-green-700 border-green-200" },
  { value: "expense",   label: "مصروفات",        badgeClass: "bg-orange-50 text-orange-700 border-orange-200" },
];

const TYPE_MAP = Object.fromEntries(ACCOUNT_TYPES.map(t => [t.value, t]));

const EXPORT_COLS = [
  { key: "code",        header: "كود الحساب",    width: 14 },
  { key: "nameAr",      header: "اسم الحساب",    width: 32 },
  { key: "nameEn",      header: "الاسم (EN)",     width: 32 },
  { key: "accountType", header: "نوع الحساب",    width: 16 },
  { key: "level",       header: "المستوى",        width: 10 },
  { key: "isPosting",   header: "قيد",            width: 10 },
  { key: "isActive",    header: "الحالة",          width: 10 },
];

const REPORT_DIRECTIONS = [
  { value: "",               label: "— تلقائي حسب النوع —" },
  { value: "balance_sheet",  label: "مركز مالي (الميزانية)" },
  { value: "income_statement", label: "قائمة الدخل" },
];

const DEFAULT_DIRECTION: Record<string, string> = {
  asset:     "balance_sheet",
  liability: "balance_sheet",
  equity:    "balance_sheet",
  revenue:   "income_statement",
  expense:   "income_statement",
};

const EMPTY: any = {
  code: "", nameAr: "", nameEn: "", accountType: "asset",
  reportDirection: "", parentId: "", level: 1, isPosting: true, isActive: true, notes: "",
};

export default function ChartOfAccounts() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const [search, setSearch]         = useState("");
  const [filterType, setFilterType] = useState("all");
  const [form, setForm]             = useState<any>(EMPTY);
  const [editId, setEditId]         = useState<number | null>(null);
  const [showForm, setShowForm]     = useState(false);

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const { data: accounts = [], isLoading } = useQuery<any[]>({
    queryKey: ["accounts", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/accounts?companyId=${cid}` : `${API}/api/accounts`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      return res.json();
    },
    enabled: !!user,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["accounts"] });

  const createMut = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch(`${API}/api/accounts`, { method: "POST", headers, body: JSON.stringify(data) });
      const json = await res.json(); if (!res.ok) throw new Error(json.error);
      return json;
    },
    onSuccess: () => { invalidate(); reset(); toast({ title: "تم حفظ الحساب" }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const updateMut = useMutation({
    mutationFn: async ({ id, data }: any) => {
      const res = await fetch(`${API}/api/accounts/${id}`, { method: "PUT", headers, body: JSON.stringify(data) });
      const json = await res.json(); if (!res.ok) throw new Error(json.error);
      return json;
    },
    onSuccess: () => { invalidate(); reset(); toast({ title: "تم التعديل" }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/accounts/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: "تم الحذف" }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  function reset() { setForm(EMPTY); setEditId(null); setShowForm(false); }

  function handleEdit(a: any) {
    setForm({ ...a, parentId: a.parentId ? String(a.parentId) : "", reportDirection: a.reportDirection ?? "" });
    setEditId(a.id);
    setShowForm(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload = { ...form, parentId: form.parentId ? Number(form.parentId) : null, level: Number(form.level) || 1 };
    if (editId) updateMut.mutate({ id: editId, data: payload });
    else        createMut.mutate(payload);
  }

  const filtered = accounts.filter((a: any) => {
    const q = search.toLowerCase();
    const matchText = !search || a.nameAr.includes(search) || a.code.includes(search) || (a.nameEn ?? "").toLowerCase().includes(q);
    const matchType = filterType === "all" || a.accountType === filterType;
    return matchText && matchType;
  });

  const exportRows = filtered.map((a: any) => ({
    code:        a.code,
    nameAr:      a.nameAr,
    nameEn:      a.nameEn ?? "",
    accountType: TYPE_MAP[a.accountType]?.label ?? a.accountType,
    level:       a.level,
    isPosting:   a.isPosting ? "نعم" : "لا",
    isActive:    a.isActive ? "نشط" : "موقوف",
  }));

  const parentItems = [
    { value: "", label: "— بدون حساب رئيسي —" },
    ...accounts.filter((a: any) => a.id !== editId).map((a: any) => ({ value: String(a.id), code: a.code, label: a.nameAr })),
  ];

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BookOpen className="h-6 w-6 text-primary" />شجرة الحسابات
          </h1>
          <p className="text-muted-foreground text-sm mt-1">دليل الحسابات المالية — ربط الحسابات بالأصناف والعملاء والموردين والمخازن</p>
        </div>
        <div className="flex gap-2">
          <ExportButtons rows={exportRows} columns={EXPORT_COLS} filename={`حسابات-${new Date().toISOString().slice(0,10)}`} title="دليل الحسابات" />
          <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
            <Plus className="h-4 w-4" />حساب جديد
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setFilterType("all")}
          className={cn("text-xs rounded-full px-3 py-1 border font-medium transition-colors",
            filterType === "all" ? "bg-primary text-primary-foreground border-primary" : "border-input bg-background hover:bg-muted"
          )}
        >
          الكل ({accounts.length})
        </button>
        {ACCOUNT_TYPES.map(t => {
          const cnt = accounts.filter((a: any) => a.accountType === t.value).length;
          return (
            <button
              key={t.value}
              onClick={() => setFilterType(t.value)}
              className={cn("text-xs rounded-full px-3 py-1 border font-medium transition-colors",
                filterType === t.value ? "bg-primary text-primary-foreground border-primary" : "border-input bg-background hover:bg-muted"
              )}
            >
              {t.label} ({cnt})
            </button>
          );
        })}
      </div>

      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input className="pr-9" placeholder="بحث بالكود أو الاسم..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-28">الكود</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">اسم الحساب</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden md:table-cell">الاسم (EN)</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground w-28">النوع</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground w-20 hidden sm:table-cell">المستوى</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground w-20 hidden sm:table-cell">قيد</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground w-20">الحالة</th>
              <th className="px-4 py-3 w-24 font-semibold text-muted-foreground">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading
              ? [...Array(5)].map((_, i) => <tr key={i}><td colSpan={8} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
              : filtered.length === 0
              ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                    <BookOpen className="h-10 w-10 mx-auto mb-2 opacity-20" />
                    <p className="font-medium">لا توجد حسابات</p>
                    <p className="text-xs mt-1">أضف حسابك الأول لبدء الربط مع الأصناف والعملاء</p>
                  </td>
                </tr>
              )
              : filtered.map((a: any) => {
                  const typeInfo  = TYPE_MAP[a.accountType];
                  const parentAcc = a.parentId ? accounts.find((x: any) => x.id === a.parentId) : null;
                  return (
                    <tr key={a.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs bg-muted px-2 py-0.5 rounded border">{a.code}</span>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium">{a.nameAr}</p>
                        {parentAcc && (
                          <p className="text-[10px] text-muted-foreground flex items-center gap-0.5 mt-0.5">
                            <ChevronLeft className="h-3 w-3" />{parentAcc.code} — {parentAcc.nameAr}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs hidden md:table-cell" dir="ltr">{a.nameEn ?? "—"}</td>
                      <td className="px-4 py-3 text-center">
                        {typeInfo && <span className={cn("text-[10px] font-medium rounded-full px-2 py-0.5 border", typeInfo.badgeClass)}>{typeInfo.label}</span>}
                      </td>
                      <td className="px-4 py-3 text-center text-xs text-muted-foreground hidden sm:table-cell">{a.level}</td>
                      <td className="px-4 py-3 text-center hidden sm:table-cell">
                        {a.isPosting
                          ? <span className="text-[10px] bg-green-50 text-green-700 border border-green-200 rounded-full px-2 py-0.5">قيد</span>
                          : <span className="text-[10px] bg-muted text-muted-foreground border rounded-full px-2 py-0.5">رأسي</span>}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {a.isActive
                          ? <span className="text-[10px] bg-green-50 text-green-700 border border-green-200 rounded-full px-2 py-0.5">نشط</span>
                          : <span className="text-[10px] bg-red-50 text-red-700 border border-red-200 rounded-full px-2 py-0.5">موقوف</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleEdit(a)}><Pencil className="h-3.5 w-3.5" /></Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive"
                            onClick={() => { if (confirm("حذف هذا الحساب؟")) deleteMut.mutate(a.id); }}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
          </tbody>
        </table>
        {!isLoading && <div className="px-4 py-2 border-t bg-muted/20 text-xs text-muted-foreground">{filtered.length} حساب</div>}
      </div>

      <Sheet open={showForm} onOpenChange={v => { if (!v) reset(); }}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto" dir="rtl">
          <SheetHeader className="border-b pb-4 mb-5">
            <SheetTitle className="flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-primary" />
              {editId ? "تعديل حساب" : "إضافة حساب جديد"}
            </SheetTitle>
          </SheetHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label>كود الحساب <span className="text-destructive">*</span></Label>
              <Input placeholder="1101" value={form.code} onChange={e => setForm((p: any) => ({ ...p, code: e.target.value }))} required />
            </div>
            <div className="space-y-1.5">
              <Label>اسم الحساب (عربي) <span className="text-destructive">*</span></Label>
              <Input placeholder="الصندوق" value={form.nameAr} onChange={e => setForm((p: any) => ({ ...p, nameAr: e.target.value }))} required />
            </div>
            <div className="space-y-1.5">
              <Label>اسم الحساب (إنجليزي)</Label>
              <Input placeholder="Cash" dir="ltr" value={form.nameEn} onChange={e => setForm((p: any) => ({ ...p, nameEn: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>نوع الحساب <span className="text-destructive">*</span></Label>
              <SearchCombobox
                items={ACCOUNT_TYPES.map(t => ({ value: t.value, label: t.label, badge: t.label, badgeClass: t.badgeClass }))}
                value={form.accountType}
                onValueChange={v => setForm((p: any) => ({ ...p, accountType: v, reportDirection: p.reportDirection || "" }))}
                placeholder="نوع الحساب"
              />
            </div>
            <div className="space-y-1.5">
              <Label>توجيه الحساب في التقارير</Label>
              <SearchCombobox
                items={REPORT_DIRECTIONS.map(d => ({ value: d.value, label: d.label }))}
                value={form.reportDirection ?? ""}
                onValueChange={v => setForm((p: any) => ({ ...p, reportDirection: v }))}
                placeholder={`تلقائي: ${DEFAULT_DIRECTION[form.accountType] === "balance_sheet" ? "مركز مالي" : "قائمة دخل"}`}
              />
            </div>
            <div className="space-y-1.5">
              <Label>الحساب الرئيسي</Label>
              <SearchCombobox
                items={parentItems}
                value={form.parentId}
                onValueChange={v => setForm((p: any) => ({ ...p, parentId: v }))}
                placeholder="— بدون رئيسي —"
                searchPlaceholder="ابحث..."
              />
            </div>
            <div className="space-y-1.5">
              <Label>المستوى</Label>
              <Input type="number" min="1" max="10" value={form.level} onChange={e => setForm((p: any) => ({ ...p, level: Number(e.target.value) }))} />
            </div>
            <div className="space-y-1.5">
              <Label>ملاحظات</Label>
              <Input placeholder="ملاحظات اختيارية" value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} />
            </div>
            <div className="space-y-3 pt-1">
              <div className="flex items-center gap-2">
                <Switch id="is-posting" checked={form.isPosting} onCheckedChange={v => setForm((p: any) => ({ ...p, isPosting: v }))} />
                <Label htmlFor="is-posting" className="cursor-pointer">حساب قيد (يقبل حركات)</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch id="is-active" checked={form.isActive} onCheckedChange={v => setForm((p: any) => ({ ...p, isActive: v }))} />
                <Label htmlFor="is-active" className="cursor-pointer">نشط</Label>
              </div>
            </div>
            <SheetFooter className="flex gap-2 pt-4 border-t">
              <Button type="button" variant="outline" className="gap-1" onClick={reset}><X className="h-4 w-4" />إلغاء</Button>
              <Button type="submit" className="gap-1 flex-1" disabled={createMut.isPending || updateMut.isPending}>
                <Save className="h-4 w-4" />{editId ? "حفظ التعديل" : "إضافة الحساب"}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </div>
  );
}
