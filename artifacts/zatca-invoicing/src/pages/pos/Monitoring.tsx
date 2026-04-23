import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity, Banknote, ReceiptText, Users as UsersIcon,
  Building2, Clock, RefreshCw, Search, Lock, AlertCircle, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { posMonitoringApi, type PosSessionRow, type PosSessionDetail } from "@/lib/posMonitoringApi";

const SAR = (n: number | string | null | undefined) =>
  new Intl.NumberFormat("ar-SA", { style: "currency", currency: "SAR", maximumFractionDigits: 2 }).format(Number(n ?? 0));
const dt = (s: string | null) => s ? new Date(s).toLocaleString("ar-SA", { dateStyle: "short", timeStyle: "short" }) : "—";
const durationMin = (a: string, b: string | null) => {
  const start = new Date(a).getTime();
  const end = b ? new Date(b).getTime() : Date.now();
  const m = Math.max(0, Math.round((end - start) / 60000));
  if (m < 60) return `${m} د`;
  const h = Math.floor(m / 60), r = m % 60;
  return `${h} س ${r} د`;
};

function StatusBadge({ status }: { status: PosSessionRow["status"] }) {
  if (status === "open") return (
    <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 hover:bg-emerald-100">
      <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 me-1.5 animate-pulse" />
      مفتوحة
    </Badge>
  );
  if (status === "closed") return <Badge variant="secondary">مغلقة</Badge>;
  return <Badge className="bg-amber-100 text-amber-800 border-amber-200">إغلاق إجباري</Badge>;
}

