import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Search, Workflow, Edit3, Trash2, Power, PowerOff,
  ChevronUp, ChevronDown, X, Save, GitBranch,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

const API = import.meta.env.VITE_API_URL || "";

type Routing = {
  id: number;
  productItemId: number | null;
  productNameAr: string | null;
  productNameEn: string | null;
  nameAr: string;
  nameEn: string | null;
  isActive: boolean;
  notes: string | null;
  stagesCount: number;
  updatedAt: string;
};

type Stage = {
  id?: number;
  sequence: number;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  expectedWasteRatio?: string | number;
  expectedDurationMinutes?: number | null;
  expectedCost?: string | number;
  expectedCostAccountId?: number | null;
  icon?: string | null;
  color?: string | null;
  notes?: string | null;
};

type ProductOpt = { id: number; nameAr: string; code: string };
type AccountOpt = {
  id: number;
  code: string;
  nameAr: string;
  accountType: string;
  isPosting: boolean;
};

const PALETTE = [
  "#f59e0b", "#0ea5e9", "#8b5cf6", "#ec4899", "#ef4444", "#10b981",
  "#6366f1", "#14b8a6", "#f97316",
];

export default function ProductionRoutings() {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [rows, setRows] = useState<Routing[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [editor, setEditor] = useState<{ id: number | null } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const url = `${API}/api/production/routings${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRows(await r.json());
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { if (token) void load(); /* eslint-disable-next-line */ }, [token]);
  useEffect(() => {
    const id = setTimeout(() => { if (token) void load(); }, 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line
  }, [q]);

  async function toggleActive(t: Routing) {
    try {
      const r = await fetch(`${API}/api/production/routings/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ isActive: !t.isActive }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    }
  }

  async function remove(t: Routing) {
    if (!confirm(`حذف القالب "${t.nameAr}"؟`)) return;
    try {
      const r = await fetch(`${API}/api/production/routings/${t.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast({ title: "✓ تم الحذف" });
      await load();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    }
  }

  const list = useMemo(() => rows ?? [], [rows]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 p-2 text-white shadow-lg">
            <Workflow className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">قوالب مراحل الإنتاج</h1>
            <p className="text-sm text-slate-500">
              عرّف مراحل تصنيع كل منتج (عجن → فرن → تعبئة …) مرة واحدة، وستُنسخ تلقائياً مع كل أمر إنتاج.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setEditor({ id: null })} data-testid="btn-new-routing">
            <Plus className="h-4 w-4 me-1" />
            قالب مراحل جديد
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 max-w-md">
        <Search className="h-4 w-4 text-slate-400" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="ابحث عن قالب أو منتج…"
          data-testid="input-search-routings"
        />
      </div>

      {loading && rows == null ? (
        <div className="space-y-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center text-slate-500">
          <GitBranch className="mx-auto h-10 w-10 text-slate-300 mb-3" />
          لا توجد قوالب مراحل بعد. اضغط <strong>«قالب مراحل جديد»</strong> لإنشاء أول قالب يحدد مراحل تصنيع منتجك.
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {list.map((t) => (
            <div
              key={t.id}
              className="group rounded-xl border bg-white p-4 hover:shadow-md transition-shadow"
              data-testid={`routing-card-${t.id}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-bold truncate">{t.nameAr}</h3>
                    {t.isActive ? (
                      <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">نشط</Badge>
                    ) : (
                      <Badge className="bg-slate-200 text-slate-600 hover:bg-slate-200">معطّل</Badge>
                    )}
                  </div>
                  <p className="text-sm text-slate-500 truncate">
                    {t.productNameAr || t.productNameEn || "—"}
                  </p>
                </div>
                <div className="text-center px-3 py-1.5 rounded-lg bg-gradient-to-br from-indigo-50 to-purple-50 border border-indigo-100 shrink-0">
                  <div className="text-2xl font-bold text-indigo-600 leading-none">{t.stagesCount}</div>
                  <div className="text-[10px] text-indigo-500 mt-0.5">مراحل</div>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => setEditor({ id: t.id })} title="تعديل المراحل">
                  <Edit3 className="h-4 w-4" />
                  <span className="me-1 text-xs">تعديل</span>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => toggleActive(t)} title={t.isActive ? "تعطيل" : "تنشيط"}>
                  {t.isActive ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
                </Button>
                <div className="flex-1" />
                <Button size="sm" variant="ghost" onClick={() => remove(t)} className="text-red-600">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editor && (
        <RoutingEditor
          id={editor.id}
          token={token}
          onClose={() => setEditor(null)}
          onSaved={async () => { setEditor(null); await load(); }}
        />
      )}
    </div>
  );
}

