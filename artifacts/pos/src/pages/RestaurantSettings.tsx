import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus, Trash2, Loader2, Save, X, Pencil, Settings, Utensils, ListOrdered, Tags, Sparkles, MapPin, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  api, getToken, getStoredUser,
  type Branch, type Item, type RTable, type RMenuCategory, type RMenuItem,
} from "@/lib/api";

const TABS = [
  { id: "tables",  label: "الطاولات",   icon: ListOrdered },
  { id: "cats",    label: "الفئات",     icon: Tags },
  { id: "items",   label: "الأصناف",   icon: Utensils },
] as const;

type Tab = typeof TABS[number]["id"];

export default function RestaurantSettings() {
  const [, setLocation] = useLocation();
  const returnTo = new URLSearchParams(window.location.search).get("returnTo") === "waiter"
    ? "/waiter"
    : "/restaurant";
  const [tab, setTab] = useState<Tab>(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    return TABS.some(item => item.id === requested) ? requested as Tab : "tables";
  });

  useEffect(() => { if (!getToken()) setLocation("/login"); }, [setLocation]);

  const user = getStoredUser();
  const cid = user?.companyId ?? null;

  const branchesQ = useQuery({
    queryKey: ["branches", cid],
    queryFn: () => cid ? api.getBranches(cid) : Promise.resolve([]),
    enabled: !!cid,
  });

  return (
    <div dir="rtl" className="min-h-[100dvh] bg-background text-foreground">
      <header className="sticky top-0 z-20 flex min-h-16 items-center gap-3 border-b border-border/80 bg-card px-3 py-2 shadow-sm sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setLocation(returnTo)} aria-label="العودة إلى المطعم" data-testid="button-settings-back">
            <ChevronRight className="h-4 w-4 ml-1" /> رجوع
          </Button>
          <div className="grid size-10 shrink-0 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-sm"><Settings className="h-5 w-5" /></div>
          <div className="min-w-0">
            <div className="truncate text-base font-black">إعدادات المطعم</div>
            <p className="text-xs text-muted-foreground">الطاولات والقائمة ومناطق الخدمة</p>
          </div>
        </div>
      </header>

      <nav className="sticky top-16 z-10 flex overflow-x-auto border-b border-border bg-card/95 px-3 backdrop-blur" aria-label="أقسام إعدادات المطعم">
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              type="button"
              aria-current={tab === t.id ? "page" : undefined}
              data-testid={`tab-restaurant-${t.id}`}
              className={`flex shrink-0 items-center gap-2 border-b-2 px-4 py-3 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${
                tab === t.id ? "border-primary text-primary font-black" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-4 w-4" /> {t.label}
            </button>
          );
        })}
      </nav>

      <main className="mx-auto max-w-6xl p-4 sm:p-6">
        {tab === "tables" && (
          <TablesTab
            branches={branchesQ.data ?? []}
            branchesLoading={branchesQ.isLoading}
            branchesError={branchesQ.isError}
            retryBranches={() => { void branchesQ.refetch(); }}
          />
        )}
        {tab === "cats"   && <CategoriesTab />}
        {tab === "items"  && <ItemsTab companyId={cid} />}
      </main>
    </div>
  );
}

// ─── Tables ──────────────────────────────────────────────────────────────
function TablesTab({
  branches,
  branchesLoading,
  branchesError,
  retryBranches,
}: {
  branches: Branch[];
  branchesLoading: boolean;
  branchesError: boolean;
  retryBranches: () => void;
}) {
  const qc = useQueryClient();
  const tablesQ = useQuery({ queryKey: ["r-tables-all"], queryFn: () => api.rTables() });
  const [batch, setBatch] = useState({
    branchId: "" as string | number,
    count: 10,
    startNumber: 1,
    codePrefix: "T",
    namePrefix: "طاولة",
    capacity: 4,
    area: "الصالة",
  });
  const [batchMessage, setBatchMessage] = useState("");
  const [manualError, setManualError] = useState("");
  const [draft, setDraft] = useState({
    branchId: "" as string | number, code: "", nameAr: "", capacity: 4, area: "",
  });
  const [editId, setEditId] = useState<number | null>(null);
  const [editBuf, setEditBuf] = useState<Partial<RTable>>({});

  useEffect(() => {
    if (batch.branchId || !branches.length) return;
    const preferredId = Number(localStorage.getItem("pos_branch_id") || 0);
    const preferred = branches.find(branch => branch.id === preferredId);
    if (preferred || branches.length === 1) {
      setBatch(current => ({ ...current, branchId: String((preferred ?? branches[0]).id) }));
    }
  }, [branches, batch.branchId]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["r-tables-all"] });
    qc.invalidateQueries({ queryKey: ["r-tables"] });
  };

  const createBatch = useMutation({
    mutationFn: () => api.rCreateTablesBatch({
      branchId: Number(batch.branchId),
      count: Number(batch.count),
      startNumber: Number(batch.startNumber),
      codePrefix: batch.codePrefix.trim(),
      namePrefix: batch.namePrefix.trim(),
      capacity: Number(batch.capacity),
      area: batch.area.trim(),
    }),
    onSuccess: rows => {
      const first = rows[0]?.code;
      const last = rows.at(-1)?.code;
      setBatchMessage(`تم إنشاء ${rows.length} طاولة بنجاح${first ? ` — ${first}${last && last !== first ? ` إلى ${last}` : ""}` : ""}.`);
      invalidate();
    },
  });

  const create = useMutation({
    mutationFn: () => api.rCreateTable({
      branchId: Number(draft.branchId), code: draft.code, nameAr: draft.nameAr,
      capacity: Number(draft.capacity), area: draft.area || null,
    }),
    onSuccess: () => {
      setDraft({ branchId: "", code: "", nameAr: "", capacity: 4, area: "" });
      setManualError("");
      invalidate();
    },
    onError: (e: any) => setManualError(e?.message ?? "فشل إنشاء الطاولة"),
  });

  const update = useMutation({
    mutationFn: () => api.rUpdateTable(editId!, editBuf),
    onSuccess: () => { setEditId(null); setEditBuf({}); invalidate(); },
    onError: (e: any) => alert(e?.message ?? "فشل التحديث"),
  });

  const del = useMutation({
    mutationFn: (id: number) => api.rDeleteTable(id),
    onSuccess: invalidate,
  });

  const startEdit = (t: RTable) => { setEditId(t.id); setEditBuf({ code: t.code, nameAr: t.nameAr, capacity: t.capacity, area: t.area, status: t.status }); };
  const previewEnd = Number(batch.startNumber) + Number(batch.count) - 1;
  const batchValid = Boolean(batch.branchId)
    && Number.isInteger(Number(batch.count)) && Number(batch.count) >= 1 && Number(batch.count) <= 100
    && Number.isInteger(Number(batch.startNumber)) && Number(batch.startNumber) >= 1 && Number(batch.startNumber) <= 999999
    && Number.isInteger(Number(batch.capacity)) && Number(batch.capacity) >= 1 && Number(batch.capacity) <= 50
    && /^[\p{L}\p{N}_-]{1,12}$/u.test(batch.codePrefix.trim())
    && batch.namePrefix.trim().length > 0 && batch.namePrefix.trim().length <= 40
    && batch.area.trim().length <= 80;

  return (
    <div className="space-y-4">
      <section className="relative overflow-hidden rounded-2xl border border-primary/20 bg-card p-4 shadow-sm sm:p-6">
        <div className="pointer-events-none absolute -left-12 -top-16 h-48 w-48 rounded-full bg-primary/[0.06] blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-primary">
              <Sparkles className="h-5 w-5" />
              <h2 className="font-black text-lg">تجهيز الطاولات دفعة واحدة</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">أنشئ العدد المطلوب بترقيم تلقائي، ثم وزّع الطاولات على مناطق المطعم.</p>
          </div>
          <span className="rounded-full border border-primary/20 bg-primary/5 px-3 py-1.5 text-xs font-bold text-primary">الافتراضي: 10 طاولات</span>
        </div>

        <div className="relative mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="space-y-1 text-xs font-semibold text-muted-foreground">
            الفرع
            <select value={batch.branchId}
              onChange={e => { setBatch({ ...batch, branchId: e.target.value }); setBatchMessage(""); }}
              aria-label="فرع الطاولات"
              data-testid="select-batch-branch"
              disabled={branchesLoading || branchesError || branches.length === 0}
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              <option value="">اختر الفرع</option>
              {branches.map(branch => <option key={branch.id} value={branch.id}>{branch.nameAr}</option>)}
            </select>
            {branchesLoading && <span className="block pt-1 font-normal">جارٍ تحميل الفروع...</span>}
            {branchesError && (
              <span className="flex items-center gap-2 pt-1 font-normal text-destructive" role="alert">
                تعذّر تحميل الفروع.
                <button type="button" className="font-bold underline" onClick={retryBranches}>إعادة المحاولة</button>
              </span>
            )}
            {!branchesLoading && !branchesError && branches.length === 0 && (
              <span className="block pt-1 font-normal text-destructive" role="alert">لا توجد فروع نشطة لإنشاء الطاولات.</span>
            )}
            {!branchesLoading && !branchesError && branches.length > 1 && !batch.branchId && (
              <span className="block pt-1 font-normal">اختر الفرع لتفعيل الإنشاء.</span>
            )}
          </label>
          <label className="space-y-1 text-xs font-semibold text-muted-foreground">
            عدد الطاولات
            <Input type="number" min={1} max={100} value={batch.count}
              onChange={e => { setBatch({ ...batch, count: Number(e.target.value) }); setBatchMessage(""); }}
              aria-label="عدد الطاولات" data-testid="input-batch-table-count"
              className="h-10 bg-background" />
          </label>
          <label className="space-y-1 text-xs font-semibold text-muted-foreground">
            بادئة الرقم
            <Input value={batch.codePrefix} maxLength={12}
              onChange={e => { setBatch({ ...batch, codePrefix: e.target.value }); setBatchMessage(""); }}
              aria-label="بادئة رمز الطاولة" data-testid="input-batch-code-prefix"
              className="h-10 bg-background" />
          </label>
          <label className="space-y-1 text-xs font-semibold text-muted-foreground">
            بداية الترقيم
            <Input type="number" min={1} value={batch.startNumber}
              onChange={e => { setBatch({ ...batch, startNumber: Number(e.target.value) }); setBatchMessage(""); }}
              aria-label="بداية الترقيم" data-testid="input-batch-start-number"
              className="h-10 bg-background" />
          </label>
          <label className="space-y-1 text-xs font-semibold text-muted-foreground">
            اسم الطاولة
            <Input value={batch.namePrefix} maxLength={40}
              onChange={e => { setBatch({ ...batch, namePrefix: e.target.value }); setBatchMessage(""); }}
              aria-label="بادئة اسم الطاولة" data-testid="input-batch-name-prefix"
              className="h-10 bg-background" />
          </label>
          <label className="space-y-1 text-xs font-semibold text-muted-foreground">
            المنطقة / الصالة
            <Input value={batch.area} maxLength={80}
              onChange={e => { setBatch({ ...batch, area: e.target.value }); setBatchMessage(""); }}
              aria-label="المنطقة أو الصالة" data-testid="input-batch-area"
              className="h-10 bg-background" />
          </label>
          <label className="space-y-1 text-xs font-semibold text-muted-foreground">
            مقاعد لكل طاولة
            <Input type="number" min={1} max={50} value={batch.capacity}
              onChange={e => { setBatch({ ...batch, capacity: Number(e.target.value) }); setBatchMessage(""); }}
              aria-label="عدد المقاعد لكل طاولة" data-testid="input-batch-capacity"
              className="h-10 bg-background" />
          </label>
          <div className="flex items-end">
            <Button data-testid="button-create-table-batch" className="h-10 w-full font-black"
              disabled={!batchValid || createBatch.isPending || branchesLoading || branchesError || branches.length === 0}
              onClick={() => { setBatchMessage(""); createBatch.mutate(); }}>
              {createBatch.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Plus className="ml-2 h-4 w-4" />}
              إنشاء الطاولات
            </Button>
          </div>
        </div>
        <div className="relative mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5 text-primary" />معاينة: {batch.codePrefix || "T"}{String(batch.startNumber).padStart(2, "0")} ← {batch.codePrefix || "T"}{String(previewEnd).padStart(2, "0")}</span>
          <span>الأرقام الموجودة تُتخطّى تلقائياً حتى لا تتكرر.</span>
        </div>
        {batchMessage && <p role="status" data-testid="status-batch-create-success" className="relative mt-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm font-semibold text-primary">{batchMessage}</p>}
        {createBatch.isError && <p role="alert" className="relative mt-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">{createBatch.error.message}</p>}
      </section>

      <details className="group rounded-xl border border-border bg-card shadow-sm">
        <summary className="cursor-pointer list-none p-4 font-bold marker:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <span className="inline-flex items-center gap-2"><Plus className="h-4 w-4 text-primary" />إضافة طاولة واحدة يدوياً</span>
          <span className="float-left text-xs font-normal text-muted-foreground">اختياري</span>
        </summary>
        <div className="border-t border-border p-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <select value={draft.branchId}
              onChange={e => setDraft({ ...draft, branchId: e.target.value })}
              aria-label="فرع الطاولة اليدوية" data-testid="select-manual-table-branch"
              className="h-10 rounded-lg border border-input bg-background px-3 text-sm">
              <option value="">اختر الفرع</option>
              {branches.map(b => <option key={b.id} value={b.id}>{b.nameAr}</option>)}
            </select>
            <Input placeholder="الرمز (T01)" value={draft.code}
              onChange={e => setDraft({ ...draft, code: e.target.value })}
              aria-label="رمز الطاولة" data-testid="input-manual-table-code" className="bg-background" />
            <Input placeholder="الاسم (طاولة 1)" value={draft.nameAr}
              onChange={e => setDraft({ ...draft, nameAr: e.target.value })}
              aria-label="اسم الطاولة" data-testid="input-manual-table-name" className="bg-background" />
            <Input type="number" placeholder="السعة" value={draft.capacity}
              onChange={e => setDraft({ ...draft, capacity: Number(e.target.value) })}
              aria-label="سعة الطاولة" data-testid="input-manual-table-capacity" className="bg-background" />
            <Input placeholder="المنطقة (اختياري)" value={draft.area}
              onChange={e => setDraft({ ...draft, area: e.target.value })}
              aria-label="منطقة الطاولة" data-testid="input-manual-table-area" className="bg-background" />
          </div>
          <Button data-testid="button-create-table" className="mt-3 font-bold"
            disabled={!draft.branchId || !draft.code || !draft.nameAr || create.isPending}
            onClick={() => { setManualError(""); create.mutate(); }}>
            {create.isPending ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : <Plus className="ml-1 h-4 w-4" />}إضافة طاولة
          </Button>
          {manualError && <p role="alert" className="mt-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">{manualError}</p>}
        </div>
      </details>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="border-b border-border p-4 font-black">الطاولات <span className="text-sm font-semibold text-muted-foreground">({tablesQ.data?.length ?? 0})</span></div>
        {tablesQ.isLoading ? <div role="status" className="p-8 text-center"><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin text-primary" />جارٍ تحميل الطاولات</div> :
          tablesQ.isError ? <div className="p-8 text-center text-sm text-destructive" role="alert">تعذّر تحميل الطاولات. <button className="font-bold underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => tablesQ.refetch()}>إعادة المحاولة</button></div> :
          (tablesQ.data ?? []).length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">لا توجد طاولات بعد. أنشئ دفعة أو أضف طاولة يدوياً.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted text-muted-foreground">
                <tr>
                  <th className="p-2 text-right">الرمز</th>
                  <th className="p-2 text-right">الاسم</th>
                  <th className="p-2 text-right">السعة</th>
                  <th className="p-2 text-right">المنطقة</th>
                  <th className="p-2 text-right">الحالة</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {tablesQ.data!.map(t => editId === t.id ? (
                  <tr key={t.id} className="border-t border-primary/30 bg-primary/[0.04]">
                    <td className="p-1"><Input aria-label="رمز الطاولة" value={editBuf.code ?? ""} onChange={e => setEditBuf({ ...editBuf, code: e.target.value })} className="h-8 bg-background" /></td>
                    <td className="p-1"><Input aria-label="اسم الطاولة" value={editBuf.nameAr ?? ""} onChange={e => setEditBuf({ ...editBuf, nameAr: e.target.value })} className="h-8 bg-background" /></td>
                    <td className="p-1"><Input aria-label="سعة الطاولة" type="number" value={editBuf.capacity ?? 0} onChange={e => setEditBuf({ ...editBuf, capacity: Number(e.target.value) })} className="h-8 w-16 bg-background" /></td>
                    <td className="p-1"><Input aria-label="منطقة الطاولة" value={editBuf.area ?? ""} onChange={e => setEditBuf({ ...editBuf, area: e.target.value })} className="h-8 bg-background" /></td>
                    <td className="p-1">
                      <select value={editBuf.status ?? "free"}
                        onChange={e => setEditBuf({ ...editBuf, status: e.target.value as any })}
                        aria-label="حالة الطاولة" className="h-8 rounded-lg border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                        <option value="free">متاحة</option>
                        <option value="occupied">مشغولة</option>
                        <option value="reserved">محجوزة</option>
                        <option value="cleaning">تنظيف</option>
                      </select>
                    </td>
                    <td className="p-1 text-left whitespace-nowrap">
                      <Button variant="ghost" size="sm" aria-label="حفظ تعديل الطاولة" data-testid={`button-save-table-${t.id}`} disabled={update.isPending} onClick={() => update.mutate()}>
                        <Save className="h-4 w-4 text-primary" />
                      </Button>
                      <Button variant="ghost" size="sm" aria-label="إلغاء تعديل الطاولة" onClick={() => { setEditId(null); setEditBuf({}); }}>
                        <X className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    </td>
                  </tr>
                ) : (
                  <tr key={t.id} className="border-t border-border/70 hover:bg-muted/40">
                    <td className="p-2">{t.code}</td>
                    <td className="p-2 font-semibold">{t.nameAr}</td>
                    <td className="p-2">{t.capacity}</td>
                    <td className="p-2 text-muted-foreground">{t.area ?? "—"}</td>
                    <td className="p-2 text-xs">{t.status === "free" ? "متاحة" : t.status === "occupied" ? "مشغولة" : t.status === "reserved" ? "محجوزة" : "تنظيف"}</td>
                    <td className="p-2 text-left whitespace-nowrap">
                      <Button variant="ghost" size="sm" aria-label={`تعديل ${t.nameAr}`} data-testid={`button-edit-table-${t.id}`} onClick={() => startEdit(t)}>
                        <Pencil className="h-4 w-4 text-primary" />
                      </Button>
                      <Button variant="ghost" size="sm" aria-label={`تعطيل ${t.nameAr}`} data-testid={`button-deactivate-table-${t.id}`} onClick={() => { if (confirm("حذف الطاولة؟")) del.mutate(t.id); }}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </div>
  );
}

// ─── Categories ──────────────────────────────────────────────────────────
function CategoriesTab() {
  const qc = useQueryClient();
  const catsQ = useQuery({ queryKey: ["r-cats-all"], queryFn: () => api.rCategories() });
  const [draft, setDraft] = useState({
    code: "", nameAr: "", kind: "food" as RMenuCategory["kind"], displayOrder: 0, color: "",
  });
  const [editId, setEditId] = useState<number | null>(null);
  const [editBuf, setEditBuf] = useState<Partial<RMenuCategory>>({});

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["r-cats-all"] });
    qc.invalidateQueries({ queryKey: ["r-cats"] });
  };

  const create = useMutation({
    mutationFn: () => api.rCreateCategory(draft as any),
    onSuccess: () => {
      setDraft({ code: "", nameAr: "", kind: "food", displayOrder: 0, color: "" });
      invalidate();
    },
    onError: (e: any) => alert(e?.message ?? "فشل الإنشاء"),
  });
  const update = useMutation({
    mutationFn: () => api.rUpdateCategory(editId!, editBuf),
    onSuccess: () => { setEditId(null); setEditBuf({}); invalidate(); },
    onError: (e: any) => alert(e?.message ?? "فشل التحديث"),
  });
  const del = useMutation({
    mutationFn: (id: number) => api.rDeleteCategory(id),
    onSuccess: invalidate,
  });

  const startEdit = (c: RMenuCategory) => { setEditId(c.id); setEditBuf({ code: c.code, nameAr: c.nameAr, kind: c.kind, displayOrder: c.displayOrder, color: c.color }); };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5">
        <div className="font-bold mb-3">إضافة فئة جديدة</div>
        <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
          <Input placeholder="الرمز" value={draft.code}
            onChange={e => setDraft({ ...draft, code: e.target.value })}
            aria-label="رمز الفئة" data-testid="input-category-code" className="bg-background" />
          <Input placeholder="الاسم (مشروبات)" value={draft.nameAr}
            onChange={e => setDraft({ ...draft, nameAr: e.target.value })}
            aria-label="اسم الفئة" data-testid="input-category-name" className="bg-background" />
          <select value={draft.kind}
            onChange={e => setDraft({ ...draft, kind: e.target.value as any })}
            aria-label="نوع الفئة" data-testid="select-category-kind" className="h-10 rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            <option value="food">طعام</option>
            <option value="drink">مشروبات</option>
            <option value="dessert">حلويات</option>
            <option value="other">أخرى</option>
          </select>
          <Input type="number" placeholder="الترتيب" value={draft.displayOrder}
            onChange={e => setDraft({ ...draft, displayOrder: Number(e.target.value) })}
            aria-label="ترتيب عرض الفئة" data-testid="input-category-order" className="bg-background" />
          <Input type="color" value={draft.color || "#f59e0b"}
            onChange={e => setDraft({ ...draft, color: e.target.value })}
            aria-label="لون الفئة" data-testid="input-category-color" className="h-10 bg-background" />
        </div>
        <Button data-testid="button-create-category" className="mt-3 font-bold"
          disabled={!draft.code || !draft.nameAr || create.isPending}
          onClick={() => create.mutate()}>
          <Plus className="h-4 w-4 ml-1" /> إضافة
        </Button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="border-b border-border p-4 font-black">الفئات <span className="text-sm font-semibold text-muted-foreground">({catsQ.data?.length ?? 0})</span></div>
        {catsQ.isLoading ? <div role="status" className="p-8 text-center"><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin text-primary" />جارٍ تحميل الفئات</div> :
          catsQ.isError ? <div className="p-8 text-center text-sm text-destructive" role="alert">تعذّر تحميل الفئات. <button className="font-bold underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => catsQ.refetch()}>إعادة المحاولة</button></div> :
          (catsQ.data ?? []).length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">لا توجد فئات بعد. أضف أول فئة للقائمة.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted text-muted-foreground">
                <tr>
                  <th className="p-2 text-right">اللون</th>
                  <th className="p-2 text-right">الرمز</th>
                  <th className="p-2 text-right">الاسم</th>
                  <th className="p-2 text-right">النوع</th>
                  <th className="p-2 text-right">الترتيب</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {catsQ.data!.map(c => editId === c.id ? (
                  <tr key={c.id} className="border-t border-primary/30 bg-primary/[0.04]">
                    <td className="p-1"><Input aria-label="لون الفئة" type="color" value={editBuf.color ?? "#0f766e"} onChange={e => setEditBuf({ ...editBuf, color: e.target.value })} className="h-8 w-14 bg-background" /></td>
                    <td className="p-1"><Input aria-label="رمز الفئة" value={editBuf.code ?? ""} onChange={e => setEditBuf({ ...editBuf, code: e.target.value })} className="h-8 bg-background" /></td>
                    <td className="p-1"><Input aria-label="اسم الفئة" value={editBuf.nameAr ?? ""} onChange={e => setEditBuf({ ...editBuf, nameAr: e.target.value })} className="h-8 bg-background" /></td>
                    <td className="p-1">
                      <select value={editBuf.kind ?? "food"}
                        onChange={e => setEditBuf({ ...editBuf, kind: e.target.value as any })}
                        aria-label="نوع الفئة" className="h-8 rounded-lg border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                        <option value="food">طعام</option>
                        <option value="drink">مشروبات</option>
                        <option value="dessert">حلويات</option>
                        <option value="other">أخرى</option>
                      </select>
                    </td>
                    <td className="p-1"><Input aria-label="ترتيب الفئة" type="number" value={editBuf.displayOrder ?? 0} onChange={e => setEditBuf({ ...editBuf, displayOrder: Number(e.target.value) })} className="h-8 w-16 bg-background" /></td>
                    <td className="p-1 text-left whitespace-nowrap">
                      <Button variant="ghost" size="sm" aria-label="حفظ تعديل الفئة" data-testid={`button-save-category-${c.id}`} disabled={update.isPending} onClick={() => update.mutate()}>
                        <Save className="h-4 w-4 text-primary" />
                      </Button>
                      <Button variant="ghost" size="sm" aria-label="إلغاء تعديل الفئة" onClick={() => { setEditId(null); setEditBuf({}); }}>
                        <X className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    </td>
                  </tr>
                ) : (
                  <tr key={c.id} className="border-t border-border/70 hover:bg-muted/40">
                    <td className="p-2"><span className="inline-block w-6 h-6 rounded" style={{ background: c.color ?? "#475569" }} /></td>
                    <td className="p-2">{c.code}</td>
                    <td className="p-2 font-semibold">{c.nameAr}</td>
                    <td className="p-2 text-xs">{kindLabel(c.kind)}</td>
                    <td className="p-2">{c.displayOrder}</td>
                    <td className="p-2 text-left whitespace-nowrap">
                      <Button variant="ghost" size="sm" aria-label={`تعديل ${c.nameAr}`} data-testid={`button-edit-category-${c.id}`} onClick={() => startEdit(c)}>
                        <Pencil className="h-4 w-4 text-primary" />
                      </Button>
                      <Button variant="ghost" size="sm" aria-label={`حذف ${c.nameAr}`} data-testid={`button-delete-category-${c.id}`} onClick={() => { if (confirm("حذف الفئة؟")) del.mutate(c.id); }}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </div>
  );
}

// ─── Items ───────────────────────────────────────────────────────────────
function ItemsTab({ companyId }: { companyId: number | null }) {
  const qc = useQueryClient();
  const catsQ = useQuery({ queryKey: ["r-cats-all"], queryFn: () => api.rCategories() });
  const itemsQ = useQuery({ queryKey: ["r-items-all"], queryFn: () => api.rMenuItems() });
  const [draft, setDraft] = useState({
    categoryId: "" as string | number, code: "", nameAr: "", price: 0,
    prepTimeMinutes: 0, kitchenStation: "kitchen" as RMenuItem["kitchenStation"],
    itemId: null as number | null,
    vatIncluded: true,
  });
  const [editId, setEditId] = useState<number | null>(null);
  const [editBuf, setEditBuf] = useState<Partial<RMenuItem>>({});

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["r-items-all"] });
    qc.invalidateQueries({ queryKey: ["r-items"] });
  };

  const create = useMutation({
    mutationFn: () => api.rCreateMenuItem({
      categoryId: Number(draft.categoryId), code: draft.code, nameAr: draft.nameAr,
      price: String(draft.price), prepTimeMinutes: draft.prepTimeMinutes,
      kitchenStation: draft.kitchenStation, itemId: draft.itemId, vatIncluded: draft.vatIncluded,
    }),
    onSuccess: () => {
      setDraft({ ...draft, code: "", nameAr: "", price: 0, prepTimeMinutes: 0, itemId: null, vatIncluded: true });
      invalidate();
    },
    onError: (e: any) => alert(e?.message ?? "فشل الإنشاء"),
  });
  const update = useMutation({
    mutationFn: () => api.rUpdateMenuItem(editId!, editBuf),
    onSuccess: () => { setEditId(null); setEditBuf({}); invalidate(); },
    onError: (e: any) => alert(e?.message ?? "فشل التحديث"),
  });
  const del = useMutation({
    mutationFn: (id: number) => api.rDeleteMenuItem(id),
    onSuccess: invalidate,
  });

  const startEdit = (it: RMenuItem) => {
    setEditId(it.id);
    setEditBuf({ categoryId: it.categoryId, code: it.code, nameAr: it.nameAr, price: it.price, prepTimeMinutes: it.prepTimeMinutes, kitchenStation: it.kitchenStation, itemId: it.itemId ?? null, vatIncluded: it.vatIncluded });
  };

  const catName = (id: number) => catsQ.data?.find(c => c.id === id)?.nameAr ?? "—";

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5">
        <div className="font-bold mb-3">إضافة صنف جديد</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <select value={draft.categoryId}
            onChange={e => setDraft({ ...draft, categoryId: e.target.value })}
            aria-label="فئة الصنف" data-testid="select-item-category" className="h-10 rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            <option value="">اختر الفئة</option>
            {(catsQ.data ?? []).map(c => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
          </select>
          <Input placeholder="الرمز" value={draft.code}
            onChange={e => setDraft({ ...draft, code: e.target.value })}
            aria-label="رمز الصنف" data-testid="input-item-code" className="bg-background" />
          <Input placeholder="الاسم (شاورما عربي)" value={draft.nameAr}
            onChange={e => setDraft({ ...draft, nameAr: e.target.value })}
            aria-label="اسم الصنف" data-testid="input-item-name" className="bg-background" />
          <Input type="number" step="0.01" placeholder="السعر" value={draft.price}
            onChange={e => setDraft({ ...draft, price: Number(e.target.value) })}
            aria-label="سعر الصنف" data-testid="input-item-price" className="bg-background" />
          <Input type="number" placeholder="وقت التحضير (دقائق)" value={draft.prepTimeMinutes}
            onChange={e => setDraft({ ...draft, prepTimeMinutes: Number(e.target.value) })}
            aria-label="وقت تحضير الصنف بالدقائق" data-testid="input-item-prep-time" className="bg-background" />
          <select value={draft.kitchenStation}
            onChange={e => setDraft({ ...draft, kitchenStation: e.target.value as any })}
            aria-label="محطة التحضير" data-testid="select-item-station" className="h-10 rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            <option value="kitchen">المطبخ</option>
            <option value="grill">الشواية</option>
            <option value="bar">البار</option>
            <option value="cold">البارد</option>
            <option value="dessert">الحلويات</option>
          </select>
        </div>
        <div className="mt-3">
          <ErpItemPicker
            companyId={companyId}
            value={draft.itemId}
            onChange={itemId => setDraft({ ...draft, itemId })}
          />
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm font-semibold">
          <input
            type="checkbox"
            checked={draft.vatIncluded}
            onChange={event => setDraft({ ...draft, vatIncluded: event.target.checked })}
            data-testid="checkbox-menu-price-vat-included"
          />
          السعر شامل ضريبة القيمة المضافة
        </label>
        <Button data-testid="button-create-menu-item" className="mt-3 font-bold"
          disabled={!draft.categoryId || !draft.code || !draft.nameAr || create.isPending}
          onClick={() => create.mutate()}>
          <Plus className="h-4 w-4 ml-1" /> إضافة
        </Button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="border-b border-border p-4 font-black">الأصناف <span className="text-sm font-semibold text-muted-foreground">({itemsQ.data?.length ?? 0})</span></div>
        {itemsQ.isLoading ? <div role="status" className="p-8 text-center"><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin text-primary" />جارٍ تحميل الأصناف</div> :
          itemsQ.isError ? <div className="p-8 text-center text-sm text-destructive" role="alert">تعذّر تحميل الأصناف. <button className="font-bold underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => itemsQ.refetch()}>إعادة المحاولة</button></div> :
          (itemsQ.data ?? []).length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">لا توجد أصناف بعد. أضف صنفاً جديداً إلى القائمة.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted text-muted-foreground">
                <tr>
                  <th className="p-2 text-right">الرمز</th>
                  <th className="p-2 text-right">الاسم</th>
                  <th className="p-2 text-right">الفئة</th>
                  <th className="p-2 text-right">المحطة</th>
                  <th className="p-2 text-right">وقت</th>
                  <th className="p-2 text-right">السعر</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {itemsQ.data!.map(it => editId === it.id ? (
                  <tr key={it.id} className="border-t border-primary/30 bg-primary/[0.04]">
                    <td className="p-1"><Input aria-label="رمز الصنف" value={editBuf.code ?? ""} onChange={e => setEditBuf({ ...editBuf, code: e.target.value })} className="h-8 bg-background" /></td>
                    <td className="p-1">
                      <Input aria-label="اسم الصنف" value={editBuf.nameAr ?? ""} onChange={e => setEditBuf({ ...editBuf, nameAr: e.target.value })} className="h-8 bg-background" />
                      <ErpItemPicker
                        companyId={companyId}
                        value={editBuf.itemId ?? null}
                        onChange={itemId => setEditBuf({ ...editBuf, itemId })}
                      />
                      <label className="mt-2 flex items-center gap-2 text-[11px] font-medium">
                        <input
                          type="checkbox"
                          checked={editBuf.vatIncluded ?? true}
                          onChange={event => setEditBuf({ ...editBuf, vatIncluded: event.target.checked })}
                          aria-label="السعر شامل ضريبة القيمة المضافة"
                        />
                        السعر شامل الضريبة
                      </label>
                    </td>
                    <td className="p-1">
                      <select value={editBuf.categoryId ?? ""}
                        onChange={e => setEditBuf({ ...editBuf, categoryId: Number(e.target.value) })}
                        aria-label="فئة الصنف" className="h-8 rounded-lg border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                        {(catsQ.data ?? []).map(c => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
                      </select>
                    </td>
                    <td className="p-1">
                      <select value={editBuf.kitchenStation ?? "kitchen"}
                        onChange={e => setEditBuf({ ...editBuf, kitchenStation: e.target.value as any })}
                        aria-label="محطة تحضير الصنف" className="h-8 rounded-lg border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                        <option value="kitchen">المطبخ</option>
                        <option value="grill">الشواية</option>
                        <option value="bar">البار</option>
                        <option value="cold">البارد</option>
                        <option value="dessert">الحلويات</option>
                      </select>
                    </td>
                    <td className="p-1"><Input aria-label="وقت التحضير" type="number" value={editBuf.prepTimeMinutes ?? 0} onChange={e => setEditBuf({ ...editBuf, prepTimeMinutes: Number(e.target.value) })} className="h-8 w-16 bg-background" /></td>
                    <td className="p-1"><Input aria-label="سعر الصنف" type="number" step="0.01" value={editBuf.price as any ?? 0} onChange={e => setEditBuf({ ...editBuf, price: e.target.value as any })} className="h-8 w-20 bg-background" /></td>
                    <td className="p-1 text-left whitespace-nowrap">
                      <Button variant="ghost" size="sm" aria-label="حفظ تعديل الصنف" data-testid={`button-save-item-${it.id}`} disabled={update.isPending} onClick={() => update.mutate()}>
                        <Save className="h-4 w-4 text-primary" />
                      </Button>
                      <Button variant="ghost" size="sm" aria-label="إلغاء تعديل الصنف" onClick={() => { setEditId(null); setEditBuf({}); }}>
                        <X className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    </td>
                  </tr>
                ) : (
                  <tr key={it.id} className="border-t border-border/70 hover:bg-muted/40">
                    <td className="p-2">{it.code}</td>
                    <td className="p-2 font-semibold">
                      <div>{it.nameAr}</div>
                      <div className={`mt-1 text-[11px] ${it.itemId ? "text-emerald-700" : "text-amber-700"}`}>
                        {it.itemId ? `مرتبط بصنف ERP #${it.itemId}` : "غير مربوط بصنف ERP — لن يقبل الفوترة"}
                      </div>
                    </td>
                    <td className="p-2 text-muted-foreground">{catName(it.categoryId)}</td>
                    <td className="p-2 text-xs">{stationLabel(it.kitchenStation)}</td>
                    <td className="p-2">{it.prepTimeMinutes} د</td>
                    <td className="p-2 font-bold text-primary">{Number(it.price).toFixed(2)}</td>
                    <td className="p-2 text-left whitespace-nowrap">
                      <Button variant="ghost" size="sm" aria-label={`تعديل ${it.nameAr}`} data-testid={`button-edit-item-${it.id}`} onClick={() => startEdit(it)}>
                        <Pencil className="h-4 w-4 text-primary" />
                      </Button>
                      <Button variant="ghost" size="sm" aria-label={`حذف ${it.nameAr}`} data-testid={`button-delete-item-${it.id}`} onClick={() => { if (confirm("حذف الصنف؟")) del.mutate(it.id); }}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </div>
  );
}

