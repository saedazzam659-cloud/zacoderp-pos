import { useState, useMemo, useRef } from "react";
import { Switch, Route, Link, useLocation, Redirect } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard, Building2, Wallet, FileText, UploadCloud, Download,
  LogOut, Code2, RefreshCw, CheckCircle2,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─────────────────────────────────────────────────────────────────────────
// Developer / Partner self-service portal (additive).
//
// Self-contained shell (own sidebar + routes, NOT the tenant Layout) rendered
// by App.tsx whenever the authenticated user's role==="partner". Every screen
// is strictly scoped server-side to the partner's own record + linked
// companies; the capability grants (partnerPermissions) only HIDE screens the
// partner can't use — the backend is the real authority (403 on any ungranted
// action). Mirrors ResellerPortal.tsx.
// ─────────────────────────────────────────────────────────────────────────

function useHeaders() {
  const token = localStorage.getItem("zatca_token");
  return useMemo(() => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" }), [token]);
}

function fmtMoney(v: any): string {
  const n = Number(v ?? 0);
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const EVENT_LABELS: Record<string, string> = {
  app_sale: "بيع تطبيق",
  app_renewal: "تجديد تطبيق",
  subscription: "اشتراك",
  adjustment: "تسوية",
};

const DOC_TYPE_LABELS: Record<string, string> = {
  cr: "السجل التجاري",
  vat: "الشهادة الضريبية",
  id: "الهوية",
  contract: "العقد",
  other: "أخرى",
};

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  active: { label: "نشط", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  suspended: { label: "موقوف", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  pending: { label: "قيد المراجعة", cls: "bg-slate-50 text-slate-600 border-slate-200" },
  approved: { label: "مقبول", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  verified: { label: "موثّق", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  rejected: { label: "مرفوض", cls: "bg-red-50 text-red-700 border-red-200" },
};

function Badge({ status }: { status: string }) {
  const b = STATUS_BADGE[status] ?? { label: status, cls: "bg-slate-50 text-slate-600 border-slate-200" };
  return <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", b.cls)}>{b.label}</span>;
}

// ─── Dashboard ───────────────────────────────────────────────────────────
function PartnerDashboard() {
  const headers = useHeaders();
  const { data, isLoading } = useQuery({
    queryKey: ["partner-dashboard"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/partner/dashboard`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });

  const cards = [
    { label: "عدد الشركات", value: data?.clientCount ?? 0, icon: Building2, color: "text-blue-600 bg-blue-50" },
    { label: "شركات نشطة", value: data?.activeClients ?? 0, icon: CheckCircle2, color: "text-emerald-600 bg-emerald-50" },
    { label: "إجمالي العمولات", value: fmtMoney(data?.commissionTotal), icon: Wallet, color: "text-violet-600 bg-violet-50", money: true },
    { label: "عمولة هذا الشهر", value: fmtMoney(data?.commissionThisMonth), icon: Wallet, color: "text-amber-600 bg-amber-50", money: true },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-800">لوحة التحكم</h2>
        <p className="text-sm text-slate-500 mt-1">نظرة عامة على شركاتك وعمولاتك (نسبة العمولة: {data?.commissionRate ?? "0"}%)</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((c, i) => (
          <div key={i} className="rounded-xl border bg-card p-4 flex items-center gap-3">
            <div className={cn("h-11 w-11 rounded-lg flex items-center justify-center shrink-0", c.color)}>
              <c.icon className="h-5 w-5" />
            </div>
            <div>
              {isLoading ? <Skeleton className="h-7 w-20" /> : (
                <p className="text-2xl font-bold tabular-nums">{c.value}{c.money ? <span className="text-sm text-slate-400 mr-1">ر.س</span> : null}</p>
              )}
              <p className="text-xs text-muted-foreground">{c.label}</p>
            </div>
          </div>
        ))}
      </div>
      {(data?.pendingDocs ?? 0) > 0 && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          لديك {data.pendingDocs} مستند قيد المراجعة من قبل الإدارة.
        </div>
      )}
    </div>
  );
}

// ─── Linked companies ────────────────────────────────────────────────────
function PartnerCompanies() {
  const headers = useHeaders();
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["partner-companies"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/partner/companies`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });
  const companies = data?.companies ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-800">الشركات المرتبطة</h2>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
          <RefreshCw className="h-4 w-4" /> تحديث
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : companies.length === 0 ? (
        <div className="rounded-xl border border-dashed py-12 text-center text-slate-400">لا توجد شركات مرتبطة بعد</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2 text-right font-medium">الكود</th>
                <th className="px-3 py-2 text-right font-medium">الاسم</th>
                <th className="px-3 py-2 text-right font-medium">المدينة</th>
                <th className="px-3 py-2 text-right font-medium">الحالة</th>
                <th className="px-3 py-2 text-right font-medium">العلاقة</th>
                <th className="px-3 py-2 text-right font-medium">انتهاء الاشتراك</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {companies.map((c: any) => (
                <tr key={c.id} data-testid={`row-company-${c.id}`}>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{c.code}</td>
                  <td className="px-3 py-2 font-medium">{c.nameAr}</td>
                  <td className="px-3 py-2">{c.city ?? "—"}</td>
                  <td className="px-3 py-2"><Badge status={c.status} /></td>
                  <td className="px-3 py-2 text-slate-600">{c.role}</td>
                  <td className="px-3 py-2 tabular-nums">{c.subscription?.endDate ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Commissions ─────────────────────────────────────────────────────────
function PartnerCommissions() {
  const headers = useHeaders();
  const { data, isLoading } = useQuery({
    queryKey: ["partner-commissions"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/partner/commissions`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });
  const { data: summary } = useQuery({
    queryKey: ["partner-commissions-summary"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/partner/commissions/summary`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });
  const rows = data?.commissions ?? [];

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold text-slate-800">العمولات</h2>
      {summary?.monthly?.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {summary.monthly.slice(0, 3).map((m: any, i: number) => (
            <div key={i} className="rounded-xl border bg-card p-4">
              <p className="text-xs text-muted-foreground">{m.periodMonth}/{m.periodYear}</p>
              <p className="text-xl font-bold tabular-nums">{fmtMoney(m.total)} <span className="text-xs text-slate-400">ر.س</span></p>
              <p className="text-xs text-slate-400">{m.count} عملية</p>
            </div>
          ))}
        </div>
      )}
      {isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed py-12 text-center text-slate-400">لا توجد عمولات بعد</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2 text-right font-medium">التاريخ</th>
                <th className="px-3 py-2 text-right font-medium">الشركة</th>
                <th className="px-3 py-2 text-right font-medium">النوع</th>
                <th className="px-3 py-2 text-right font-medium">الأساس</th>
                <th className="px-3 py-2 text-right font-medium">النسبة</th>
                <th className="px-3 py-2 text-right font-medium">العمولة</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((c: any) => (
                <tr key={c.id} data-testid={`row-commission-${c.id}`}>
                  <td className="px-3 py-2 text-xs text-slate-500 tabular-nums">{(c.createdAt ?? "").slice(0, 10)}</td>
                  <td className="px-3 py-2">{c.companyName ?? "—"}</td>
                  <td className="px-3 py-2">{EVENT_LABELS[c.eventType] ?? c.eventType}</td>
                  <td className="px-3 py-2 tabular-nums">{fmtMoney(c.baseAmount)}</td>
                  <td className="px-3 py-2 tabular-nums">{c.commissionRate}%</td>
                  <td className="px-3 py-2 tabular-nums font-semibold text-emerald-700">{fmtMoney(c.commissionAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Documents (self-upload) ─────────────────────────────────────────────
function PartnerDocuments() {
  const headers = useHeaders();
  const qc = useQueryClient();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState("cr");
  const [title, setTitle] = useState("");
  const [uploading, setUploading] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["partner-documents"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/partner/documents`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });
  const documents = data?.documents ?? [];

  // Self-upload: request a presigned URL → PUT the file → record the document.
  async function onUpload() {
    const file = fileRef.current?.files?.[0];
    if (!file) { toast({ title: "اختر ملفاً أولاً", variant: "destructive" }); return; }
    setUploading(true);
    try {
      const urlRes = await fetch(`${API}/api/partner/documents/upload-url`, {
        method: "POST", headers, body: JSON.stringify({ name: file.name, contentType: file.type || "application/octet-stream" }),
      });
      const urlData = await urlRes.json().catch(() => ({}));
      if (!urlRes.ok) throw new Error(urlData?.error ?? "تعذّر إنشاء رابط الرفع");

      const putRes = await fetch(urlData.uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!putRes.ok) throw new Error("فشل رفع الملف");

      const recRes = await fetch(`${API}/api/partner/documents`, {
        method: "POST", headers,
        body: JSON.stringify({ docType, title: title.trim() || null, objectPath: urlData.objectPath }),
      });
      const recData = await recRes.json().catch(() => ({}));
      if (!recRes.ok) throw new Error(recData?.error ?? "فشل تسجيل المستند");

      toast({ title: "تم رفع المستند" });
      setTitle("");
      if (fileRef.current) fileRef.current.value = "";
      qc.invalidateQueries({ queryKey: ["partner-documents"] });
    } catch (e: any) {
      toast({ title: "خطأ", description: e.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  // Download streams through the scoped, ownership-checked backend route.
  async function onDownload(id: number) {
    try {
      const r = await fetch(`${API}/api/partner/documents/${id}/download`, { headers });
      if (!r.ok) throw new Error();
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "تعذّر تنزيل الملف", variant: "destructive" });
    }
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <h2 className="text-2xl font-bold text-slate-800">المستندات</h2>
      <p className="text-sm text-slate-500">ارفع مستنداتك (السجل التجاري، الشهادة الضريبية، العقود…) لمراجعتها من قبل الإدارة.</p>

      <Card>
        <CardContent className="p-5 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>نوع المستند</Label>
              <select value={docType} onChange={(e) => setDocType(e.target.value)}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" data-testid="select-doc-type">
                {Object.entries(DOC_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div>
              <Label>عنوان (اختياري)</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1" data-testid="input-doc-title" />
            </div>
          </div>
          <div>
            <Label>الملف</Label>
            <input ref={fileRef} type="file"
              className="mt-1 block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-2 file:text-sm file:text-primary"
              data-testid="input-doc-file" />
          </div>
          <Button onClick={onUpload} disabled={uploading} className="gap-2" data-testid="button-upload-doc">
            <UploadCloud className="h-4 w-4" /> {uploading ? "جارٍ الرفع…" : "رفع المستند"}
          </Button>
        </CardContent>
      </Card>

      {isLoading ? <Skeleton className="h-24 w-full" /> : documents.length === 0 ? (
        <div className="rounded-xl border border-dashed py-10 text-center text-slate-400">لا توجد مستندات</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2 text-right font-medium">النوع</th>
                <th className="px-3 py-2 text-right font-medium">العنوان</th>
                <th className="px-3 py-2 text-right font-medium">الحالة</th>
                <th className="px-3 py-2 text-right font-medium">التاريخ</th>
                <th className="px-3 py-2 text-right font-medium">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {documents.map((d: any) => (
                <tr key={d.id} data-testid={`row-document-${d.id}`}>
                  <td className="px-3 py-2 font-medium">{DOC_TYPE_LABELS[d.docType] ?? d.docType}</td>
                  <td className="px-3 py-2 text-slate-600">{d.title ?? "—"}</td>
                  <td className="px-3 py-2"><Badge status={d.status} /></td>
                  <td className="px-3 py-2 text-xs text-slate-500 tabular-nums">{(d.createdAt ?? "").slice(0, 10)}</td>
                  <td className="px-3 py-2">
                    {d.fileUrl && (
                      <Button size="sm" variant="outline" className="gap-1" onClick={() => onDownload(d.id)} data-testid={`button-download-${d.id}`}>
                        <Download className="h-3.5 w-3.5" /> تنزيل
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Portal shell ────────────────────────────────────────────────────────
export default function PartnerPortal() {
  const { user, logout } = useAuth() as any;
  const [location] = useLocation();
  const perms: Record<string, boolean> = user?.partnerPermissions ?? {};

  const nav = [
    { href: "/partner", label: "لوحة التحكم", icon: LayoutDashboard, show: true, exact: true },
    { href: "/partner/companies", label: "الشركات المرتبطة", icon: Building2, show: true },
    { href: "/partner/commissions", label: "العمولات", icon: Wallet, show: perms.view_reports === true },
    { href: "/partner/documents", label: "المستندات", icon: FileText, show: true },
  ];

  const isActive = (href: string, exact?: boolean) =>
    exact ? location === href : location === href || location.startsWith(href + "/");

  return (
    <div dir="rtl" className="min-h-screen flex bg-slate-50">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 border-l bg-white flex flex-col">
        <div className="h-16 flex items-center gap-2 px-5 border-b">
          <div className="h-9 w-9 rounded-xl bg-primary/10 flex items-center justify-center">
            <Code2 className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="text-sm font-bold text-slate-800 leading-tight">بوابة المطوّرين والشركاء</p>
            <p className="text-[11px] text-slate-400 leading-tight">{user?.nameAr ?? user?.username}</p>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {nav.filter((n) => n.show).map((n) => (
            <Link key={n.href} href={n.href} className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              isActive(n.href, n.exact) ? "bg-primary/10 text-primary" : "text-slate-600 hover:bg-slate-100"
            )} data-testid={`nav-${n.href.replace(/\//g, "-")}`}>
              <n.icon className="h-4 w-4" />
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="p-3 border-t">
          <Button variant="ghost" className="w-full justify-start gap-3 text-slate-600" onClick={() => logout()} data-testid="button-partner-logout">
            <LogOut className="h-4 w-4" /> تسجيل الخروج
          </Button>
        </div>
      </aside>

      {/* Content */}
      <main className="flex-1 overflow-auto p-6">
        <Switch>
          <Route path="/partner" component={PartnerDashboard} />
          <Route path="/partner/companies" component={PartnerCompanies} />
          <Route path="/partner/commissions" component={PartnerCommissions} />
          <Route path="/partner/documents" component={PartnerDocuments} />
          <Route><Redirect to="/partner" /></Route>
        </Switch>
      </main>
    </div>
  );
}