function StatCard({ icon: Icon, label, value, accent, sub }: {
  icon: any; label: string; value: string; accent: string; sub?: string;
}) {
  return (
    <Card className="overflow-hidden border-0 shadow-sm">
      <CardContent className="p-5">
        <div className="flex items-center gap-4">
          <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${accent}`}>
            <Icon className="w-6 h-6 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="text-2xl font-bold leading-tight truncate">{value}</div>
            {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function PosMonitoring() {
  const { user, token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const isSuperAdmin = user?.role === "superadmin";
  const [companyId, setCompanyId] = useState<number | null>(user?.companyId ?? null);

  // Companies dropdown for superadmin to filter by tenant.
  const companiesQ = useQuery({
    queryKey: ["companies-for-pos-monitor"],
    enabled: isSuperAdmin,
    queryFn: async () => {
      const API = import.meta.env.VITE_API_URL || "";
      const res = await fetch(`${API}/api/companies`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error("فشل تحميل الشركات");
      return (await res.json()) as Array<{ id: number; nameAr: string; nameEn?: string }>;
    },
  });
  const [status, setStatus] = useState<"" | "open" | "closed" | "force_closed">("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  useEffect(() => { if (user?.companyId) setCompanyId(user.companyId); }, [user?.companyId]);

  const summary = useQuery({
    queryKey: ["pos-summary-today", companyId],
    queryFn: () => posMonitoringApi.summaryToday(companyId),
    refetchInterval: autoRefresh ? 10_000 : false,
  });

  const list = useQuery({
    queryKey: ["pos-sessions", companyId, status],
    queryFn: () => posMonitoringApi.list({ companyId, status }),
    refetchInterval: autoRefresh ? 10_000 : false,
  });

  const detail = useQuery({
    queryKey: ["pos-session", selectedId],
    queryFn: () => posMonitoringApi.get(selectedId!),
    enabled: selectedId != null,
    refetchInterval: selectedId && autoRefresh ? 10_000 : false,
  });

  const filtered = useMemo(() => {
    const rows = list.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      String(r.id).includes(q) ||
      r.user?.username?.toLowerCase().includes(q) ||
      r.user?.nameAr?.toLowerCase().includes(q) ||
      r.branch?.nameAr?.toLowerCase().includes(q) ||
      r.cashBox?.nameAr?.toLowerCase().includes(q)
    );
  }, [list.data, search]);

  const openSessions = filtered.filter(r => r.status === "open");
  const byUser = useMemo(() => {
    const map = new Map<string, { name: string; sales: number; invoices: number }>();
    for (const r of filtered) {
      const key = r.user?.username || "—";
      const name = r.user?.nameAr || r.user?.username || "—";
      const cur = map.get(key) ?? { name, sales: 0, invoices: 0 };
      cur.sales += Number(r.totalSales || 0);
      cur.invoices += Number(r.invoiceCount || 0);
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.sales - a.sales).slice(0, 5);
  }, [filtered]);

  async function forceClose(id: number) {
    try {
      await posMonitoringApi.forceClose(id, "إغلاق من لوحة المراقبة");
      toast({ title: "تم الإغلاق", description: `تم إغلاق الجلسة #${id} بنجاح` });
      qc.invalidateQueries({ queryKey: ["pos-sessions"] });
      qc.invalidateQueries({ queryKey: ["pos-summary-today"] });
      qc.invalidateQueries({ queryKey: ["pos-session", id] });
    } catch (e: any) {
      toast({ title: "تعذّر الإغلاق", description: e?.message || "خطأ غير معروف", variant: "destructive" });
    }
  }

  return (
    <div className="space-y-6 p-1" dir="rtl">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Activity className="w-6 h-6 text-emerald-600" />
            مراقبة نقاط البيع
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            تتبّع جلسات الكاشير المفتوحة والمغلقة، ومبيعات اليوم اللحظية
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={autoRefresh ? "default" : "outline"}
            size="sm"
            onClick={() => setAutoRefresh(v => !v)}
            className="gap-1"
          >
            <span className={`inline-block w-2 h-2 rounded-full ${autoRefresh ? "bg-emerald-300 animate-pulse" : "bg-muted-foreground"}`} />
            تحديث تلقائي
          </Button>
          <Button variant="outline" size="sm" onClick={() => { list.refetch(); summary.refetch(); }} className="gap-1">
            <RefreshCw className="w-4 h-4" />
            تحديث
          </Button>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {summary.isLoading ? (
          <>
            {[0,1,2,3].map(i => <Skeleton key={i} className="h-24 rounded-xl" />)}
          </>
        ) : (
          <>
            <StatCard
              icon={Activity}
              label="جلسات مفتوحة الآن"
              value={String(summary.data?.openSessions ?? 0)}
              accent="bg-gradient-to-br from-emerald-500 to-emerald-600"
              sub="عبر كل الفروع"
            />
            <StatCard
              icon={Banknote}
              label="مبيعات اليوم (نقاط البيع)"
              value={SAR(summary.data?.totalSales ?? 0)}
              accent="bg-gradient-to-br from-blue-500 to-indigo-600"
              sub="فواتير مرحّلة فقط"
            />
            <StatCard
              icon={ReceiptText}
              label="عدد فواتير اليوم"
              value={String(summary.data?.invoiceCount ?? 0)}
              accent="bg-gradient-to-br from-purple-500 to-fuchsia-600"
            />
            <StatCard
              icon={Lock}
              label="جلسات أُغلقت اليوم"
              value={String(summary.data?.closedToday ?? 0)}
              accent="bg-gradient-to-br from-slate-500 to-slate-700"
            />
          </>
        )}
      </div>

      {/* Filters */}
      <Card className="border-0 shadow-sm">
        <CardContent className="p-4 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="بحث برقم الجلسة، الكاشير، الفرع، الصندوق..."
              className="pe-9"
            />
          </div>
          <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : v as any)}>
            <SelectTrigger className="w-44"><SelectValue placeholder="كل الحالات" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">كل الحالات</SelectItem>
              <SelectItem value="open">مفتوحة</SelectItem>
              <SelectItem value="closed">مغلقة</SelectItem>
              <SelectItem value="force_closed">إغلاق إجباري</SelectItem>
            </SelectContent>
          </Select>
          {isSuperAdmin && (
            <Select
              value={companyId ? String(companyId) : "all"}
              onValueChange={(v) => setCompanyId(v === "all" ? null : Number(v))}
            >
              <SelectTrigger className="w-56" data-testid="select-company">
                <SelectValue placeholder="كل الشركات" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">كل الشركات</SelectItem>
                {(companiesQ.data ?? []).map(c => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.nameAr}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </CardContent>
      </Card>

      {/* Active sessions live strip */}
      {openSessions.length > 0 && (
        <Card className="border-0 shadow-sm bg-gradient-to-l from-emerald-50 to-white">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
              <h3 className="font-semibold text-emerald-900">جلسات نشطة الآن ({openSessions.length})</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {openSessions.map(s => (
                <button
                  key={s.id}
                  onClick={() => setSelectedId(s.id)}
                  className="text-right rounded-xl border border-emerald-200 bg-white p-3 hover:shadow-md hover:border-emerald-400 transition-all"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-sm font-bold">
                        {(s.user?.nameAr || s.user?.username || "?").charAt(0)}
                      </div>
                      <div>
                        <div className="font-medium text-sm">{s.user?.nameAr || s.user?.username || "—"}</div>
                        <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                          <Building2 className="w-3 h-3" />
                          {s.branch?.nameAr || "—"} · {s.cashBox?.nameAr || "بدون صندوق"}
                        </div>
                      </div>
                    </div>
                    <div className="text-left">
                      <div className="text-base font-bold text-emerald-700">{SAR(s.totalSales)}</div>
                      <div className="text-[11px] text-muted-foreground">{s.invoiceCount} فاتورة</div>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-1"><Clock className="w-3 h-3" />فُتحت {dt(s.openedAt)}</span>
                    <span className="font-medium text-emerald-700">{durationMin(s.openedAt, null)}</span>
                  </div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Top performers */}
      {byUser.length > 0 && (
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <UsersIcon className="w-4 h-4 text-blue-600" />
              أفضل الكاشيرات (حسب المبيعات)
            </h3>
            <div className="space-y-2">
              {byUser.map((u, idx) => (
                <div key={u.name} className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold">{idx + 1}</div>
                  <div className="flex-1 text-sm font-medium">{u.name}</div>
                  <div className="text-xs text-muted-foreground">{u.invoices} فاتورة</div>
                  <div className="font-semibold text-sm">{SAR(u.sales)}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Sessions table */}
      <Card className="border-0 shadow-sm">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs">
                <tr className="text-right">
                  <th className="p-3">#</th>
                  <th className="p-3">الكاشير</th>
                  <th className="p-3">الفرع</th>
                  <th className="p-3">الصندوق</th>
                  <th className="p-3">فُتحت</th>
                  <th className="p-3">أُغلقت</th>
                  <th className="p-3">المدة</th>
                  <th className="p-3 text-left">الفواتير</th>
                  <th className="p-3 text-left">المبيعات</th>
                  <th className="p-3 text-left">فرق الصندوق</th>
                  <th className="p-3">الحالة</th>
                  <th className="p-3 text-left">إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {list.isLoading && (
                  <tr><td colSpan={12} className="p-6 text-center text-muted-foreground">جارٍ التحميل…</td></tr>
                )}
                {!list.isLoading && filtered.length === 0 && (
                  <tr><td colSpan={12} className="p-8 text-center text-muted-foreground">
                    لا توجد جلسات مطابقة للبحث.
                  </td></tr>
                )}
                {filtered.map(s => (
                  <tr
                    key={s.id}
                    className="border-t hover:bg-muted/30 cursor-pointer"
                    onClick={() => setSelectedId(s.id)}
                  >
                    <td className="p-3 font-mono text-xs">#{s.id}</td>
                    <td className="p-3">
                      <div className="font-medium">{s.user?.nameAr || s.user?.username || "—"}</div>
                      {s.user?.nameAr && <div className="text-[11px] text-muted-foreground">{s.user.username}</div>}
                    </td>
                    <td className="p-3">{s.branch?.nameAr || "—"}</td>
                    <td className="p-3">{s.cashBox?.nameAr || "—"}</td>
                    <td className="p-3 text-xs">{dt(s.openedAt)}</td>
                    <td className="p-3 text-xs">{dt(s.closedAt)}</td>
                    <td className="p-3 text-xs">{durationMin(s.openedAt, s.closedAt)}</td>
                    <td className="p-3 text-left tabular-nums">{s.invoiceCount}</td>
                    <td className="p-3 text-left font-semibold tabular-nums">{SAR(s.totalSales)}</td>
                    <td className="p-3 text-left tabular-nums">
                      {s.difference != null ? (
                        <span className={Number(s.difference) === 0 ? "text-muted-foreground" :
                          Number(s.difference) > 0 ? "text-emerald-600" : "text-red-600"}>
                          {SAR(s.difference)}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="p-3"><StatusBadge status={s.status} /></td>
                    <td className="p-3 text-left">
                      {s.status === "open" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={(e) => { e.stopPropagation(); if (confirm(`إغلاق الجلسة #${s.id} إجباريًا؟`)) forceClose(s.id); }}
                          className="gap-1 text-xs"
                        >
                          <Lock className="w-3 h-3" />
                          إغلاق
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Session details dialog */}
      <Dialog open={selectedId != null} onOpenChange={(o) => !o && setSelectedId(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Activity className="w-5 h-5 text-emerald-600" />
              تفاصيل الجلسة {selectedId ? `#${selectedId}` : ""}
            </DialogTitle>
          </DialogHeader>

          {detail.isLoading && <div className="py-8 text-center text-muted-foreground">جارٍ التحميل…</div>}
          {detail.data && <SessionDetailBody d={detail.data} onForceClose={() => forceClose(detail.data!.id)} />}

          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedId(null)}>
              <X className="w-4 h-4 me-1" />
              إغلاق
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SessionDetailBody({ d, onForceClose }: { d: PosSessionDetail; onForceClose: () => void }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Info label="الكاشير" value={d.user?.nameAr || d.user?.username || "—"} />
        <Info label="الفرع" value={d.branch?.nameAr || "—"} />
        <Info label="الصندوق" value={d.cashBox?.nameAr || "—"} />
        <Info label="الحالة" value={<StatusBadge status={d.status} />} />
        <Info label="فُتحت" value={dt(d.openedAt)} />
        <Info label="أُغلقت" value={dt(d.closedAt)} />
        <Info label="المدة" value={durationMin(d.openedAt, d.closedAt)} />
        <Info label="الجهاز" value={<span className="text-[11px] truncate block">{d.device || "—"}</span>} />
        <Info label="نقدية افتتاحية" value={SAR(d.openingCash)} />
        <Info label="نقدية متوقعة" value={SAR(d.expectedCash)} />
        <Info label="نقدية إغلاق" value={SAR(d.closingCash)} />
        <Info
          label="الفرق"
          value={
            <span className={Number(d.difference || 0) === 0 ? "" :
              Number(d.difference || 0) > 0 ? "text-emerald-600 font-semibold" : "text-red-600 font-semibold"}>
              {d.difference != null ? SAR(d.difference) : "—"}
            </span>
          }
        />
      </div>

      <div className="grid grid-cols-3 gap-3 pt-3 border-t">
        <div className="rounded-lg bg-blue-50 p-3 text-center">
          <div className="text-[11px] text-blue-700">إجمالي المبيعات</div>
          <div className="text-lg font-bold text-blue-900">{SAR(d.totalSales)}</div>
        </div>
        <div className="rounded-lg bg-purple-50 p-3 text-center">
          <div className="text-[11px] text-purple-700">عدد الفواتير</div>
          <div className="text-lg font-bold text-purple-900">{d.invoiceCount}</div>
        </div>
        <div className="rounded-lg bg-emerald-50 p-3 text-center">
          <div className="text-[11px] text-emerald-700">متوسط الفاتورة</div>
          <div className="text-lg font-bold text-emerald-900">
            {SAR(d.invoiceCount ? d.totalSales / d.invoiceCount : 0)}
          </div>
        </div>
      </div>

      <div>
        <h4 className="font-semibold mb-2 flex items-center gap-2">
          <ReceiptText className="w-4 h-4" />
          فواتير الجلسة ({d.invoices.length})
        </h4>
        <div className="rounded-lg border max-h-72 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs sticky top-0">
              <tr className="text-right">
                <th className="p-2">رقم</th>
                <th className="p-2">التاريخ</th>
                <th className="p-2">الدفع</th>
                <th className="p-2">الحالة</th>
                <th className="p-2 text-left">الإجمالي</th>
              </tr>
            </thead>
            <tbody>
              {d.invoices.length === 0 && (
                <tr><td colSpan={5} className="p-4 text-center text-muted-foreground">لا توجد فواتير في هذه الجلسة بعد.</td></tr>
              )}
              {d.invoices.map(i => (
                <tr key={i.id} className="border-t">
                  <td className="p-2 font-mono text-xs">{i.docNumber || `#${i.id}`}</td>
                  <td className="p-2 text-xs">{new Date(i.createdAt).toLocaleTimeString("ar-SA")}</td>
                  <td className="p-2 text-xs">{i.paymentType === "cash" ? "نقدًا" : i.paymentType || "—"}</td>
                  <td className="p-2 text-xs">
                    {i.status === "posted"
                      ? <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200">مرحّلة</Badge>
                      : <Badge variant="secondary">{i.status}</Badge>}
                  </td>
                  <td className="p-2 text-left tabular-nums font-medium">{SAR(i.totalAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {d.status === "open" && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200">
          <AlertCircle className="w-4 h-4 text-amber-700 shrink-0" />
          <div className="flex-1 text-xs text-amber-900">
            هذه الجلسة لا تزال مفتوحة. يمكنك إغلاقها إجباريًا من هنا (يُسجَّل الإغلاق باسمك).
          </div>
          <Button size="sm" variant="outline" onClick={() => { if (confirm("تأكيد الإغلاق الإجباري؟")) onForceClose(); }}>
            <Lock className="w-3 h-3 me-1" />
            إغلاق إجباري
          </Button>
        </div>
      )}

      {d.closedNotes && (
        <div className="text-xs text-muted-foreground">
          <span className="font-medium">ملاحظات الإغلاق:</span> {d.closedNotes}
        </div>
      )}
    </div>
  );
}

function Info({ label, value }: { label: string; value: any }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-medium mt-0.5">{value}</div>
    </div>
  );
}