function kindLabel(k: string) {
  return k === "food" ? "طعام" : k === "drink" ? "مشروبات" : k === "dessert" ? "حلويات" : "أخرى";
}
function stationLabel(s: string) {
  return s === "kitchen" ? "المطبخ" : s === "grill" ? "الشواية" : s === "bar" ? "البار" : s === "cold" ? "البارد" : "الحلويات";
}

function ErpItemPicker({
  companyId,
  value,
  onChange,
}: {
  companyId: number | null;
  value: number | null;
  onChange: (itemId: number | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [changing, setChanging] = useState(false);
  const search = useQuery({
    queryKey: ["restaurant-erp-item-search", companyId, query],
    queryFn: () => api.searchItems(companyId!, query.trim()),
    enabled: companyId != null && query.trim().length >= 2,
    staleTime: 30_000,
  });
  const selected = useQuery({
    queryKey: ["restaurant-erp-item-selected", companyId, value],
    queryFn: () => api.lookupItems(companyId!, [value!]),
    enabled: companyId != null && value != null && value > 0,
    staleTime: 60_000,
  });
  const showInput = value == null || changing;

  return (
    <div className="mt-2 min-w-48">
      <div className="mb-1 text-[11px] font-semibold text-muted-foreground">
        ربط بصنف ERP موجود (مطلوب لإصدار الفاتورة)
      </div>
      {value != null && !changing && (
        <div className="mb-1 flex items-center gap-2 text-xs">
          <span className="truncate font-semibold">
            {selected.data?.[0]
              ? `${selected.data[0].nameAr} · ${selected.data[0].code} · ${selected.data[0].itemType === "stock" ? "مخزني" : "خدمة"}`
              : selected.isLoading ? "جارٍ تحميل الصنف المرتبط..." : `صنف ERP #${value}`}
          </span>
          <button type="button" className="shrink-0 text-primary underline" onClick={() => setChanging(true)}>تغيير</button>
          <button type="button" className="shrink-0 text-destructive underline" onClick={() => onChange(null)}>إزالة</button>
        </div>
      )}
      {showInput && (
        <>
          <Input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="ابحث بالاسم أو الرمز (حرفان فأكثر)"
            aria-label="البحث عن صنف مخزون أو خدمة"
            data-testid="input-restaurant-erp-item-search"
            disabled={companyId == null}
            className="h-9 bg-background text-xs"
          />
          {query.trim().length >= 2 && (
            <div role="listbox" aria-label="نتائج أصناف ERP" className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-card shadow-md">
              {search.isFetching ? (
                <div className="p-2 text-xs text-muted-foreground">جارٍ البحث...</div>
              ) : (search.data ?? []).length === 0 ? (
                <div className="p-2 text-xs text-muted-foreground">لا توجد أصناف مخزون أو خدمات مطابقة</div>
              ) : (search.data ?? []).map(item => (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={value === item.id}
                  className="block w-full border-b border-border/60 p-2 text-right text-xs hover:bg-muted"
                  onClick={() => {
                    onChange(item.id);
                    setQuery("");
                    setChanging(false);
                  }}
                >
                  <span className="font-bold">{item.nameAr}</span>
                  <span className="mr-2 text-muted-foreground">{item.code} · {item.itemType === "stock" ? "مخزني" : "خدمة"}</span>
                </button>
              ))}
            </div>
          )}
          {changing && <button type="button" className="mt-1 text-xs text-muted-foreground underline" onClick={() => { setChanging(false); setQuery(""); }}>إلغاء التغيير</button>}
        </>
      )}
    </div>
  );
}
