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
import { Plus, Pencil, Trash2, Tag, Search, BookMarked } from "lucide-react";
import { AccountCombobox } from "@/components/AccountCombobox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

const EMPTY = { code: "", nameAr: "", nameEn: "", costAccountId: "", revenueAccountId: "" };

export default function ItemGroups() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`inventoryMaster.itemGroups.${k}`, opts) as string;
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
    queryKey: ["item-groups", cid],
    queryFn: () => inventoryApi.getItemGroups(cid),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["item-groups"] });
  const errToast = (title: string) => (e: any) => toast({ title, description: parseError(e), variant: "destructive" });
  const createMut = useMutation({ mutationFn: inventoryApi.createItemGroup, onSuccess: () => { invalidate(); reset(); toast({ title: tr("savedToast") }); }, onError: errToast(tr("saveError")) });
  const updateMut = useMutation({ mutationFn: ({ id, data }: any) => inventoryApi.updateItemGroup(id, data), onSuccess: () => { invalidate(); reset(); toast({ title: tr("savedToast") }); }, onError: errToast(tr("saveError")) });
  const deleteMut = useMutation({ mutationFn: inventoryApi.deleteItemGroup, onSuccess: () => { invalidate(); toast({ title: tr("deletedToast") }); }, onError: errToast(tr("deleteError")) });

  function reset() { setForm(EMPTY); setEditId(null); setShowForm(false); setActiveTab("basic"); }
  function handleEdit(g: any) {
    setForm({
      ...g,
      costAccountId:    g.costAccountId    ? String(g.costAccountId)    : "",
      revenueAccountId: g.revenueAccountId ? String(g.revenueAccountId) : "",
    });
    setEditId(g.id);
    setShowForm(true);
  }
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload = {
      ...form,
      costAccountId:    form.costAccountId    ? Number(form.costAccountId)    : null,
      revenueAccountId: form.revenueAccountId ? Number(form.revenueAccountId) : null,
    };
    if (editId) updateMut.mutate({ id: editId, data: payload });
    else        createMut.mutate(payload);
  }

  const filtered = data.filter((g: any) =>
    g.nameAr.includes(search) || g.code.includes(search) || (g.nameEn ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Tag className="h-6 w-6 text-primary" />{tr("title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{tr("subtitle")}</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
          <Plus className="h-4 w-4" />{tr("newGroup")}
        </Button>
      </div>

      {showForm && (
        <FormPanel
          icon={Tag}
          title={editId ? tr("editGroup") : tr("newGroup")}
          subtitle={tr("subtitle")}
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={createMut.isPending || updateMut.isPending}
          saveDisabled={!form.code || !form.nameAr}
          saveLabel={t("common.save") as string}
        >
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="w-full h-9 mb-5">
              <TabsTrigger value="basic"    className="flex-1 text-xs gap-1.5"><Tag        className="h-3.5 w-3.5" />{t("inventoryMaster.common.code") as string} / {t("inventoryMaster.common.nameAr") as string}</TabsTrigger>
              <TabsTrigger value="accounts" className="flex-1 text-xs gap-1.5"><BookMarked className="h-3.5 w-3.5" />{isRtl ? "الربط المحاسبي" : "Accounting Mapping"}</TabsTrigger>
            </TabsList>

            <TabsContent value="basic" className="mt-0">
              <FormGrid>
                <Field label={t("inventoryMaster.common.code") as string} required>
                  <Input placeholder={tr("codePh")} value={form.code} onChange={e => setForm((p: any) => ({ ...p, code: e.target.value }))} />
                </Field>
                <Field label={t("inventoryMaster.common.nameAr") as string} required>
                  <Input placeholder={tr("nameArPh")} value={form.nameAr} onChange={e => setForm((p: any) => ({ ...p, nameAr: e.target.value }))} />
                </Field>
                <Field label={t("inventoryMaster.common.nameEn") as string} className="md:col-span-2">
                  <Input placeholder={tr("nameEnPh")} dir="ltr" className="text-left" value={form.nameEn} onChange={e => setForm((p: any) => ({ ...p, nameEn: e.target.value }))} />
                </Field>
              </FormGrid>
            </TabsContent>

            <TabsContent value="accounts" className="mt-0">
              <FormGrid>
                <Field label={isRtl ? "حساب التكلفة الافتراضي" : "Default Cost Account"} hint={isRtl ? "يُورَث لكل صنف ينتمي لهذه المجموعة إذا لم يُحدَّد له حساب" : "Inherited by each item in this group if no account is specified"}>
                  <AccountCombobox
                    value={form.costAccountId}
                    onValueChange={v => setForm((p: any) => ({ ...p, costAccountId: v }))}
                    placeholder={isRtl ? "— اختر حساب التكلفة —" : "— Select cost account —"}
                    filterTypes={["expense", "asset"]}
                    grouped={false}
                  />
                </Field>
                <Field label={isRtl ? "حساب الإيراد الافتراضي" : "Default Revenue Account"} hint={isRtl ? "يُورَث لكل صنف ينتمي لهذه المجموعة إذا لم يُحدَّد له حساب" : "Inherited by each item in this group if no account is specified"}>
                  <AccountCombobox
                    value={form.revenueAccountId}
                    onValueChange={v => setForm((p: any) => ({ ...p, revenueAccountId: v }))}
                    placeholder={isRtl ? "— اختر حساب الإيراد —" : "— Select revenue account —"}
                    filterTypes={["revenue"]}
                    grouped={false}
                  />
                </Field>
              </FormGrid>
            </TabsContent>
          </Tabs>
        </FormPanel>
      )}

      <div className="relative">
        <Search className={`absolute ${isRtl ? "right-3" : "left-3"} top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground`} />
        <Input className={isRtl ? "pr-9" : "pl-9"} placeholder={tr("searchPh")} value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colCode")}</th>
              <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colName")}</th>
              <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{isRtl ? t("inventoryMaster.common.nameEn") as string : t("inventoryMaster.common.nameAr") as string}</th>
              <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground w-24`}>{t("inventoryMaster.common.actions") as string}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading
              ? [...Array(4)].map((_, i) => <tr key={i}><td colSpan={4} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
              : filtered.length === 0
              ? <tr><td colSpan={4} className="px-4 py-10 text-center text-muted-foreground"><Tag className="h-8 w-8 mx-auto mb-2 opacity-30" />{tr("noGroups")}</td></tr>
              : filtered.map((g: any) => (
                  <tr key={g.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3 font-mono text-xs">{g.code}</td>
                    <td className="px-4 py-3 font-medium">{pickName(g.nameAr, g.nameEn)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{isRtl ? (g.nameEn ?? "—") : (g.nameAr ?? "—")}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleEdit(g)}><Pencil className="h-3.5 w-3.5" /></Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => { if (confirm(t("inventoryMaster.common.deleteConfirm") as string)) deleteMut.mutate(g.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                      </div>
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
        {!isLoading && <div className="px-4 py-2 border-t bg-muted/20 text-xs text-muted-foreground">{filtered.length}</div>}
      </div>
    </div>
  );
}
