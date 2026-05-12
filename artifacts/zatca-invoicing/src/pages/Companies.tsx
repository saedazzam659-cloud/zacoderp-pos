import { useState } from "react";
import { useListCompanies, useDeleteCompany } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import {
  Plus, Building2, ExternalLink, ShieldCheck, AlertCircle,
  CheckCircle2, Search, ChevronDown, ChevronUp, MapPin,
  BadgeCheck, FileText, RefreshCw, Layers, Trash2, Globe2, LogIn
} from "lucide-react";
import ExportButtons from "@/components/ExportButtons";
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
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string } | null>(null);

  // Soft delete: moves the company to /companies/deleted (recycle bin).
  // Reversible from there via "إرجاع إلى مكانها"; permanent cascade
  // delete is a separate, explicit action only available in that screen.
  const confirmDelete = () => {
    if (!deleteTarget) return;
    deleteCompany.mutate({ id: deleteTarget.id }, {
      onSuccess: () => {
        toast({
          title: "تم النقل إلى المحذوفات",
          description: `نُقلت شركة "${deleteTarget.name}" إلى صفحة الشركات المحذوفة. يمكنك إرجاعها أو حذفها نهائياً من هناك.`,
        });
        queryClient.invalidateQueries({ queryKey: ["companies"] });
        setDeleteTarget(null);
        setExpandedRow(null);
      },
      onError: () => {
        toast({ title: "حدث خطأ", description: "تعذّر حذف الشركة، حاول مرة أخرى.", variant: "destructive" });
        setDeleteTarget(null);
      },
    });
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
          style={{ gridTemplateColumns: "2fr 0.5fr 0.8fr 1.2fr 0.85fr 0.9fr 1fr 0.9fr 0.8fr auto" }}>
          <span>الشركة</span>
          <span>ID</span>
          <span>كود الشركة</span>
          <span>الرقم الضريبي</span>
          <span>الدولة</span>
          <span>المدينة</span>
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
                  style={{ gridTemplateColumns: "2fr 0.5fr 0.8fr 1.2fr 0.85fr 0.9fr 1fr 0.9fr 0.8fr auto" }}
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
                  <span
                    className="inline-flex items-center justify-center font-mono text-[11px] font-semibold tracking-wide bg-primary/5 text-primary border border-primary/20 rounded-md px-2 py-0.5 w-fit truncate"
                    data-testid={`company-code-${company.id}`}
                    title={company.code ?? ""}
                  >
                    {company.code || "—"}
                  </span>

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
                      {(company.status ?? "active") === "active" && !company.zatcaPcsid && (
                        <Button asChild size="sm" className="gap-1.5 h-8">
                          <Link href={`/companies/${company.id}?tab=zatca`}>
                            <ShieldCheck className="h-3.5 w-3.5" />ربط ZATCA
                          </Link>
                        </Button>
                      )}
                      <Button asChild variant="outline" size="sm" className="gap-1.5 h-8">
                        <Link href={`/companies/${company.id}`}>
                          <ExternalLink className="h-3.5 w-3.5" />عرض التفاصيل
                        </Link>
                      </Button>
                      {/* SuperAdmin-only "enter company" — sets the global
                          impersonation context so every API call from here
                          on automatically scopes to this tenant. The yellow
                          banner in Layout makes the active context obvious
                          and provides a one-click exit. */}
                      {isSuperAdmin && (
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
                      {/* Soft delete: any status. Moves to recycle bin
                          (/companies/deleted) — fully reversible. */}
                      <Button
                        size="sm" variant="ghost"
                        className="gap-1.5 h-8 text-destructive hover:bg-destructive/10 mr-auto"
                        onClick={() => setDeleteTarget({ id: company.id, name: company.nameAr })}
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
    </div>
  );
}
