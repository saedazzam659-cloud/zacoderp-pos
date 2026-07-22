import { useState, useMemo } from "react";
import { fmt2 } from "@/lib/format";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { AccountCombobox } from "@/components/AccountCombobox";
import {
  Plus, Pencil, Trash2, Play, Repeat, AlertCircle, CheckCircle2,
  CalendarClock, Sparkles, FileText, ArrowRightCircle, Link2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DateField } from "@/components/ui/date-field";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Adjustment = {
  id: number;
  companyId: number;
  type: "prepaid" | "accrued";
  name: string;
  expenseAccountId: number;
  contraAccountId: number;
  costCenterId: number | null;
  totalAmount: string;
  startDate: string;
  endDate: string;
  monthlyAmount: string;
  autoGenerate: boolean;
  carryForwardEnabled: boolean;
  parentAdjustmentId: number | null;
  status: "active" | "completed" | "cancelled" | "carried_forward";
  lastGeneratedDate: string | null;
  notes: string | null;
  createdAt: string;
  // computed by server
  recognizedAmount: string;
  remainingAmount:  string;
  runCount: number;
};

const TYPE_LABELS: Record<Adjustment["type"], string> = {
  prepaid: "مصروف مدفوع مقدمًا",
  accrued: "مصروف مستحق",
};

const STATUS_BADGE: Record<Adjustment["status"], { label: string; cls: string }> = {
  active:          { label: "نشط",        cls: "bg-green-50 text-green-700 border-green-200" },
  completed:       { label: "مكتمل",      cls: "bg-slate-50 text-slate-700 border-slate-200" },
  cancelled:       { label: "ملغى",       cls: "bg-red-50 text-red-700 border-red-200" },
  carried_forward: { label: "مُرحَّل",     cls: "bg-purple-50 text-purple-700 border-purple-200" },
};

// Default carry-forward window = next calendar year (Jan 1 → Dec 31)
const defaultCarryDates = (parentEndDate: string) => {
  const [y] = parentEndDate.split("-").map(Number);
  const ny = y + 1;
  return { start: `${ny}-01-01`, end: `${ny}-12-31` };
};

