import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useBranches } from "@/hooks/useBranches";
import { inventoryApi } from "@/lib/inventoryApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Plus, Pencil, Trash2, Warehouse, Search, CheckCircle2, XCircle, MapPin, BookMarked } from "lucide-react";
import { FormPanel } from "@/components/FormPanel";
import { TablePagination, usePagination } from "@/components/TablePagination";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { AccountCombobox } from "@/components/AccountCombobox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useTranslation } from "react-i18next";

const EMPTY = { code: "", nameAr: "", nameEn: "", groupId: "", branchId: "", city: "", region: "", allowNegative: false, negativeLimit: "", accountId: "", isDefault: false };

export default function Warehouses() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const pickName = (ar?: string | null, en?: string | null) => (isRtl ? (ar ?? en) : (en ?? ar)) ?? "";
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<any>(EMPTY);
  const [editId, setEditId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [activeTab, setActiveTab] = useState("basic");
  const [errors, setErrors] = useState<{ nameAr?: string; branchId?: string }>({});

  const { data: warehouses = [], isLoading } = useQuery({
    queryKey: ["warehouses", cid],
    queryFn: () => inventoryApi.getWarehouses(cid),
  });
  // Plan-based quota — refetched on focus and on `subscription_changed` SSE
  // (handled globally by AuthContext via qc.invalidateQueries()) so that any
  // SuperAdmin upgrade/downgrade reflects without a re-login.
  const { data: quota } = useQuery({
    queryKey: ["warehouses-quota", cid],
    queryFn: () => inventoryApi.getWarehouseQuota(cid),
    enabled: !!cid,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const { data: groups = [] } = useQuery({
    queryKey: ["warehouse-groups", cid],
    queryFn: () => inventoryApi.getWarehouseGroups(cid),
  });
  // Branches the current user is allowed to see (already filtered server-side
  // by /api/org/branches based on viewAllBranches / user_branches).
  const { data: branches = [] } = useBranches();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["warehouses"] });
    qc.invalidateQueries({ queryKey: ["warehouses-quota"] });
  };
  // Parse the API error body — server returns JSON like
  // `{ error, code: "WAREHOUSE_LIMIT_REACHED", limit, used }` for plan caps.
  // Falls back to the raw message for other errors.
  const extractApiError = (err: any): string => {
    const raw = String(err?.message ?? err ?? "");
    try {
      const parsed = JSON.parse(raw);
      return parsed.error || parsed.message || raw;
    } catch { return raw; }
  };
  const createMut = useMutation({
    mutationFn: inventoryApi.createWarehouse,
    onSuccess: () => { invalidate(); reset(); toast({ title: t("pages.warehouses.messages.saved") }); },
    onError: (err: any) => { toast({ title: t("common.error", { defaultValue: "خطأ" }), description: extractApiError(err), variant: "destructive" }); qc.invalidateQueries({ queryKey: ["warehouses-quota"] }); },
  });
  const updateMut = useMutation({
    mutationFn: ({ id, data }: any) => inventoryApi.updateWarehouse(id, data),
    onSuccess: () => { invalidate(); reset(); toast({ title: t("pages.warehouses.messages.updated") }); },
    onError: (err: any) => { toast({ title: t("common.error", { defaultValue: "خطأ" }), description: extractApiError(err), variant: "destructive" }); },
  });
  const deleteMut = useMutation({ mutationFn: inventoryApi.deleteWarehouse, onSuccess: () => { invalidate(); toast({ title: t("pages.warehouses.messages.deleted") }); } });

  function reset() { setForm(EMPTY); setEditId(null); setShowForm(false); setActiveTab("basic"); setErrors({}); }
  function handleEdit(w: any) {
    setForm({ ...w, groupId: w.groupId ?? "", branchId: w.branchId ? String(w.branchId) : "", negativeLimit: w.negativeLimit ?? "", accountId: w.accountId ? String(w.accountId) : "" });
    setEditId(w.id);
    setShowForm(true);
    setErrors({});
  }

  // Auto-generate the next sequential warehouse code based on existing codes.
  // Detects the dominant prefix (e.g. "WH-") and numeric width (e.g. 2 digits)
  // from existing warehouses and produces the next number. Falls back to
  // "WH-01" when there are no warehouses yet.
  function generateNextCode(): string {
    const existing = (warehouses as any[]).map(w => String(w.code || "")).filter(Boolean);
    if (existing.length === 0) return "WH-01";
    const re = /^(.*?)(\d+)$/;
    let bestPrefix = "WH-";
    let bestWidth = 2;
    let maxNum = 0;
    const prefixCounts: Record<string, number> = {};
    for (const c of existing) {
      const m = c.match(re);
      if (!m) continue;
      const [, prefix, num] = m;
      prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1;
    }
    bestPrefix = Object.entries(prefixCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "WH-";
    for (const c of existing) {
      const m = c.match(re);
      if (!m) continue;
      const [, prefix, num] = m;
      if (prefix === bestPrefix) {
        const n = parseInt(num, 10);
        if (n > maxNum) maxNum = n;
        if (num.length > bestWidth) bestWidth = num.length;
      }
    }
    const next = maxNum + 1;
    return `${bestPrefix}${String(next).padStart(bestWidth, "0")}`;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Validate required: nameAr only. Code is auto-generated when missing
    // so it does not need to be validated — preventing an unnecessary block
    // on the user.
    const newErrors: { nameAr?: string; branchId?: string } = {};
    const nameAr = String(form.nameAr || "").trim();
    if (!nameAr) newErrors.nameAr = t("pages.warehouses.validation.nameRequired", { defaultValue: "الاسم العربي مطلوب" });
    if (!String(form.branchId || "").trim()) newErrors.branchId = t("pages.warehouses.validation.branchRequired", { defaultValue: "اختيار الفرع إجباري" });
    if (Object.keys(newErrors).length) {
      setErrors(newErrors);
      if (newErrors.nameAr || newErrors.branchId) setActiveTab("basic");
      toast({ title: t("common.validationError", { defaultValue: "تحقق من البيانات" }), description: Object.values(newErrors)[0], variant: "destructive" });
      return;
    }
    setErrors({});
    const codeFinal = String(form.code || "").trim() || generateNextCode();
    const payload = {
      ...form,
      code:          codeFinal,
      nameAr,
      groupId:       form.groupId  ? Number(form.groupId)  : null,
      branchId:      form.branchId ? Number(form.branchId) : null,
      negativeLimit: form.negativeLimit || null,
      accountId:     form.accountId ? Number(form.accountId) : null,
      isDefault:     !!form.isDefault,
    };
    if (editId) updateMut.mutate({ id: editId, data: payload });
    else        createMut.mutate(payload);
  }

  const filtered = warehouses.filter((w: any) =>
    w.nameAr.includes(search) || w.code.includes(search) || (w.nameEn ?? "").toLowerCase().includes(search.toLowerCase())
  );

  const pager = usePagination(filtered);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Warehouse className="h-6 w-6 text-primary" />{t("pages.warehouses.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("pages.warehouses.description")}</p>
        </div>
        <div className="flex items-center gap-3">
          {quota && (
            <div
              className={
                "rounded-lg border px-3 py-1.5 text-xs font-medium tabular-nums " +
                (quota.remaining === 0
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : quota.remaining <= Math.max(1, Math.floor(quota.limit * 0.2))
                    ? "border-amber-300 bg-amber-50 text-amber-800"
                    : "border-emerald-200 bg-emerald-50 text-emerald-800")
              }
              title={quota.remaining === 0 ? t("inventoryMaster.warehouses.quotaMaxReached") : t("inventoryMaster.warehouses.quotaCanAdd", { count: quota.remaining })}
            >
              {t("pages.warehouses.quota", { defaultValue: "المستخدم" })}: <span className="font-bold">{quota.used}</span> / {quota.limit}
            </div>
          )}
          <Button
            size="sm"
            className="gap-2"
            onClick={() => {
              if (quota && quota.remaining === 0) {
                toast({
                  title: t("pages.warehouses.limitReachedTitle", { defaultValue: "وصلت للحد الأقصى" }),
                  description: t("inventoryMaster.warehouses.limitReachedDesc", { count: quota.limit }),
                  variant: "destructive",
                });
                return;
              }
              reset();
              setShowForm(true);
            }}
          >
            <Plus className="h-4 w-4" />{t("pages.warehouses.addWarehouse")}
          </Button>
        </div>
      </div>

      {showForm && (
        <FormPanel
          icon={Warehouse}
          title={editId ? t("pages.warehouses.editWarehouse") : t("pages.warehouses.addNewWarehouse")}
          subtitle={t("pages.warehouses.subtitle")}
          width="4xl"
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={createMut.isPending || updateMut.isPending}
          saveDisabled={false}
          saveLabel={editId ? t("pages.warehouses.saveEdit") : t("common.new")}
        >
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="w-full h-9 mb-4">
              <TabsTrigger value="basic"    className="flex-1 text-xs gap-1"><Warehouse  className="h-3.5 w-3.5" />{t("pages.warehouses.tabs.basic")}</TabsTrigger>
              <TabsTrigger value="location" className="flex-1 text-xs gap-1"><MapPin     className="h-3.5 w-3.5" />{t("pages.warehouses.tabs.location")}</TabsTrigger>
              <TabsTrigger value="accounts" className="flex-1 text-xs gap-1"><BookMarked className="h-3.5 w-3.5" />{t("pages.warehouses.tabs.accounting")}</TabsTrigger>
            </TabsList>

            <TabsContent value="basic" className="mt-0">
              <div className="grid md:grid-cols-2 gap-x-4 gap-y-4">
                <div className="space-y-1.5">
                  <Label>{t("pages.warehouses.fields.code")}</Label>
                  <Input placeholder={t("pages.warehouses.placeholders.codeAuto", { defaultValue: "اتركه فارغاً للتوليد التلقائي" })} value={form.code} onChange={e => setForm((p: any) => ({ ...p, code: e.target.value }))} />
                  <p className="text-[10px] text-muted-foreground">{t("pages.warehouses.fields.codeHint", { defaultValue: "إذا تركته فارغاً سيتم توليده تلقائياً بالتسلسل" })}</p>
                </div>
                <div className="space-y-1.5">
                  <Label>{t("pages.warehouses.fields.group")}</Label>
                  <SearchCombobox
                    items={[{ value: "", label: t("pages.warehouses.fields.noGroup") }, ...(groups as any[]).map((g: any) => ({ value: String(g.id), code: g.code, label: g.nameAr, labelEn: g.nameEn }))]}
                    value={form.groupId}
                    onValueChange={v => setForm((p: any) => ({ ...p, groupId: v }))}
                    placeholder={t("pages.warehouses.placeholders.selectGroup")}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{t("pages.warehouses.fields.nameAr")} <span className="text-destructive">*</span></Label>
                  <Input
                    placeholder={t("pages.warehouses.placeholders.mainWarehouse")}
                    value={form.nameAr}
                    onChange={e => { setForm((p: any) => ({ ...p, nameAr: e.target.value })); if (errors.nameAr) setErrors(p => ({ ...p, nameAr: undefined })); }}
                    className={errors.nameAr ? "border-destructive focus-visible:ring-destructive" : ""}
                    aria-invalid={!!errors.nameAr}
                  />
                  {errors.nameAr && <p className="text-[11px] text-destructive">{errors.nameAr}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label>{t("pages.warehouses.fields.nameEn")}</Label>
                  <Input placeholder="Main Warehouse" dir="ltr" className="text-left" value={form.nameEn} onChange={e => setForm((p: any) => ({ ...p, nameEn: e.target.value }))} />
                </div>
                <div className="md:col-span-2 flex items-center gap-3 rounded-lg border bg-amber-50/40 border-amber-200 px-3 py-2.5">
                  <Switch checked={!!form.isDefault} onCheckedChange={v => setForm((p: any) => ({ ...p, isDefault: v }))} id="is-default-wh" />
                  <Label htmlFor="is-default-wh" className="text-sm cursor-pointer flex-1">
                    {t("inventoryMaster.warehouses.defaultWarehouse")}
                    <span className="block text-[10px] text-muted-foreground font-normal mt-0.5">{t("inventoryMaster.warehouses.defaultWarehouseHint")}</span>
                  </Label>
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label>{t("pages.warehouses.fields.branch")} <span className="text-destructive">*</span></Label>
                  <SearchCombobox
                    items={(branches as any[]).map((b: any) => ({ value: String(b.id), code: b.code, label: b.nameAr, labelEn: b.nameEn }))}
                    value={form.branchId}
                    onValueChange={v => { setForm((p: any) => ({ ...p, branchId: v })); if (errors.branchId) setErrors(p => ({ ...p, branchId: undefined })); }}
                    placeholder={t("pages.warehouses.placeholders.selectBranch")}
                  />
                  {errors.branchId && <p className="text-[11px] text-destructive">{errors.branchId}</p>}
                  <p className="text-[10px] text-muted-foreground">{t("pages.warehouses.fields.branchHint")}</p>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="location" className="mt-0">
              <div className="grid md:grid-cols-2 gap-x-4 gap-y-4">
                <div className="space-y-1.5">
                  <Label>{t("pages.warehouses.fields.city")}</Label>
                  <Input placeholder={t("pages.warehouses.placeholders.riyadh")} value={form.city} onChange={e => setForm((p: any) => ({ ...p, city: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label>{t("pages.warehouses.fields.region")}</Label>
                  <Input placeholder={t("pages.warehouses.placeholders.riyadhRegion")} value={form.region} onChange={e => setForm((p: any) => ({ ...p, region: e.target.value }))} />
                </div>
                <div className="md:col-span-2 flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2.5">
                  <Switch checked={form.allowNegative} onCheckedChange={v => setForm((p: any) => ({ ...p, allowNegative: v }))} id="allow-neg" />
                  <Label htmlFor="allow-neg" className="text-sm cursor-pointer">{t("pages.warehouses.fields.allowNegative")}</Label>
                </div>
                {form.allowNegative && (
                  <div className="space-y-1.5 md:col-span-2">
                    <Label>{t("pages.warehouses.fields.negativeLimit")}</Label>
                    <Input type="number" placeholder="0.00" dir="ltr" className="text-left" value={form.negativeLimit} onChange={e => setForm((p: any) => ({ ...p, negativeLimit: e.target.value }))} />
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="accounts" className="mt-0">
              <div className="space-y-1.5">
                <Label>{t("pages.warehouses.fields.inventoryAccount")}</Label>
                <AccountCombobox
                  value={form.accountId}
                  onValueChange={v => setForm((p: any) => ({ ...p, accountId: v }))}
                  placeholder={t("pages.warehouses.placeholders.selectAccount")}
                  filterTypes={["asset"]}
                  grouped={false}
                />
                <p className="text-[10px] text-muted-foreground">{t("pages.warehouses.fields.inventoryAccountHint")}</p>
              </div>
            </TabsContent>
          </Tabs>
        </FormPanel>
      )}

      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input className="pr-9" placeholder={t("pages.warehouses.placeholders.search")} value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {/* ─────── MOBILE CARDS (visible < md only) ─────── */}
      <div className="md:hidden space-y-3" data-testid="mobile-cards-warehouses">
        {isLoading && (
          <div className="text-center py-10 text-muted-foreground bg-white rounded-xl border">{t("common.loading")}</div>
        )}
        {!isLoading && filtered.length === 0 && (
          <div className="text-center py-10 text-muted-foreground bg-white rounded-xl border">
            <Warehouse className="h-10 w-10 mx-auto mb-2 opacity-30" />
            {t("pages.warehouses.table.noWarehouses")}
          </div>
        )}
        {!isLoading && pager.pagedItems.map((w: any) => (
          <div
            key={w.id}
            className="bg-white rounded-2xl border border-cyan-100/70 shadow-sm overflow-hidden"
            data-testid={`mobile-card-warehouse-${w.id}`}
          >
            <div className="bg-gradient-to-l from-cyan-50 to-cyan-100/60 px-4 py-2.5 flex items-center justify-between border-b border-cyan-100">
              <div className="flex items-center gap-2">
                <Warehouse className="h-4 w-4 text-cyan-700" />
                <span className="font-mono font-bold text-sm text-cyan-900">{w.code}</span>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap justify-end">
                {w.isDefault && (
                  <span className="text-[10px] rounded-full px-2 py-0.5 font-semibold bg-amber-100 text-amber-800 inline-flex items-center gap-1">
                    ★ {t("inventoryMaster.warehouses.defaultBadge")}
                  </span>
                )}
                {w.allowNegative ? (
                  <span className="text-[10px] rounded-full px-2 py-0.5 font-semibold bg-emerald-100 text-emerald-800 inline-flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> {t("inventoryMaster.warehouses.overdraftAllowed")}
                  </span>
                ) : (
                  <span className="text-[10px] rounded-full px-2 py-0.5 font-semibold bg-slate-100 text-slate-600 inline-flex items-center gap-1">
                    <XCircle className="h-3 w-3" /> {t("inventoryMaster.warehouses.balanceOnly")}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => handleEdit(w)}
              className="w-full text-start px-4 py-3 space-y-1.5"
              data-testid={`mobile-open-warehouse-${w.id}`}
            >
              <div className="font-bold text-sm text-slate-900 leading-tight">
                {pickName(w.nameAr, w.nameEn)}
                {(isRtl ? w.nameEn : w.nameAr) && <span className="block text-[11px] text-muted-foreground font-normal">{isRtl ? w.nameEn : w.nameAr}</span>}
              </div>
              <div className="flex items-center gap-3 text-[11px] text-slate-600 flex-wrap">
                {pickName(w.group?.nameAr, w.group?.nameEn) && (
                  <span className="inline-flex items-center gap-1"><BookMarked className="h-3 w-3" /> {pickName(w.group?.nameAr, w.group?.nameEn)}</span>
                )}
                {w.city && (
                  <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" /> {w.city}</span>
                )}
              </div>
            </button>
            <div className="border-t border-slate-100 bg-slate-50/60 grid grid-cols-2 divide-x divide-slate-100 [direction:ltr]">
              <button type="button"
                onClick={() => { if (confirm(t("pages.warehouses.messages.confirmDelete"))) deleteMut.mutate(w.id); }}
                className="py-2.5 text-rose-600 active:bg-rose-100 flex items-center justify-center gap-1 text-xs"
                data-testid={`mobile-btn-delete-warehouse-${w.id}`}>
                <Trash2 className="h-3.5 w-3.5" /> {t("inventoryMaster.common.delete")}
              </button>
              <button type="button" onClick={() => handleEdit(w)}
                className="py-2.5 text-cyan-700 active:bg-cyan-100 flex items-center justify-center gap-1 text-xs font-medium"
                data-testid={`mobile-btn-edit-warehouse-${w.id}`}>
                <Pencil className="h-3.5 w-3.5" /> {t("inventoryMaster.common.edit")}
              </button>
            </div>
          </div>
        ))}
        {!isLoading && filtered.length > 0 && (
          <div className="bg-white rounded-xl border p-2">
            <TablePagination
              page={pager.page}
              pageSize={pager.pageSize}
              pageCount={pager.pageCount}
              total={pager.total}
              onPageChange={pager.setPage}
              onPageSizeChange={pager.setPageSize}
              itemLabel={t("pages.warehouses.itemLabel", { defaultValue: "مستودع" })}
            />
          </div>
        )}
      </div>

      {/* ─────── DESKTOP TABLE (md+ only) ─────── */}
      <div className="hidden md:block rounded-xl border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">{t("pages.warehouses.table.code")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">{t("pages.warehouses.table.name")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">{t("pages.warehouses.table.group")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden md:table-cell">{t("pages.warehouses.table.city")}</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground w-24">{t("pages.warehouses.table.overdraft")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-24">{t("common.actions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading
              ? [...Array(4)].map((_, i) => <tr key={i}><td colSpan={6} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
              : filtered.length === 0
              ? <tr><td colSpan={6} className="px-4 py-10 text-center text-muted-foreground"><Warehouse className="h-8 w-8 mx-auto mb-2 opacity-30" />{t("pages.warehouses.table.noWarehouses")}</td></tr>
              : pager.pagedItems.map((w: any) => (
                  <tr key={w.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3 font-mono text-xs">{w.code}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium inline-flex items-center gap-1.5">
                        {pickName(w.nameAr, w.nameEn)}
                        {w.isDefault && (
                          <span className="text-[10px] rounded-full px-1.5 py-0.5 font-semibold bg-amber-100 text-amber-800">★ {t("inventoryMaster.warehouses.defaultBadge")}</span>
                        )}
                      </p>
                      {(isRtl ? w.nameEn : w.nameAr) && <p className="text-xs text-muted-foreground">{isRtl ? w.nameEn : w.nameAr}</p>}
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell text-muted-foreground text-xs">{pickName(w.group?.nameAr, w.group?.nameEn) || "—"}</td>
                    <td className="px-4 py-3 hidden md:table-cell text-muted-foreground text-xs">{w.city ?? "—"}</td>
                    <td className="px-4 py-3 text-center">
                      {w.allowNegative ? <CheckCircle2 className="h-4 w-4 text-green-500 mx-auto" /> : <XCircle className="h-4 w-4 text-muted-foreground/30 mx-auto" />}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleEdit(w)}><Pencil className="h-3.5 w-3.5" /></Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => { if (confirm(t("pages.warehouses.messages.confirmDelete"))) deleteMut.mutate(w.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
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
            itemLabel={t("pages.warehouses.itemLabel", { defaultValue: "مستودع" })}
          />
        )}
      </div>

      {/* ─────── MOBILE FAB ─────── */}
      <button
        type="button"
        onClick={() => { reset(); setShowForm(true); }}
        className="md:hidden fixed bottom-6 end-6 z-40 group"
        data-testid="mobile-fab-new-warehouse"
        aria-label={t("inventoryMaster.warehouses.newWarehouseAria")}
      >
        <span className="absolute inset-0 rounded-full bg-cyan-500 opacity-30 group-active:opacity-0 animate-ping" />
        <span className="relative flex items-center justify-center h-14 w-14 rounded-full bg-gradient-to-br from-cyan-500 via-cyan-600 to-cyan-800 text-white shadow-xl shadow-cyan-500/40 ring-4 ring-white active:scale-95 transition-transform">
          <Plus className="h-7 w-7" strokeWidth={2.5} />
        </span>
      </button>
    </div>
  );
}
