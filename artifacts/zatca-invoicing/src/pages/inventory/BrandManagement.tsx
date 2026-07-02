import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { parseError } from "@/lib/parseError";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { TablePagination, usePagination } from "@/components/TablePagination";
import { Plus, Pencil, Trash2, Bookmark, Search, Info } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// العلامة التجارية (Brand) master data. A brand is a PRINT-ONLY concept on
// sales invoices — the per-brand price / cost / barcode / part-number live on
// the item↔brand links (managed from the Items screen). Nothing here ever
// touches the ZATCA UBL XML, hash, QR, or ICV/PIH chain.
const EMPTY = {
  code: "", nameAr: "", nameEn: "",
  manufacturerName: "", supplierName: "", countryOfOrigin: "",
  status: "active", notes: "",
};

export default function BrandManagement() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const pickName = (ar?: string | null, en?: string | null) => isRtl ? (ar ?? en ?? "") : (en ?? ar ?? "");

  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<any>(EMPTY);
  const [editId, setEditId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [activeTab, setActiveTab] = useState("basic");

  const { data = [], isLoading } = useQuery({
    queryKey: ["brands", cid],
    queryFn: () => inventoryApi.getBrands(cid),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["brands"] });
  const errToast = (title: string) => (e: any) => toast({ title, description: parseError(e), variant: "destructive" });
  const createMut = useMutation({ mutationFn: inventoryApi.createBrand, onSuccess: () => { invalidate(); reset(); toast({ title: t("common.saved", { defaultValue: "تم الحفظ" }) as string }); }, onError: errToast("تعذّر الحفظ") });
  const updateMut = useMutation({ mutationFn: ({ id, data }: any) => inventoryApi.updateBrand(id, data), onSuccess: () => { invalidate(); reset(); toast({ title: t("common.saved", { defaultValue: "تم الحفظ" }) as string }); }, onError: errToast("تعذّر الحفظ") });
  const deleteMut = useMutation({ mutationFn: inventoryApi.deleteBrand, onSuccess: () => { invalidate(); toast({ title: "تم الحذف" }); }, onError: errToast("تعذّر الحذف") });

  function reset() { setForm(EMPTY); setEditId(null); setShowForm(false); setActiveTab("basic"); }
  function handleEdit(b: any) {
    setForm({
      ...EMPTY,
      ...b,
      nameEn:           b.nameEn           ?? "",
      manufacturerName: b.manufacturerName ?? "",
      supplierName:     b.supplierName     ?? "",
      countryOfOrigin:  b.countryOfOrigin  ?? "",
      status:           b.status           ?? "active",
      notes:            b.notes            ?? "",
    });
    setEditId(b.id);
    setShowForm(true);
  }
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (editId) updateMut.mutate({ id: editId, data: form });
    else        createMut.mutate(form);
  }

  const filtered = data.filter((b: any) =>
    b.nameAr.includes(search) || b.code.includes(search) || (b.nameEn ?? "").toLowerCase().includes(search.toLowerCase())
  );

  const pager = usePagination(filtered);

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Bookmark className="h-6 w-6 text-primary" />العلامات التجارية</h1>
          <p className="text-muted-foreground text-sm mt-1">إدارة العلامات التجارية — الصنف الواحد قد يحمل عدة علامات تجارية بأسعار وباركود وأرقام قطع مختلفة.</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
          <Plus className="h-4 w-4" />علامة تجارية جديدة
        </Button>
      </div>

      {showForm && (
        <FormPanel
          icon={Bookmark}
          title={editId ? "تعديل العلامة التجارية" : "علامة تجارية جديدة"}
          subtitle="بيانات العلامة التجارية"
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={createMut.isPending || updateMut.isPending}
          saveDisabled={!form.code || !form.nameAr}
          saveLabel={t("common.save") as string}
        >
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="w-full h-9 mb-5">
              <TabsTrigger value="basic" className="flex-1 text-xs gap-1.5"><Bookmark className="h-3.5 w-3.5" />{t("inventoryMaster.common.code") as string} / {t("inventoryMaster.common.nameAr") as string}</TabsTrigger>
              <TabsTrigger value="more"  className="flex-1 text-xs gap-1.5"><Info className="h-3.5 w-3.5" />بيانات إضافية</TabsTrigger>
            </TabsList>

            <TabsContent value="basic" className="mt-0">
              <FormGrid>
                <Field label={t("inventoryMaster.common.code") as string} required>
                  <Input placeholder="مثال: BR-001" value={form.code} onChange={e => setForm((p: any) => ({ ...p, code: e.target.value }))} />
                </Field>
                <Field label={t("inventoryMaster.common.nameAr") as string} required>
                  <Input placeholder="اسم العلامة التجارية" value={form.nameAr} onChange={e => setForm((p: any) => ({ ...p, nameAr: e.target.value }))} />
                </Field>
                <Field label={t("inventoryMaster.common.nameEn") as string} className="md:col-span-2">
                  <Input placeholder="Brand name (English)" dir="ltr" className="text-left" value={form.nameEn} onChange={e => setForm((p: any) => ({ ...p, nameEn: e.target.value }))} />
                </Field>
                <Field label="الحالة">
                  <Select value={form.status} onValueChange={v => setForm((p: any) => ({ ...p, status: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">نشطة</SelectItem>
                      <SelectItem value="inactive">غير نشطة</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </FormGrid>
            </TabsContent>

            <TabsContent value="more" className="mt-0">
              <FormGrid>
                <Field label="الشركة المصنِّعة">
                  <Input placeholder="اسم الشركة المالكة/المصنعة" value={form.manufacturerName} onChange={e => setForm((p: any) => ({ ...p, manufacturerName: e.target.value }))} />
                </Field>
                <Field label="المورّد">
                  <Input placeholder="اسم المورّد" value={form.supplierName} onChange={e => setForm((p: any) => ({ ...p, supplierName: e.target.value }))} />
                </Field>
                <Field label="بلد المنشأ">
                  <Input placeholder="بلد المنشأ" value={form.countryOfOrigin} onChange={e => setForm((p: any) => ({ ...p, countryOfOrigin: e.target.value }))} />
                </Field>
                <Field label="ملاحظات" className="md:col-span-2">
                  <Input placeholder="ملاحظات" value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} />
                </Field>
              </FormGrid>
            </TabsContent>
          </Tabs>
        </FormPanel>
      )}

      <div className="relative">
        <Search className={`absolute ${isRtl ? "right-3" : "left-3"} top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground`} />
        <Input className={isRtl ? "pr-9" : "pl-9"} placeholder="بحث بالكود أو الاسم..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>الكود</th>
              <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>الاسم</th>
              <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>الشركة المصنِّعة</th>
              <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>الحالة</th>
              <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground w-24`}>{t("inventoryMaster.common.actions") as string}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading
              ? [...Array(4)].map((_, i) => <tr key={i}><td colSpan={5} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
              : filtered.length === 0
              ? <tr><td colSpan={5} className="px-4 py-10 text-center text-muted-foreground"><Bookmark className="h-8 w-8 mx-auto mb-2 opacity-30" />لا توجد علامات تجارية</td></tr>
              : pager.pagedItems.map((b: any) => (
                  <tr key={b.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3 font-mono text-xs">{b.code}</td>
                    <td className="px-4 py-3 font-medium">{pickName(b.nameAr, b.nameEn)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{b.manufacturerName ?? "—"}</td>
                    <td className="px-4 py-3">
                      <span className={b.status === "active" ? "text-emerald-600 text-xs" : "text-muted-foreground text-xs"}>
                        {b.status === "active" ? "نشطة" : "غير نشطة"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleEdit(b)}><Pencil className="h-3.5 w-3.5" /></Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => { if (confirm(t("inventoryMaster.common.deleteConfirm") as string)) deleteMut.mutate(b.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                      </div>
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
        {!isLoading && filtered.length > 0 && (
          <TablePagination
            page={pager.page}
            pageSize={pager.pageSize}
            pageCount={pager.pageCount}
            total={pager.total}
            onPageChange={pager.setPage}
            onPageSizeChange={pager.setPageSize}
            itemLabel="علامة تجارية"
          />
        )}
      </div>
    </div>
  );
}
