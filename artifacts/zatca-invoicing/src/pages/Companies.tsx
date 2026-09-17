import { useState } from "react";
import { useListCompanies, useDeleteCompany } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import {
  Plus, Building2, ExternalLink, ShieldCheck, AlertCircle,
  CheckCircle2, Search, ChevronDown, ChevronUp, MapPin,
  BadgeCheck, FileText, RefreshCw, Layers, Trash2, Globe2, LogIn, Pencil,
  ListOrdered, ScanSearch, ShieldAlert
} from "lucide-react";
import ExportButtons from "@/components/ExportButtons";
import CompanyCodeDialog, { type CompanyCodeTarget } from "@/components/CompanyCodeDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { getCountryName } from "@/lib/countries";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const INVOICE_TYPE: Record<string, string> = {
  standard:   "ضريبية",
  simplified: "مبسطة",
  both:       "ضريبية ومبسطة",
};

const STATUS_CONFIG: Record<string, { label: string; variant: string; icon: any; rowBg: string }> = {
  active:   { label: "نشطة",    variant: "bg-green-100 text-green-800 border-green-300",  icon: CheckCircle2, rowBg: "bg-white hover:bg-green-50/30" },
  pending:  { label: "معلقة",   variant: "bg-amber-100 text-amber-800 border-amber-300",  icon: AlertCircle,  rowBg: "bg-amber-50/40 hover:bg-amber-50/70" },
  rejected: { label: "مرفوضة",  variant: "bg-red-100 text-red-800 border-red-300",         icon: AlertCircle,  rowBg: "bg-red-50/20 hover:bg-red-50/40" },
};

const ZATCA_CONFIG = {
  full:  { label: "مسجّلة ZATCA",        color: "bg-green-100 text-green-800 border-green-300" },
  half:  { label: "CSID — ناقص PCSID",  color: "bg-blue-100 text-blue-800 border-blue-200" },
  none:  { label: "غير مسجّلة",           color: "bg-amber-100 text-amber-700 border-amber-200" },
};

function StatCard({ label, value, color, border }: any) {
  return (
    <div className={cn("flex-1 min-w-[110px] rounded-xl border px-5 py-4 text-center", border)}>
      <p className={cn("text-3xl font-bold tabular-nums", color)}>{value ?? "—"}</p>
      <p className="text-xs text-muted-foreground mt-1 font-medium">{label}</p>
    </div>
  );
}

