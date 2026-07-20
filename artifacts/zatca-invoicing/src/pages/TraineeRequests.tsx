import { useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CheckCircle2, XCircle, Clock, Search, RefreshCw, GraduationCap, Loader2, Mail,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { ARAB_COUNTRIES } from "@/pages/TraineeRegister";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// High-level module keys accepted by the approve endpoint — must stay in
// lockstep with REGISTRATION_MODULE_PERMISSIONS (api-server routes/auth.ts).
const MODULE_OPTIONS: { key: string; label: string }[] = [
  { key: "sales",        label: "المبيعات" },
  { key: "purchasing",   label: "المشتريات" },
  { key: "inventory",    label: "المخزون" },
  { key: "pos",          label: "نقاط البيع" },
  { key: "cash",         label: "الخزينة والبنوك" },
  { key: "accounting",   label: "المحاسبة" },
  { key: "hr",           label: "الموارد البشرية" },
  { key: "zatca",        label: "زاتكا والتقارير" },
  { key: "contracting",  label: "المقاولات" },
  { key: "production",   label: "الإنتاج والتصنيع" },
  { key: "security",     label: "الأمن والمراقبة" },
  { key: "maintenance",  label: "الصيانة والأصول" },
  { key: "installments", label: "الأقساط" },
  { key: "hotel",        label: "الفنادق" },
];

const STATUS_CONFIG: Record<string, { label: string; variant: string; icon: any }> = {
  pending:  { label: "معلق",  variant: "bg-amber-100 text-amber-800 border-amber-300", icon: Clock },
  approved: { label: "مقبول", variant: "bg-green-100 text-green-800 border-green-300", icon: CheckCircle2 },
  rejected: { label: "مرفوض", variant: "bg-red-100 text-red-800 border-red-300",       icon: XCircle },
};

type TraineeRow = {
  id: number;
  fullName: string;
  email: string;
  phone: string;
  phoneCountryKey: string;
  country: string;
  city: string | null;
  companyName: string | null;
  jobTitle: string;
  industry: string;
  experienceYears: number;
  status: string;
  rejectReason: string | null;
  durationDays: number | null;
  envMode: string | null;
  companyId: number | null;
  allowedModules: string[] | null;
  activationEmailSentAt: string | null;
  createdAt: string;
};

function countryNameAr(code: string): string {
  return ARAB_COUNTRIES.find(c => c.code === code)?.nameAr ?? code;
}

export default function TraineeRequests() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("all");

  // Approve dialog state
  const [approveDialog, setApproveDialog] = useState<TraineeRow | null>(null);
  const [durationDays, setDurationDays] = useState("30");
  const [envMode, setEnvMode] = useState<"shared" | "separate">("separate");
  const [sharedCompanyId, setSharedCompanyId] = useState<string>("");
  const [allowedModules, setAllowedModules] = useState<string[]>(["sales", "accounting"]);

  // Reject dialog state
  const [rejectDialog, setRejectDialog] = useState<TraineeRow | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const { data: requests = [], isLoading, refetch, isFetching } = useQuery<TraineeRow[]>({
    queryKey: ["trainee-requests"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/trainee-requests`, { headers });
      if (!r.ok) throw new Error("فشل تحميل الطلبات");
      return r.json();
    },
  });

  // Companies list for shared-mode picker (SA-only endpoint).
  const { data: companies = [] } = useQuery<any[]>({
    queryKey: ["admin-companies-for-trainees"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/companies`, { headers });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!approveDialog && envMode === "shared",
  });

  const approveMutation = useMutation({
    mutationFn: async () => {
      if (!approveDialog) return;
      const body: Record<string, unknown> = {
        durationDays: Number(durationDays),
        envMode,
        allowedModules,
      };
      if (envMode === "shared") body.companyId = Number(sharedCompanyId);
      const r = await fetch(`${API}/api/admin/trainee-requests/${approveDialog.id}/approve`, {
        method: "POST", headers, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || "فشل اعتماد الطلب");
      return j;
    },
    onSuccess: (j: any) => {
      toast({
        title: "تم تفعيل حساب المتدرب",
        description: j?.emailSent === false
          ? "تنبيه: تعذّر إرسال رسالة التفعيل بالبريد — الحساب مفعّل، أعد الإرسال يدوياً."
          : "تم إرسال رسالة التفعيل إلى بريد المتدرب.",
      });
      setApproveDialog(null);
      qc.invalidateQueries({ queryKey: ["trainee-requests"] });
    },
    onError: (e: any) => toast({ title: e?.message || "فشل اعتماد الطلب", variant: "destructive" as any }),
  });

  const rejectMutation = useMutation({
    mutationFn: async () => {
      if (!rejectDialog) return;
      const r = await fetch(`${API}/api/admin/trainee-requests/${rejectDialog.id}/reject`, {
        method: "POST", headers, body: JSON.stringify({ reason: rejectReason }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || "فشل رفض الطلب");
      return j;
    },
    onSuccess: () => {
      toast({ title: "تم رفض الطلب" });
      setRejectDialog(null); setRejectReason("");
      qc.invalidateQueries({ queryKey: ["trainee-requests"] });
    },
    onError: (e: any) => toast({ title: e?.message || "فشل رفض الطلب", variant: "destructive" as any }),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return requests.filter(r => {
      if (filterStatus !== "all" && r.status !== filterStatus) return false;
      if (!q) return true;
      return [r.fullName, r.email, r.phone, r.jobTitle, r.industry, r.companyName ?? "", countryNameAr(r.country)]
        .some(v => v.toLowerCase().includes(q));
    });
  }, [requests, search, filterStatus]);

  const counts = useMemo(() => ({
    all: requests.length,
    pending: requests.filter(r => r.status === "pending").length,
    approved: requests.filter(r => r.status === "approved").length,
    rejected: requests.filter(r => r.status === "rejected").length,
  }), [requests]);

  const openApprove = (row: TraineeRow) => {
    setDurationDays("30");
    setEnvMode("separate");
    setSharedCompanyId("");
    setAllowedModules(["sales", "accounting"]);
    setApproveDialog(row);
  };

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <GraduationCap className="h-5 w-5 text-emerald-600" />
            طلبات المتدربين
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            مراجعة واعتماد طلبات الحسابات التدريبية — تحديد المدة وبيئة التدريب والموديولات المتاحة.
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
          تحديث
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {(["all", "pending", "approved", "rejected"] as const).map(s => (
          <button
            key={s}
            onClick={() => setFilterStatus(s)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-semibold transition",
              filterStatus === s ? "bg-primary text-primary-foreground border-primary" : "bg-card hover:bg-muted",
            )}
            data-testid={`trainee-filter-${s}`}
          >
            {s === "all" ? "الكل" : STATUS_CONFIG[s].label} ({counts[s]})
          </button>
        ))}
        <div className="relative flex-1 min-w-[200px] max-w-xs mr-auto">
          <Search className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="بحث بالاسم أو البريد…"
                 className="pr-8 h-8 text-sm" data-testid="trainee-requests-search" />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-xs text-muted-foreground">
                  <th className="text-start px-4 py-2.5 font-medium">المتدرب</th>
                  <th className="text-start px-4 py-2.5 font-medium">الدولة / الجوال</th>
                  <th className="text-start px-4 py-2.5 font-medium">الوظيفة / النشاط</th>
                  <th className="text-start px-4 py-2.5 font-medium">الخبرة</th>
                  <th className="text-start px-4 py-2.5 font-medium">الحالة</th>
                  <th className="text-start px-4 py-2.5 font-medium">التفعيل</th>
                  <th className="text-start px-4 py-2.5 font-medium">إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr><td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin inline-block" />
                  </td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                    لا توجد طلبات مطابقة
                  </td></tr>
                ) : filtered.map(row => {
                  const sc = STATUS_CONFIG[row.status] ?? STATUS_CONFIG.pending;
                  const StatusIcon = sc.icon;
                  return (
                    <tr key={row.id} className="border-b last:border-0 hover:bg-muted/30" data-testid={`trainee-row-${row.id}`}>
                      <td className="px-4 py-3">
                        <div className="font-medium">{row.fullName}</div>
                        <div className="text-xs text-muted-foreground" dir="ltr">{row.email}</div>
                        {row.companyName && <div className="text-xs text-muted-foreground">{row.companyName}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <div>{countryNameAr(row.country)}{row.city ? ` — ${row.city}` : ""}</div>
                        <div className="text-xs text-muted-foreground" dir="ltr">{row.phoneCountryKey} {row.phone}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div>{row.jobTitle}</div>
                        <div className="text-xs text-muted-foreground">{row.industry}</div>
                      </td>
                      <td className="px-4 py-3 tabular-nums">{row.experienceYears} سنة</td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className={cn("gap-1", sc.variant)}>
                          <StatusIcon className="h-3 w-3" />
                          {sc.label}
                        </Badge>
                        {row.status === "rejected" && row.rejectReason && (
                          <div className="text-xs text-muted-foreground mt-1 max-w-[180px] truncate" title={row.rejectReason}>
                            {row.rejectReason}
                          </div>
                        )}
                        {row.status === "approved" && (
                          <div className="text-xs text-muted-foreground mt-1">
                            {row.durationDays} يوم — {row.envMode === "shared" ? "بيئة مشتركة" : "بيئة مستقلة"}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {row.status === "approved" ? (
                          row.activationEmailSentAt
                            ? <span className="inline-flex items-center gap-1 text-xs text-emerald-700"><Mail className="h-3 w-3" /> أُرسلت</span>
                            : <span className="text-xs text-amber-700">لم تُرسل</span>
                        ) : <span className="text-xs text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        {row.status === "pending" && (
                          <div className="flex gap-1.5">
                            <Button size="sm" className="h-7 gap-1 bg-emerald-600 hover:bg-emerald-700"
                                    onClick={() => openApprove(row)} data-testid={`trainee-approve-${row.id}`}>
                              <CheckCircle2 className="h-3.5 w-3.5" /> اعتماد
                            </Button>
                            <Button size="sm" variant="outline" className="h-7 gap-1 text-destructive border-destructive/40 hover:bg-destructive/10"
                                    onClick={() => { setRejectReason(""); setRejectDialog(row); }}
                                    data-testid={`trainee-reject-${row.id}`}>
                              <XCircle className="h-3.5 w-3.5" /> رفض
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* ── Approve dialog ── */}
      <Dialog open={!!approveDialog} onOpenChange={o => { if (!o) setApproveDialog(null); }}>
        <DialogContent className="max-w-lg" dir="rtl">
          <DialogHeader>
            <DialogTitle>اعتماد طلب التدريب — {approveDialog?.fullName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">مدة التدريب (بالأيام)</label>
                <Input type="text" inputMode="numeric" dir="ltr" className="text-left"
                       value={durationDays}
                       onChange={e => setDurationDays(e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
                       data-testid="trainee-approve-duration" />
                <p className="text-xs text-muted-foreground">من 1 إلى 730 يوماً</p>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">بيئة التدريب</label>
                <Select value={envMode} onValueChange={v => setEnvMode(v as "shared" | "separate")}>
                  <SelectTrigger data-testid="trainee-approve-envmode"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="separate">بيئة مستقلة (شركة تدريب جديدة)</SelectItem>
                    <SelectItem value="shared">بيئة مشتركة (شركة قائمة)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {envMode === "shared" && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">الشركة المشتركة</label>
                <Select value={sharedCompanyId} onValueChange={setSharedCompanyId}>
                  <SelectTrigger data-testid="trainee-approve-company"><SelectValue placeholder="اختر الشركة…" /></SelectTrigger>
                  <SelectContent>
                    {(companies as any[]).map(c => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.nameAr ?? c.name ?? `#${c.id}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-sm font-medium">الموديولات المتاحة</label>
              <div className="grid grid-cols-2 gap-1.5 rounded-lg border p-3 max-h-48 overflow-y-auto">
                {MODULE_OPTIONS.map(m => (
                  <label key={m.key} className="flex items-center gap-2 text-sm cursor-pointer select-none">
                    <Checkbox
                      checked={allowedModules.includes(m.key)}
                      onCheckedChange={v => setAllowedModules(prev =>
                        v === true ? [...prev, m.key] : prev.filter(k => k !== m.key))}
                      data-testid={`trainee-module-${m.key}`}
                    />
                    {m.label}
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                لوحة المعلومات والفواتير والعملاء متاحة دائماً بشكل افتراضي.
              </p>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setApproveDialog(null)}>إلغاء</Button>
            <Button
              className="gap-1.5 bg-emerald-600 hover:bg-emerald-700"
              disabled={approveMutation.isPending || !durationDays || (envMode === "shared" && !sharedCompanyId)}
              onClick={() => approveMutation.mutate()}
              data-testid="trainee-approve-confirm"
            >
              {approveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              اعتماد وإرسال رسالة التفعيل
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Reject dialog ── */}
      <Dialog open={!!rejectDialog} onOpenChange={o => { if (!o) setRejectDialog(null); }}>
        <DialogContent className="max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle>رفض طلب — {rejectDialog?.fullName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">سبب الرفض <span className="text-destructive">*</span></label>
            <Input value={rejectReason} onChange={e => setRejectReason(e.target.value)} maxLength={500}
                   placeholder="سبب الرفض (3 أحرف على الأقل)" data-testid="trainee-reject-reason" />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRejectDialog(null)}>إلغاء</Button>
            <Button variant="destructive" className="gap-1.5"
                    disabled={rejectMutation.isPending || rejectReason.trim().length < 3}
                    onClick={() => rejectMutation.mutate()}
                    data-testid="trainee-reject-confirm">
              {rejectMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
              رفض الطلب
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
