import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { FormPanel } from "@/components/FormPanel";
import { AccountCombobox } from "@/components/AccountCombobox";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Plus, Search, Pencil, Trash2, UserCheck, UserX,
  Phone, Mail, MapPin, Percent, Target, Users, Sparkles, Loader2,
  FileSpreadsheet, X, KeyRound, Wand2,
  ListChecks, BarChart3, TrendingUp, Award, Wallet, Trophy,
  Link2, CheckCircle2, Clock, Hash, AtSign, IdCard,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  rowToneFor, SEL_TONE, DocColorLegend, buildToneTooltip, DICT_TONES, type LegendItem,
} from "@/lib/docRowTone";
import { downloadCsv, matchCol, useAuditGridLayout, useColumnResize } from "@/lib/auditGridLayout";
import {
  AuditGridBulkBar, AuditGridPagination, ColumnReorderPopover,
  FooterColorPicker, HeaderColorPicker, HeaderSelectCheckbox, RowSelectCheckbox,
} from "@/components/auditGrid/AuditGridControls";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Rep = {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  branchId: number | null;
  region: string | null;
  isActive: boolean;
  commissionPct: string;
  commissionType: "invoice" | "collection";
  monthlyTarget: string;
  accountId: number | null;
  notes: string | null;
  userId: number | null;
};

type CompanyUser = {
  id: number;
  username: string;
  nameAr: string | null;
  nameEn: string | null;
  email: string | null;
  code: string | null;
  role: string;
  isActive: boolean;
  lastLoginAt: string | null;
};

const EMPTY_FORM = {
  code: "",
  nameAr: "",
  nameEn: "",
  phone: "",
  email: "",
  address: "",
  branchId: "" as string,
  region: "",
  isActive: true,
  commissionPct: "0",
  commissionType: "invoice" as "invoice" | "collection",
  monthlyTarget: "0",
  accountId: "" as string,
  notes: "",
  userId: "" as string,
};