// ─── Editor Modal ─────────────────────────────────────────────────────────

function RoutingEditor({
  id, token, onClose, onSaved,
}: {
  id: number | null;
  token: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [nameAr, setNameAr] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [productItemId, setProductItemId] = useState<number | "">("");
  const [productSearch, setProductSearch] = useState("");
  const [products, setProducts] = useState<ProductOpt[]>([]);
  const [isActive, setIsActive] = useState(true);
  const [notes, setNotes] = useState("");
  const [stages, setStages] = useState<Stage[]>([
    { sequence: 1, code: "S1", nameAr: "المرحلة الأولى", color: PALETTE[0], expectedWasteRatio: 0, expectedCost: 0, expectedCostAccountId: null },
  ]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!!id);
  const [accounts, setAccounts] = useState<AccountOpt[]>([]);
  const [newAccountFor, setNewAccountFor] = useState<number | null>(null);

  // Load chart of accounts (filtered to expense / cost-of-goods accounts that
  // are postable — those are the only valid targets for a routing-stage cost).
  async function loadAccounts() {
    try {
      const r = await fetch(`${API}/api/accounts`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return;
      const all: AccountOpt[] = await r.json();
      // Keep posting expense / cost accounts (case-insensitive match on type).
      const filtered = all.filter((a) => {
        if (!a.isPosting) return false;
        const t = (a.accountType || "").toLowerCase();
        return t.includes("expense") || t.includes("cost") || t.includes("مصروف") || t.includes("تكلف");
      });
      setAccounts(filtered.length > 0 ? filtered : all.filter((a) => a.isPosting));
    } catch { /* ignore */ }
  }
  useEffect(() => { if (token) void loadAccounts(); /* eslint-disable-next-line */ }, [token]);

  useEffect(() => {
    if (!id) return;
    void (async () => {
      try {
        const r = await fetch(`${API}/api/production/routings/${id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        setNameAr(j.nameAr || "");
        setNameEn(j.nameEn || "");
        setProductItemId(j.productItemId ?? "");
        setIsActive(!!j.isActive);
        setNotes(j.notes || "");
        if (Array.isArray(j.stages) && j.stages.length > 0) {
          setStages(j.stages);
        }
      } catch (e: any) {
        toast({ title: "خطأ تحميل القالب", description: e?.message, variant: "destructive" });
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line
  }, [id]);

  // product picker: simple search on items
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const r = await fetch(
          `${API}/api/inventory/items?q=${encodeURIComponent(productSearch.trim())}&limit=20`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!r.ok) return;
        const data = await r.json();
        const arr = Array.isArray(data) ? data : (data.items ?? data.rows ?? []);
        setProducts(arr.map((x: any) => ({ id: x.id, nameAr: x.nameAr, code: x.code })));
      } catch {/* ignore */}
    }, 250);
    return () => clearTimeout(t);
  }, [productSearch, token]);

  function moveStage(idx: number, dir: -1 | 1) {
    setStages((prev) => {
      const arr = [...prev];
      const j = idx + dir;
      if (j < 0 || j >= arr.length) return prev;
      [arr[idx], arr[j]] = [arr[j], arr[idx]];
      return arr.map((s, i) => ({ ...s, sequence: i + 1 }));
    });
  }
  function addStage() {
    setStages((prev) => [
      ...prev,
      {
        sequence: prev.length + 1,
        code: `S${prev.length + 1}`,
        nameAr: `مرحلة ${prev.length + 1}`,
        color: PALETTE[prev.length % PALETTE.length],
        expectedWasteRatio: 0,
        expectedCost: 0,
        // Default to the previous stage's cost account so users only
        // pick once per routing in the common case.
        expectedCostAccountId: prev[prev.length - 1]?.expectedCostAccountId ?? null,
      },
    ]);
  }
  function removeStage(i: number) {
    setStages((prev) =>
      prev.filter((_, idx) => idx !== i).map((s, k) => ({ ...s, sequence: k + 1 })),
    );
  }
  function patchStage(i: number, patch: Partial<Stage>) {
    setStages((prev) => prev.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  }

  async function save() {
    if (!nameAr.trim()) { toast({ title: "اسم القالب مطلوب", variant: "destructive" }); return; }
    if (!productItemId) { toast({ title: "اختر المنتج النهائي", variant: "destructive" }); return; }
    if (stages.length === 0) { toast({ title: "أضف مرحلة واحدة على الأقل", variant: "destructive" }); return; }
    setBusy(true);
    try {
      const stagesPayload = stages.map((s, i) => ({
        sequence: i + 1,
        code: (s.code || `S${i + 1}`).toUpperCase().slice(0, 24),
        nameAr: s.nameAr || `مرحلة ${i + 1}`,
        nameEn: s.nameEn || null,
        expectedWasteRatio: Number(s.expectedWasteRatio ?? 0) || 0,
        expectedDurationMinutes: s.expectedDurationMinutes || null,
        expectedCost: Number(s.expectedCost ?? 0) || 0,
        expectedCostAccountId: s.expectedCostAccountId || null,
        icon: s.icon || null,
        color: s.color || null,
        notes: s.notes || null,
      }));
      let routingId: number;
      if (id) {
        const r1 = await fetch(`${API}/api/production/routings/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ nameAr, nameEn, isActive, notes, productItemId }),
        });
        if (!r1.ok) throw new Error((await r1.json()).error || "حفظ");
        routingId = id;
        const r2 = await fetch(`${API}/api/production/routings/${id}/stages`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ stages: stagesPayload }),
        });
        if (!r2.ok) throw new Error((await r2.json()).error || "حفظ المراحل");
      } else {
        const r = await fetch(`${API}/api/production/routings`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ nameAr, nameEn, isActive, notes, productItemId, stages: stagesPayload }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "إنشاء");
        routingId = j.id;
      }
      toast({ title: "✓ تم الحفظ" });
      onSaved();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto shadow-2xl">
        <div className="flex items-center justify-between p-4 border-b bg-gradient-to-r from-indigo-50 to-purple-50 rounded-t-2xl sticky top-0 z-10">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Workflow className="h-5 w-5 text-indigo-600" />
            {id ? "تعديل قالب المراحل" : "قالب مراحل جديد"}
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>

        {loading ? (
          <div className="p-6 space-y-2"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-32" /></div>
        ) : (
          <div className="p-4 space-y-4">
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium block mb-1">اسم القالب (عربي) *</label>
                <Input value={nameAr} onChange={(e) => setNameAr(e.target.value)} placeholder="مثال: خط الإنتاج الكامل" data-testid="input-routing-name-ar" />
              </div>
              <div>
                <label className="text-sm font-medium block mb-1">اسم القالب (إنجليزي)</label>
                <Input value={nameEn} onChange={(e) => setNameEn(e.target.value)} placeholder="Full Production Line" />
              </div>
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">المنتج النهائي *</label>
              <Input
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                placeholder="ابحث عن منتج بالاسم أو الكود…"
              />
              <div className="mt-1 max-h-32 overflow-y-auto rounded border bg-slate-50 text-sm">
                {products.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => { setProductItemId(p.id); setProductSearch(p.nameAr); }}
                    className={`w-full text-start p-2 hover:bg-indigo-50 ${productItemId === p.id ? "bg-indigo-100" : ""}`}
                  >
                    <span className="font-mono text-xs text-slate-500">{p.code}</span> — {p.nameAr}
                  </button>
                ))}
                {products.length === 0 && (
                  <div className="p-2 text-center text-slate-400">اكتب للبحث…</div>
                )}
              </div>
              {productItemId && (
                <div className="mt-1 text-xs text-emerald-600">المنتج المختار: #{productItemId}</div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                id="isActive"
              />
              <label htmlFor="isActive" className="text-sm">نشط (سيُستخدم تلقائياً عند إنشاء أمر إنتاج لهذا المنتج)</label>
            </div>

            <div className="rounded-xl border bg-gradient-to-b from-slate-50 to-white p-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold">المراحل ({stages.length})</h3>
                <Button size="sm" variant="outline" onClick={addStage}>
                  <Plus className="h-4 w-4 me-1" /> أضف مرحلة
                </Button>
              </div>
              <div className="space-y-2">
                {stages.map((s, i) => (
                  <div
                    key={i}
                    className="rounded-lg border bg-white p-3"
                    style={{ borderInlineStartWidth: 4, borderInlineStartColor: s.color || PALETTE[i % PALETTE.length] }}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center text-xs font-bold">
                        {i + 1}
                      </div>
                      <Input
                        value={s.icon || ""}
                        onChange={(e) => patchStage(i, { icon: e.target.value })}
                        placeholder="🔥"
                        className="w-14 text-center text-lg"
                      />
                      <Input
                        value={s.nameAr}
                        onChange={(e) => patchStage(i, { nameAr: e.target.value })}
                        placeholder="اسم المرحلة"
                        className="flex-1"
                      />
                      <Input
                        value={s.code}
                        onChange={(e) => patchStage(i, { code: e.target.value.toUpperCase() })}
                        placeholder="CODE"
                        className="w-24 font-mono text-xs"
                      />
                      <div className="flex items-center gap-1">
                        <button onClick={() => moveStage(i, -1)} className="p-1 hover:bg-slate-100 rounded" title="لأعلى">
                          <ChevronUp className="h-4 w-4" />
                        </button>
                        <button onClick={() => moveStage(i, 1)} className="p-1 hover:bg-slate-100 rounded" title="لأسفل">
                          <ChevronDown className="h-4 w-4" />
                        </button>
                        <button onClick={() => removeStage(i)} className="p-1 hover:bg-red-50 text-red-600 rounded" title="حذف">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                    <div className="grid md:grid-cols-2 gap-2 text-xs">
                      <div>
                        <label className="text-slate-500 block mb-1">نسبة الهالك المتوقعة</label>
                        <Input
                          type="number"
                          step="0.001"
                          value={s.expectedWasteRatio ?? 0}
                          onChange={(e) => patchStage(i, { expectedWasteRatio: e.target.value })}
                          placeholder="0.01 = 1%"
                        />
                      </div>
                      <div>
                        <label className="text-slate-500 block mb-1">المدة المتوقعة (دقائق)</label>
                        <Input
                          type="number"
                          value={s.expectedDurationMinutes ?? ""}
                          onChange={(e) => patchStage(i, { expectedDurationMinutes: e.target.value ? Number(e.target.value) : null })}
                          placeholder="60"
                        />
                      </div>
                    </div>
                    {/* Cost row — international ERP standard: each operation
                        carries an expected cost (labor + overhead) and the
                        GL expense account it will be charged to. */}
                    <div className="grid md:grid-cols-2 gap-2 text-xs mt-2 pt-2 border-t border-dashed">
                      <div>
                        <label className="text-slate-500 block mb-1">التكلفة المتوقعة للمرحلة (ريال)</label>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          value={s.expectedCost ?? 0}
                          onChange={(e) => patchStage(i, { expectedCost: e.target.value })}
                          placeholder="0.00"
                          data-testid={`input-stage-cost-${i}`}
                        />
                      </div>
                      <div>
                        <label className="text-slate-500 block mb-1 flex items-center justify-between">
                          <span>حساب التكلفة (شجرة الحسابات)</span>
                          <button
                            type="button"
                            onClick={() => setNewAccountFor(i)}
                            className="text-indigo-600 hover:text-indigo-800 text-[11px] inline-flex items-center gap-0.5"
                            title="إنشاء حساب جديد"
                          >
                            <Plus className="h-3 w-3" /> حساب جديد
                          </button>
                        </label>
                        <select
                          value={s.expectedCostAccountId ?? ""}
                          onChange={(e) => patchStage(i, { expectedCostAccountId: e.target.value ? Number(e.target.value) : null })}
                          className="w-full rounded-md border bg-white p-2 text-xs"
                          data-testid={`select-stage-account-${i}`}
                        >
                          <option value="">— بدون حساب —</option>
                          {accounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.code} — {a.nameAr}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="mt-2 pt-2 border-t border-dashed">
                      <label className="text-slate-500 block mb-1 text-xs">اللون</label>
                      <div className="flex gap-1 flex-wrap">
                        {PALETTE.map((c) => (
                          <button
                            key={c}
                            onClick={() => patchStage(i, { color: c })}
                            className={`h-6 w-6 rounded-full border-2 ${s.color === c ? "border-slate-800" : "border-white"}`}
                            style={{ background: c }}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <label className="text-sm font-medium block mb-1">ملاحظات</label>
              <textarea
                className="w-full rounded-md border p-2 text-sm min-h-[60px]"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="ملاحظات عامة عن القالب…"
              />
            </div>
          </div>
        )}

        <div className="border-t p-3 bg-slate-50 rounded-b-2xl flex justify-end gap-2 sticky bottom-0">
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button onClick={save} disabled={busy} data-testid="btn-save-routing">
            <Save className="h-4 w-4 me-1" />
            {busy ? "جاري الحفظ…" : "حفظ"}
          </Button>
        </div>
      </div>

      {newAccountFor != null && (
        <NewAccountModal
          token={token}
          existingAccounts={accounts}
          onClose={() => setNewAccountFor(null)}
          onCreated={async (acc) => {
            await loadAccounts();
            patchStage(newAccountFor, { expectedCostAccountId: acc.id });
            setNewAccountFor(null);
          }}
        />
      )}
    </div>
  );
}

// ─── Inline "Create Account" modal ────────────────────────────────────────
// Lets the user add a new posting account to the chart of accounts without
// leaving the routing editor. POSTs to /api/accounts.
function NewAccountModal({
  token, existingAccounts, onClose, onCreated,
}: {
  token: string;
  existingAccounts: AccountOpt[];
  onClose: () => void;
  onCreated: (acc: AccountOpt) => void;
}) {
  const { toast } = useToast();
  const [code, setCode] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [accountType, setAccountType] = useState("expense");
  const [parentId, setParentId] = useState<number | "">("");
  const [busy, setBusy] = useState(false);

  // Suggest a fresh code based on the highest existing numeric code
  useEffect(() => {
    if (code) return;
    const nums = existingAccounts
      .map((a) => Number(String(a.code).replace(/\D/g, "")))
      .filter((n) => Number.isFinite(n) && n > 0);
    const next = nums.length ? Math.max(...nums) + 1 : 5101;
    setCode(String(next));
    // eslint-disable-next-line
  }, []);

  async function create() {
    if (!code.trim() || !nameAr.trim()) {
      toast({ title: "كود الحساب واسمه مطلوبة", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          code: code.trim(),
          nameAr: nameAr.trim(),
          nameEn: nameEn.trim() || null,
          accountType,
          parentId: parentId || null,
          isPosting: true,
          isActive: true,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      toast({ title: "✓ تم إنشاء الحساب" });
      onCreated({
        id: j.id,
        code: j.code,
        nameAr: j.nameAr,
        accountType: j.accountType,
        isPosting: !!j.isPosting,
      });
    } catch (e: any) {
      toast({ title: "خطأ في إنشاء الحساب", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between p-3 border-b bg-emerald-50 rounded-t-xl">
          <h3 className="font-bold flex items-center gap-2">
            <Plus className="h-4 w-4 text-emerald-600" />
            حساب جديد في شجرة الحسابات
          </h3>
          <Button variant="ghost" size="sm" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>
        <div className="p-4 space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-slate-500 block mb-1 text-xs">كود الحساب *</label>
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="5101" data-testid="input-new-account-code" />
            </div>
            <div>
              <label className="text-slate-500 block mb-1 text-xs">نوع الحساب</label>
              <select
                value={accountType}
                onChange={(e) => setAccountType(e.target.value)}
                className="w-full rounded-md border bg-white p-2 text-sm"
              >
                <option value="expense">مصروف (Expense)</option>
                <option value="cost_of_goods">تكلفة بضاعة (COGS)</option>
                <option value="liability">التزام (Liability)</option>
                <option value="asset">أصل (Asset)</option>
              </select>
            </div>
          </div>
          <div>
            <label className="text-slate-500 block mb-1 text-xs">الاسم بالعربي *</label>
            <Input value={nameAr} onChange={(e) => setNameAr(e.target.value)} placeholder="مثال: مصروف عمالة الإنتاج" data-testid="input-new-account-name-ar" />
          </div>
          <div>
            <label className="text-slate-500 block mb-1 text-xs">الاسم بالإنجليزي</label>
            <Input value={nameEn} onChange={(e) => setNameEn(e.target.value)} placeholder="Production Labor Expense" />
          </div>
          <div>
            <label className="text-slate-500 block mb-1 text-xs">الحساب الأب (اختياري)</label>
            <select
              value={parentId}
              onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : "")}
              className="w-full rounded-md border bg-white p-2 text-sm"
            >
              <option value="">— حساب رئيسي —</option>
              {existingAccounts.map((a) => (
                <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="p-3 border-t bg-slate-50 rounded-b-xl flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>إلغاء</Button>
          <Button size="sm" onClick={create} disabled={busy} data-testid="btn-create-account">
            <Save className="h-4 w-4 me-1" />
            {busy ? "جارٍ الحفظ…" : "إنشاء واختياره"}
          </Button>
        </div>
      </div>
    </div>
  );
}
