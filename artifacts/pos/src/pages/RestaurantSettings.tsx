import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus, Trash2, Loader2, Save, X, Pencil, Settings, Utensils, ListOrdered, Tags, Sparkles, MapPin, AlertCircle, Clock3, QrCode, Award, CalendarClock, ChefHat } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  api, getToken, getStoredUser,
  type Branch, type Item, type RTable, type RMenuCategory, type RMenuItem, type RKitchenStation, type RLoyaltyProgram, type RLoyaltyRule, type RLoyaltyTier,
} from "@/lib/api";
import ShiftManagementTab from "@/components/ShiftManagementTab";
import RestaurantReservationsTab from "@/components/RestaurantReservationsTab";

const TABS = [
  { id: "tables",  label: "الطاولات",   icon: ListOrdered },
  { id: "cats",    label: "فئات القائمة",     icon: Tags },
  { id: "items",   label: "أصناف القائمة",   icon: Utensils },
  { id: "stations", label: "محطات المطبخ", icon: ChefHat },
  { id: "reservations", label: "الحجوزات", icon: CalendarClock },
  { id: "shifts",  label: "الورديات", icon: Clock3 },
  { id: "loyalty", label: "الولاء", icon: Award },
] as const;

type Tab = typeof TABS[number]["id"];

export default function RestaurantSettings() {
  const [, setLocation] = useLocation();
  const returnTarget = new URLSearchParams(window.location.search).get("returnTo");
  const returnTo = returnTarget === "waiter"
    ? "/waiter"
    : returnTarget === "cashier"
      ? "/pos"
      : "/restaurant";
  const [tab, setTab] = useState<Tab>(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    return TABS.some(item => item.id === requested) ? requested as Tab : "tables";
  });

  useEffect(() => { if (!getToken()) setLocation("/login"); }, [setLocation]);

  const user = getStoredUser();
  const cid = user?.companyId ?? null;
  const canManageShifts = user?.role === "admin" || user?.role === "superadmin";
  const canManageLoyalty = canManageShifts || user?.role === "manager";
  const visibleTabs = TABS.filter(item => item.id !== "shifts" || canManageShifts).filter(item => item.id !== "loyalty" || canManageLoyalty);

  const branchesQ = useQuery({
    queryKey: ["branches", cid],
    queryFn: () => cid ? api.getBranches(cid) : Promise.resolve([]),
    enabled: !!cid,
  });

  return (
    <div dir="rtl" className="min-h-[100dvh] bg-background text-foreground">
      <header className="sticky top-0 z-20 flex min-h-16 items-center gap-3 border-b border-border/80 bg-card px-3 py-2 shadow-sm sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setLocation(returnTo, { replace: true })} aria-label="العودة إلى الشاشة السابقة" data-testid="button-settings-back">
            <ChevronRight className="h-4 w-4 ml-1" /> رجوع
          </Button>
          <div className="grid size-10 shrink-0 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-sm"><Settings className="h-5 w-5" /></div>
          <div className="min-w-0">
            <div className="truncate text-base font-black">إعدادات المطعم</div>
            <p className="text-xs text-muted-foreground">الطاولات وقائمة النادل ومسار الطلب للمطبخ والكاشير</p>
          </div>
        </div>
      </header>

      <nav className="sticky top-16 z-10 flex overflow-x-auto border-b border-border bg-card/95 px-3 backdrop-blur" aria-label="أقسام إعدادات المطعم">
        {visibleTabs.map(t => {
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
        <section aria-labelledby="restaurant-role-heading" className="mb-5 rounded-2xl border border-primary/20 bg-primary/[0.04] p-4 sm:p-5">
          <h1 id="restaurant-role-heading" className="font-black">ما وظيفة نظام المطعم؟</h1>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            يدير قائمة النادل وطلبات الطاولات والتحضير والتحصيل. لا يستبدل أصناف المخزون أو حساباته.
          </p>
          <div className="mt-3 grid gap-2 text-xs font-semibold sm:grid-cols-4">
            <div className="rounded-lg bg-background px-3 py-2">١. إعداد فئات وأصناف قائمة النادل</div>
            <div className="rounded-lg bg-background px-3 py-2">٢. تسجيل الطلب على الطاولة</div>
            <div className="rounded-lg bg-background px-3 py-2">٣. إرسال الأصناف لمحطات التحضير</div>
            <div className="rounded-lg bg-background px-3 py-2">٤. إصدار فاتورة البيع من الكاشير</div>
          </div>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            اربط كل صنف في القائمة بصنف مخزون أو خدمة من ERP حتى يظهر في الفاتورة وتُسجل الحركة على السجل الصحيح. الربط الحالي لصنف ERP واحد، وليس وصفة متعددة المكونات.
          </p>
        </section>
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
        {tab === "stations" && <KitchenStationsTab />}
        {tab === "reservations" && <RestaurantReservationsTab branches={branchesQ.data ?? []} />}
        {tab === "shifts" && canManageShifts && cid && <ShiftManagementTab companyId={cid} />}
        {tab === "loyalty" && canManageLoyalty && <RestaurantLoyaltyTab />}
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
  const [qrTable, setQrTable] = useState<{ id: number; nameAr: string; token: string } | null>(null);

  useEffect(() => {
    if (!branches.length) return;
    const preferredId = Number(localStorage.getItem("pos_branch_id") || 0);
    const branch = branches.find(item => item.id === preferredId)
      ?? branches.find(item => (item as Branch & { isMain?: boolean }).isMain === true)
      ?? branches[0];
    if (!batch.branchId) setBatch(current => ({ ...current, branchId: String(branch.id) }));
    if (!draft.branchId) setDraft(current => ({ ...current, branchId: String(branch.id) }));
  }, [branches, batch.branchId, draft.branchId]);

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

  const createQr = useMutation({
    mutationFn: (table: RTable) => api.rCreateTableQrToken(table.id),
    onSuccess: (result, table) => setQrTable({ id: table.id, nameAr: table.nameAr, token: result.token }),
  });
  const revokeQr = useMutation({
    mutationFn: (id: number) => api.rRevokeTableQrToken(id),
    onSuccess: () => { setQrTable(null); invalidate(); },
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
                      <Button variant="ghost" size="sm" aria-label={`إنشاء QR لـ ${t.nameAr}`} data-testid={`button-table-qr-${t.id}`} disabled={createQr.isPending} onClick={() => createQr.mutate(t)}>
                        <QrCode className="h-4 w-4 text-primary" />
                      </Button>
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
      <Dialog open={!!qrTable} onOpenChange={open => !open && setQrTable(null)}>
        <DialogContent className="max-w-sm text-center">
          <DialogHeader><DialogTitle>رمز الطلب الذاتي · {qrTable?.nameAr}</DialogTitle></DialogHeader>
          {qrTable && <div className="flex flex-col items-center gap-4">
            <QRCodeSVG value={`${window.location.origin}${import.meta.env.BASE_URL}qr-order/${qrTable.token}`} size={240} level="M" includeMargin />
            <p className="text-sm text-muted-foreground">امسح الرمز لعرض قائمة الطعام وإرسال طلب ينتظر تأكيد الموظف.</p>
            <Button variant="destructive" disabled={revokeQr.isPending} onClick={() => revokeQr.mutate(qrTable.id)}>إلغاء هذا الرمز</Button>
          </div>}
        </DialogContent>
      </Dialog>
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
      <p className="rounded-xl border border-border bg-muted/30 p-3 text-sm leading-6 text-muted-foreground">
        فئات القائمة لتنظيم ما يراه النادل، مثل الوجبات والمشروبات والحلويات. لا تنشئ مجموعة أصناف أو تصنيفًا محاسبيًا في المخزون.
      </p>
      <div className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5">
        <div className="font-bold mb-3">إضافة فئة لقائمة المطعم</div>
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
        <div className="border-b border-border p-4 font-black">فئات قائمة المطعم <span className="text-sm font-semibold text-muted-foreground">({catsQ.data?.length ?? 0})</span></div>
        {catsQ.isLoading ? <div role="status" className="p-8 text-center"><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin text-primary" />جارٍ تحميل الفئات</div> :
          catsQ.isError ? <div className="p-8 text-center text-sm text-destructive" role="alert">تعذّر تحميل الفئات. <button className="font-bold underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => catsQ.refetch()}>إعادة المحاولة</button></div> :
          (catsQ.data ?? []).length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">لا توجد فئات لقائمة المطعم بعد. أضف فئة مثل الوجبات أو المشروبات.</div>
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

function KitchenStationsTab() {
  const qc = useQueryClient();
  const [nameAr, setNameAr] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [names, setNames] = useState<Record<number, string>>({});
  const stationsQ = useQuery({ queryKey: ["r-kitchen-stations"], queryFn: () => api.rKitchenStations() });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["r-kitchen-stations"] });
    void qc.invalidateQueries({ queryKey: ["r-kitchen-display-stations"] });
    void qc.invalidateQueries({ queryKey: ["r-items-all"] });
  };
  const create = useMutation({
    mutationFn: () => api.rCreateKitchenStation({ nameAr: nameAr.trim(), nameEn: nameEn.trim() || undefined }),
    onSuccess: () => { setNameAr(""); setNameEn(""); refresh(); },
    onError: (error: any) => alert(error?.message ?? "تعذرت إضافة المحطة"),
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Partial<Pick<RKitchenStation, "nameAr" | "isActive">> }) =>
      api.rUpdateKitchenStation(id, patch),
    onSuccess: refresh,
    onError: (error: any) => alert(error?.message ?? "تعذر تحديث المحطة"),
  });

  return (
    <div className="space-y-4">
      <p className="rounded-xl border border-border bg-muted/30 p-3 text-sm leading-6 text-muted-foreground">
        أضف محطات التحضير وسمّها كما تعمل في مطعمك، ثم اربط أصناف القائمة بالمحطة المناسبة. لا يمكن تعطيل محطة ما زالت مرتبطة بأصناف أو تذاكر نشطة.
      </p>
      <div className="grid gap-2 rounded-2xl border border-border bg-card p-4 shadow-sm sm:grid-cols-[1fr_1fr_auto]">
        <Input value={nameAr} onChange={event => setNameAr(event.target.value)} maxLength={80} placeholder="اسم المحطة بالعربية" aria-label="اسم محطة المطبخ بالعربية" />
        <Input value={nameEn} onChange={event => setNameEn(event.target.value)} maxLength={80} placeholder="اسم المحطة بالإنجليزية (اختياري)" aria-label="اسم محطة المطبخ بالإنجليزية" />
        <Button disabled={!nameAr.trim() || create.isPending} onClick={() => create.mutate()}><Plus className="ml-1 h-4 w-4" />إضافة محطة</Button>
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        {stationsQ.isLoading ? <div className="p-8 text-center"><Loader2 className="mx-auto animate-spin" /></div> :
          stationsQ.isError ? <div className="p-5 text-sm text-destructive" role="alert">تعذر تحميل المحطات. <button className="underline" onClick={() => stationsQ.refetch()}>إعادة المحاولة</button></div> :
          <div className="divide-y divide-border">
            {(stationsQ.data ?? []).map(station => (
              <div key={station.id} className="flex flex-wrap items-center gap-2 p-3 sm:flex-nowrap">
                <Input
                  value={names[station.id] ?? station.nameAr}
                  onChange={event => setNames(current => ({ ...current, [station.id]: event.target.value }))}
                  maxLength={80}
                  aria-label={`اسم محطة ${station.nameAr}`}
                  className="min-w-40 flex-1"
                />
                <span className={`min-w-16 text-xs ${station.isActive ? "text-emerald-700" : "text-muted-foreground"}`}>
                  {station.isActive ? "نشطة" : "معطلة"}
                </span>
                <Button
                  variant="outline" size="sm"
                  disabled={update.isPending || !(names[station.id] ?? station.nameAr).trim() || (names[station.id] ?? station.nameAr) === station.nameAr}
                  onClick={() => update.mutate({ id: station.id, patch: { nameAr: (names[station.id] ?? station.nameAr).trim() } })}
                ><Save className="ml-1 h-4 w-4" />حفظ الاسم</Button>
                <Button
                  variant={station.isActive ? "ghost" : "outline"} size="sm"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ id: station.id, patch: { isActive: !station.isActive } })}
                >{station.isActive ? "تعطيل" : "تفعيل"}</Button>
              </div>
            ))}
            {(stationsQ.data ?? []).length === 0 && <div className="p-6 text-center text-sm text-muted-foreground">لا توجد محطات بعد.</div>}
          </div>}
      </div>
    </div>
  );
}