export default function SalesReps() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Rep | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<typeof EMPTY_FORM>(EMPTY_FORM);
  const [deleteRep, setDeleteRep] = useState<Rep | null>(null);
  const [aiRep, setAiRep] = useState<Rep | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<string>("");
  const [aiLoading, setAiLoading] = useState(false);

  async function runAiAnalysis(rep: Rep) {
    setAiRep(rep);
    setAiAnalysis("");
    setAiLoading(true);
    try {
      const r = await fetch(`${API}/api/sales-reps/${rep.id}/ai-analysis?companyId=${cid}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? "فشل التحليل");
      setAiAnalysis(j.analysis ?? "");
    } catch (e: any) {
      toast({ title: "تعذّر التحليل", description: String(e?.message ?? e), variant: "destructive" });
      setAiRep(null);
    } finally {
      setAiLoading(false);
    }
  }

  const { data: reps = [], isLoading } = useQuery<Rep[]>({
    queryKey: ["sales-reps", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/sales-reps?companyId=${cid}` : `${API}/api/sales-reps`;
      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error("فشل تحميل المناديب");
      return r.json();
    },
    enabled: !!user,
  });

  // ─── Company users for the "حساب الدخول" dropdown ─────────────
  // Pulls every user in the tenant; the UI filters out users already linked
  // to *another* rep (we keep the currently-edited rep's user, of course).
  const { data: users = [] } = useQuery<CompanyUser[]>({
    queryKey: ["company-users", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/users?companyId=${cid}`, { headers });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!cid,
  });

  const { data: branches = [] } = useQuery<any[]>({
    queryKey: ["branches", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/org/branches?companyId=${cid}`, { headers });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!cid,
    staleTime: 60_000,
  });

  const filteredBySearch = reps.filter((r) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      r.nameAr?.includes(search) ||
      r.nameEn?.toLowerCase().includes(q) ||
      r.code?.toLowerCase().includes(q) ||
      r.phone?.includes(search) ||
      r.email?.toLowerCase().includes(q) ||
      r.region?.includes(search)
    );
  });

  // ── Audit-grid layout (column reorder, resize, filters, palette, paging) ──
  type ColType = "text" | "num" | "none";
  interface ColDef { key: string; label: string; type: ColType; valueOf: (r: Rep) => string | number }
  const COLUMNS: ColDef[] = useMemo(() => [
    { key: "_sel",       label: "",            type: "none", valueOf: () => "" },
    { key: "_idx",       label: "#",           type: "none", valueOf: () => "" },
    { key: "code",       label: "الكود",       type: "text", valueOf: (r) => r.code ?? "" },
    { key: "name",       label: "الاسم",       type: "text", valueOf: (r) => `${r.nameAr ?? ""} ${r.nameEn ?? ""}`.trim() },
    { key: "phone",      label: "الهاتف",      type: "text", valueOf: (r) => r.phone ?? "" },
    { key: "email",      label: "البريد",      type: "text", valueOf: (r) => r.email ?? "" },
    { key: "region",     label: "المنطقة",     type: "text", valueOf: (r) => r.region ?? "" },
    { key: "commission", label: "العمولة %",   type: "num",  valueOf: (r) => Number(r.commissionPct) || 0 },
    { key: "target",     label: "الهدف الشهري", type: "num",  valueOf: (r) => Number(r.monthlyTarget) || 0 },
    { key: "status",     label: "الحالة",      type: "text", valueOf: (r) => r.isActive ? "نشط" : "متوقف" },
    { key: "_act",       label: "إجراءات",     type: "none", valueOf: () => "" },
  ], []);
  const dataKeys = useMemo(() => COLUMNS.filter(c => !["_sel","_idx","_act"].includes(c.key)).map(c => c.key), [COLUMNS]);
  const allColKeys = useMemo(() => COLUMNS.map(c => c.key), [COLUMNS]);
  const layout = useAuditGridLayout({ screenSlug: "salesReps", cid, dataKeys, allColKeys });
  const { tableRef, gripProps } = useColumnResize(layout.setColWidths);
  const { theme, colWidths, colFilters, setColFilter, clearColFilters,
          isSelected, toggleRow, toggleAll, isAllSelected, isSomeSelected, clearSelection,
          pageSize, page, setPage } = layout;
  const isRtl = true;

  const filtered = useMemo(() => filteredBySearch.filter((r) => {
    for (const col of COLUMNS) {
      const f = colFilters[col.key];
      if (!f) continue;
      if (!matchCol(col.valueOf(r), f, col.type)) return false;
    }
    return true;
  }), [filteredBySearch, colFilters, COLUMNS]);

  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  useEffect(() => { if (safePage !== page) setPage(safePage); }, [safePage, page, setPage]);
  const paged = useMemo(() => pageSize === 0 ? filtered : filtered.slice((safePage - 1) * pageSize, safePage * pageSize), [filtered, pageSize, safePage]);
  const pageStart = filtered.length === 0 ? 0 : pageSize === 0 ? 1 : (safePage - 1) * pageSize + 1;
  const pageEnd = pageSize === 0 ? filtered.length : Math.min(safePage * pageSize, filtered.length);

  const visibleColumns = useMemo(() => {
    const dataCols = layout.dataOrder.map(k => COLUMNS.find(c => c.key === k)).filter((c): c is ColDef => !!c);
    const sel = COLUMNS.find(c => c.key === "_sel")!;
    const idx = COLUMNS.find(c => c.key === "_idx")!;
    const act = COLUMNS.find(c => c.key === "_act")!;
    return [sel, idx, ...dataCols, act];
  }, [layout.dataOrder, COLUMNS]);
  const reorderableCols = useMemo(() => layout.dataOrder
    .map(k => COLUMNS.find(c => c.key === k)!)
    .map(c => ({ key: c.key, label: c.label })), [layout.dataOrder, COLUMNS]);
  const allFilteredIds = useMemo(() => filtered.map(r => r.id), [filtered]);

  function exportCsv() {
    if (filtered.length === 0) {
      toast({ title: "لا يوجد بيانات للتصدير", variant: "destructive" });
      return;
    }
    const exportable = visibleColumns.filter(c => !["_sel","_idx","_act"].includes(c.key));
    const header = ["#", ...exportable.map(c => c.label)];
    const rows = filtered.map((r, i) => [
      i + 1,
      ...exportable.map(c => {
        const v = c.valueOf(r);
        return c.type === "num" ? Number(v).toFixed(2) : String(v ?? "");
      }),
    ]);
    downloadCsv(`sales-reps-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
  }

  function openNew() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  }

  function openEdit(r: Rep) {
    setEditing(r);
    setForm({
      code: r.code ?? "",
      nameAr: r.nameAr ?? "",
      nameEn: r.nameEn ?? "",
      phone: r.phone ?? "",
      email: r.email ?? "",
      address: r.address ?? "",
      branchId: r.branchId ? String(r.branchId) : "",
      region: r.region ?? "",
      isActive: r.isActive,
      commissionPct: String(r.commissionPct ?? "0"),
      commissionType: r.commissionType ?? "invoice",
      monthlyTarget: String(r.monthlyTarget ?? "0"),
      accountId: r.accountId ? String(r.accountId) : "",
      notes: r.notes ?? "",
      userId: r.userId ? String(r.userId) : "",
    });
    setShowForm(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.nameAr.trim()) throw new Error("اسم المندوب مطلوب");
      const body: any = {
        companyId: cid,
        code: form.code.trim() || undefined,
        nameAr: form.nameAr.trim(),
        nameEn: form.nameEn.trim() || null,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        address: form.address.trim() || null,
        branchId: form.branchId ? Number(form.branchId) : null,
        region: form.region.trim() || null,
        isActive: form.isActive,
        commissionPct: Number(form.commissionPct) || 0,
        commissionType: form.commissionType,
        monthlyTarget: Number(form.monthlyTarget) || 0,
        accountId: form.accountId ? Number(form.accountId) : null,
        notes: form.notes.trim() || null,
        // Either pass a user id OR explicit null to disconnect on edit. The
        // backend treats undefined as "leave alone" but null as "clear".
        userId: form.userId ? Number(form.userId) : (editing ? null : undefined),
      };
      const url = editing
        ? `${API}/api/sales-reps/${editing.id}`
        : `${API}/api/sales-reps`;
      const r = await fetch(url, {
        method: editing ? "PUT" : "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "تعذّر الحفظ");
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-reps", cid] });
      toast({ title: editing ? "تم التحديث" : "تم الإضافة" });
      setShowForm(false);
      setEditing(null);
      setForm(EMPTY_FORM);
    },
    onError: (e: any) => {
      toast({ title: "خطأ", description: e?.message || "فشل الحفظ", variant: "destructive" });
    },
  });

  // ─── One-click rep onboarding ───────────────────────────────────
  // Posts to /api/sales-reps/:id/onboard-user which, on the linked user,
  // (a) sets scopeOwnCustomersOnly = true and (b) merges the standard rep
  // permission set (customers / sales_invoices / sales_quotations / etc.)
  // without removing any extra perms an admin already granted. Idempotent.
  const onboardMut = useMutation({
    mutationFn: async (repId: number) => {
      const r = await fetch(`${API}/api/sales-reps/${repId}/onboard-user?companyId=${cid}`, {
        method: "POST",
        headers,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "تعذّر التجهيز");
      return j;
    },
    onSuccess: (j: any) => {
      qc.invalidateQueries({ queryKey: ["sales-reps", cid] });
      qc.invalidateQueries({ queryKey: ["company-users", cid] });
      toast({
        title: "تم تجهيز المندوب",
        description: `تم تفعيل عزل العملاء ومنح صلاحيات: ${(j?.modules ?? []).length} وحدة. اطلب من المندوب تسجيل الخروج والدخول مجدداً.`,
      });
    },
    onError: (e: any) => {
      toast({ title: "تعذّر تجهيز المندوب", description: e?.message, variant: "destructive" });
    },
  });

  const deleteMut = useMutation({
    mutationFn: async () => {
      if (!deleteRep) return;
      const r = await fetch(`${API}/api/sales-reps/${deleteRep.id}?companyId=${cid}`, {
        method: "DELETE",
        headers,
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "تعذّر الحذف");
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-reps", cid] });
      toast({ title: "تم الحذف" });
      setDeleteRep(null);
    },
    onError: (e: any) => {
      toast({ title: "تعذّر الحذف", description: e?.message, variant: "destructive" });
      setDeleteRep(null);
    },
  });

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="h-6 w-6 text-primary" />
            مناديب المبيعات
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            إدارة مناديب المبيعات وعمولاتهم — {reps.length} مندوب
          </p>
        </div>
        <Button onClick={openNew} data-testid="btn-new-rep">
          <Plus className="h-4 w-4 ms-2" />
          مندوب جديد
        </Button>
      </div>

      <Tabs defaultValue="list" className="w-full">
        <TabsList className="grid grid-cols-2 w-full max-w-md mx-auto h-12 p-1 bg-gradient-to-l from-violet-50 via-blue-50 to-emerald-50 border border-slate-200 shadow-sm">
          <TabsTrigger
            value="list"
            className="gap-2 text-sm font-semibold data-[state=active]:bg-white data-[state=active]:shadow-md data-[state=active]:text-blue-700 transition-all"
            data-testid="tab-reps-list"
          >
            <ListChecks className="h-4 w-4" />
            قائمة المناديب
            <span className="ms-1 text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 font-mono">
              {reps.length}
            </span>
          </TabsTrigger>
          <TabsTrigger
            value="dashboard"
            className="gap-2 text-sm font-semibold data-[state=active]:bg-white data-[state=active]:shadow-md data-[state=active]:text-violet-700 transition-all"
            data-testid="tab-reps-dashboard"
          >
            <BarChart3 className="h-4 w-4" />
            لوحة الأداء
            <Sparkles className="h-3 w-3 text-violet-500" />
          </TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="space-y-4 mt-4">
      {/* Audit-grid toolbar */}
      <div className={cn("rounded-t-lg overflow-hidden border shadow-sm transition-colors", theme.border)}>
        <div className={cn("px-3 py-2 flex items-center gap-2 flex-wrap transition-colors", theme.bar, theme.text)} dir="rtl">
          <div className={cn("flex-1 text-sm font-bold tracking-wide flex items-center gap-2", theme.text)}>
            <Users className="h-4 w-4 opacity-90" />
            مناديب المبيعات
          </div>
          <div className="flex items-center gap-1.5">
            <HeaderColorPicker layout={layout} isRtl={isRtl} />
            <FooterColorPicker layout={layout} isRtl={isRtl} />
            <ColumnReorderPopover layout={layout} isRtl={isRtl} columns={reorderableCols} />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={cn("h-7 px-2 text-xs gap-1", theme.btn)}
              onClick={exportCsv}
              data-testid="btn-export-csv"
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />
              تصدير CSV
            </Button>
          </div>
        </div>
        <div className="bg-slate-50 border-t border-slate-200 px-3 py-2 flex items-center gap-2 flex-wrap text-xs" dir="rtl">
          <div className="relative">
            <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="بحث بالاسم، الكود، الهاتف، المنطقة…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pe-7 h-7 text-xs w-64"
              data-testid="input-search-rep"
            />
          </div>
          {Object.values(colFilters).some(v => v) && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-rose-700 hover:bg-rose-50"
              onClick={clearColFilters}
            >
              <X className="h-3.5 w-3.5 me-1" />
              مسح فلاتر الأعمدة
            </Button>
          )}
          <div className="flex-1" />
          <span className="text-slate-700 font-medium">
            {filtered.length} مندوب
            {filtered.length !== reps.length && <span className="text-slate-400"> / {reps.length}</span>}
          </span>
        </div>
        <AuditGridBulkBar count={layout.selected.size} onClear={clearSelection}>
          <span className="text-emerald-800">
            تم تحديد {layout.selected.size} مندوب
          </span>
        </AuditGridBulkBar>
      </div>

      {showForm && (
        <FormPanel
          icon={editing ? Pencil : Plus}
          title={editing ? `تعديل المندوب: ${editing.nameAr}` : "إضافة مندوب جديد"}
          subtitle={editing ? `الكود: ${editing.code}` : "املأ بيانات المندوب — الكود يُولَّد تلقائياً إن تركته فارغاً"}
          width="3xl"
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSave={() => saveMut.mutate()}
          saving={saveMut.isPending}
          saveLabel="حفظ"
          cancelLabel="إلغاء"
        >
          <Tabs defaultValue="basic" className="w-full" dir="rtl">
            <TabsList className="grid w-full grid-cols-2 h-auto p-1.5 bg-gradient-to-l from-slate-100 to-slate-50 border border-slate-200 rounded-xl gap-1.5">
              <TabsTrigger
                value="basic"
                className="flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg text-sm font-semibold text-slate-600 data-[state=active]:bg-gradient-to-l data-[state=active]:from-emerald-600 data-[state=active]:to-teal-600 data-[state=active]:text-white data-[state=active]:shadow-md transition-all"
                data-testid="tab-rep-basic"
              >
                <Users className="h-4 w-4" />
                <span>البيانات الأساسية</span>
              </TabsTrigger>
              <TabsTrigger
                value="financial"
                className="flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg text-sm font-semibold text-slate-600 data-[state=active]:bg-gradient-to-l data-[state=active]:from-violet-600 data-[state=active]:to-fuchsia-600 data-[state=active]:text-white data-[state=active]:shadow-md transition-all"
                data-testid="tab-rep-financial"
              >
                <Wallet className="h-4 w-4" />
                <span>العمولة وحساب الدخول</span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="basic" className="mt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>الكود</Label>
              <Input
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                placeholder="تلقائي مثل SR0001"
                data-testid="input-code"
              />
            </div>
            <div>
              <Label>الاسم بالعربية *</Label>
              <Input
                value={form.nameAr}
                onChange={(e) => setForm({ ...form, nameAr: e.target.value })}
                placeholder="اسم المندوب"
                data-testid="input-name-ar"
              />
            </div>
            <div>
              <Label>الاسم بالإنجليزية</Label>
              <Input
                value={form.nameEn}
                onChange={(e) => setForm({ ...form, nameEn: e.target.value })}
                placeholder="Sales Rep Name"
                data-testid="input-name-en"
              />
            </div>
            <div>
              <Label>الهاتف</Label>
              <Input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="05xxxxxxxx"
                data-testid="input-phone"
              />
            </div>
            <div>
              <Label>البريد الإلكتروني</Label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="rep@example.com"
                data-testid="input-email"
              />
            </div>
            <div>
              <Label>الفرع</Label>
              <select
                className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.branchId}
                onChange={(e) => setForm({ ...form, branchId: e.target.value })}
                data-testid="select-branch"
              >
                <option value="">— اختر الفرع —</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.nameAr || b.nameEn}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>المنطقة</Label>
              <Input
                value={form.region}
                onChange={(e) => setForm({ ...form, region: e.target.value })}
                placeholder="الرياض / جدة / الشرقية…"
                data-testid="input-region"
              />
            </div>
            <div>
              <Label>العنوان</Label>
              <Input
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                placeholder="عنوان المندوب"
                data-testid="input-address"
              />
            </div>
          </div>
            </TabsContent>

            <TabsContent value="financial" className="mt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>نسبة العمولة %</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                max="100"
                value={form.commissionPct}
                onChange={(e) => setForm({ ...form, commissionPct: e.target.value })}
                data-testid="input-commission-pct"
              />
            </div>
            <div>
              <Label>نوع العمولة</Label>
              <select
                className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.commissionType}
                onChange={(e) => setForm({ ...form, commissionType: e.target.value as any })}
                data-testid="select-commission-type"
              >
                <option value="invoice">على الفاتورة (تُحسب عند البيع)</option>
                <option value="collection">على التحصيل (تُحسب عند القبض)</option>
              </select>
            </div>
            <div>
              <Label>الهدف الشهري (ر.س)</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={form.monthlyTarget}
                onChange={(e) => setForm({ ...form, monthlyTarget: e.target.value })}
                data-testid="input-monthly-target"
              />
            </div>
            <div>
              <Label>الحساب المحاسبي (اختياري)</Label>
              <AccountCombobox
                value={form.accountId}
                onValueChange={(v) => setForm({ ...form, accountId: v })}
                placeholder="— اختر حساب العمولات —"
                allowEmpty
              />
            </div>
            <div className="md:col-span-2">
              <Label>ملاحظات</Label>
              <Input
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="ملاحظات إدارية"
                data-testid="input-notes"
              />
            </div>
            <div className="md:col-span-2">
              <Label className="flex items-center gap-1">
                <KeyRound className="h-3.5 w-3.5 text-blue-600" />
                حساب الدخول للنظام
              </Label>
              <select
                className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.userId}
                onChange={(e) => {
                  const newUserId = e.target.value;
                  // Auto-fill the rep form from the selected user's profile.
                  // Strategy: copy code / nameAr / nameEn / email ONLY when
                  // the corresponding rep field is empty — never overwrite
                  // data the admin already typed. Lets the admin "snap" a
                  // rep to a system user in one click and get a fully
                  // pre-populated form to confirm and save.
                  setForm((f) => {
                    const next = { ...f, userId: newUserId };
                    if (newUserId) {
                      const u = users.find((x) => String(x.id) === newUserId);
                      if (u) {
                        if (!f.code.trim() && u.code)   next.code   = u.code;
                        if (!f.nameAr.trim() && u.nameAr) next.nameAr = u.nameAr;
                        if (!f.nameEn.trim() && u.nameEn) next.nameEn = u.nameEn;
                        if (!f.email.trim() && u.email)   next.email  = u.email;
                      }
                    }
                    return next;
                  });
                }}
                data-testid="select-rep-user"
              >
                <option value="">— بدون حساب دخول (مندوب خارجي) —</option>
                {users
                  .filter((u) => {
                    // Hide users already linked to a *different* rep so the
                    // unique constraint can't bite at save time. Always keep
                    // the currently-edited rep's own user in the list.
                    const takenBy = reps.find((r) => r.userId === u.id);
                    return !takenBy || takenBy.id === editing?.id;
                  })
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.nameAr || u.nameEn || u.username} ({u.username})
                      {!u.isActive ? " — موقوف" : ""}
                    </option>
                  ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                عند ربط حساب دخول، فواتير هذا المستخدم تُسنَد تلقائياً للمندوب وتُحسب عمولته بدون تدخّل يدوي.
              </p>

              {/* ─── Linked-user preview card ─────────────────────────────
                  When a system account is selected, show an attractive
                  summary card with the user's basic info (name, username,
                  email, role, active status, last login). Helps the admin
                  confirm they picked the right account before saving and
                  surfaces problems early (e.g. account is deactivated). */}
              {(() => {
                const selectedUser = users.find((u) => String(u.id) === form.userId);
                if (!selectedUser) return null;
                const fullName = selectedUser.nameAr || selectedUser.nameEn || selectedUser.username;
                const initials = (fullName || "?").trim().slice(0, 2);
                const lastLogin = selectedUser.lastLoginAt
                  ? new Date(selectedUser.lastLoginAt).toLocaleString("ar-SA", {
                      dateStyle: "medium", timeStyle: "short",
                    })
                  : "لم يسجّل دخول بعد";
                const roleLabel = selectedUser.role === "admin" ? "مدير" : selectedUser.role === "superadmin" ? "سوبر أدمن" : "مستخدم";
                return (
                  <div
                    className="mt-3 rounded-xl overflow-hidden border-2 border-blue-200 shadow-sm animate-in fade-in slide-in-from-top-2 duration-300"
                    data-testid="linked-user-preview"
                  >
                    {/* Header strip with avatar + status */}
                    <div className={cn(
                      "px-4 py-3 flex items-center gap-3 text-white",
                      selectedUser.isActive
                        ? "bg-gradient-to-l from-blue-600 via-cyan-600 to-teal-500"
                        : "bg-gradient-to-l from-slate-500 via-slate-600 to-slate-700",
                    )}>
                      <div className="size-12 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center text-lg font-bold ring-2 ring-white/30 shadow-inner">
                        {initials}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className="font-bold text-base truncate">{fullName}</div>
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/25 text-[10px] font-semibold backdrop-blur-sm">
                            <Link2 className="size-2.5" /> مربوط
                          </span>
                        </div>
                        <div className="text-xs opacity-90 flex items-center gap-1">
                          <AtSign className="size-3" /> {selectedUser.username}
                        </div>
                      </div>
                      {selectedUser.isActive ? (
                        <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-400/30 backdrop-blur-sm text-xs font-bold ring-1 ring-emerald-200/40">
                          <CheckCircle2 className="size-3.5" /> نشط
                        </div>
                      ) : (
                        <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-rose-500/40 backdrop-blur-sm text-xs font-bold ring-1 ring-rose-200/40">
                          <UserX className="size-3.5" /> موقوف
                        </div>
                      )}
                    </div>

                    {/* Body grid with detail badges */}
                    <div className="bg-gradient-to-bl from-blue-50/60 via-white to-cyan-50/60 px-4 py-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                      <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white border border-slate-200 shadow-sm">
                        <Hash className="size-3.5 text-indigo-500 shrink-0" />
                        <div className="min-w-0">
                          <div className="text-[10px] text-slate-500">الكود</div>
                          <div className="font-mono font-semibold truncate">{selectedUser.code || "—"}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white border border-slate-200 shadow-sm">
                        <IdCard className="size-3.5 text-violet-500 shrink-0" />
                        <div className="min-w-0">
                          <div className="text-[10px] text-slate-500">الدور</div>
                          <div className="font-semibold truncate">{roleLabel}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white border border-slate-200 shadow-sm col-span-2">
                        <Mail className="size-3.5 text-amber-500 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="text-[10px] text-slate-500">البريد الإلكتروني</div>
                          <div className="font-mono text-[11px] truncate" dir="ltr">{selectedUser.email || "—"}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white border border-slate-200 shadow-sm col-span-2 md:col-span-4">
                        <Clock className="size-3.5 text-rose-500 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="text-[10px] text-slate-500">آخر تسجيل دخول</div>
                          <div className="font-medium text-[11px] truncate">{lastLogin}</div>
                        </div>
                      </div>
                    </div>

                    {/* Auto-fill helper — re-applies the auto-population on demand */}
                    <div className="px-4 py-2 border-t bg-gradient-to-l from-sky-50 to-cyan-50 flex items-center justify-between gap-3">
                      <div className="text-[11px] text-slate-700 flex items-center gap-1.5">
                        <Sparkles className="size-3.5 text-cyan-600" />
                        تم تعبئة الحقول الفارغة تلقائياً من حساب المستخدم.
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 text-[11px] bg-white border-cyan-300 text-cyan-700 hover:bg-cyan-50"
                        onClick={() => {
                          // Force-overwrite: copy ALL fields from the user
                          // regardless of what's currently in the form.
                          // Useful when the admin typed something wrong and
                          // wants a clean snap to the user's profile.
                          setForm((f) => ({
                            ...f,
                            code:   selectedUser.code   ?? f.code,
                            nameAr: selectedUser.nameAr ?? f.nameAr,
                            nameEn: selectedUser.nameEn ?? f.nameEn,
                            email:  selectedUser.email  ?? f.email,
                          }));
                          toast({ title: "✨ تم تحديث البيانات من حساب المستخدم" });
                        }}
                        data-testid="button-resync-user"
                      >
                        <Wand2 className="size-3 me-1" /> إعادة المزامنة
                      </Button>
                    </div>
                  </div>
                );
              })()}
            </div>
            <div className="md:col-span-2 flex items-center gap-2">
              <input
                id="rep-active"
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                className="h-4 w-4"
                data-testid="checkbox-active"
              />
              <Label htmlFor="rep-active" className="cursor-pointer">
                المندوب نشط
              </Label>
            </div>
          </div>
            </TabsContent>
          </Tabs>
        </FormPanel>
      )}

      {(() => {
        const items: LegendItem[] = [
          { kind: "active",   count: filtered.filter((r) => r.isActive).length },
          { kind: "inactive", count: filtered.filter((r) => !r.isActive).length },
        ];
        return <DocColorLegend items={items} />;
      })()}

      <div className="border border-slate-300 border-t-0 rounded-b-lg bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table ref={tableRef} className="w-full text-[11px] border-collapse" dir="rtl">
            <colgroup>
              {visibleColumns.map((col) => (
                <col
                  key={col.key}
                  data-col-key={col.key}
                  style={colWidths[col.key] ? { width: `${colWidths[col.key]}px` } : undefined}
                />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-10">
              <tr className="bg-gradient-to-b from-slate-100 to-slate-200 text-slate-700">
                {visibleColumns.map((col, idx) => (
                  <th
                    key={col.key}
                    data-col-key={col.key}
                    className={cn(
                      "relative px-2 py-1.5 text-right font-semibold border-e border-slate-300 select-none",
                      col.key === "_sel" && "w-9 text-center px-1",
                      col.key === "_idx" && "w-10 text-center px-1",
                      col.key === "_act" && "w-32 text-center",
                      col.type === "num" && "text-end",
                    )}
                  >
                    {col.key === "_sel" ? (
                      <HeaderSelectCheckbox
                        allSelected={isAllSelected(allFilteredIds)}
                        someSelected={isSomeSelected(allFilteredIds)}
                        onToggle={() => toggleAll(allFilteredIds)}
                        disabled={allFilteredIds.length === 0}
                      />
                    ) : (
                      <span className="inline-block truncate">{col.label}</span>
                    )}
                    {col.key !== "_sel" && (
                      <span
                        {...gripProps(col.key, idx)}
                        className="absolute inset-y-0 start-0 w-1 cursor-col-resize hover:bg-blue-400/40 active:bg-blue-500/60"
                      />
                    )}
                  </th>
                ))}
              </tr>
              <tr className="bg-amber-50/80 border-b border-amber-200">
                {visibleColumns.map((col) => (
                  <th key={col.key} className="px-1 py-1 border-e border-amber-200/60">
                    {col.type === "none" ? null : (
                      <Input
                        value={colFilters[col.key] ?? ""}
                        onChange={(e) => setColFilter(col.key, e.target.value)}
                        placeholder={col.type === "num" ? ">=N" : "فلتر…"}
                        className="h-6 text-[10px] px-1.5 bg-white"
                      />
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                [1, 2, 3, 4, 5].map((i) => (
                  <tr key={i}>
                    <td colSpan={visibleColumns.length} className="px-2 py-2">
                      <Skeleton className="h-6 w-full" />
                    </td>
                  </tr>
                ))
              ) : paged.length === 0 ? (
                <tr>
                  <td colSpan={visibleColumns.length} className="px-3 py-12 text-center text-muted-foreground">
                    {reps.length === 0
                      ? "لا يوجد مناديب بعد. اضغط على «مندوب جديد» للإضافة."
                      : "لا توجد نتائج مطابقة لبحثك."}
                  </td>
                </tr>
              ) : (
                paged.map((r, rowIdx) => {
                  const dictStatus = r.isActive ? "active" : "inactive";
                  const sel = isSelected(r.id);
                  return (
                    <tr
                      key={r.id}
                      data-status={dictStatus}
                      className={cn(
                        "border-b border-slate-200 transition-colors",
                        sel ? SEL_TONE : rowToneFor({ status: dictStatus, statusMap: DICT_TONES }),
                      )}
                      title={buildToneTooltip({ status: dictStatus, statusMap: DICT_TONES })}
                      data-testid={`row-rep-${r.id}`}
                    >
                      {visibleColumns.map((col) => {
                        if (col.key === "_sel") {
                          return (
                            <td key={col.key} className="px-1 py-1 text-center border-e border-slate-200/60">
                              <RowSelectCheckbox
                                checked={sel}
                                onToggle={() => toggleRow(r.id)}
                                ariaLabel={`تحديد ${r.nameAr}`}
                              />
                            </td>
                          );
                        }
                        if (col.key === "_idx") {
                          return (
                            <td key={col.key} className="px-1 py-1 text-center text-slate-500 font-mono border-e border-slate-200/60">
                              {pageStart + rowIdx}
                            </td>
                          );
                        }
                        if (col.key === "code") {
                          return <td key={col.key} className="px-2 py-1 font-mono text-[10px] border-e border-slate-200/60">{r.code}</td>;
                        }
                        if (col.key === "name") {
                          return (
                            <td key={col.key} className="px-2 py-1 border-e border-slate-200/60">
                              <div className="font-medium">{r.nameAr}</div>
                              {r.nameEn && <div className="text-[10px] text-muted-foreground">{r.nameEn}</div>}
                            </td>
                          );
                        }
                        if (col.key === "phone") {
                          return (
                            <td key={col.key} className="px-2 py-1 text-muted-foreground border-e border-slate-200/60">
                              {r.phone ? (<span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{r.phone}</span>) : "—"}
                            </td>
                          );
                        }
                        if (col.key === "email") {
                          return (
                            <td key={col.key} className="px-2 py-1 text-muted-foreground border-e border-slate-200/60">
                              {r.email ? (<span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" />{r.email}</span>) : "—"}
                            </td>
                          );
                        }
                        if (col.key === "region") {
                          return (
                            <td key={col.key} className="px-2 py-1 text-muted-foreground border-e border-slate-200/60">
                              {r.region ? (<span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{r.region}</span>) : "—"}
                            </td>
                          );
                        }
                        if (col.key === "commission") {
                          return (
                            <td key={col.key} className="px-2 py-1 tabular-nums text-end border-e border-slate-200/60">
                              <div className="inline-flex items-center gap-1">
                                <Percent className="h-3 w-3 text-muted-foreground" />
                                <span className="font-medium">{Number(r.commissionPct).toFixed(2)}%</span>
                              </div>
                              <div className="text-[10px] text-muted-foreground">
                                {r.commissionType === "collection" ? "على التحصيل" : "على الفاتورة"}
                              </div>
                            </td>
                          );
                        }
                        if (col.key === "target") {
                          return (
                            <td key={col.key} className="px-2 py-1 tabular-nums text-end border-e border-slate-200/60">
                              <span className="inline-flex items-center gap-1">
                                <Target className="h-3 w-3 text-muted-foreground" />
                                {Number(r.monthlyTarget).toLocaleString("ar-SA", { maximumFractionDigits: 2 })} ر.س
                              </span>
                            </td>
                          );
                        }
                        if (col.key === "status") {
                          return (
                            <td key={col.key} className="px-2 py-1 border-e border-slate-200/60">
                              {r.isActive ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-green-50 text-green-700 border border-green-200">
                                  <UserCheck className="h-3 w-3" />نشط
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-gray-100 text-gray-600 border border-gray-200">
                                  <UserX className="h-3 w-3" />متوقف
                                </span>
                              )}
                            </td>
                          );
                        }
                        if (col.key === "_act") {
                          return (
                            <td key={col.key} className="px-1 py-1 text-center">
                              <div className="flex items-center justify-center gap-0.5">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-violet-600 hover:text-violet-700"
                                  onClick={() => runAiAnalysis(r)}
                                  title="تحليل الأداء بالذكاء الاصطناعي"
                                  data-testid={`btn-ai-${r.id}`}
                                >
                                  <Sparkles className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className={cn(
                                    "h-7 w-7",
                                    r.userId ? "text-emerald-600 hover:text-emerald-700" : "text-gray-300 cursor-not-allowed",
                                  )}
                                  disabled={!r.userId || onboardMut.isPending}
                                  onClick={() => r.userId && onboardMut.mutate(r.id)}
                                  title={r.userId ? "تجهيز كامل للمندوب (تفعيل العزل + منح الصلاحيات الأساسية)" : "اربط المندوب بمستخدم أولاً"}
                                  data-testid={`btn-onboard-${r.id}`}
                                >
                                  {onboardMut.isPending && onboardMut.variables === r.id
                                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    : <Wand2 className="h-3.5 w-3.5" />}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  onClick={() => openEdit(r)}
                                  data-testid={`btn-edit-${r.id}`}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-red-600 hover:text-red-700"
                                  onClick={() => setDeleteRep(r)}
                                  data-testid={`btn-delete-${r.id}`}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </td>
                          );
                        }
                        return null;
                      })}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <AuditGridPagination
          layout={layout}
          totalRows={filtered.length}
          pageStart={pageStart}
          pageEnd={pageEnd}
          totalPages={totalPages}
          unitLabel="مندوب"
        />
      </div>
        </TabsContent>

        <TabsContent value="dashboard" className="space-y-4 mt-4" dir="rtl">
          {(() => {
            const activeReps = reps.filter((r) => r.isActive);
            const inactiveReps = reps.filter((r) => !r.isActive);
            const totalTarget = reps.reduce((s, r) => s + Number(r.monthlyTarget || 0), 0);
            const avgCommission = reps.length
              ? reps.reduce((s, r) => s + Number(r.commissionPct || 0), 0) / reps.length
              : 0;
            const linkedUsers = reps.filter((r) => r.userId).length;
            const invoiceType = reps.filter((r) => r.commissionType === "invoice").length;
            const collectionType = reps.filter((r) => r.commissionType === "collection").length;
            const topByTarget = [...reps]
              .sort((a, b) => Number(b.monthlyTarget || 0) - Number(a.monthlyTarget || 0))
              .slice(0, 5);
            const regionMap = new Map<string, number>();
            reps.forEach((r) => {
              const k = (r.region || "غير محدد").trim() || "غير محدد";
              regionMap.set(k, (regionMap.get(k) || 0) + 1);
            });
            const regions = [...regionMap.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 6);
            const fmt = (n: number) =>
              n.toLocaleString("ar-SA", { maximumFractionDigits: 2 });

            const kpis = [
              {
                icon: Users,
                label: "إجمالي المناديب",
                value: reps.length,
                tone: "from-blue-500 to-blue-600",
                bg: "bg-blue-50",
                fg: "text-blue-700",
              },
              {
                icon: UserCheck,
                label: "المناديب النشطون",
                value: activeReps.length,
                sub: reps.length
                  ? `${Math.round((activeReps.length / reps.length) * 100)}% من الإجمالي`
                  : "—",
                tone: "from-emerald-500 to-emerald-600",
                bg: "bg-emerald-50",
                fg: "text-emerald-700",
              },
              {
                icon: UserX,
                label: "المناديب الموقوفون",
                value: inactiveReps.length,
                tone: "from-slate-400 to-slate-500",
                bg: "bg-slate-50",
                fg: "text-slate-700",
              },
              {
                icon: Target,
                label: "إجمالي الهدف الشهري",
                value: `${fmt(totalTarget)} ر.س`,
                tone: "from-amber-500 to-orange-500",
                bg: "bg-amber-50",
                fg: "text-amber-700",
                wide: true,
              },
              {
                icon: Percent,
                label: "متوسط نسبة العمولة",
                value: `${avgCommission.toFixed(2)}%`,
                tone: "from-violet-500 to-fuchsia-500",
                bg: "bg-violet-50",
                fg: "text-violet-700",
              },
              {
                icon: KeyRound,
                label: "مرتبطون بحساب دخول",
                value: linkedUsers,
                sub: `${reps.length - linkedUsers} بدون حساب`,
                tone: "from-cyan-500 to-teal-500",
                bg: "bg-cyan-50",
                fg: "text-cyan-700",
              },
            ];

            return (
              <>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                  {kpis.map((k) => {
                    const Icon = k.icon;
                    return (
                      <Card
                        key={k.label}
                        className={cn(
                          "relative overflow-hidden border-slate-200 hover:shadow-lg transition-shadow group",
                          k.wide && "col-span-2 lg:col-span-2",
                        )}
                      >
                        <div
                          className={cn(
                            "absolute inset-x-0 top-0 h-1 bg-gradient-to-l",
                            k.tone,
                          )}
                        />
                        <CardContent className="p-4">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="text-[11px] text-muted-foreground font-medium truncate">
                                {k.label}
                              </p>
                              <p className={cn("text-2xl font-bold mt-1 tabular-nums", k.fg)}>
                                {k.value}
                              </p>
                              {k.sub && (
                                <p className="text-[10px] text-muted-foreground mt-0.5">
                                  {k.sub}
                                </p>
                              )}
                            </div>
                            <div
                              className={cn(
                                "p-2 rounded-lg group-hover:scale-110 transition-transform",
                                k.bg,
                              )}
                            >
                              <Icon className={cn("h-5 w-5", k.fg)} />
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <Card className="lg:col-span-2 border-slate-200">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2 mb-3 pb-2 border-b">
                        <Trophy className="h-4 w-4 text-amber-500" />
                        <h3 className="text-sm font-bold text-slate-800">
                          أعلى 5 مناديب من حيث الهدف الشهري
                        </h3>
                      </div>
                      {topByTarget.length === 0 ? (
                        <p className="text-xs text-muted-foreground text-center py-6">
                          لا يوجد مناديب بعد
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {topByTarget.map((r, i) => {
                            const pct = totalTarget
                              ? (Number(r.monthlyTarget || 0) / Number(topByTarget[0].monthlyTarget || 1)) * 100
                              : 0;
                            const medal =
                              i === 0
                                ? "bg-amber-100 text-amber-700 border-amber-300"
                                : i === 1
                                ? "bg-slate-100 text-slate-700 border-slate-300"
                                : i === 2
                                ? "bg-orange-100 text-orange-700 border-orange-300"
                                : "bg-blue-50 text-blue-700 border-blue-200";
                            return (
                              <div key={r.id} className="flex items-center gap-3">
                                <div
                                  className={cn(
                                    "h-7 w-7 rounded-full border flex items-center justify-center text-[11px] font-bold shrink-0",
                                    medal,
                                  )}
                                >
                                  {i + 1}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center justify-between gap-2 mb-1">
                                    <span className="text-xs font-semibold truncate">
                                      {r.nameAr}
                                    </span>
                                    <span className="text-xs tabular-nums font-mono text-amber-700">
                                      {fmt(Number(r.monthlyTarget || 0))} ر.س
                                    </span>
                                  </div>
                                  <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                    <div
                                      className="h-full bg-gradient-to-l from-amber-400 to-orange-500 transition-all"
                                      style={{ width: `${Math.max(pct, 4)}%` }}
                                    />
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  <Card className="border-slate-200">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2 mb-3 pb-2 border-b">
                        <Wallet className="h-4 w-4 text-violet-500" />
                        <h3 className="text-sm font-bold text-slate-800">
                          نوع العمولة
                        </h3>
                      </div>
                      {reps.length === 0 ? (
                        <p className="text-xs text-muted-foreground text-center py-6">
                          لا توجد بيانات
                        </p>
                      ) : (
                        <div className="space-y-3">
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-xs font-medium">على الفاتورة</span>
                              <span className="text-xs font-mono tabular-nums text-blue-700">
                                {invoiceType}
                              </span>
                            </div>
                            <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-gradient-to-l from-blue-400 to-blue-600"
                                style={{ width: `${(invoiceType / reps.length) * 100}%` }}
                              />
                            </div>
                          </div>
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-xs font-medium">على التحصيل</span>
                              <span className="text-xs font-mono tabular-nums text-emerald-700">
                                {collectionType}
                              </span>
                            </div>
                            <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-gradient-to-l from-emerald-400 to-emerald-600"
                                style={{ width: `${(collectionType / reps.length) * 100}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>

                <Card className="border-slate-200">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-3 pb-2 border-b">
                      <MapPin className="h-4 w-4 text-rose-500" />
                      <h3 className="text-sm font-bold text-slate-800">
                        التوزيع الجغرافي للمناديب
                      </h3>
                    </div>
                    {regions.length === 0 ? (
                      <p className="text-xs text-muted-foreground text-center py-6">
                        لا توجد بيانات منطقة
                      </p>
                    ) : (
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
                        {regions.map(([region, count]) => (
                          <div
                            key={region}
                            className="rounded-lg border border-rose-100 bg-gradient-to-br from-rose-50 to-pink-50 p-3 hover:shadow-md transition-shadow"
                          >
                            <div className="flex items-center gap-1.5 mb-1">
                              <MapPin className="h-3 w-3 text-rose-500 shrink-0" />
                              <span className="text-xs font-semibold text-slate-700 truncate">
                                {region}
                              </span>
                            </div>
                            <div className="flex items-baseline gap-1">
                              <span className="text-xl font-bold text-rose-700 tabular-nums">
                                {count}
                              </span>
                              <span className="text-[10px] text-muted-foreground">مندوب</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </>
            );
          })()}
        </TabsContent>
      </Tabs>

      <AlertDialog open={!!deleteRep} onOpenChange={(o) => !o && setDeleteRep(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف المندوب</AlertDialogTitle>
            <AlertDialogDescription>
              هل أنت متأكد من حذف المندوب «{deleteRep?.nameAr}»؟ لا يمكن التراجع عن هذه العملية.
              <br />
              <span className="text-xs text-muted-foreground mt-2 block">
                ملاحظة: لا يمكن حذف مندوب مرتبط بفواتير أو عملاء — يمكنك تعطيله بدلاً من ذلك.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMut.mutate()}
              className="bg-red-600 hover:bg-red-700"
            >
              حذف
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!aiRep} onOpenChange={(o) => { if (!o) { setAiRep(null); setAiAnalysis(""); } }}>
        <DialogContent dir="rtl" className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-violet-600" />
              تحليل أداء المندوب: {aiRep?.nameAr}
            </DialogTitle>
          </DialogHeader>
          <div className="mt-2">
            {aiLoading ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Loader2 className="h-8 w-8 animate-spin mb-3 text-violet-600" />
                <p className="text-sm">جارٍ تحليل بيانات آخر 90 يوماً…</p>
                <p className="text-xs mt-1">قد يستغرق الأمر بضع ثوان.</p>
              </div>
            ) : aiAnalysis ? (
              <div
                className="prose prose-sm max-w-none whitespace-pre-wrap leading-relaxed text-foreground"
                data-testid="ai-analysis-content"
              >
                {aiAnalysis}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-6 text-center">
                لا يوجد محتوى للعرض.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
