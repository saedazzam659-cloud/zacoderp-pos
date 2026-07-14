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
import { Plus, Pencil, Trash2, Tag, Search, BookMarked, Wand2, Link2, CheckCircle2 } from "lucide-react";
import { AccountCombobox } from "@/components/AccountCombobox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

const EMPTY = { code: "", nameAr: "", nameEn: "", costAccountId: "", revenueAccountId: "", categoryType: "", parentAccountId: "", accountLinkMode: "auto", accountId: "" };

// نوع الفئة → أنواع الحسابات المسموح اختيارها كحساب رئيسي (تُطابق قواعد السيرفر)
const PARENT_FILTER: Record<string, ("asset" | "expense")[]> = {
  inventory: ["asset"], fixed_asset: ["asset"], expense: ["expense"],
};

export default function ItemGroups() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`inventoryMaster.itemGroups.${k}`, opts) as string;
  const pickName = (ar?: string | null, en?: string | null) => isRtl ? (ar ?? en ?? "") : (en ?? ar ?? "");

  const { user, token } = useAuth() as any;
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
  // أسماء الحسابات لعرض عمود «الحساب» في الجدول (نفس مفتاح كاش الكومبوبوكس)
  const { data: accounts = [] } = useQuery<any[]>({
    queryKey: ["accounts", cid],
    queryFn: async () => {
      const API = import.meta.env.BASE_URL.replace(/\/$/, "");
      const url = cid ? `${API}/api/accounts?companyId=${cid}` : `${API}/api/accounts`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return [];
      const b = await r.json().catch(() => []);
      return Array.isArray(b) ? b : [];
    },
    enabled: !!user,
    staleTime: 60_000,
  });
  const accById = new Map<number, any>((Array.isArray(accounts) ? accounts : []).map((a: any) => [a.id, a]));

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
      categoryType:     g.categoryType ?? "",
      parentAccountId:  g.parentAccountId ? String(g.parentAccountId) : "",
      // الوضع: لو الفئة مربوطة بحساب من غير حساب رئيسي → كانت مربوطة يدوياً
      accountLinkMode:  g.categoryType && g.accountId && !g.parentAccountId ? "manual" : "auto",
      accountId:        g.accountId ? String(g.accountId) : "",
    });
    setEditId(g.id);
    setShowForm(true);
  }
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const manual = form.accountLinkMode === "manual";
    if (form.categoryType && !manual && !form.parentAccountId) {
      toast({ title: tr("typeRequiresParent"), variant: "destructive" });
      setActiveTab("accounts");
      return;
    }
    if (form.categoryType && manual && !form.accountId) {
      toast({ title: tr("manualRequiresAccount"), variant: "destructive" });
      setActiveTab("accounts");
      return;
    }
    const payload = {
      ...form,
      costAccountId:    form.costAccountId    ? Number(form.costAccountId)    : null,
      revenueAccountId: form.revenueAccountId ? Number(form.revenueAccountId) : null,
      categoryType:     form.categoryType || null,
      accountLinkMode:  form.categoryType ? (manual ? "manual" : "auto") : undefined,
      accountId:        form.categoryType && manual && form.accountId ? Number(form.accountId) : undefined,
      parentAccountId:  form.categoryType && !manual && form.parentAccountId ? Number(form.parentAccountId) : null,
    };
    if (editId) updateMut.mutate({ id: editId, data: payload });
    else        createMut.mutate(payload);
  }

  // معاينة الحساب الفرعي القادم (مثل الموردين: آخر حساب 111002 → القادم 111003)
  const peekParentId = form.categoryType && form.accountLinkMode !== "manual" && form.parentAccountId ? Number(form.parentAccountId) : 0;
  const { data: peek } = useQuery({
    queryKey: ["item-group-next-account", peekParentId, form.categoryType],
    queryFn: () => inventoryApi.getItemGroupNextAccount(peekParentId, form.categoryType),
    enabled: peekParentId > 0 && !!form.categoryType,
    retry: false,
  });

  const typeLabel = (ct?: string | null) =>
    ct === "inventory" ? tr("typeInventory") : ct === "fixed_asset" ? tr("typeFixedAsset") : ct === "expense" ? tr("typeExpense") : "—";

  const filtered = data.filter((g: any) =>
    g.nameAr.includes(search) || g.code.includes(search) || (g.nameEn ?? "").toLowerCase().includes(search.toLowerCase())
  );

  const pager = usePagination(filtered);

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
              <TabsTrigger value="accounts" className="flex-1 text-xs gap-1.5"><BookMarked className="h-3.5 w-3.5" />{tr("accountingMappingTab")}</TabsTrigger>
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
                <Field label={tr("categoryType")}>
                  <select
                    className="w-full h-9 rounded-md border bg-background px-3 text-sm"
                    value={form.categoryType}
                    onChange={e => setForm((p: any) => ({ ...p, categoryType: e.target.value, parentAccountId: "", accountId: "" }))}
                  >
                    <option value="">{tr("categoryTypeNone")}</option>
                    <option value="inventory">{tr("typeInventory")}</option>
                    <option value="fixed_asset">{tr("typeFixedAsset")}</option>
                    <option value="expense">{tr("typeExpense")}</option>
                  </select>
                </Field>
                {form.categoryType && (
                  <div className="md:col-span-2 space-y-3">
                    {/* ── اختيار طريقة الربط المحاسبي (مثل شاشة المستودعات) ── */}
                    <div className="text-sm font-medium">{tr("linkModeTitle")}</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" role="radiogroup" aria-label={tr("linkModeTitle")}>
                      {([
                        { mode: "auto",   Icon: Wand2, title: tr("linkModeAuto"),   desc: tr("linkModeAutoDesc") },
                        { mode: "manual", Icon: Link2, title: tr("linkModeManual"), desc: tr("linkModeManualDesc") },
                      ] as const).map(({ mode, Icon, title, desc }) => {
                        const active = (form.accountLinkMode ?? "auto") === mode;
                        return (
                          <button
                            key={mode}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            onClick={() => setForm((p: any) => ({ ...p, accountLinkMode: mode }))}
                            className={`relative rounded-lg border p-3 text-start transition-colors ${
                              active
                                ? "border-primary bg-primary/5 ring-1 ring-primary"
                                : "border-border bg-card hover:bg-muted/40"
                            }`}
                          >
                            {active && <CheckCircle2 className="absolute top-2 end-2 h-4 w-4 text-primary" />}
                            <div className="flex items-center gap-2 mb-1">
                              <Icon className={`h-4 w-4 ${active ? "text-primary" : "text-muted-foreground"}`} />
                              <span className="text-sm font-semibold">{title}</span>
                            </div>
                            <p className="text-xs text-muted-foreground leading-relaxed">{desc}</p>
                          </button>
                        );
                      })}
                    </div>

                    {form.accountLinkMode === "manual" ? (
                      <>
                        <Field label={tr("manualAccount")} hint={tr("manualAccountHint")} required>
                          <AccountCombobox
                            value={form.accountId}
                            onValueChange={v => setForm((p: any) => ({ ...p, accountId: v }))}
                            placeholder={tr("selectManualAccount")}
                            filterTypes={PARENT_FILTER[form.categoryType] ?? ["asset"]}
                            grouped={false}
                            allowEmpty={false}
                          />
                        </Field>
                        {form.accountId && accById.get(Number(form.accountId)) && (
                          <div className="rounded-md border border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-200">
                            {tr("manualLinkedPreview", {
                              code: accById.get(Number(form.accountId))?.code,
                              name: pickName(accById.get(Number(form.accountId))?.nameAr, accById.get(Number(form.accountId))?.nameEn),
                            })}
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <Field label={tr("parentAccount")} hint={tr("parentAccountHint")} required>
                          <AccountCombobox
                            value={form.parentAccountId}
                            onValueChange={v => setForm((p: any) => ({ ...p, parentAccountId: v }))}
                            placeholder={tr("selectParentAccount")}
                            filterTypes={PARENT_FILTER[form.categoryType] ?? ["asset"]}
                            grouped={false}
                          />
                        </Field>
                        {peekParentId > 0 && peek && (
                          <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs space-y-1">
                            <div className="text-muted-foreground">
                              {peek.lastCode ? tr("lastChild", { code: peek.lastCode }) : tr("noChildrenYet")}
                            </div>
                            <div className="font-medium text-primary">
                              {tr("nextChild", { code: peek.nextCode, name: form.nameAr || "—" })}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
                <Field label={tr("defaultCostAccount")} hint={tr("inheritedAccountHint")}>
                  <AccountCombobox
                    value={form.costAccountId}
                    onValueChange={v => setForm((p: any) => ({ ...p, costAccountId: v }))}
                    placeholder={tr("selectCostAccount")}
                    filterTypes={["expense", "asset"]}
                    grouped={false}
                  />
                </Field>
                <Field label={tr("defaultRevenueAccount")} hint={tr("inheritedAccountHint")}>
                  <AccountCombobox
                    value={form.revenueAccountId}
                    onValueChange={v => setForm((p: any) => ({ ...p, revenueAccountId: v }))}
                    placeholder={tr("selectRevenueAccount")}
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
              <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colType")}</th>
              <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colAccount")}</th>
              <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground w-24`}>{t("inventoryMaster.common.actions") as string}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading
              ? [...Array(4)].map((_, i) => <tr key={i}><td colSpan={6} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
              : filtered.length === 0
              ? <tr><td colSpan={6} className="px-4 py-10 text-center text-muted-foreground"><Tag className="h-8 w-8 mx-auto mb-2 opacity-30" />{tr("noGroups")}</td></tr>
              : pager.pagedItems.map((g: any) => (
                  <tr key={g.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3 font-mono text-xs">{g.code}</td>
                    <td className="px-4 py-3 font-medium">{pickName(g.nameAr, g.nameEn)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{isRtl ? (g.nameEn ?? "—") : (g.nameAr ?? "—")}</td>
                    <td className="px-4 py-3">
                      {g.categoryType
                        ? <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            g.categoryType === "inventory" ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                            : g.categoryType === "fixed_asset" ? "bg-purple-50 text-purple-700 dark:bg-purple-950 dark:text-purple-300"
                            : "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300"}`}>
                            {typeLabel(g.categoryType)}
                          </span>
                        : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {g.accountId && accById.get(g.accountId)
                        ? <span><span className="font-mono">{accById.get(g.accountId)?.code}</span> — {pickName(accById.get(g.accountId)?.nameAr, accById.get(g.accountId)?.nameEn)}</span>
                        : <span className="text-muted-foreground">—</span>}
                    </td>
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
        {!isLoading && filtered.length > 0 && (
          <TablePagination
            page={pager.page}
            pageSize={pager.pageSize}
            pageCount={pager.pageCount}
            total={pager.total}
            onPageChange={pager.setPage}
            onPageSizeChange={pager.setPageSize}
            itemLabel={t("inventoryMaster.itemGroups.itemLabel", { defaultValue: "مجموعة" })}
          />
        )}
      </div>
    </div>
  );
}