// ─── Items ───────────────────────────────────────────────────────────────
function ItemsTab({ companyId }: { companyId: number | null }) {
  const qc = useQueryClient();
  const catsQ = useQuery({ queryKey: ["r-cats-all"], queryFn: () => api.rCategories() });
  const itemsQ = useQuery({ queryKey: ["r-items-all"], queryFn: () => api.rMenuItems() });
  const stationsQ = useQuery({ queryKey: ["r-kitchen-stations"], queryFn: () => api.rKitchenStations() });
  const [bulkQuery, setBulkQuery] = useState("");
  const [bulkSelected, setBulkSelected] = useState<Record<number, Item>>({});
  const [bulkCategoryId, setBulkCategoryId] = useState("");
  const [bulkStation, setBulkStation] = useState<string>("kitchen");
  const [bulkVatIncluded, setBulkVatIncluded] = useState(true);
  const [bulkMessage, setBulkMessage] = useState("");
  const [draft, setDraft] = useState({
    categoryId: "" as string | number, code: "", nameAr: "", price: 0,
    prepTimeMinutes: 0, kitchenStation: "kitchen" as RMenuItem["kitchenStation"],
    itemId: null as number | null,
    vatIncluded: true,
  });
  const [editId, setEditId] = useState<number | null>(null);
  const [editBuf, setEditBuf] = useState<Partial<RMenuItem>>({});
  const bulkSearchQ = useQuery({
    queryKey: ["restaurant-erp-bulk-search", companyId, bulkQuery.trim()],
    queryFn: () => api.searchItems(companyId!, bulkQuery.trim()),
    enabled: companyId != null && bulkQuery.trim().length >= 2,
    staleTime: 30_000,
  });

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
  const importSelected = useMutation({
    mutationFn: async () => {
      const linkedIds = new Set((itemsQ.data ?? []).map(item => item.itemId).filter((id): id is number => Number.isInteger(id)));
      const selected = Object.values(bulkSelected).filter(item => !linkedIds.has(item.id));
      const createdIds: number[] = [];
      const failed: string[] = [];
      for (const item of selected) {
        try {
          await api.rCreateMenuItem({
            categoryId: Number(bulkCategoryId),
            code: item.code,
            nameAr: item.nameAr,
            nameEn: item.nameEn ?? null,
            price: String(item.salePrice ?? "0"),
            prepTimeMinutes: 0,
            kitchenStation: bulkStation,
            itemId: item.id,
            vatIncluded: bulkVatIncluded,
          });
          createdIds.push(item.id);
        } catch {
          failed.push(item.nameAr);
        }
      }
      return { createdIds, failed };
    },
    onSuccess: ({ createdIds, failed }) => {
      if (createdIds.length) invalidate();
      setBulkSelected(current => Object.fromEntries(
        Object.entries(current).filter(([id]) => !createdIds.includes(Number(id))),
      ));
      setBulkMessage(
        failed.length
          ? `تم استيراد ${createdIds.length} صنف، وتعذّر استيراد: ${failed.join("، ")}`
          : `تمت إضافة ${createdIds.length} صنف إلى قائمة المطعم.`,
      );
    },
  });
  const linkedItemIds = new Set(
    (itemsQ.data ?? []).map(item => item.itemId).filter((id): id is number => Number.isInteger(id)),
  );

  const startEdit = (it: RMenuItem) => {
    setEditId(it.id);
    setEditBuf({ categoryId: it.categoryId, code: it.code, nameAr: it.nameAr, price: it.price, prepTimeMinutes: it.prepTimeMinutes, kitchenStation: it.kitchenStation, itemId: it.itemId ?? null, vatIncluded: it.vatIncluded });
  };

  const catName = (id: number) => catsQ.data?.find(c => c.id === id)?.nameAr ?? "—";

  return (
    <div className="space-y-4">
      <p className="rounded-xl border border-border bg-muted/30 p-3 text-sm leading-6 text-muted-foreground">
        صنف القائمة هو ما يظهر للنادل بسعر البيع ومحطة التحضير. لا ينشئ صنف مخزون جديدًا؛ استورد صنفًا موجودًا أو اربطه به حتى تُصدر الفاتورة على الصنف الصحيح.
      </p>
      <details className="group rounded-2xl border border-border bg-card shadow-sm">
        <summary className="cursor-pointer list-none p-4 font-bold marker:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <span className="inline-flex items-center gap-2"><Plus className="h-4 w-4 text-primary" />إضافة أصناف مخزون إلى قائمة المطعم</span>
          <span className="float-left text-xs font-normal text-muted-foreground">اختر الأصناف والفئة قبل الإضافة</span>
        </summary>
        <div className="space-y-3 border-t border-border p-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <select
              value={bulkCategoryId}
              onChange={event => { setBulkCategoryId(event.target.value); setBulkMessage(""); }}
              aria-label="فئة الأصناف المستوردة"
              data-testid="select-bulk-import-category"
              className="h-10 rounded-lg border border-input bg-background px-3 text-sm"
            >
              <option value="">اختر فئة قائمة المطعم</option>
              {(catsQ.data ?? []).map(category => <option key={category.id} value={category.id}>{category.nameAr}</option>)}
            </select>
            <select
              value={bulkStation}
              onChange={event => setBulkStation(event.target.value)}
              aria-label="محطة تحضير الأصناف المستوردة"
              data-testid="select-bulk-import-station"
              className="h-10 rounded-lg border border-input bg-background px-3 text-sm"
            >
              {(stationsQ.data ?? []).filter(station => station.isActive).map(station => <option key={station.id} value={station.stationKey}>{station.nameAr}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={bulkVatIncluded}
              onChange={event => setBulkVatIncluded(event.target.checked)}
              data-testid="checkbox-bulk-import-vat-included"
            />
            سعر الصنف المستورد شامل ضريبة القيمة المضافة
          </label>
          <div>
            <Input
              value={bulkQuery}
              onChange={event => { setBulkQuery(event.target.value); setBulkMessage(""); }}
              placeholder="ابحث في المخزون بالاسم أو الرمز (حرفان فأكثر)"
              aria-label="البحث عن أصناف للاستيراد"
              data-testid="input-bulk-import-search"
              disabled={companyId == null}
              className="bg-background"
            />
          </div>
          {Object.keys(bulkSelected).length > 0 && (
            <p className="text-xs font-semibold text-primary" role="status">
              محدد {Object.keys(bulkSelected).length} صنف — سيتم نسخ سعر البيع الحالي وربط كل صنف بسجله في المخزون.
            </p>
          )}
          {bulkQuery.trim().length >= 2 && (
            <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
              {bulkSearchQ.isFetching ? (
                <p className="p-3 text-sm text-muted-foreground">جارٍ البحث في المخزون...</p>
              ) : bulkSearchQ.isError ? (
                <p className="p-3 text-sm text-destructive" role="alert">تعذّر البحث عن الأصناف.</p>
              ) : (bulkSearchQ.data ?? []).length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">لا توجد أصناف مخزون أو خدمات مطابقة.</p>
              ) : (
                (bulkSearchQ.data ?? []).map(item => {
                  const linked = linkedItemIds.has(item.id);
                  return (
                    <label key={item.id} className={`flex items-center gap-3 border-b border-border/60 p-3 last:border-b-0 ${linked ? "opacity-55" : "cursor-pointer hover:bg-muted/40"}`}>
                      <input
                        type="checkbox"
                        checked={linked || !!bulkSelected[item.id]}
                        disabled={linked}
                        onChange={event => {
                          setBulkSelected(current => {
                            const next = { ...current };
                            if (event.target.checked) next[item.id] = item;
                            else delete next[item.id];
                            return next;
                          });
                        }}
                        aria-label={`${linked ? "مضاف بالفعل" : "اختيار"} ${item.nameAr}`}
                        data-testid={`checkbox-bulk-import-item-${item.id}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">{item.nameAr}</span>
                        <span className="block text-xs text-muted-foreground">{item.code} · {item.itemType === "stock" ? "مخزني" : "خدمة"}</span>
                      </span>
                      <span className="shrink-0 text-sm font-bold tabular-nums">{Number(item.salePrice || 0).toFixed(2)} ر.س</span>
                      {linked && <span className="shrink-0 text-xs text-muted-foreground">مضاف</span>}
                    </label>
                  );
                })
              )}
            </div>
          )}
          {bulkMessage && <p role="status" data-testid="status-bulk-import" className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm font-semibold text-primary">{bulkMessage}</p>}
          <Button
            type="button"
            data-testid="button-bulk-import-items"
            disabled={!bulkCategoryId || Object.keys(bulkSelected).length === 0 || importSelected.isPending}
            onClick={() => { setBulkMessage(""); importSelected.mutate(); }}
          >
            {importSelected.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Plus className="ml-2 h-4 w-4" />}
            إضافة الأصناف المحددة ({Object.keys(bulkSelected).length})
          </Button>
        </div>
      </details>

      <div className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5">
        <div className="font-bold mb-1">إضافة صنف إلى قائمة المطعم</div>
        <p className="mb-3 text-xs leading-5 text-muted-foreground">استخدم هذا النموذج لصنف قائمة جديد. إذا كان الصنف موجودًا في المخزون، اربطه به أو استخدم الاستيراد الجماعي أعلاه بدل إنشاء بطاقة مخزون ثانية.</p>
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
             onChange={e => setDraft({ ...draft, kitchenStation: e.target.value })}
            aria-label="محطة التحضير" data-testid="select-item-station" className="h-10 rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            {(stationsQ.data ?? []).filter(station => station.isActive).map(station => <option key={station.id} value={station.stationKey}>{station.nameAr}</option>)}
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
        <div className="border-b border-border p-4 font-black">أصناف قائمة المطعم <span className="text-sm font-semibold text-muted-foreground">({itemsQ.data?.length ?? 0})</span></div>
        {itemsQ.isLoading ? <div role="status" className="p-8 text-center"><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin text-primary" />جارٍ تحميل الأصناف</div> :
          itemsQ.isError ? <div className="p-8 text-center text-sm text-destructive" role="alert">تعذّر تحميل الأصناف. <button className="font-bold underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => itemsQ.refetch()}>إعادة المحاولة</button></div> :
          (itemsQ.data ?? []).length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">لا توجد أصناف في قائمة المطعم بعد. أضف صنفًا أو استورده من المخزون واربطه بسجله الحالي.</div>
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
                        onChange={e => setEditBuf({ ...editBuf, kitchenStation: e.target.value })}
                        aria-label="محطة تحضير الصنف" className="h-8 rounded-lg border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                        {(stationsQ.data ?? []).filter(station => station.isActive || station.stationKey === editBuf.kitchenStation).map(station => <option key={station.id} value={station.stationKey}>{station.nameAr}{station.isActive ? "" : " (معطلة)"}</option>)}
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
                    <td className="p-2 text-xs">{stationLabel(it.kitchenStation, stationsQ.data ?? [])}</td>
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
function stationLabel(s: string, stations: RKitchenStation[]) {
  return stations.find(station => station.stationKey === s)?.nameAr ?? s;
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

function RestaurantLoyaltyTab() {
  const qc = useQueryClient();
  const companyId = getStoredUser()?.companyId ?? null;
  const groupsQ = useQuery({
    queryKey: ["customer-groups", companyId],
    queryFn: () => companyId ? api.getCustomerGroups(companyId) : Promise.resolve([]),
    enabled: !!companyId,
  });
  const programQ = useQuery({ queryKey: ["r-loyalty-program"], queryFn: () => api.rLoyaltyProgram() });
  const [draft, setDraft] = useState<RLoyaltyProgram | null>(null);
  useEffect(() => {
    if (programQ.data) setDraft(structuredClone(programQ.data));
  }, [programQ.data]);
  const save = useMutation({
    mutationFn: () => api.rSaveLoyaltyProgram(draft!),
    onSuccess: value => {
      qc.setQueryData(["r-loyalty-program"], value);
      qc.invalidateQueries({ queryKey: ["r-loyalty-program"] });
      setDraft(structuredClone(value));
    },
  });
  const patch = <K extends keyof RLoyaltyProgram>(key: K, value: RLoyaltyProgram[K]) =>
    setDraft(current => current ? { ...current, [key]: value } : current);
  const patchRule = (index: number, values: Partial<RLoyaltyRule>) =>
    patch("rules", (draft?.rules ?? []).map((rule, i) => i === index ? { ...rule, ...values } : rule));
  const patchTier = (index: number, values: Partial<RLoyaltyTier>) =>
    patch("tiers", (draft?.tiers ?? []).map((tier, i) => i === index ? { ...tier, ...values } : tier));
  if (programQ.isLoading) return <div role="status" className="rounded-2xl border bg-card p-10 text-center text-muted-foreground"><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin text-primary" />جارٍ تحميل إعدادات الولاء</div>;
  if (programQ.isError) return <div role="alert" className="rounded-2xl border border-destructive/20 bg-card p-6 text-center text-destructive">تعذّر تحميل إعدادات الولاء. <button className="font-bold underline" onClick={() => programQ.refetch()}>إعادة المحاولة</button></div>;
  if (!draft) return null;
  const field = (label: string, key: "earnEvery" | "redeemValuePer100" | "minRedeemPoints" | "expiryDays", help: string) => (
    <label className="space-y-1 text-xs font-bold text-muted-foreground">{label}
      <Input type="number" min={0} step="any" value={draft[key]} onChange={e => patch(key, Number(e.target.value))} className="h-10 bg-background text-foreground" />
      <span className="block font-normal">{help}</span>
    </label>
  );
  return <div className="space-y-4">
    <section className="rounded-2xl border border-primary/20 bg-card p-4 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div className="flex items-center gap-3"><div className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary"><Award className="h-5 w-5" /></div><div><h2 className="font-black text-lg">برنامج ولاء المطعم</h2><p className="text-sm text-muted-foreground">اضبط كسب النقاط واستبدالها لعملائك.</p></div></div>
        <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm font-bold"><input type="checkbox" checked={draft.enabled} onChange={e => patch("enabled", e.target.checked)} className="size-4 accent-primary" />تفعيل البرنامج</label>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {field("كل كم ريال تُكتسب نقطة؟", "earnEvery", "قيمة الإنفاق اللازمة لاكتساب نقطة واحدة.")}
        {field("قيمة كل ١٠٠ نقطة (ر.س)", "redeemValuePer100", "المبلغ الذي يُخصم مقابل مئة نقطة.")}
        {field("أقل نقاط للاستبدال", "minRedeemPoints", "الحد الأدنى عند فوترة الطلب.")}
        {field("صلاحية النقاط بالأيام", "expiryDays", "اتركها ٠ دون انتهاء إذا كانت السياسة تسمح بذلك.")}
      </div>
    </section>
    <section className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-2"><div><h3 className="font-black">قواعد اكتساب النقاط</h3><p className="text-xs text-muted-foreground">القناة والحد الأدنى ومضاعف النقاط لكل قاعدة.</p></div><Button variant="outline" size="sm" onClick={() => patch("rules", [...draft.rules, { id: `new-${Date.now()}`, name: "", channel: "all", minInvoiceAmount: 0, customerGroupId: null, pointsMultiplier: 1, isActive: true }])}><Plus className="ml-1 h-4 w-4" />إضافة قاعدة</Button></div>
      <div className="space-y-2">{draft.rules.map((rule, i) => <div key={rule.id} className="grid gap-2 rounded-xl border border-border bg-muted/20 p-3 sm:grid-cols-2 lg:grid-cols-6">
        <Input aria-label="اسم القاعدة" placeholder="اسم القاعدة" value={rule.name} onChange={e => patchRule(i, { name: e.target.value })} className="bg-background" />
        <select aria-label="قناة الطلب" value={rule.channel} onChange={e => patchRule(i, { channel: e.target.value as RLoyaltyRule["channel"] })} className="h-10 rounded-lg border border-input bg-background px-2 text-sm"><option value="all">كل القنوات</option><option value="dine_in">الصالة</option><option value="takeaway">سفري</option><option value="delivery">توصيل</option></select>
        <Input aria-label="الحد الأدنى للفاتورة" type="number" min="0" value={rule.minInvoiceAmount} onChange={e => patchRule(i, { minInvoiceAmount: Number(e.target.value) })} placeholder="أقل فاتورة" className="bg-background" />
        <select aria-label="مجموعة العملاء" value={rule.customerGroupId ?? ""} onChange={e => patchRule(i, { customerGroupId: e.target.value ? Number(e.target.value) : null })} className="h-10 rounded-lg border border-input bg-background px-2 text-sm"><option value="">كل العملاء</option>{(groupsQ.data ?? []).map(group => <option key={group.id} value={group.id}>{group.nameAr}</option>)}</select>
        <Input aria-label="مضاعف النقاط" type="number" min="0.1" step="0.1" value={rule.pointsMultiplier} onChange={e => patchRule(i, { pointsMultiplier: Number(e.target.value) })} placeholder="المضاعف" className="bg-background" />
        <div className="flex items-center justify-between gap-2"><label className="flex items-center gap-2 text-xs font-bold"><input type="checkbox" checked={rule.isActive} onChange={e => patchRule(i, { isActive: e.target.checked })} className="accent-primary" />نشطة</label><Button variant="ghost" size="icon" aria-label="حذف القاعدة" onClick={() => patch("rules", draft.rules.filter((_, n) => n !== i))}><Trash2 className="h-4 w-4 text-destructive" /></Button></div>
      </div>)}
      {draft.rules.length === 0 && <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">لا توجد قواعد مضافة.</p>}</div>
    </section>
    <section className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-2"><div><h3 className="font-black">مستويات العملاء</h3><p className="text-xs text-muted-foreground">يُطبّق المستوى بحسب إجمالي إنفاق العميل مدى الحياة.</p></div><Button variant="outline" size="sm" onClick={() => patch("tiers", [...draft.tiers, { id: `new-${Date.now()}`, name: "", minLifetimeSpend: 0, pointsMultiplier: 1, isActive: true }])}><Plus className="ml-1 h-4 w-4" />إضافة مستوى</Button></div>
      <div className="space-y-2">{draft.tiers.map((tier, i) => <div key={tier.id} className="grid gap-2 rounded-xl border border-border bg-muted/20 p-3 sm:grid-cols-2 lg:grid-cols-5">
        <Input aria-label="اسم المستوى" placeholder="اسم المستوى" value={tier.name} onChange={e => patchTier(i, { name: e.target.value })} className="bg-background" />
        <Input aria-label="الحد الأدنى للإنفاق مدى الحياة" type="number" min="0" value={tier.minLifetimeSpend} onChange={e => patchTier(i, { minLifetimeSpend: Number(e.target.value) })} placeholder="أقل إنفاق مدى الحياة" className="bg-background" />
        <Input aria-label="مضاعف نقاط المستوى" type="number" min="0.1" step="0.1" value={tier.pointsMultiplier} onChange={e => patchTier(i, { pointsMultiplier: Number(e.target.value) })} placeholder="مضاعف النقاط" className="bg-background" />
        <label className="flex items-center gap-2 text-xs font-bold"><input type="checkbox" checked={tier.isActive} onChange={e => patchTier(i, { isActive: e.target.checked })} className="accent-primary" />نشط</label>
        <Button variant="ghost" className="justify-self-start" aria-label="حذف المستوى" onClick={() => patch("tiers", draft.tiers.filter((_, n) => n !== i))}><Trash2 className="ml-1 h-4 w-4 text-destructive" />حذف</Button>
      </div>)}
      {draft.tiers.length === 0 && <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">لا توجد مستويات مضافة.</p>}</div>
    </section>
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/15 bg-primary/[0.04] p-3">
      <p className="text-xs text-muted-foreground">التعديلات لا تُطبّق حتى تحفظها. تأكد من مراجعة سياسة الاستبدال قبل التفعيل.</p>
      <Button disabled={save.isPending || draft.earnEvery <= 0 || draft.redeemValuePer100 < 0 || draft.minRedeemPoints < 0 || draft.expiryDays < 0} onClick={() => save.mutate()}><Save className="ml-2 h-4 w-4" />{save.isPending ? "جارٍ الحفظ..." : "حفظ إعدادات الولاء"}</Button>
      {save.isError && <p role="alert" className="w-full text-sm text-destructive">{save.error.message}</p>}
      {save.isSuccess && <p role="status" className="w-full text-sm font-bold text-primary">تم حفظ إعدادات برنامج الولاء.</p>}
    </div>
  </div>;
}