const today = () => new Date().toISOString().slice(0, 10);
const plusYear = () => {
  const d = new Date(); d.setFullYear(d.getFullYear() + 1); d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
};
// End date = one year minus a day after a given ISO start date
const plusYearFrom = (iso: string) => {
  const [y, m, dd] = iso.slice(0, 10).split("-").map(Number);
  const d = new Date(Date.UTC(y, (m ?? 1) - 1, dd ?? 1));
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

const EMPTY_FORM = {
  type: "prepaid" as Adjustment["type"],
  name: "",
  expenseAccountId: "",
  contraAccountId: "",
  costCenterId: "",
  totalAmount: "",
  startDate: today(),
  endDate: plusYear(),
  autoGenerate: true,
  carryForwardEnabled: true,
  notes: "",
};

export default function Adjustments() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  // GET headers incl. superadmin acting-company scope (mirrors journalEntriesApi)
  const getHeaders = (): Record<string, string> => {
    const h: Record<string, string> = { Authorization: `Bearer ${token}` };
    const acting = localStorage.getItem("zatca_acting_company_id");
    if (acting) h["x-acting-company-id"] = acting;
    return h;
  };

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Adjustment | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [confirmDelId, setConfirmDelId] = useState<number | null>(null);
  const [carryFor, setCarryFor] = useState<Adjustment | null>(null);
  const [carryForm, setCarryForm] = useState({ start: "", end: "" });

  // ── "تعبئة من مستند" — prefill the create form from a purchase invoice
  //    or a manual journal entry. READ-ONLY: nothing about posting changes.
  const [importKind, setImportKind] = useState<null | "invoice" | "je">(null);
  const [importSearch, setImportSearch] = useState("");
  const [pickedJe, setPickedJe] = useState<any | null>(null); // JE detail (with lines) for the line-pick step
  const [pickedJeLoading, setPickedJeLoading] = useState(false);

  // Cost centers for the optional picker (posting + active only) — the picked
  // centre rides the expense (debit) line of every generated JE.
  const { data: costCentersList = [] } = useQuery<any[]>({
    queryKey: ["cost-centers", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/cost-centers?companyId=${cid}` : `${API}/api/cost-centers`;
      const r = await fetch(url, { headers: getHeaders() });
      if (!r.ok) return [];
      const d = await r.json();
      return Array.isArray(d) ? d : [];
    },
    enabled: !!user,
  });

  const { data: adjustments = [], isLoading } = useQuery<Adjustment[]>({
    queryKey: ["adjustments", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/adjustments?companyId=${cid}` : `${API}/api/adjustments`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      return r.ok ? r.json() : [];
    },
  });

  // Candidate documents for "تعبئة من مستند" — fetched lazily only when a picker is open
  const { data: srcInvoices = [], isLoading: invLoading } = useQuery<any[]>({
    queryKey: ["adj-src-invoices", cid],
    enabled: showForm && importKind === "invoice",
    queryFn: async () => {
      const url = cid
        ? `${API}/api/purchasing/purchase-invoices?companyId=${cid}`
        : `${API}/api/purchasing/purchase-invoices`;
      const r = await fetch(url, { headers: getHeaders() });
      const d = r.ok ? await r.json() : [];
      return Array.isArray(d) ? d : [];
    },
  });
  const { data: srcEntries = [], isLoading: jeLoading } = useQuery<any[]>({
    queryKey: ["adj-src-jes", cid],
    enabled: showForm && importKind === "je",
    queryFn: async () => {
      const url = cid ? `${API}/api/journal-entries?companyId=${cid}` : `${API}/api/journal-entries`;
      const r = await fetch(url, { headers: getHeaders() });
      const d = r.ok ? await r.json() : [];
      return Array.isArray(d) ? d : [];
    },
  });
  const { data: accountsList = [] } = useQuery<any[]>({
    queryKey: ["adj-src-accounts", cid],
    enabled: showForm && importKind !== null,
    queryFn: async () => {
      const url = cid ? `${API}/api/accounts?companyId=${cid}` : `${API}/api/accounts`;
      const r = await fetch(url, { headers: getHeaders() });
      const d = r.ok ? await r.json() : [];
      return Array.isArray(d) ? d : [];
    },
  });
  const accLabel = (id: number | null | undefined) => {
    if (!id) return "—";
    const a = accountsList.find((x: any) => x.id === id);
    return a ? `${a.code} — ${a.nameAr}` : `#${id}`;
  };

  const closeImport = () => { setImportKind(null); setImportSearch(""); setPickedJe(null); };

  // Apply a JE debit line: the debited account on the source doc IS the prepaid
  // (asset) account → becomes the adjustment's CONTRA (credit) side.
  const applyFromJeLine = (entry: any, line: any) => {
    const amt = Number(line.debit) || 0;
    const start = String(entry.entryDate ?? "").slice(0, 10) || today();
    setForm(p => ({
      ...p,
      type: "prepaid",
      contraAccountId: String(line.accountId),
      totalAmount: amt > 0 ? String(amt) : p.totalAmount,
      name: p.name || (entry.description ? String(entry.description) : `مصروف مقدم — قيد ${entry.docNumber ?? entry.id}`),
      startDate: start,
      endDate: plusYearFrom(start),
      notes: [p.notes, `المصدر: قيد يومية رقم ${entry.docNumber ?? entry.id}`].filter(Boolean).join("\n"),
    }));
    closeImport();
    toast({
      title: "تمت التعبئة من القيد",
      description: "راجع تاريخي البداية والنهاية واختر حساب المصروف (المدين) ثم احفظ",
    });
  };

  // Pick a purchase invoice: prefill amount/name/dates; if it's posted with a
  // linked JE we load its lines so the user can also pick the prepaid account.
  const applyFromInvoice = async (inv: any) => {
    const start = String(inv.invoiceDate ?? "").slice(0, 10) || today();
    const amt = Number(inv.subtotal) || Number(inv.totalAmount) || 0;
    setForm(p => ({
      ...p,
      type: "prepaid",
      totalAmount: amt > 0 ? String(amt) : p.totalAmount,
      name: p.name || `مصروف مقدم — فاتورة مشتريات ${inv.docNumber ?? inv.id}`,
      startDate: start,
      endDate: plusYearFrom(start),
      notes: [p.notes, `المصدر: فاتورة مشتريات رقم ${inv.docNumber ?? inv.id}${inv.supplierInvoiceNumber ? ` (فاتورة المورد ${inv.supplierInvoiceNumber})` : ""}`]
        .filter(Boolean).join("\n"),
    }));
    if (inv.journalEntryId) {
      // second step: pick the prepaid (debit) line from the invoice's JE
      setPickedJeLoading(true);
      try {
        const r = await fetch(`${API}/api/journal-entries/${inv.journalEntryId}${cid ? `?companyId=${cid}` : ""}`, {
          headers: getHeaders(),
        });
        const d = r.ok ? await r.json() : null;
        if (d && Array.isArray(d.lines)) { setPickedJe(d); setImportKind("je"); return; }
      } catch { /* fall through — amounts/dates are already applied */ }
      finally { setPickedJeLoading(false); }
    }
    closeImport();
    toast({
      title: "تمت التعبئة من الفاتورة",
      description: "اختر حساب المصروف وحساب المدفوع مقدمًا ثم احفظ",
    });
  };

  const openJeLines = async (entry: any) => {
    setPickedJeLoading(true);
    try {
      const r = await fetch(`${API}/api/journal-entries/${entry.id}${cid ? `?companyId=${cid}` : ""}`, {
        headers: getHeaders(),
      });
      const d = r.ok ? await r.json() : null;
      if (d && Array.isArray(d.lines)) setPickedJe(d);
      else toast({ title: "خطأ", description: "تعذر تحميل بنود القيد", variant: "destructive" });
    } catch {
      toast({ title: "خطأ", description: "تعذر تحميل بنود القيد", variant: "destructive" });
    } finally { setPickedJeLoading(false); }
  };

  const safeJson = async (r: Response, fallback: string) => {
    const ct = r.headers.get("content-type") || "";
    const d = ct.includes("application/json") ? await r.json().catch(() => ({})) : {};
    if (!r.ok) throw new Error((d as any)?.error || fallback);
    return d;
  };

  const monthlyPreview = useMemo(() => {
    const total = parseFloat(form.totalAmount || "0");
    if (!form.startDate || !form.endDate || !total) return null;
    const [sy, sm, sd] = form.startDate.split("-").map(Number);
    const [ey, em, ed] = form.endDate.split("-").map(Number);
    // Day-aware count (mirrors the server's monthsBetween): the end month is
    // dropped when its day is before the start day — 04/11/2025 → 03/05/2026
    // is exactly 6 months, not 7.
    const months = (ey - sy) * 12 + (em - sm) + (ed >= sd ? 1 : 0);
    if (months <= 0) return null;
    // While editing an adjustment that already has generated months, the
    // server re-spreads (newTotal − recognized) over the REMAINING months —
    // mirror that here so the preview matches what will be saved.
    if (editing && (editing.runCount ?? 0) > 0) {
      const recognized = parseFloat(editing.recognizedAmount ?? "0");
      const remMonths = months - (editing.runCount ?? 0);
      if (remMonths <= 0) return null;
      const remainder = total - recognized;
      if (remainder < 0) return null;
      return { months: remMonths, monthly: remainder / remMonths, respread: true };
    }
    return { months, monthly: total / months, respread: false };
  }, [form.totalAmount, form.startDate, form.endDate, editing]);

  const editLocked = !!editing && (editing.runCount ?? 0) > 0;

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    closeImport();
    setShowForm(true);
  };

  const openEdit = (a: Adjustment) => {
    setEditing(a);
    setForm({
      type: a.type,
      name: a.name,
      expenseAccountId: String(a.expenseAccountId),
      contraAccountId:  String(a.contraAccountId),
      costCenterId:     a.costCenterId != null ? String(a.costCenterId) : "",
      totalAmount:      a.totalAmount,
      startDate:        a.startDate,
      endDate:          a.endDate,
      autoGenerate:     a.autoGenerate,
      carryForwardEnabled: a.carryForwardEnabled,
      notes:            a.notes ?? "",
    });
    setShowForm(true);
  };

  const openCarry = (a: Adjustment) => {
    const d = defaultCarryDates(a.endDate);
    setCarryForm({ start: d.start, end: d.end });
    setCarryFor(a);
  };

  const saveMut = useMutation({
    mutationFn: async () => {
      const body: any = {
        ...form,
        companyId: cid,
        expenseAccountId: Number(form.expenseAccountId),
        contraAccountId:  Number(form.contraAccountId),
        // Optional cost center — applied to the EXPENSE (debit) line of every
        // generated JE. Empty string → explicit null (clears it on edit).
        costCenterId:     form.costCenterId ? Number(form.costCenterId) : null,
      };
      const url = editing ? `${API}/api/adjustments/${editing.id}` : `${API}/api/adjustments`;
      const r = await fetch(url, { method: editing ? "PUT" : "POST", headers, body: JSON.stringify(body) });
      return safeJson(r, "تعذر حفظ التسوية");
    },
    onSuccess: (d: any) => {
      const n = Number(d?.catchUpRuns ?? 0);
      toast({
        title: editing ? "تم تحديث التسوية" : "تم إنشاء التسوية",
        description: !editing && n > 0 ? `تم توليد وترحيل ${n} قيد للأشهر المستحقة تلقائياً` : undefined,
      });
      qc.invalidateQueries({ queryKey: ["adjustments", cid] });
      setShowForm(false); setEditing(null); setForm(EMPTY_FORM);
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/adjustments/${id}`, { method: "DELETE", headers });
      return safeJson(r, "تعذر الحذف");
    },
    onSuccess: () => {
      toast({ title: "تم حذف التسوية" });
      qc.invalidateQueries({ queryKey: ["adjustments", cid] });
      setConfirmDelId(null);
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const generateMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/adjustments/${id}/generate`, { method: "POST", headers });
      return safeJson(r, "تعذر توليد القيود");
    },
    onSuccess: (d: any) => {
      const created = d?.created?.length ?? 0;
      const skipped = d?.skipped?.length ?? 0;
      toast({
        title: "تم توليد القيود",
        description: `أُنشئ ${created} قيد${skipped > 0 ? ` — ${skipped} شهر متخطّى` : ""}`,
      });
      qc.invalidateQueries({ queryKey: ["adjustments", cid] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const carryMut = useMutation({
    mutationFn: async () => {
      if (!carryFor) throw new Error("لا توجد تسوية محددة");
      const r = await fetch(`${API}/api/adjustments/${carryFor.id}/carry-forward`, {
        method: "POST", headers,
        body: JSON.stringify({ newStartDate: carryForm.start, newEndDate: carryForm.end }),
      });
      return safeJson(r, "تعذر ترحيل المتبقي");
    },
    onSuccess: (d: any) => {
      toast({
        title: "تم ترحيل المتبقي للسنة الجديدة",
        description: `رُحِّل ${d?.summary?.carriedForward ?? "—"} على ${d?.summary?.months ?? "—"} شهر بقسط شهري ${d?.summary?.newMonthly ?? "—"}`,
      });
      qc.invalidateQueries({ queryKey: ["adjustments", cid] });
      setCarryFor(null);
    },
    onError: (e: any) => toast({ title: "تعذر الترحيل", description: e.message, variant: "destructive" }),
  });

  const runDueMut = useMutation({
    mutationFn: async () => {
      const url = cid ? `${API}/api/adjustments/run-due?companyId=${cid}` : `${API}/api/adjustments/run-due`;
      const r = await fetch(url, { method: "POST", headers });
      return safeJson(r, "تعذر تشغيل التسويات المستحقة");
    },
    onSuccess: (d: any) => {
      const total = d?.total ?? 0;
      const processed = Array.isArray(d?.summary) ? d.summary.length : 0;
      toast({
        title: "تم تشغيل التسويات",
        description: `${total} قيد جديد عبر ${processed} تسوية`,
      });
      qc.invalidateQueries({ queryKey: ["adjustments", cid] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const formValid = form.name.trim() && form.expenseAccountId && form.contraAccountId
    && parseFloat(form.totalAmount) > 0
    && form.expenseAccountId !== form.contraAccountId;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-xl bg-gradient-to-br from-emerald-500 via-teal-500 to-cyan-500 text-white shadow-md">
            <CalendarClock className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">تسويات شهرية</h1>
            <p className="text-sm text-muted-foreground">المصاريف المدفوعة مقدماً والمستحقة بقيود توليد آلي</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="lg" variant="outline"
            onClick={() => runDueMut.mutate()}
            disabled={runDueMut.isPending || adjustments.length === 0}
            className="gap-2"
          >
            <Repeat className="h-4 w-4" />
            تشغيل التسويات المستحقة
          </Button>
          <Button
            size="lg"
            onClick={openCreate}
            className="gap-2 bg-gradient-to-l from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 shadow-md"
          >
            <Plus className="h-5 w-5" />
            تسوية جديدة
          </Button>
        </div>
      </div>

      {/* Form */}
      {showForm && (
        <FormPanel
          icon={Sparkles}
          title={editing ? "تعديل التسوية" : "تسوية جديدة"}
          subtitle="ستُولّد قيود الاستهلاك تلقائياً كل شهر بقيمة موزّعة بالتساوي"
          width="2xl"
          onClose={() => { setShowForm(false); closeImport(); }}
          onSave={() => saveMut.mutate()}
          saving={saveMut.isPending}
          saveDisabled={!formValid}
          saveLabel={editing ? "حفظ التغييرات" : "إنشاء"}
        >
          {!editing && (
            <div className="mb-4 rounded-lg border border-dashed border-emerald-300 bg-emerald-50/40 p-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 text-sm font-medium text-emerald-900">
                  <Link2 className="h-4 w-4" />
                  تعبئة من مستند موجود (اختياري)
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button" size="sm" variant={importKind === "invoice" && !pickedJe ? "default" : "outline"}
                    onClick={() => { setPickedJe(null); setImportSearch(""); setImportKind(k => k === "invoice" ? null : "invoice"); }}
                  >
                    <FileText className="h-4 w-4 ms-0 me-1" />
                    من فاتورة مشتريات
                  </Button>
                  <Button
                    type="button" size="sm" variant={importKind === "je" ? "default" : "outline"}
                    onClick={() => { setPickedJe(null); setImportSearch(""); setImportKind(k => k === "je" ? null : "je"); }}
                  >
                    <ArrowRightCircle className="h-4 w-4 ms-0 me-1" />
                    من قيد يومية
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                اختر الفاتورة أو القيد اللي فيه المصروف المدفوع مقدمًا وسيتم تعبئة المبلغ والحساب والتواريخ تلقائيًا — بعدها راجع تاريخ البداية والنهاية واحفظ.
              </p>

              {importKind && !pickedJe && (
                <div className="mt-3 space-y-2">
                  <Input
                    placeholder={importKind === "invoice" ? "ابحث برقم الفاتورة أو رقم فاتورة المورد…" : "ابحث برقم القيد أو الوصف…"}
                    value={importSearch}
                    onChange={(e) => setImportSearch(e.target.value)}
                    className="h-9"
                  />
                  <div className="max-h-56 overflow-y-auto rounded-md border bg-background divide-y">
                    {(importKind === "invoice" ? invLoading : jeLoading) || pickedJeLoading ? (
                      <div className="p-3 text-sm text-muted-foreground">جارٍ التحميل…</div>
                    ) : importKind === "invoice" ? (
                      (() => {
                        const q = importSearch.trim().toLowerCase();
                        const list = srcInvoices
                          .filter((inv: any) => !q
                            || String(inv.docNumber ?? "").toLowerCase().includes(q)
                            || String(inv.supplierInvoiceNumber ?? "").toLowerCase().includes(q))
                          .slice(0, 30);
                        if (list.length === 0) return <div className="p-3 text-sm text-muted-foreground">لا توجد فواتير مطابقة</div>;
                        return list.map((inv: any) => (
                          <button
                            key={inv.id} type="button"
                            className="w-full text-start p-2.5 hover:bg-emerald-50 flex items-center justify-between gap-2 text-sm"
                            onClick={() => applyFromInvoice(inv)}
                          >
                            <span className="flex flex-col">
                              <span className="font-medium">فاتورة {inv.docNumber ?? inv.id}{inv.supplierInvoiceNumber ? ` — مورد ${inv.supplierInvoiceNumber}` : ""}</span>
                              <span className="text-xs text-muted-foreground">{inv.invoiceDate} · {inv.status === "posted" ? "مرحّلة" : "مسودة"}</span>
                            </span>
                            <span className="font-mono">{fmt2(Number(inv.totalAmount) || 0)}</span>
                          </button>
                        ));
                      })()
                    ) : (
                      (() => {
                        const q = importSearch.trim().toLowerCase();
                        const list = srcEntries
                          // Manual/general JEs only — auto-generated postings (sales,
                          // purchases, system…) are not valid prefill sources here.
                          .filter((en: any) => (en.entryType ?? "general") === "general")
                          .filter((en: any) => !q
                            || String(en.docNumber ?? "").toLowerCase().includes(q)
                            || String(en.description ?? "").toLowerCase().includes(q))
                          .slice(0, 30);
                        if (list.length === 0) return <div className="p-3 text-sm text-muted-foreground">لا توجد قيود مطابقة</div>;
                        return list.map((en: any) => (
                          <button
                            key={en.id} type="button"
                            className="w-full text-start p-2.5 hover:bg-emerald-50 flex items-center justify-between gap-2 text-sm"
                            onClick={() => openJeLines(en)}
                          >
                            <span className="flex flex-col">
                              <span className="font-medium">قيد {en.docNumber ?? en.id}</span>
                              <span className="text-xs text-muted-foreground truncate max-w-[340px]">{String(en.entryDate ?? "").slice(0, 10)}{en.description ? ` · ${en.description}` : ""}</span>
                            </span>
                            <span className="font-mono">{fmt2(Number(en.totalDebit) || 0)}</span>
                          </button>
                        ));
                      })()
                    )}
                  </div>
                </div>
              )}

              {pickedJe && (
                <div className="mt-3 space-y-2">
                  <div className="text-xs text-muted-foreground">
                    اختر البند المدين الذي يمثل المصروف المدفوع مقدمًا في قيد {pickedJe.docNumber ?? pickedJe.id}:
                  </div>
                  <div className="max-h-56 overflow-y-auto rounded-md border bg-background divide-y">
                    {(pickedJe.lines ?? []).filter((l: any) => Number(l.debit) > 0).length === 0 ? (
                      <div className="p-3 text-sm text-muted-foreground">لا توجد بنود مدينة في هذا القيد</div>
                    ) : (
                      (pickedJe.lines ?? [])
                        .filter((l: any) => Number(l.debit) > 0)
                        .map((l: any) => (
                          <button
                            key={l.id} type="button"
                            className="w-full text-start p-2.5 hover:bg-emerald-50 flex items-center justify-between gap-2 text-sm"
                            onClick={() => applyFromJeLine(pickedJe, l)}
                          >
                            <span className="flex flex-col">
                              <span className="font-medium">{accLabel(l.accountId)}</span>
                              {l.description ? <span className="text-xs text-muted-foreground">{l.description}</span> : null}
                            </span>
                            <span className="font-mono">{fmt2(Number(l.debit) || 0)}</span>
                          </button>
                        ))
                    )}
                  </div>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setPickedJe(null)}>رجوع</Button>
                </div>
              )}
            </div>
          )}
          <FormGrid>
            <Field label="نوع التسوية" required>
              <select
                value={form.type}
                onChange={(e) => setForm(p => ({ ...p, type: e.target.value as Adjustment["type"] }))}
                className="w-full h-10 rounded-md border bg-background px-3 text-sm disabled:opacity-60"
                disabled={!!editing}
              >
                <option value="prepaid">مصروف مدفوع مقدمًا (إيجار، تأمين…)</option>
                <option value="accrued">مصروف مستحق (رواتب، فوائد…)</option>
              </select>
            </Field>
            <Field label="المسمى" required>
              <Input
                placeholder="مثال: إيجار المعرض - السنة 2026"
                value={form.name}
                onChange={(e) => setForm(p => ({ ...p, name: e.target.value }))}
              />
            </Field>
            <Field label={form.type === "prepaid" ? "حساب المصروف (مدين)" : "حساب المصروف (مدين)"} required>
              <AccountCombobox
                value={form.expenseAccountId}
                onValueChange={(v) => setForm(p => ({ ...p, expenseAccountId: v }))}
                filterTypes={["expense"]}
                allowEmpty={false}
                placeholder="— اختر حساب المصروف —"
              />
            </Field>
            <Field
              label={form.type === "prepaid" ? "حساب المصروف المدفوع مقدمًا (دائن)" : "حساب المستحقات الدائنة (دائن)"}
              required
            >
              <AccountCombobox
                value={form.contraAccountId}
                onValueChange={(v) => setForm(p => ({ ...p, contraAccountId: v }))}
                filterTypes={form.type === "prepaid" ? ["asset"] : ["liability"]}
                allowEmpty={false}
                placeholder={form.type === "prepaid" ? "— حساب أصل (مدفوع مقدمًا) —" : "— حساب التزام (مستحق) —"}
              />
            </Field>
            <Field label="مركز التكلفة (اختياري — على حساب المصروف)">
              <select
                value={form.costCenterId}
                onChange={(e) => setForm(p => ({ ...p, costCenterId: e.target.value }))}
                className="w-full h-10 rounded-md border bg-background px-3 text-sm"
                data-testid="select-adjustment-cost-center"
              >
                <option value="">— بدون مركز تكلفة —</option>
                {costCentersList
                  .filter((c: any) => (c.isPosting ?? true) && (c.isActive ?? true))
                  .map((c: any) => (
                    <option key={c.id} value={String(c.id)}>{c.code} — {c.nameAr ?? c.name}</option>
                  ))}
              </select>
            </Field>
            <Field label="المبلغ الإجمالي" required>
              {/* type="text" + sanitizer (not type="number"): the native number
                  input renders Arabic-Indic digits on Saudi-locale devices.
                  This keeps Latin digits + the mobile decimal keypad. */}
              <Input
                type="text" inputMode="decimal" dir="ltr"
                value={form.totalAmount}
                onChange={(e) => {
                  const v = e.target.value
                    .replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
                    .replace(/[^0-9.]/g, "")
                    .replace(/^(\d*\.?\d*).*/, "$1");
                  setForm(p => ({ ...p, totalAmount: v }));
                }}
                placeholder="0.00"
                className="text-left font-mono"
              />
            </Field>
            <Field label={editLocked ? "القسط الشهري الجديد (للأشهر المتبقية)" : "القسط الشهري المحسوب"}>
              <div className="h-10 rounded-md border bg-muted/30 px-3 flex items-center text-sm font-mono">
                {monthlyPreview ? `${fmt2(monthlyPreview.monthly)} × ${monthlyPreview.months} شهر${monthlyPreview.respread ? " متبقٍ" : ""}` : "—"}
              </div>
            </Field>
            <Field label="تاريخ البداية" required>
              <DateField
                value={form.startDate}
                onChange={(e) => setForm(p => ({ ...p, startDate: e.target.value }))}
                disabled={editLocked}
              />
            </Field>
            <Field label="تاريخ النهاية" required>
              <DateField value={form.endDate} onChange={(e) => setForm(p => ({ ...p, endDate: e.target.value }))} />
            </Field>
            <Field label="ملاحظات" className="md:col-span-2">
              <Textarea
                rows={2}
                value={form.notes}
                onChange={(e) => setForm(p => ({ ...p, notes: e.target.value }))}
                placeholder="اختياري"
              />
            </Field>
            <Field label="" className="md:col-span-2">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.autoGenerate}
                  onChange={(e) => setForm(p => ({ ...p, autoGenerate: e.target.checked }))}
                  className="h-4 w-4"
                />
                توليد القيود تلقائياً ضمن «تشغيل التسويات المستحقة»
              </label>
            </Field>
            <Field label="" className="md:col-span-2">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.carryForwardEnabled}
                  onChange={(e) => setForm(p => ({ ...p, carryForwardEnabled: e.target.checked }))}
                  className="h-4 w-4"
                />
                <span>السماح بترحيل المتبقي للسنة الجديدة عند الإقفال
                  <span className="text-muted-foreground text-xs me-1">— يضمن أن الرصيد غير المستحق لا يضيع</span>
                </span>
              </label>
            </Field>
          </FormGrid>

          {form.expenseAccountId && form.expenseAccountId === form.contraAccountId && (
            <div className="rounded-md p-3 mt-3 flex gap-2 text-xs text-red-800 bg-red-50 border border-red-200">
              <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <p>حساب المصروف وحساب المقابل لا يمكن أن يكونا الحساب ذاته</p>
            </div>
          )}
        </FormPanel>
      )}

      {/* List */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : adjustments.length === 0 ? (
        <Card className="p-12 text-center">
          <CalendarClock className="h-16 w-16 mx-auto mb-3 opacity-10" />
          <p className="text-sm font-semibold mb-1">لا توجد تسويات</p>
          <p className="text-xs text-muted-foreground mb-3">أنشئ تسوية لتوزيع مصاريف على عدة أشهر تلقائياً</p>
          <Button size="sm" variant="outline" onClick={openCreate}>
            <Plus className="h-4 w-4 ml-1" />
            تسوية جديدة
          </Button>
        </Card>
      ) : (
        <div className="grid gap-3">
          {adjustments.map(a => {
            const sb = STATUS_BADGE[a.status];
            return (
              <Card key={a.id} className="hover:shadow-md transition-all">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="font-semibold text-base">{a.name}</span>
                        <Badge variant="outline" className="text-[10px]">
                          {TYPE_LABELS[a.type]}
                        </Badge>
                        <Badge variant="outline" className={cn("text-[10px]", sb.cls)}>
                          {sb.label}
                        </Badge>
                        {a.autoGenerate && (
                          <Badge variant="outline" className="text-[10px] bg-blue-50 text-blue-700 border-blue-200">
                            <Repeat className="h-2.5 w-2.5 ml-0.5" />
                            توليد تلقائي
                          </Badge>
                        )}
                        {a.parentAdjustmentId && (
                          <Badge variant="outline" className="text-[10px] bg-purple-50 text-purple-700 border-purple-200">
                            <Link2 className="h-2.5 w-2.5 ml-0.5" />
                            مُرحَّل من #{a.parentAdjustmentId}
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground flex items-center gap-3 flex-wrap">
                        <span>الإجمالي: <strong className="text-foreground">{fmt2(a.totalAmount)}</strong></span>
                        <span>الشهري: <strong className="text-foreground">{fmt2(a.monthlyAmount)}</strong></span>
                        <span className="text-emerald-700">
                          مُحقّق: <strong>{fmt2(a.recognizedAmount ?? "0")}</strong>
                          <span className="text-muted-foreground"> ({a.runCount ?? 0} شهر)</span>
                        </span>
                        <span className={cn(parseFloat(a.remainingAmount ?? "0") > 0.01 ? "text-amber-700 font-semibold" : "text-muted-foreground")}>
                          متبقٍ: <strong>{fmt2(a.remainingAmount ?? a.totalAmount)}</strong>
                        </span>
                        <span dir="ltr">{a.startDate} — {a.endDate}</span>
                        {a.lastGeneratedDate && (
                          <span className="text-emerald-700">
                            <CheckCircle2 className="h-3 w-3 inline ml-0.5" />
                            آخر توليد: <span dir="ltr">{a.lastGeneratedDate}</span>
                          </span>
                        )}
                      </div>
                      {/* Progress bar */}
                      <div className="mt-2 h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-l from-emerald-500 to-teal-500 transition-all"
                          style={{
                            width: `${Math.min(100, Math.max(0,
                              (parseFloat(a.recognizedAmount ?? "0") / Math.max(0.01, parseFloat(a.totalAmount))) * 100
                            )).toFixed(1)}%`,
                          }}
                        />
                      </div>
                      {a.notes && (
                        <div className="text-xs text-muted-foreground mt-1 flex items-start gap-1">
                          <FileText className="h-3 w-3 mt-0.5 flex-shrink-0" />
                          <span>{a.notes}</span>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-1 flex-shrink-0">
                      <Button
                        size="sm" variant="outline"
                        onClick={() => generateMut.mutate(a.id)}
                        disabled={generateMut.isPending || a.status !== "active"}
                        className="h-8 gap-1 text-emerald-700 border-emerald-300 hover:bg-emerald-50"
                      >
                        <Play className="h-3 w-3" />
                        توليد
                      </Button>
                      {a.status === "active" && a.carryForwardEnabled && parseFloat(a.remainingAmount ?? "0") > 0.01 && (
                        <Button
                          size="sm" variant="outline"
                          onClick={() => openCarry(a)}
                          className="h-8 gap-1 text-purple-700 border-purple-300 hover:bg-purple-50"
                          title="ترحيل المتبقي للسنة الجديدة"
                        >
                          <ArrowRightCircle className="h-3 w-3" />
                          ترحيل المتبقي
                        </Button>
                      )}
                      <Button
                        size="sm" variant="ghost"
                        onClick={() => openEdit(a)}
                        className="h-8 w-8 p-0"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      {confirmDelId === a.id ? (
                        <div className="flex items-center gap-1 bg-red-50 border border-red-300 rounded-md px-1">
                          <Button size="sm" variant="ghost" onClick={() => setConfirmDelId(null)} className="h-6 px-2 text-[10px]">إلغاء</Button>
                          <Button size="sm" variant="destructive" onClick={() => delMut.mutate(a.id)} className="h-6 px-2 text-[10px]">تأكيد</Button>
                        </div>
                      ) : (
                        <Button
                          size="sm" variant="ghost"
                          onClick={() => setConfirmDelId(a.id)}
                          className="h-8 w-8 p-0 text-red-600 hover:bg-red-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Carry-forward dialog */}
      {carryFor && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-background rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="bg-gradient-to-l from-purple-600 to-fuchsia-600 text-white p-4 rounded-t-2xl flex items-center gap-3">
              <div className="p-2 rounded-lg bg-white/15"><ArrowRightCircle className="h-5 w-5" /></div>
              <div className="flex-1">
                <h2 className="text-lg font-bold">ترحيل المتبقي للسنة الجديدة</h2>
                <p className="text-xs opacity-90">{carryFor.name}</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setCarryFor(null)} className="text-white hover:bg-white/20 h-8 w-8 p-0">×</Button>
            </div>
            <div className="p-5 space-y-4">
              <div className="rounded-lg p-3 bg-purple-50 border border-purple-200 text-sm space-y-1.5">
                <div className="flex justify-between"><span>الإجمالي الأصلي:</span><strong>{fmt2(carryFor.totalAmount)}</strong></div>
                <div className="flex justify-between text-emerald-700"><span>المُحقّق حتى الآن:</span><strong>{fmt2(carryFor.recognizedAmount ?? "0")}</strong></div>
                <div className="flex justify-between text-purple-800 text-base pt-1 border-t border-purple-200">
                  <span>سيُرحَّل:</span><strong>{fmt2(carryFor.remainingAmount ?? "0")}</strong>
                </div>
                <p className="text-[11px] text-muted-foreground pt-1">
                  ستُنشأ تسوية فرعية جديدة بنفس الحسابات تستحق المتبقي على الأشهر التي تختارها. التسوية الأصلية ستُختم بحالة «مُرحَّل».
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">تاريخ بداية الترحيل</Label>
                  <DateField value={carryForm.start} onChange={e => setCarryForm(p => ({ ...p, start: e.target.value }))} />
                </div>
                <div>
                  <Label className="text-xs">تاريخ نهاية الترحيل</Label>
                  <DateField value={carryForm.end} onChange={e => setCarryForm(p => ({ ...p, end: e.target.value }))} />
                </div>
              </div>
              {carryForm.start && carryForm.start <= carryFor.endDate && (
                <div className="rounded-md p-2 text-xs bg-amber-50 border border-amber-200 text-amber-900 flex gap-2">
                  <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                  تاريخ البداية يجب أن يكون بعد <span dir="ltr" className="mx-1">{carryFor.endDate}</span>
                </div>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="outline" onClick={() => setCarryFor(null)}>إلغاء</Button>
                <Button
                  onClick={() => carryMut.mutate()}
                  disabled={carryMut.isPending || !carryForm.start || !carryForm.end || carryForm.start <= carryFor.endDate || carryForm.end < carryForm.start}
                  className="bg-gradient-to-l from-purple-600 to-fuchsia-600 hover:from-purple-700 hover:to-fuchsia-700"
                >
                  {carryMut.isPending ? "جاري…" : "تأكيد الترحيل"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
