import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus, Trash2, Loader2, Save, X, Pencil, Settings, Utensils, ListOrdered, Tags, Sparkles, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  api, getToken, getStoredUser,
  type Branch, type RTable, type RMenuCategory, type RMenuItem,
} from "@/lib/api";

const TABS = [
  { id: "tables",  label: "الطاولات",   icon: ListOrdered },
  { id: "cats",    label: "الفئات",     icon: Tags },
  { id: "items",   label: "الأصناف",   icon: Utensils },
] as const;

type Tab = typeof TABS[number]["id"];

export default function RestaurantSettings() {
  const [, setLocation] = useLocation();
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
    <div dir="rtl" className="min-h-screen bg-slate-950 text-white">
      <header className="flex items-center justify-between p-3 border-b border-white/10 bg-slate-900">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setLocation("/restaurant")}>
            <ChevronRight className="h-4 w-4 ml-1" /> رجوع
          </Button>
          <Settings className="text-amber-400" />
          <div className="font-bold">إعدادات المطعم / المقهى</div>
        </div>
      </header>

      <div className="border-b border-white/10 bg-slate-900/50 flex">
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2.5 text-sm flex items-center gap-1.5 border-b-2 ${
                tab === t.id ? "border-amber-500 text-amber-300 font-bold" : "border-transparent text-white/60"
              }`}
            >
              <Icon className="h-4 w-4" /> {t.label}
            </button>
          );
        })}
      </div>

      <main className="p-4 max-w-5xl mx-auto">
        {tab === "tables" && <TablesTab branches={branchesQ.data ?? []} />}
        {tab === "cats"   && <CategoriesTab />}
        {tab === "items"  && <ItemsTab />}
      </main>
    </div>
  );
}

// ─── Tables ──────────────────────────────────────────────────────────────
function TablesTab({ branches }: { branches: Branch[] }) {
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
      invalidate();
    },
    onError: (e: any) => alert(e?.message ?? "فشل الإنشاء"),
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
    && Number.isInteger(Number(batch.startNumber)) && Number(batch.startNumber) >= 1
    && Number.isInteger(Number(batch.capacity)) && Number(batch.capacity) >= 1 && Number(batch.capacity) <= 50
    && /^[\p{L}\p{N}_-]{1,12}$/u.test(batch.codePrefix.trim())
    && batch.namePrefix.trim().length > 0;

  return (
    <div className="space-y-4">
      <section className="relative overflow-hidden rounded-2xl border border-amber-300/20 bg-gradient-to-br from-slate-900 via-slate-900 to-amber-950/40 p-4 sm:p-5 shadow-xl">
        <div className="pointer-events-none absolute -left-12 -top-16 h-48 w-48 rounded-full bg-amber-400/10 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-amber-300">
              <Sparkles className="h-5 w-5" />
              <h2 className="font-black text-lg">تجهيز الطاولات دفعة واحدة</h2>
            </div>
            <p className="mt-1 text-sm text-white/60">أنشئ العدد المطلوب بترقيم تلقائي، ثم وزّع الطاولات على مناطق المطعم.</p>
          </div>
          <span className="rounded-full border border-amber-300/20 bg-amber-400/10 px-3 py-1 text-xs font-bold text-amber-200">الافتراضي: 10 طاولات</span>
        </div>

        <div className="relative mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="space-y-1 text-xs font-semibold text-white/70">
            الفرع
            <select value={batch.branchId}
              onChange={e => { setBatch({ ...batch, branchId: e.target.value }); setBatchMessage(""); }}
              className="h-10 w-full rounded-lg border border-white/10 bg-slate-800 px-3 text-sm text-white">
              <option value="">اختر الفرع</option>
              {branches.map(branch => <option key={branch.id} value={branch.id}>{branch.nameAr}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-xs font-semibold text-white/70">
            عدد الطاولات
            <Input type="number" min={1} max={100} value={batch.count}
              onChange={e => { setBatch({ ...batch, count: Number(e.target.value) }); setBatchMessage(""); }}
              className="h-10 border-white/10 bg-slate-800 text-white" />
          </label>
          <label className="space-y-1 text-xs font-semibold text-white/70">
            بادئة الرقم
            <Input value={batch.codePrefix} maxLength={12}
              onChange={e => { setBatch({ ...batch, codePrefix: e.target.value }); setBatchMessage(""); }}
              className="h-10 border-white/10 bg-slate-800 text-white" />
          </label>
          <label className="space-y-1 text-xs font-semibold text-white/70">
            بداية الترقيم
            <Input type="number" min={1} value={batch.startNumber}
              onChange={e => { setBatch({ ...batch, startNumber: Number(e.target.value) }); setBatchMessage(""); }}
              className="h-10 border-white/10 bg-slate-800 text-white" />
          </label>
          <label className="space-y-1 text-xs font-semibold text-white/70">
            اسم الطاولة
            <Input value={batch.namePrefix}
              onChange={e => { setBatch({ ...batch, namePrefix: e.target.value }); setBatchMessage(""); }}
              className="h-10 border-white/10 bg-slate-800 text-white" />
          </label>
          <label className="space-y-1 text-xs font-semibold text-white/70">
            المنطقة / الصالة
            <Input value={batch.area}
              onChange={e => { setBatch({ ...batch, area: e.target.value }); setBatchMessage(""); }}
              className="h-10 border-white/10 bg-slate-800 text-white" />
          </label>
          <label className="space-y-1 text-xs font-semibold text-white/70">
            مقاعد لكل طاولة
            <Input type="number" min={1} max={50} value={batch.capacity}
              onChange={e => { setBatch({ ...batch, capacity: Number(e.target.value) }); setBatchMessage(""); }}
              className="h-10 border-white/10 bg-slate-800 text-white" />
          </label>
          <div className="flex items-end">
            <Button className="h-10 w-full bg-amber-400 font-black text-slate-950 hover:bg-amber-300"
              disabled={!batchValid || createBatch.isPending || branches.length === 0}
              onClick={() => { setBatchMessage(""); createBatch.mutate(); }}>
              {createBatch.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Plus className="ml-2 h-4 w-4" />}
              إنشاء الطاولات
            </Button>
          </div>
        </div>
        <div className="relative mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-white/60">
          <span className="inline-flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5 text-amber-300" />معاينة: {batch.codePrefix || "T"}{String(batch.startNumber).padStart(2, "0")} ← {batch.codePrefix || "T"}{String(previewEnd).padStart(2, "0")}</span>
          <span>الأرقام الموجودة تُتخطّى تلقائياً حتى لا تتكرر.</span>
        </div>
        {batchMessage && <p role="status" className="relative mt-3 rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-sm font-semibold text-emerald-200">{batchMessage}</p>}
        {createBatch.isError && <p role="alert" className="relative mt-3 rounded-lg border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">{createBatch.error.message}</p>}
      </section>

      <details className="group rounded-xl border border-white/10 bg-slate-900">
        <summary className="cursor-pointer list-none p-4 font-bold text-white/80 marker:hidden">
          <span className="inline-flex items-center gap-2"><Plus className="h-4 w-4 text-amber-300" />إضافة طاولة واحدة يدوياً</span>
          <span className="float-left text-xs font-normal text-white/40">اختياري</span>
        </summary>
        <div className="border-t border-white/10 p-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <select value={draft.branchId}
              onChange={e => setDraft({ ...draft, branchId: e.target.value })}
              className="rounded border border-slate-700 bg-slate-800 px-2 py-2 text-sm">
              <option value="">اختر الفرع</option>
              {branches.map(b => <option key={b.id} value={b.id}>{b.nameAr}</option>)}
            </select>
            <Input placeholder="الرمز (T01)" value={draft.code}
              onChange={e => setDraft({ ...draft, code: e.target.value })}
              className="border-slate-700 bg-slate-800" />
            <Input placeholder="الاسم (طاولة 1)" value={draft.nameAr}
              onChange={e => setDraft({ ...draft, nameAr: e.target.value })}
              className="border-slate-700 bg-slate-800" />
            <Input type="number" placeholder="السعة" value={draft.capacity}
              onChange={e => setDraft({ ...draft, capacity: Number(e.target.value) })}
              className="border-slate-700 bg-slate-800" />
            <Input placeholder="المنطقة (اختياري)" value={draft.area}
              onChange={e => setDraft({ ...draft, area: e.target.value })}
              className="border-slate-700 bg-slate-800" />
          </div>
          <Button className="mt-3 bg-slate-700 font-bold hover:bg-slate-600"
            disabled={!draft.branchId || !draft.code || !draft.nameAr || create.isPending}
            onClick={() => create.mutate()}>
            {create.isPending ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : <Plus className="ml-1 h-4 w-4" />}إضافة طاولة
          </Button>
        </div>
      </details>

      <div className="bg-slate-900 rounded-xl border border-white/10 overflow-hidden">
        <div className="p-3 border-b border-white/10 font-bold">الطاولات ({tablesQ.data?.length ?? 0})</div>
        {tablesQ.isLoading ? <Loader2 className="animate-spin mx-auto my-8" /> :
          (tablesQ.data ?? []).length === 0 ? (
            <div className="p-8 text-center text-white/50 text-sm">لا توجد طاولات بعد</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-800 text-white/70">
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
                  <tr key={t.id} className="border-t border-amber-500/30 bg-amber-500/5">
                    <td className="p-1"><Input value={editBuf.code ?? ""} onChange={e => setEditBuf({ ...editBuf, code: e.target.value })} className="bg-slate-800 border-slate-700 h-8" /></td>
                    <td className="p-1"><Input value={editBuf.nameAr ?? ""} onChange={e => setEditBuf({ ...editBuf, nameAr: e.target.value })} className="bg-slate-800 border-slate-700 h-8" /></td>
                    <td className="p-1"><Input type="number" value={editBuf.capacity ?? 0} onChange={e => setEditBuf({ ...editBuf, capacity: Number(e.target.value) })} className="bg-slate-800 border-slate-700 h-8 w-16" /></td>
                    <td className="p-1"><Input value={editBuf.area ?? ""} onChange={e => setEditBuf({ ...editBuf, area: e.target.value })} className="bg-slate-800 border-slate-700 h-8" /></td>
                    <td className="p-1">
                      <select value={editBuf.status ?? "free"}
                        onChange={e => setEditBuf({ ...editBuf, status: e.target.value as any })}
                        className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-xs h-8">
                        <option value="free">متاحة</option>
                        <option value="occupied">مشغولة</option>
                        <option value="reserved">محجوزة</option>
                        <option value="cleaning">تنظيف</option>
                      </select>
                    </td>
                    <td className="p-1 text-left whitespace-nowrap">
                      <Button variant="ghost" size="sm" disabled={update.isPending} onClick={() => update.mutate()}>
                        <Save className="h-4 w-4 text-emerald-400" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => { setEditId(null); setEditBuf({}); }}>
                        <X className="h-4 w-4 text-white/60" />
                      </Button>
                    </td>
                  </tr>
                ) : (
                  <tr key={t.id} className="border-t border-white/5">
                    <td className="p-2">{t.code}</td>
                    <td className="p-2 font-semibold">{t.nameAr}</td>
                    <td className="p-2">{t.capacity}</td>
                    <td className="p-2 text-white/60">{t.area ?? "—"}</td>
                    <td className="p-2 text-xs">{t.status === "free" ? "متاحة" : t.status === "occupied" ? "مشغولة" : t.status === "reserved" ? "محجوزة" : "تنظيف"}</td>
                    <td className="p-2 text-left whitespace-nowrap">
                      <Button variant="ghost" size="sm" onClick={() => startEdit(t)}>
                        <Pencil className="h-4 w-4 text-blue-400" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => { if (confirm("حذف الطاولة؟")) del.mutate(t.id); }}>
                        <Trash2 className="h-4 w-4 text-red-400" />
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
      <div className="bg-slate-900 rounded-xl p-4 border border-white/10">
        <div className="font-bold mb-3">إضافة فئة جديدة</div>
        <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
          <Input placeholder="الرمز" value={draft.code}
            onChange={e => setDraft({ ...draft, code: e.target.value })}
            className="bg-slate-800 border-slate-700" />
          <Input placeholder="الاسم (مشروبات)" value={draft.nameAr}
            onChange={e => setDraft({ ...draft, nameAr: e.target.value })}
            className="bg-slate-800 border-slate-700" />
          <select value={draft.kind}
            onChange={e => setDraft({ ...draft, kind: e.target.value as any })}
            className="bg-slate-800 border border-slate-700 rounded px-2 py-2 text-sm">
            <option value="food">طعام</option>
            <option value="drink">مشروبات</option>
            <option value="dessert">حلويات</option>
            <option value="other">أخرى</option>
          </select>
          <Input type="number" placeholder="الترتيب" value={draft.displayOrder}
            onChange={e => setDraft({ ...draft, displayOrder: Number(e.target.value) })}
            className="bg-slate-800 border-slate-700" />
          <Input type="color" value={draft.color || "#f59e0b"}
            onChange={e => setDraft({ ...draft, color: e.target.value })}
            className="bg-slate-800 border-slate-700 h-10" />
        </div>
        <Button className="mt-3 bg-amber-500 hover:bg-amber-600 text-slate-900 font-bold"
          disabled={!draft.code || !draft.nameAr || create.isPending}
          onClick={() => create.mutate()}>
          <Plus className="h-4 w-4 ml-1" /> إضافة
        </Button>
      </div>

      <div className="bg-slate-900 rounded-xl border border-white/10 overflow-hidden">
        <div className="p-3 border-b border-white/10 font-bold">الفئات ({catsQ.data?.length ?? 0})</div>
        {catsQ.isLoading ? <Loader2 className="animate-spin mx-auto my-8" /> :
          (catsQ.data ?? []).length === 0 ? (
            <div className="p-8 text-center text-white/50 text-sm">لا توجد فئات بعد</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-800 text-white/70">
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
                  <tr key={c.id} className="border-t border-amber-500/30 bg-amber-500/5">
                    <td className="p-1"><Input type="color" value={editBuf.color ?? "#475569"} onChange={e => setEditBuf({ ...editBuf, color: e.target.value })} className="bg-slate-800 border-slate-700 h-8 w-14" /></td>
                    <td className="p-1"><Input value={editBuf.code ?? ""} onChange={e => setEditBuf({ ...editBuf, code: e.target.value })} className="bg-slate-800 border-slate-700 h-8" /></td>
                    <td className="p-1"><Input value={editBuf.nameAr ?? ""} onChange={e => setEditBuf({ ...editBuf, nameAr: e.target.value })} className="bg-slate-800 border-slate-700 h-8" /></td>
                    <td className="p-1">
                      <select value={editBuf.kind ?? "food"}
                        onChange={e => setEditBuf({ ...editBuf, kind: e.target.value as any })}
                        className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-xs h-8">
                        <option value="food">طعام</option>
                        <option value="drink">مشروبات</option>
                        <option value="dessert">حلويات</option>
                        <option value="other">أخرى</option>
                      </select>
                    </td>
                    <td className="p-1"><Input type="number" value={editBuf.displayOrder ?? 0} onChange={e => setEditBuf({ ...editBuf, displayOrder: Number(e.target.value) })} className="bg-slate-800 border-slate-700 h-8 w-16" /></td>
                    <td className="p-1 text-left whitespace-nowrap">
                      <Button variant="ghost" size="sm" disabled={update.isPending} onClick={() => update.mutate()}>
                        <Save className="h-4 w-4 text-emerald-400" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => { setEditId(null); setEditBuf({}); }}>
                        <X className="h-4 w-4 text-white/60" />
                      </Button>
                    </td>
                  </tr>
                ) : (
                  <tr key={c.id} className="border-t border-white/5">
                    <td className="p-2"><span className="inline-block w-6 h-6 rounded" style={{ background: c.color ?? "#475569" }} /></td>
                    <td className="p-2">{c.code}</td>
                    <td className="p-2 font-semibold">{c.nameAr}</td>
                    <td className="p-2 text-xs">{kindLabel(c.kind)}</td>
                    <td className="p-2">{c.displayOrder}</td>
                    <td className="p-2 text-left whitespace-nowrap">
                      <Button variant="ghost" size="sm" onClick={() => startEdit(c)}>
                        <Pencil className="h-4 w-4 text-blue-400" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => { if (confirm("حذف الفئة؟")) del.mutate(c.id); }}>
                        <Trash2 className="h-4 w-4 text-red-400" />
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
function ItemsTab() {
  const qc = useQueryClient();
  const catsQ = useQuery({ queryKey: ["r-cats-all"], queryFn: () => api.rCategories() });
  const itemsQ = useQuery({ queryKey: ["r-items-all"], queryFn: () => api.rMenuItems() });
  const [draft, setDraft] = useState({
    categoryId: "" as string | number, code: "", nameAr: "", price: 0,
    prepTimeMinutes: 0, kitchenStation: "kitchen" as RMenuItem["kitchenStation"],
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
      kitchenStation: draft.kitchenStation,
    } as any),
    onSuccess: () => {
      setDraft({ ...draft, code: "", nameAr: "", price: 0, prepTimeMinutes: 0 });
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
    setEditBuf({ categoryId: it.categoryId, code: it.code, nameAr: it.nameAr, price: it.price, prepTimeMinutes: it.prepTimeMinutes, kitchenStation: it.kitchenStation });
  };

  const catName = (id: number) => catsQ.data?.find(c => c.id === id)?.nameAr ?? "—";

  return (
    <div className="space-y-4">
      <div className="bg-slate-900 rounded-xl p-4 border border-white/10">
        <div className="font-bold mb-3">إضافة صنف جديد</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <select value={draft.categoryId}
            onChange={e => setDraft({ ...draft, categoryId: e.target.value })}
            className="bg-slate-800 border border-slate-700 rounded px-2 py-2 text-sm">
            <option value="">اختر الفئة</option>
            {(catsQ.data ?? []).map(c => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
          </select>
          <Input placeholder="الرمز" value={draft.code}
            onChange={e => setDraft({ ...draft, code: e.target.value })}
            className="bg-slate-800 border-slate-700" />
          <Input placeholder="الاسم (شاورما عربي)" value={draft.nameAr}
            onChange={e => setDraft({ ...draft, nameAr: e.target.value })}
            className="bg-slate-800 border-slate-700" />
          <Input type="number" step="0.01" placeholder="السعر" value={draft.price}
            onChange={e => setDraft({ ...draft, price: Number(e.target.value) })}
            className="bg-slate-800 border-slate-700" />
          <Input type="number" placeholder="وقت التحضير (دقائق)" value={draft.prepTimeMinutes}
            onChange={e => setDraft({ ...draft, prepTimeMinutes: Number(e.target.value) })}
            className="bg-slate-800 border-slate-700" />
          <select value={draft.kitchenStation}
            onChange={e => setDraft({ ...draft, kitchenStation: e.target.value as any })}
            className="bg-slate-800 border border-slate-700 rounded px-2 py-2 text-sm">
            <option value="kitchen">المطبخ</option>
            <option value="grill">الشواية</option>
            <option value="bar">البار</option>
            <option value="cold">البارد</option>
            <option value="dessert">الحلويات</option>
          </select>
        </div>
        <Button className="mt-3 bg-amber-500 hover:bg-amber-600 text-slate-900 font-bold"
          disabled={!draft.categoryId || !draft.code || !draft.nameAr || create.isPending}
          onClick={() => create.mutate()}>
          <Plus className="h-4 w-4 ml-1" /> إضافة
        </Button>
      </div>

      <div className="bg-slate-900 rounded-xl border border-white/10 overflow-hidden">
        <div className="p-3 border-b border-white/10 font-bold">الأصناف ({itemsQ.data?.length ?? 0})</div>
        {itemsQ.isLoading ? <Loader2 className="animate-spin mx-auto my-8" /> :
          (itemsQ.data ?? []).length === 0 ? (
            <div className="p-8 text-center text-white/50 text-sm">لا توجد أصناف بعد</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-800 text-white/70">
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
                  <tr key={it.id} className="border-t border-amber-500/30 bg-amber-500/5">
                    <td className="p-1"><Input value={editBuf.code ?? ""} onChange={e => setEditBuf({ ...editBuf, code: e.target.value })} className="bg-slate-800 border-slate-700 h-8" /></td>
                    <td className="p-1"><Input value={editBuf.nameAr ?? ""} onChange={e => setEditBuf({ ...editBuf, nameAr: e.target.value })} className="bg-slate-800 border-slate-700 h-8" /></td>
                    <td className="p-1">
                      <select value={editBuf.categoryId ?? ""}
                        onChange={e => setEditBuf({ ...editBuf, categoryId: Number(e.target.value) })}
                        className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-xs h-8">
                        {(catsQ.data ?? []).map(c => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
                      </select>
                    </td>
                    <td className="p-1">
                      <select value={editBuf.kitchenStation ?? "kitchen"}
                        onChange={e => setEditBuf({ ...editBuf, kitchenStation: e.target.value as any })}
                        className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-xs h-8">
                        <option value="kitchen">المطبخ</option>
                        <option value="grill">الشواية</option>
                        <option value="bar">البار</option>
                        <option value="cold">البارد</option>
                        <option value="dessert">الحلويات</option>
                      </select>
                    </td>
                    <td className="p-1"><Input type="number" value={editBuf.prepTimeMinutes ?? 0} onChange={e => setEditBuf({ ...editBuf, prepTimeMinutes: Number(e.target.value) })} className="bg-slate-800 border-slate-700 h-8 w-16" /></td>
                    <td className="p-1"><Input type="number" step="0.01" value={editBuf.price as any ?? 0} onChange={e => setEditBuf({ ...editBuf, price: e.target.value as any })} className="bg-slate-800 border-slate-700 h-8 w-20" /></td>
                    <td className="p-1 text-left whitespace-nowrap">
                      <Button variant="ghost" size="sm" disabled={update.isPending} onClick={() => update.mutate()}>
                        <Save className="h-4 w-4 text-emerald-400" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => { setEditId(null); setEditBuf({}); }}>
                        <X className="h-4 w-4 text-white/60" />
                      </Button>
                    </td>
                  </tr>
                ) : (
                  <tr key={it.id} className="border-t border-white/5">
                    <td className="p-2">{it.code}</td>
                    <td className="p-2 font-semibold">{it.nameAr}</td>
                    <td className="p-2 text-white/60">{catName(it.categoryId)}</td>
                    <td className="p-2 text-xs">{stationLabel(it.kitchenStation)}</td>
                    <td className="p-2">{it.prepTimeMinutes} د</td>
                    <td className="p-2 text-amber-400 font-bold">{Number(it.price).toFixed(2)}</td>
                    <td className="p-2 text-left whitespace-nowrap">
                      <Button variant="ghost" size="sm" onClick={() => startEdit(it)}>
                        <Pencil className="h-4 w-4 text-blue-400" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => { if (confirm("حذف الصنف؟")) del.mutate(it.id); }}>
                        <Trash2 className="h-4 w-4 text-red-400" />
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
