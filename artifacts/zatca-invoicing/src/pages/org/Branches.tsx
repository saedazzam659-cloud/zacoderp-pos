import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { branchesApi } from "@/lib/branchesApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Pencil, Trash2, Building2, Search, X,
  MapPin, Phone, Mail, Star, CheckCircle2, XCircle, ArrowRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Link, useSearch } from "wouter";

const EMPTY_BRANCH = {
  code: "", nameAr: "", nameEn: "", regionId: "", city: "",
  address: "", phone: "", email: "", isMain: false, status: "active", notes: "",
};

const STATUS_CFG: Record<string, { label: string; cls: string }> = {
  active:   { label: "نشط",   cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  inactive: { label: "موقوف", cls: "bg-red-50 text-red-600 border-red-200" },
};

export default function Branches() {
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const qc = useQueryClient();
  const { toast } = useToast();
  const search = useSearch();

  const [textSearch, setTextSearch]   = useState("");
  const [regionFilter, setRegionFilter] = useState("");
  const [form, setForm]               = useState<any>(EMPTY_BRANCH);
  const [editId, setEditId]           = useState<number | null>(null);
  const [showForm, setShowForm]       = useState(false);
  const [activeTab, setActiveTab]     = useState("basic");

  // Pre-select region from URL param (?region=X)
  useEffect(() => {
    const params = new URLSearchParams(search);
    const rid = params.get("region");
    if (rid) {
      setRegionFilter(rid);
      setForm((p: any) => ({ ...p, regionId: rid }));
      setShowForm(true);
    }
  }, [search]);

  const { data: regions = [] } = useQuery({
    queryKey: ["regions", cid],
    queryFn:  () => branchesApi.getRegions(cid),
  });

  const { data: branches = [], isLoading } = useQuery({
    queryKey: ["branches", cid],
    queryFn:  () => branchesApi.getBranches(cid),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["branches"] });
    qc.invalidateQueries({ queryKey: ["regions"] });
  };

  const createMut = useMutation({ mutationFn: branchesApi.createBranch, onSuccess: () => { invalidate(); reset(); toast({ title: "تم إضافة الفرع" }); } });
  const updateMut = useMutation({ mutationFn: ({ id, data }: any) => branchesApi.updateBranch(id, data), onSuccess: () => { invalidate(); reset(); toast({ title: "تم تعديل الفرع" }); } });
  const deleteMut = useMutation({ mutationFn: branchesApi.deleteBranch, onSuccess: () => { invalidate(); toast({ title: "تم الحذف" }); } });

  function reset() {
    setForm(EMPTY_BRANCH); setEditId(null); setShowForm(false); setActiveTab("basic");
  }
  function handleEdit(b: any) {
    setForm({ ...b, regionId: b.regionId ? String(b.regionId) : "" });
    setEditId(b.id); setShowForm(true); setActiveTab("basic");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload = {
      ...form,
      regionId: form.regionId ? Number(form.regionId) : null,
      companyId: cid,
    };
    if (editId) updateMut.mutate({ id: editId, data: payload });
    else        createMut.mutate(payload);
  }

  const regionMap: Record<number, any> = {};
  for (const r of regions as any[]) regionMap[r.id] = r;

  const filtered = (branches as any[]).filter(b => {
    const matchRegion = !regionFilter || String(b.regionId) === regionFilter;
    const matchText   = !textSearch
      || b.nameAr.includes(textSearch)
      || b.code.includes(textSearch)
      || (b.city ?? "").includes(textSearch);
    return matchRegion && matchText;
  });

  return (
    <div className="space-y-6" dir="rtl">
      {/* ── Page Header ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Building2 className="h-6 w-6 text-primary" />الفروع
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            إدارة جميع الفروع وتوزيعها على المناطق الجغرافية
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/org/regions">
            <Button variant="outline" size="sm" className="gap-2">
              <MapPin className="h-4 w-4" />المناطق
            </Button>
          </Link>
          <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
            <Plus className="h-4 w-4" />إضافة فرع
          </Button>
        </div>
      </div>

      {/* ── Form Card ───────────────────────────────────────────── */}
      {showForm && (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b bg-muted/30">
            <div className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-primary" />
              <h2 className="font-semibold">{editId ? "تعديل فرع" : "فرع جديد"}</h2>
              {form.regionId && (
                <span className="text-xs bg-blue-100 text-blue-700 rounded-full px-2 py-0.5 flex items-center gap-1">
                  <MapPin className="h-3 w-3" />
                  {regionMap[Number(form.regionId)]?.nameAr ?? "منطقة"}
                </span>
              )}
            </div>
            <Button variant="ghost" size="icon" onClick={reset}><X className="h-4 w-4" /></Button>
          </div>
          <form onSubmit={handleSubmit} className="p-5">
            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
              <div className="flex items-center justify-between mb-4">
                <span className="text-xs text-muted-foreground">اختر التبويب لتعبئة البيانات</span>
                <TabsList className="h-9">
                  <TabsTrigger value="basic"   className="text-xs gap-1.5 px-3"><Building2 className="h-3.5 w-3.5" />البيانات الأساسية</TabsTrigger>
                  <TabsTrigger value="contact" className="text-xs gap-1.5 px-3"><Phone     className="h-3.5 w-3.5" />الموقع والتواصل</TabsTrigger>
                </TabsList>
              </div>

              {/* Tab 1 — البيانات الأساسية */}
              <TabsContent value="basic" className="mt-0">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  <div className="space-y-1.5">
                    <Label>كود الفرع *</Label>
                    <Input placeholder="BR-01" value={form.code} onChange={e => setForm((p: any) => ({ ...p, code: e.target.value }))} required />
                  </div>
                  <div className="space-y-1.5">
                    <Label>الاسم بالعربي *</Label>
                    <Input placeholder="الفرع الرئيسي" value={form.nameAr} onChange={e => setForm((p: any) => ({ ...p, nameAr: e.target.value }))} required />
                  </div>
                  <div className="space-y-1.5">
                    <Label>الاسم بالإنجليزي</Label>
                    <Input placeholder="Main Branch" value={form.nameEn} onChange={e => setForm((p: any) => ({ ...p, nameEn: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>المنطقة</Label>
                    <SearchCombobox
                      items={[
                        { value: "", label: "— بدون منطقة —" },
                        ...(regions as any[]).map((r: any) => ({ value: String(r.id), code: r.code, label: r.nameAr, labelEn: r.nameEn })),
                      ]}
                      value={form.regionId}
                      onValueChange={v => setForm((p: any) => ({ ...p, regionId: v }))}
                      placeholder="— اختر المنطقة —"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>الحالة</Label>
                    <SearchCombobox
                      items={[{ value: "active", label: "نشط" }, { value: "inactive", label: "موقوف" }]}
                      value={form.status}
                      onValueChange={v => setForm((p: any) => ({ ...p, status: v }))}
                      placeholder="الحالة"
                    />
                  </div>
                  <div className="space-y-1.5 flex items-center gap-3 pt-4">
                    <Switch
                      checked={form.isMain}
                      onCheckedChange={v => setForm((p: any) => ({ ...p, isMain: v }))}
                      id="is-main"
                    />
                    <div>
                      <Label htmlFor="is-main" className="flex items-center gap-1">
                        <Star className="h-3.5 w-3.5 text-amber-500" />الفرع الرئيسي
                      </Label>
                      <p className="text-[10px] text-muted-foreground">يُلغي الرئيسي من بقية الفروع تلقائياً</p>
                    </div>
                  </div>
                </div>
              </TabsContent>

              {/* Tab 2 — الموقع والتواصل */}
              <TabsContent value="contact" className="mt-0">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>المدينة</Label>
                    <Input placeholder="الرياض" value={form.city} onChange={e => setForm((p: any) => ({ ...p, city: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>رقم الهاتف</Label>
                    <Input placeholder="0512345678" value={form.phone} onChange={e => setForm((p: any) => ({ ...p, phone: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>البريد الإلكتروني</Label>
                    <Input type="email" placeholder="branch@company.com" value={form.email} onChange={e => setForm((p: any) => ({ ...p, email: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>ملاحظات</Label>
                    <Input placeholder="ملاحظات اختيارية" value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label>العنوان التفصيلي</Label>
                    <Input placeholder="شارع الملك عبدالعزيز، حي العليا" value={form.address} onChange={e => setForm((p: any) => ({ ...p, address: e.target.value }))} />
                  </div>
                </div>
              </TabsContent>
            </Tabs>

            <div className="flex gap-2 justify-end pt-4 mt-4 border-t">
              <Button type="button" variant="outline" onClick={reset}>إلغاء</Button>
              <Button type="submit" disabled={createMut.isPending || updateMut.isPending}>
                {editId ? "حفظ التعديل" : "إضافة الفرع"}
              </Button>
            </div>
          </form>
        </div>
      )}

      {/* ── Filter Bar ──────────────────────────────────────────── */}
      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pr-9" placeholder="بحث بالاسم أو الكود أو المدينة..." value={textSearch} onChange={e => setTextSearch(e.target.value)} />
        </div>
        <div className="w-52">
          <SearchCombobox
            items={[
              { value: "", label: "جميع المناطق" },
              ...(regions as any[]).map((r: any) => ({ value: String(r.id), code: r.code, label: r.nameAr })),
            ]}
            value={regionFilter}
            onValueChange={setRegionFilter}
            placeholder="فلتر بالمنطقة"
          />
        </div>
      </div>

      {/* ── Branches Table ──────────────────────────────────────── */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-28">الكود</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">الفرع</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">المنطقة</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden md:table-cell">المدينة</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden lg:table-cell">الهاتف</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground w-20">رئيسي</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground w-24">الحالة</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-24">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading
              ? [...Array(4)].map((_, i) => (
                  <tr key={i}><td colSpan={8} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>
                ))
              : filtered.length === 0
              ? (
                  <tr>
                    <td colSpan={8} className="py-14 text-center text-muted-foreground">
                      <Building2 className="h-10 w-10 mx-auto mb-3 opacity-20" />
                      <p className="font-medium">لا توجد فروع{regionFilter ? " في هذه المنطقة" : ""}</p>
                      <Button size="sm" className="mt-4 gap-1" onClick={() => { reset(); setShowForm(true); }}>
                        <Plus className="h-4 w-4" />إضافة فرع
                      </Button>
                    </td>
                  </tr>
                )
              : filtered.map((b: any) => {
                  const st  = STATUS_CFG[b.status] ?? STATUS_CFG.active;
                  const rgn = b.regionId ? regionMap[b.regionId] : null;
                  return (
                    <tr key={b.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs bg-muted px-2 py-0.5 rounded font-medium">{b.code}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {b.isMain && <Star className="h-3.5 w-3.5 text-amber-500 shrink-0" title="الفرع الرئيسي" />}
                          <div>
                            <p className="font-medium">{b.nameAr}</p>
                            {b.nameEn && <p className="text-xs text-muted-foreground">{b.nameEn}</p>}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell">
                        {rgn
                          ? <span className="flex items-center gap-1 text-xs text-blue-700 bg-blue-50 rounded-full px-2 py-0.5 w-fit border border-blue-200">
                              <MapPin className="h-3 w-3" />{rgn.nameAr}
                            </span>
                          : <span className="text-muted-foreground/40 text-xs">—</span>}
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell text-muted-foreground text-sm">{b.city ?? "—"}</td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        {b.phone
                          ? <span className="flex items-center gap-1 text-xs text-muted-foreground"><Phone className="h-3 w-3" />{b.phone}</span>
                          : <span className="text-muted-foreground/40 text-xs">—</span>}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {b.isMain
                          ? <CheckCircle2 className="h-4 w-4 text-amber-500 mx-auto" />
                          : <span className="text-muted-foreground/20 text-xs">—</span>}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={cn("text-[10px] font-medium rounded-full px-2.5 py-0.5 border", st.cls)}>
                          {st.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-primary/10 hover:text-primary" onClick={() => handleEdit(b)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost" size="icon"
                            className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={() => { if (confirm(`حذف فرع "${b.nameAr}"؟`)) deleteMut.mutate(b.id); }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
          </tbody>
        </table>
        {!isLoading && (
          <div className="px-4 py-2 border-t bg-muted/20 flex items-center justify-between text-xs text-muted-foreground">
            <span>{filtered.length} فرع</span>
            {regionFilter && (
              <button
                onClick={() => setRegionFilter("")}
                className="flex items-center gap-1 hover:text-foreground transition-colors"
              >
                <X className="h-3 w-3" />إزالة فلتر المنطقة
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