export default function Companies() {
  const { user, actingCompanyId, setActingCompany } = useAuth() as any;
  const [, setLocation] = useLocation();
  const isSuperAdmin = user?.role === "superadmin";
  const { data: companies = [], isLoading, refetch } = useListCompanies({
    query: { queryKey: ["companies"] }
  }) as any;

  const { toast }       = useToast();
  const queryClient     = useQueryClient();
  const deleteCompany   = useDeleteCompany();

  const [search, setSearch]             = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [expandedRow, setExpandedRow]   = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string; agent?: number } | null>(null);
  const [editTarget, setEditTarget]     = useState<{ id: number; name: string; agent?: number } | null>(null);
  const [editName, setEditName]         = useState("");
  const [renaming, setRenaming]         = useState(false);
  const [codeTarget, setCodeTarget] = useState<CompanyCodeTarget | null>(null);
  const openCodeEditor = (company: any) => setCodeTarget({
    id: company.id, name: company.nameAr, code: company.code ?? null,
    agent: company.agentInstanceId ?? undefined,
  });
  const [sequenceTarget, setSequenceTarget] = useState<{ id: number; name: string; agent?: number } | null>(null);
  const [sequenceSummary, setSequenceSummary] = useState<any>(null);
  const [currentJournalNumber, setCurrentJournalNumber] = useState("");
  const [replacementJournalNumber, setReplacementJournalNumber] = useState("");
  const [sequenceLoading, setSequenceLoading] = useState(false);
  const [sequenceSaving, setSequenceSaving] = useState(false);
  const [invoiceRepairTarget, setInvoiceRepairTarget] = useState<{ id: number; name: string; agent?: number } | null>(null);
  const [invoiceRepairScan, setInvoiceRepairScan] = useState<any>(null);
  const [invoiceRepairKind, setInvoiceRepairKind] = useState<"all" | "sales" | "purchase">("all");
  const [invoiceRepairBranch, setInvoiceRepairBranch] = useState("");
  const [invoiceRepairFrom, setInvoiceRepairFrom] = useState("");
  const [invoiceRepairTo, setInvoiceRepairTo] = useState("");
  const [invoiceRepairLoading, setInvoiceRepairLoading] = useState(false);
  const [invoiceRepairSaving, setInvoiceRepairSaving] = useState(false);
  const [invoiceRepairMode, setInvoiceRepairMode] = useState<"correct_draft" | "repair_next">("repair_next");
  const [invoiceRepairDoc, setInvoiceRepairDoc] = useState<any>(null);
  const [invoiceRepairNumber, setInvoiceRepairNumber] = useState("");
  const [invoiceRepairDate, setInvoiceRepairDate] = useState("");
  const [invoiceRepairPayment, setInvoiceRepairPayment] = useState("credit");
  const [invoiceRepairForeign, setInvoiceRepairForeign] = useState(false);
  const [invoiceRepairConfirm, setInvoiceRepairConfirm] = useState("");
  const { token } = useAuth() as any;

  // Rename (SuperAdmin): PUT /api/companies/:id — agent companies route into
  // their agent DB via `?agent=<id>` (SA-only, enforced server-side).
  const confirmRename = async () => {
    if (!editTarget || !editName.trim() || renaming) return;
    setRenaming(true);
    try {
      const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
      const qs = editTarget.agent ? `?agent=${editTarget.agent}` : "";
      const r = await fetch(`${BASE}/api/companies/${editTarget.id}/rename${qs}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ nameAr: editName.trim() }),
      });
      if (!r.ok) throw new Error();
      toast({ title: "تم تعديل الاسم", description: `أصبح اسم الشركة "${editName.trim()}".` });
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      setEditTarget(null);
    } catch {
      toast({ title: "حدث خطأ", description: "تعذّر تعديل اسم الشركة، حاول مرة أخرى.", variant: "destructive" });
    } finally {
      setRenaming(false);
    }
  };

  // Soft delete: moves the company to /companies/deleted (recycle bin).
  // Reversible from there via "إرجاع إلى مكانها"; permanent cascade
  // delete is a separate, explicit action only available in that screen.
  // Agent-DB companies (deleteTarget.agent) go through a raw fetch with
  // `?agent=` so the backend routes the soft-delete into the agent DB.
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const onSuccess = () => {
      toast({
        title: "تم النقل إلى المحذوفات",
        description: `نُقلت شركة "${deleteTarget.name}" إلى صفحة الشركات المحذوفة. يمكنك إرجاعها أو حذفها نهائياً من هناك.`,
      });
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      setDeleteTarget(null);
      setExpandedRow(null);
    };
    const onError = () => {
      toast({ title: "حدث خطأ", description: "تعذّر حذف الشركة، حاول مرة أخرى.", variant: "destructive" });
      setDeleteTarget(null);
    };
    if (deleteTarget.agent) {
      try {
        const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
        const r = await fetch(`${BASE}/api/companies/${deleteTarget.id}?agent=${deleteTarget.agent}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) { onError(); return; }
        onSuccess();
      } catch { onError(); }
      return;
    }
    deleteCompany.mutate({ id: deleteTarget.id }, { onSuccess, onError });
  };

  const openSequenceControl = async (company: any) => {
    const target = {
      id: Number(company.id),
      name: String(company.nameAr ?? ""),
      agent: company.agentInstanceId ? Number(company.agentInstanceId) : undefined,
    };
    setSequenceTarget(target);
    setSequenceSummary(null);
    setCurrentJournalNumber("");
    setReplacementJournalNumber("");
    setSequenceLoading(true);
    try {
      const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
      const qs = target.agent ? `?agent=${target.agent}` : "";
      const r = await fetch(`${BASE}/api/admin/companies/${target.id}/journal-sequence-control${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || "تعذر تحميل التسلسل");
      setSequenceSummary(body);
    } catch (e: any) {
      toast({ title: "تعذر تحميل التسلسل", description: e?.message ?? "حاول مرة أخرى.", variant: "destructive" });
      setSequenceTarget(null);
    } finally {
      setSequenceLoading(false);
    }
  };

  const confirmSequenceRepair = async () => {
    if (!sequenceTarget || !currentJournalNumber.trim() || !replacementJournalNumber.trim() || sequenceSaving) return;
    setSequenceSaving(true);
    try {
      const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
      const qs = sequenceTarget.agent ? `?agent=${sequenceTarget.agent}` : "";
      const r = await fetch(`${BASE}/api/admin/companies/${sequenceTarget.id}/journal-sequence-control${qs}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          currentDocNumber: currentJournalNumber.trim(),
          newDocNumber: replacementJournalNumber.trim(),
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || "تعذر تعديل رقم القيد");
      toast({
        title: "تم تصحيح تسلسل القيد",
        description: `تغيّر ${body.oldDocNumber} إلى ${body.newDocNumber}، والتسلسل العددي القادم ${body.nextNumericSuffix}.`,
      });
      setSequenceTarget(null);
    } catch (e: any) {
      toast({ title: "لم يتم تعديل التسلسل", description: e?.message ?? "حاول مرة أخرى.", variant: "destructive" });
    } finally {
      setSequenceSaving(false);
    }
  };

  const scanInvoiceNumbers = async (target = invoiceRepairTarget) => {
    if (!target || invoiceRepairLoading) return;
    setInvoiceRepairLoading(true);
    try {
      const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
      const qs = new URLSearchParams({ kind: invoiceRepairKind });
      if (target.agent) qs.set("agent", String(target.agent));
      if (invoiceRepairBranch) qs.set("branchId", invoiceRepairBranch);
      if (invoiceRepairFrom) qs.set("from", invoiceRepairFrom);
      if (invoiceRepairTo) qs.set("to", invoiceRepairTo);
      const r = await fetch(`${BASE}/api/admin/companies/${target.id}/invoice-numbering-repair?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || "تعذر فحص أرقام الفواتير");
      setInvoiceRepairScan(body);
    } catch (e: any) {
      toast({ title: "فشل الفحص", description: e?.message ?? "", variant: "destructive" });
    } finally { setInvoiceRepairLoading(false); }
  };

  const openInvoiceRepair = (company: any) => {
    const target = { id: Number(company.id), name: String(company.nameAr ?? ""), agent: company.agentInstanceId ? Number(company.agentInstanceId) : undefined };
    setInvoiceRepairTarget(target); setInvoiceRepairScan(null); setInvoiceRepairDoc(null);
    setInvoiceRepairNumber(""); setInvoiceRepairConfirm(""); setInvoiceRepairDate(""); setInvoiceRepairPayment("credit");
    setInvoiceRepairForeign(false);
    void scanInvoiceNumbers(target);
  };

  const selectInvoiceRepairDoc = (doc: any) => {
    setInvoiceRepairDoc(doc); setInvoiceRepairMode("correct_draft"); setInvoiceRepairNumber("");
    setInvoiceRepairDate(doc.invoiceDate ?? ""); setInvoiceRepairPayment(doc.paymentType ?? "credit");
    setInvoiceRepairBranch(doc.branchId == null ? "" : String(doc.branchId));
  };

  const applyInvoiceRepair = async () => {
    if (!invoiceRepairTarget || !invoiceRepairNumber.trim() || invoiceRepairSaving
      || invoiceRepairConfirm.trim() !== invoiceRepairTarget.name.trim()) return;
    if (invoiceRepairMode === "correct_draft" && !invoiceRepairDoc) return;
    if (invoiceRepairMode === "repair_next" && invoiceRepairKind === "all") {
      toast({ title: "اختر نوع فاتورة محددًا", description: "لا يمكن إصلاح عداد المبيعات والمشتريات معًا.", variant: "destructive" });
      return;
    }
    setInvoiceRepairSaving(true);
    try {
      const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
      const qs = invoiceRepairTarget.agent ? `?agent=${invoiceRepairTarget.agent}` : "";
      const kind = invoiceRepairMode === "correct_draft" ? invoiceRepairDoc.kind : (invoiceRepairKind === "purchase" ? "purchase" : "sales");
      const r = await fetch(`${BASE}/api/admin/companies/${invoiceRepairTarget.id}/invoice-numbering-repair${qs}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: invoiceRepairMode, kind, number: invoiceRepairNumber.trim(),
          invoiceId: invoiceRepairDoc?.id, branchId: invoiceRepairBranch ? Number(invoiceRepairBranch) : 0,
          invoiceDate: invoiceRepairDate, paymentType: invoiceRepairPayment, isForeign: invoiceRepairForeign,
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || "تعذر تنفيذ الإصلاح");
      toast({ title: "تم إصلاح الترقيم", description: `الرقم التالي: ${body.nextNumber}` });
      setInvoiceRepairConfirm(""); setInvoiceRepairDoc(null); setInvoiceRepairNumber("");
      await scanInvoiceNumbers();
    } catch (e: any) {
      toast({ title: "لم يتم تنفيذ الإصلاح", description: e?.message ?? "", variant: "destructive" });
    } finally { setInvoiceRepairSaving(false); }
  };

  // Stats
  const total    = companies.length;
  const active   = companies.filter((c: any) => (c.status ?? "active") === "active").length;
  const pending  = companies.filter((c: any) => c.status === "pending").length;
  const zatcaDone = companies.filter((c: any) => c.zatcaPcsid).length;

  // Filter
  const filtered = companies.filter((c: any) => {
    const matchSearch =
      c.nameAr?.includes(search) ||
      c.nameEn?.includes(search) ||
      c.vatNumber?.includes(search) ||
      c.code?.toLowerCase().includes(search.toLowerCase()) ||
      c.city?.includes(search) ||
      (/^\d+$/.test(search) && String(c.id).includes(search));
    const matchStatus =
      filterStatus === "all" || (c.status ?? "active") === filterStatus;
    return matchSearch && matchStatus;
  });

  return (
    <div className="space-y-6" dir="rtl">

      {/* ── Header ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Building2 className="h-6 w-6 text-primary" />
            الشركات المسجّلة
          </h1>
          <p className="text-sm text-muted-foreground mt-1">إدارة الشركات المسجّلة في نظام الفاتورة الإلكترونية</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
            <RefreshCw className="h-3.5 w-3.5" />تحديث
          </Button>
          <ExportButtons
            rows={filtered.map((c: any) => ({
              id:            c.id,
              code:          c.code          ?? "",
              nameAr:        c.nameAr        ?? "",
              nameEn:        c.nameEn        ?? "",
              vatNumber:     c.vatNumber     ?? "",
              crNumber:      c.crNumber      ?? "",
              country:       getCountryName(c.country, "ar"),
              city:          c.city          ?? "",
              status:        STATUS_CONFIG[c.status ?? "active"]?.label ?? c.status ?? "",
              subscriptionPlan: c.subscriptionPlan ?? "",
              invoiceType:   INVOICE_TYPE[c.invoiceType ?? ""] ?? c.invoiceType ?? "",
              zatca:         c.zatcaPcsid ? "مسجّلة" : (c.zatcaCsid ? "جزئي" : "غير مسجّلة"),
            }))}
            columns={[
              { key: "id",              header: "ID",                   width: 8 },
              { key: "code",            header: "كود الشركة",           width: 14 },
              { key: "nameAr",          header: "اسم الشركة (عربي)",    width: 28 },
              { key: "nameEn",          header: "اسم الشركة (إنجليزي)", width: 28 },
              { key: "vatNumber",       header: "الرقم الضريبي",        width: 20 },
              { key: "crNumber",        header: "السجل التجاري",        width: 18 },
              { key: "country",         header: "الدولة",               width: 14 },
              { key: "city",            header: "المدينة",              width: 16 },
              { key: "status",          header: "الحالة",               width: 14 },
              { key: "subscriptionPlan", header: "الباقة",              width: 16 },
              { key: "invoiceType",     header: "نوع الفاتورة",         width: 18 },
              { key: "zatca",           header: "حالة ZATCA",           width: 16 },
            ]}
            filename={`شركات-${new Date().toISOString().slice(0, 10)}`}
            title="الشركات المسجّلة"
            subtitle={`نظام الفاتورة الإلكترونية — ${new Date().toLocaleDateString("ar-SA-u-nu-latn")}`}
          />
          <Button asChild size="sm" variant="outline" className="gap-2">
            <Link href="/companies/deleted">
              <Trash2 className="h-3.5 w-3.5" />الشركات المحذوفة
            </Link>
          </Button>
          <Button asChild size="sm" className="gap-2">
            <Link href="/companies/new">
              <Plus className="h-3.5 w-3.5" />إضافة شركة
            </Link>
          </Button>
        </div>
      </div>

      {/* ── Stats ── */}
      <div className="flex gap-3 flex-wrap">
        <StatCard label="الإجمالي"     value={total}     color="text-foreground"  border="border bg-muted/30" />
        <StatCard label="نشطة"         value={active}    color="text-green-700"   border="border-green-200 bg-green-50/60" />
        <StatCard label="معلقة"        value={pending}   color="text-amber-700"   border="border-amber-200 bg-amber-50/60" />
        <StatCard label="مسجّلة ZATCA" value={zatcaDone} color="text-primary"     border="border-primary/20 bg-primary/5" />
      </div>

      {/* ── Search + Filter ── */}
      <div className="flex gap-3 flex-col sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="ابحث بالاسم أو الرقم الضريبي أو المدينة..."
            className="pr-10 h-9 text-sm" />
        </div>
        <div className="flex rounded-lg border overflow-hidden bg-background text-sm">
          {[
            { key: "all",      label: "الكل",    count: total },
            { key: "active",   label: "نشطة",    count: active },
            { key: "pending",  label: "معلقة",   count: pending },
            { key: "rejected", label: "مرفوضة",  count: companies.filter((c: any) => c.status === "rejected").length },
          ].map((tab, i) => (
            <button key={tab.key}
              onClick={() => setFilterStatus(tab.key)}
              className={cn(
                "px-4 py-1.5 flex items-center gap-1.5 transition-colors font-medium",
                i > 0 && "border-r",
                filterStatus === tab.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted/60"
              )}>
              {tab.label}
              <span className={cn("text-[11px] rounded-full px-1.5 font-bold",
                filterStatus === tab.key ? "bg-white/20" : "bg-muted"
              )}>{tab.count}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Grid Table ── */}
      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">

        {/* Column headers */}
        <div
          className="grid items-center gap-4 border-b bg-muted/40 px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide select-none"
          style={{ gridTemplateColumns: "2fr 0.5fr 0.8fr 1.2fr 0.85fr 0.9fr 0.9fr 0.9fr 0.9fr 0.8fr auto" }}>
          <span>الشركة</span>
          <span>ID</span>
          <span>كود الشركة</span>
          <span>الرقم الضريبي</span>
          <span>الدولة</span>
          <span>المدينة</span>
          <span>الوكيل</span>
          <span>نوع الفاتورة</span>
          <span>حالة ZATCA</span>
          <span>الحالة</span>
          <span className="text-center w-8">—</span>
        </div>

        {/* Loading skeleton */}
        {isLoading && (
          <div className="divide-y">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="flex items-center gap-4 px-4 py-3.5 animate-pulse">
                <div className="h-9 w-9 rounded-lg bg-muted shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-40 bg-muted rounded" />
                  <div className="h-3 w-28 bg-muted/60 rounded" />
                </div>
                <div className="h-3.5 w-32 bg-muted rounded" />
                <div className="h-3.5 w-20 bg-muted rounded" />
                <div className="h-6 w-20 bg-muted rounded-full" />
                <div className="h-6 w-16 bg-muted rounded-full" />
                <div className="h-7 w-7 bg-muted rounded" />
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!isLoading && filtered.length === 0 && (
          <div className="py-20 text-center">
            <Building2 className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-muted-foreground font-medium">
              {search ? "لا توجد شركات مطابقة" : "لا توجد شركات مسجّلة"}
            </p>
            {!search && (
              <Button asChild variant="outline" size="sm" className="mt-4 gap-2">
                <Link href="/companies/new"><Plus className="h-3.5 w-3.5" />إضافة أول شركة</Link>
              </Button>
            )}
          </div>
        )}

        {/* Rows */}
        <div className="divide-y">
          {filtered.map((company: any) => {
            const status   = STATUS_CONFIG[company.status ?? "active"] ?? STATUS_CONFIG.active;
            const StatusIcon = status.icon;
            const zatcaKey = company.zatcaPcsid ? "full" : company.zatcaCsid ? "half" : "none";
            const zatca    = ZATCA_CONFIG[zatcaKey];
            const isExpanded = expandedRow === company.id;

            return (
              <div key={company.id} className={cn("transition-colors", status.rowBg)}>

                {/* Main row */}
                <div
                  className="grid items-center gap-4 px-4 py-3.5 cursor-pointer"
                  style={{ gridTemplateColumns: "2fr 0.5fr 0.8fr 1.2fr 0.85fr 0.9fr 0.9fr 0.9fr 0.9fr 0.8fr auto" }}
                  onClick={() => setExpandedRow(isExpanded ? null : company.id)}
                >
                  {/* Company name */}
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg font-bold text-sm",
                      company.zatcaPcsid ? "bg-green-100 text-green-700" :
                      (company.status ?? "active") === "pending" ? "bg-amber-100 text-amber-700" :
                      "bg-primary/10 text-primary"
                    )}>
                      {company.nameAr?.[0] ?? "ش"}
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-sm text-foreground truncate leading-tight">{company.nameAr}</p>
                      {company.nameEn && <p className="text-xs text-muted-foreground truncate leading-tight">{company.nameEn}</p>}
                    </div>
                  </div>

                  {/* Internal numeric company id — useful for the SuperAdmin
                      to copy/paste when referencing a specific tenant. */}
                  <span
                    className="font-mono text-xs font-semibold text-foreground/80 truncate"
                    data-testid={`company-id-${company.id}`}
                    title={String(company.id)}
                  >
                    {company.id}
                  </span>

                  {/* Company code (used at /login). Mono + chip style so
                      the SuperAdmin can spot and copy it at a glance — the
                      code is what tenants type on the login page. */}
                  <button
                    className="inline-flex items-center justify-center font-mono text-[11px] font-semibold tracking-wide bg-primary/5 text-primary border border-primary/20 rounded-md px-2 py-0.5 w-fit truncate"
                    data-testid={`company-code-${company.id}`}
                    title={isSuperAdmin ? "تغيير كود الشركة" : company.code ?? ""}
                    disabled={!isSuperAdmin}
                    onClick={event => { event.stopPropagation(); openCodeEditor(company); }}
                    aria-label={`كود الشركة ${company.code ?? ""}${isSuperAdmin ? " — تغيير الكود" : ""}`}
                  >
                    {company.code || "—"}
                    {isSuperAdmin && <Pencil className="ms-1 h-3 w-3 shrink-0" />}
                  </button>

                  {/* VAT */}
                  <span className="font-mono text-xs text-muted-foreground tracking-wide truncate">
                    {company.vatNumber}
                  </span>

                  {/* Country (from registration) */}
                  <span className="inline-flex items-center gap-1.5 text-xs text-foreground/80 truncate" data-testid={`company-country-${company.id}`}>
                    <Globe2 className="h-3 w-3 shrink-0 text-muted-foreground" />
                    {getCountryName(company.country, "ar")}
                  </span>

                  {/* City */}
                  <span className="text-sm text-foreground/80 truncate">{company.city || "—"}</span>

                  {/* Agent (full_shell) badge — company lives on the agent's
                      own DB; admin ops carry ?agent=<id> to route there. */}
                  {company.agentInstanceId ? (
                    <span
                      className="inline-flex items-center gap-1 text-[11px] border rounded-full px-2 py-0.5 font-medium w-fit bg-violet-100 text-violet-800 border-violet-300 truncate"
                      data-testid={`company-agent-${company.id}`}
                      title={company.agentName}
                    >
                      <Globe2 className="h-3 w-3 shrink-0" />
                      {company.agentName ?? `وكيل #${company.agentInstanceId}`}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">المنصة</span>
                  )}

                  {/* Invoice type */}
                  <span className="text-xs text-muted-foreground truncate">
                    {INVOICE_TYPE[company.invoiceType] ?? company.invoiceType ?? "—"}
                  </span>

                  {/* ZATCA status */}
                  <span className={cn("inline-flex items-center gap-1 text-[11px] border rounded-full px-2 py-0.5 font-medium w-fit", zatca.color)}>
                    {zatcaKey === "full"
                      ? <CheckCircle2 className="h-3 w-3 shrink-0" />
                      : <AlertCircle className="h-3 w-3 shrink-0" />}
                    {zatca.label}
                  </span>

                  {/* Company status */}
                  <span className={cn("inline-flex items-center gap-1 text-xs border rounded-full px-2 py-0.5 font-medium w-fit", status.variant)}>
                    <StatusIcon className="h-3 w-3 shrink-0" />
                    {status.label}
                  </span>

                  {/* Expand */}
                  <button
                    className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted transition-colors text-muted-foreground"
                    onClick={e => { e.stopPropagation(); setExpandedRow(isExpanded ? null : company.id); }}
                  >
                    {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                </div>

                {/* Expanded details */}
                {isExpanded && (
                  <div className="border-t bg-muted/20 px-4 pb-4 pt-3 space-y-4">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                      {[
                        { icon: BadgeCheck, label: "الرقم الضريبي",   value: company.vatNumber,  mono: true },
                        { icon: Building2,  label: "السجل التجاري",    value: company.crNumber,   mono: true },
                        { icon: MapPin,     label: "العنوان",           value: [company.buildingNumber, company.street, company.district, company.city, company.postalCode].filter(Boolean).join("، ") },
                        { icon: FileText,   label: "نوع الفاتورة",      value: INVOICE_TYPE[company.invoiceType] ?? company.invoiceType },
                        { icon: Layers,     label: "البيئة",            value: company.isSandbox ? "محاكاة (Sandbox)" : "إنتاج (Production)" },
                        { icon: ShieldCheck,label: "حالة ZATCA",       value: zatca.label },
                      ].map(item => (
                        <div key={item.label} className="flex items-start gap-2 bg-background/60 rounded-lg p-2.5 border">
                          <item.icon className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                          <div className="min-w-0">
                            <p className="text-[10px] text-muted-foreground/70 uppercase tracking-wide font-semibold">{item.label}</p>
                            <p className={cn("text-xs font-medium truncate mt-0.5", item.mono ? "font-mono" : "")}>{item.value || "—"}</p>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* ZATCA notice */}
                    {!company.zatcaPcsid && (
                      <div className={cn(
                        "flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs font-medium border",
                        company.zatcaCsid
                          ? "bg-blue-50 text-blue-800 border-blue-200"
                          : "bg-amber-50 text-amber-800 border-amber-200"
                      )}>
                        {company.zatcaCsid
                          ? <><ShieldCheck className="h-3.5 w-3.5 shrink-0" />اكتملت CSID — أكمل الخطوة الأخيرة للحصول على PCSID</>
                          : <><AlertCircle className="h-3.5 w-3.5 shrink-0" />لم يكتمل الربط مع هيئة الزكاة والدخل والجمارك</>
                        }
                      </div>
                    )}

                    {/* Action buttons */}
                    <div className="flex items-center gap-2 pt-1 flex-wrap">
                      {isSuperAdmin && <Button size="sm" variant="outline" className="gap-1.5 h-8"
                        onClick={() => openCodeEditor(company)} data-testid={`button-change-company-code-${company.id}`}>
                        <Pencil className="h-3.5 w-3.5" />تغيير كود الشركة
                      </Button>}
                      {/* ZATCA onboarding endpoints are not agent-DB-scoped —
                          hide the shortcut for agent companies to avoid
                          touching a colliding central company ID. */}
                      {(company.status ?? "active") === "active" && !company.zatcaPcsid && !company.agentInstanceId && (
                        <Button asChild size="sm" className="gap-1.5 h-8">
                          <Link href={`/companies/${company.id}?tab=zatca${company.agentInstanceId ? `&agent=${company.agentInstanceId}` : ""}`}>
                            <ShieldCheck className="h-3.5 w-3.5" />ربط ZATCA
                          </Link>
                        </Button>
                      )}
                      <Button asChild variant="outline" size="sm" className="gap-1.5 h-8">
                        <Link href={`/companies/${company.id}${company.agentInstanceId ? `?agent=${company.agentInstanceId}` : ""}`}>
                          <ExternalLink className="h-3.5 w-3.5" />عرض التفاصيل
                        </Link>
                      </Button>
                      {/* SuperAdmin-only "enter company" — sets the global
                          impersonation context so every API call from here
                          on automatically scopes to this tenant. The yellow
                          banner in Layout makes the active context obvious
                          and provides a one-click exit. */}
                      {isSuperAdmin && !company.agentInstanceId && (
                        <Button
                          size="sm"
                          variant={actingCompanyId === company.id ? "secondary" : "default"}
                          className="gap-1.5 h-8"
                          onClick={() => {
                            setActingCompany(company.id);
                            setLocation("/dashboard");
                          }}
                        >
                          <LogIn className="h-3.5 w-3.5" />
                          {actingCompanyId === company.id ? "داخل الشركة" : "دخول إلى الشركة"}
                        </Button>
                      )}
                      {/* Rename — SuperAdmin only; works for central AND
                          agent-DB companies (routed via ?agent=). */}
                      {isSuperAdmin && (
                        <Button
                          size="sm" variant="outline" className="gap-1.5 h-8"
                          onClick={() => openSequenceControl(company)}
                          data-testid={`button-journal-sequence-${company.id}`}
                        >
                          <ListOrdered className="h-3.5 w-3.5" />تصحيح تسلسل القيود
                        </Button>
                      )}
                       {isSuperAdmin && (
                         <Button
                           size="sm" variant="outline" className="gap-1.5 h-8"
                           onClick={() => openInvoiceRepair(company)}
                           data-testid={`button-invoice-numbering-repair-${company.id}`}
                         >
                           <ScanSearch className="h-3.5 w-3.5" />فحص ترقيم الفواتير
                         </Button>
                       )}
                      {isSuperAdmin && (
                        <Button
                          size="sm" variant="outline" className="gap-1.5 h-8"
                          onClick={() => { setEditTarget({ id: company.id, name: company.nameAr, agent: company.agentInstanceId ?? undefined }); setEditName(company.nameAr ?? ""); }}
                          data-testid={`button-rename-company-${company.id}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />تعديل الاسم
                        </Button>
                      )}
                      {/* Soft delete: any status. Moves to recycle bin
                          (/companies/deleted) — fully reversible. */}
                      <Button
                        size="sm" variant="ghost"
                        className="gap-1.5 h-8 text-destructive hover:bg-destructive/10 mr-auto"
                        onClick={() => setDeleteTarget({ id: company.id, name: company.nameAr, agent: company.agentInstanceId ?? undefined })}
                      >
                        <Trash2 className="h-3.5 w-3.5" />حذف مؤقت
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        {!isLoading && filtered.length > 0 && (
          <div className="border-t bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground flex items-center justify-between">
            <span>عدد الشركات: <strong>{filtered.length}</strong></span>
            <span className="text-muted-foreground/60">انقر على أي صف لعرض التفاصيل والإجراءات</span>
          </div>
        )}
      </div>

      {/* ── Delete confirmation dialog ── */}
      <AlertDialog open={!!deleteTarget} onOpenChange={open => !open && setDeleteTarget(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="h-5 w-5" />نقل الشركة إلى المحذوفات
            </AlertDialogTitle>
            <AlertDialogDescription className="text-right space-y-1">
              <span>سيتم نقل شركة </span>
              <strong className="text-foreground">"{deleteTarget?.name}"</strong>
              <span> إلى صفحة "الشركات المحذوفة" وستُعطّل حسابات مستخدميها فوراً.</span>
              <br />
              <span className="text-muted-foreground">يمكنك إرجاعها لاحقاً، أو حذفها نهائياً من هناك.</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={deleteCompany.isPending}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground gap-2"
            >
              <Trash2 className="h-4 w-4" />
              {deleteCompany.isPending ? "جاري النقل..." : "نعم، انقل إلى المحذوفات"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Rename dialog (SuperAdmin) ── */}
      <AlertDialog open={!!editTarget} onOpenChange={open => !open && setEditTarget(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5 text-primary" />تعديل اسم الشركة
            </AlertDialogTitle>
            <AlertDialogDescription className="text-right">
              الاسم الحالي: <strong className="text-foreground">"{editTarget?.name}"</strong>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={editName}
            onChange={e => setEditName(e.target.value)}
            placeholder="الاسم الجديد للشركة"
            dir="rtl"
            autoFocus
            onKeyDown={e => { if (e.key === "Enter") confirmRename(); }}
            data-testid="input-rename-company"
          />
          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              onClick={e => { e.preventDefault(); confirmRename(); }}
              disabled={renaming || !editName.trim()}
              className="gap-2"
              data-testid="button-confirm-rename"
            >
              <Pencil className="h-4 w-4" />
              {renaming ? "جاري الحفظ..." : "حفظ الاسم"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {codeTarget && <CompanyCodeDialog
        key={`${codeTarget.agent ?? "central"}:${codeTarget.id}`}
        company={codeTarget} onClose={() => setCodeTarget(null)}
        onSaved={() => { void queryClient.invalidateQueries({ queryKey: ["companies"] }); }}
      />}

      {/* ── Journal sequence repair (SuperAdmin) ── */}
      <AlertDialog open={!!sequenceTarget} onOpenChange={open => !open && !sequenceSaving && setSequenceTarget(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ListOrdered className="h-5 w-5 text-primary" />تصحيح تسلسل القيود
            </AlertDialogTitle>
            <AlertDialogDescription className="text-right">
              شركة <strong className="text-foreground">"{sequenceTarget?.name}"</strong>. تعدّل هذه الأداة رقم قيد واحد موجود،
              ثم تجعل كل القيود الجديدة تكمل بعده دون تغيير البادئة أو منطق الشهر.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {sequenceLoading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">جاري قراءة أعلى تسلسل فعلي...</div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-1">
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">أعلى رقم فعلي حالي</span>
                  <strong className="font-mono" dir="ltr">{sequenceSummary?.highestEntry?.docNumber ?? "لا يوجد"}</strong>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">اللاحقة المطلوبة للبديل</span>
                  <strong className="font-mono" dir="ltr">{sequenceSummary?.requiredReplacementSuffix ?? 1}</strong>
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">رقم القيد الخاطئ الحالي</label>
                <Input
                  value={currentJournalNumber}
                  onChange={e => setCurrentJournalNumber(e.target.value)}
                  placeholder="مثال: QYD/08/0001"
                  dir="ltr"
                  className="text-left font-mono"
                  data-testid="input-current-journal-number"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">رقم القيد الصحيح البديل</label>
                <Input
                  value={replacementJournalNumber}
                  onChange={e => setReplacementJournalNumber(e.target.value)}
                  placeholder={`مثال: QYD/08/${sequenceSummary?.requiredReplacementSuffix ?? 1}`}
                  dir="ltr"
                  className="text-left font-mono"
                  data-testid="input-replacement-journal-number"
                />
                <p className="text-xs text-muted-foreground">
                  يجب أن ينتهي الرقم باللاحقة التالية مباشرة. لن تتغير أي مبالغ أو حسابات أو حالة ترحيل.
                </p>
              </div>
            </div>
          )}

          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogCancel disabled={sequenceSaving}>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              onClick={e => { e.preventDefault(); confirmSequenceRepair(); }}
              disabled={sequenceLoading || sequenceSaving || !currentJournalNumber.trim() || !replacementJournalNumber.trim()}
              className="gap-2"
              data-testid="button-confirm-journal-sequence"
            >
              <ListOrdered className="h-4 w-4" />
              {sequenceSaving ? "جاري التصحيح..." : "تصحيح الرقم والمتابعة بعده"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Sales/purchase invoice numbering repair (SuperAdmin) ── */}
      <AlertDialog open={!!invoiceRepairTarget} onOpenChange={open => !open && !invoiceRepairSaving && setInvoiceRepairTarget(null)}>
        <AlertDialogContent dir="rtl" className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ScanSearch className="h-5 w-5 text-primary" />فحص وإصلاح ترقيم فواتير المبيعات والمشتريات
            </AlertDialogTitle>
            <AlertDialogDescription className="text-right">
              شركة <strong className="text-foreground">"{invoiceRepairTarget?.name}"</strong>. الفحص للقراءة فقط؛ لا يُعاد ترقيم التاريخ تلقائياً.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 flex gap-2">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            لا تُعدّل الأداة الفواتير المرحّلة أو الملغاة أو الموقعة/المرسلة إلى ZATCA، ولا تمس UUID أو ICV أو hash أو سلسلة الفواتير. المشتريات المرحّلة غير مدعومة.
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 items-end">
            <div><label className="text-xs">النوع</label><select className="w-full h-9 border rounded px-2 text-sm" value={invoiceRepairKind} onChange={e => { setInvoiceRepairKind(e.target.value as any); setInvoiceRepairScan(null); }}>
              <option value="all">الكل</option><option value="sales">مبيعات</option><option value="purchase">مشتريات</option>
            </select></div>
            <div><label className="text-xs">الفرع (اختياري)</label><Input value={invoiceRepairBranch} onChange={e => { setInvoiceRepairBranch(e.target.value); setInvoiceRepairScan(null); }} type="number" /></div>
            <div><label className="text-xs">من تاريخ</label><Input value={invoiceRepairFrom} onChange={e => { setInvoiceRepairFrom(e.target.value); setInvoiceRepairScan(null); }} type="date" /></div>
            <div><label className="text-xs">إلى تاريخ</label><Input value={invoiceRepairTo} onChange={e => { setInvoiceRepairTo(e.target.value); setInvoiceRepairScan(null); }} type="date" /></div>
          </div>
          <Button variant="outline" className="w-fit" onClick={() => scanInvoiceNumbers()} disabled={invoiceRepairLoading}>
            {invoiceRepairLoading ? "جاري الفحص..." : "فحص (بدون أي كتابة)"}
          </Button>
          {invoiceRepairScan && (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2 text-center text-sm">
                <div className="rounded border p-2">المفحوص: <strong>{invoiceRepairScan.scanned}</strong></div>
                <div className="rounded border border-red-200 p-2">تطابق تام: <strong>{invoiceRepairScan.exactDuplicates?.length ?? 0}</strong></div>
                <div className="rounded border border-amber-200 p-2">تكافؤ أصفار: <strong>{invoiceRepairScan.numericEquivalentDuplicates?.length ?? 0}</strong></div>
              </div>
              {(invoiceRepairScan.exactDuplicates?.length || invoiceRepairScan.numericEquivalentDuplicates?.length) ? (
                <div className="border rounded max-h-48 overflow-auto text-xs">
                  {[...(invoiceRepairScan.exactDuplicates ?? []).map((x: any) => ({ ...x, type: "تطابق تام" })), ...(invoiceRepairScan.numericEquivalentDuplicates ?? []).map((x: any) => ({ ...x, type: "تكافؤ رقمي" }))].map((g: any, i: number) => (
                    <div className="border-b p-2" key={`${g.type}-${g.key}-${i}`}>
                      <strong>{g.type}: </strong><span className="font-mono" dir="ltr">{g.key}</span>
                      <span className="mr-2">{g.docs.map((d: any) => `${d.kind === "sales" ? "مبيعات" : "مشتريات"} #${d.id}: ${d.docNumber}`).join(" · ")}</span>
                    </div>
                  ))}
                </div>
              ) : <p className="text-sm text-emerald-700">لا توجد تكرارات ضمن الفلاتر الحالية.</p>}
              <div className="border rounded max-h-52 overflow-auto">
                {(invoiceRepairScan.documents ?? []).map((doc: any) => (
                  <div key={`${doc.kind}-${doc.id}`} className="p-2 border-b flex justify-between items-center gap-2 text-xs">
                    <span><strong>{doc.kind === "sales" ? "مبيعات" : "مشتريات"} #{doc.id}</strong> <span className="font-mono" dir="ltr">{doc.docNumber}</span> · {doc.status} {doc.conflictReason ? `— ${doc.conflictReason}` : ""}</span>
                    {doc.correctionAllowed && <Button size="sm" variant="outline" onClick={() => selectInvoiceRepairDoc(doc)}>تصحيح هذه المسودة</Button>}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="border-t pt-3 space-y-3">
            <div className="flex gap-4 text-sm">
              <label><input type="radio" checked={invoiceRepairMode === "repair_next"} onChange={() => { setInvoiceRepairMode("repair_next"); setInvoiceRepairDoc(null); }} /> إصلاح العداد التالي فقط</label>
              <label><input type="radio" checked={invoiceRepairMode === "correct_draft"} onChange={() => setInvoiceRepairMode("correct_draft")} /> تصحيح مسودة مختارة</label>
            </div>
            {invoiceRepairMode === "correct_draft" && !invoiceRepairDoc && <p className="text-xs text-muted-foreground">اختر مسودة مسموحة من نتائج الفحص أولاً.</p>}
            <div className="grid md:grid-cols-3 gap-2">
              <div><label className="text-xs">الرقم المطلوب (مطابق لإعداد المسلسل)</label><Input value={invoiceRepairNumber} onChange={e => setInvoiceRepairNumber(e.target.value)} dir="ltr" className="font-mono" placeholder="INV-0012" /></div>
              {invoiceRepairMode === "repair_next" && <><div><label className="text-xs">تاريخ/دلو الفاتورة</label><Input value={invoiceRepairDate} onChange={e => setInvoiceRepairDate(e.target.value)} type="date" /></div><div><label className="text-xs">الدفع</label><select className="w-full h-10 border rounded px-2" value={invoiceRepairPayment} onChange={e => setInvoiceRepairPayment(e.target.value)}><option value="credit">آجل</option><option value="cash">نقدي</option><option value="bank">بنكي</option></select></div></>}
            </div>
            {invoiceRepairMode === "repair_next" && invoiceRepairKind === "sales" && <label className="text-xs flex items-center gap-2"><input type="checkbox" checked={invoiceRepairForeign} onChange={e => setInvoiceRepairForeign(e.target.checked)} />مسلسل عميل أجنبي (غير سعودي)</label>}
            <div><label className="text-xs">للتأكيد اكتب اسم الشركة: <strong>{invoiceRepairTarget?.name}</strong></label><Input value={invoiceRepairConfirm} onChange={e => setInvoiceRepairConfirm(e.target.value)} /></div>
          </div>
          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogCancel disabled={invoiceRepairSaving}>إلغاء</AlertDialogCancel>
            <AlertDialogAction onClick={e => { e.preventDefault(); applyInvoiceRepair(); }} disabled={invoiceRepairSaving || !invoiceRepairNumber.trim() || invoiceRepairConfirm.trim() !== invoiceRepairTarget?.name?.trim() || (invoiceRepairMode === "correct_draft" && !invoiceRepairDoc)} className="gap-2">
              {invoiceRepairSaving ? "جاري التنفيذ..." : invoiceRepairMode === "repair_next" ? "تأكيد إصلاح العداد" : "تأكيد تصحيح المسودة"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
