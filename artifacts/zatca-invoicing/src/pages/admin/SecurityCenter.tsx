import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Shield, ShieldAlert, Loader2, RefreshCw, LogOut, Users, History, KeyRound, Activity,
  LogIn, XCircle, Timer, Lock, AlertTriangle, Building2,
  ChevronRight, ChevronLeft, ChevronsRight, ChevronsLeft,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─── Types ──────────────────────────────────────────────────────────────
interface SessionRow {
  userId: number; username: string; email: string | null;
  role: string; companyId: number | null; companyName: string | null;
  companyLoginCount: number | null;
  zatcaStatus: "production" | "sandbox" | "not_linked" | null;
  sessionId: string | null; lastLoginAt: string | null;
  ip: string | null; country: string | null; userAgent: string | null;
}

// Map ZATCA linkage status → presentation. Three states:
//  • production : real CSID issued, env=production → green
//  • sandbox    : compliance/sandbox CSID only OR explicit sandbox flag → amber
//  • not_linked : no CSID at all → neutral gray
const ZATCA_BADGE: Record<NonNullable<SessionRow["zatcaStatus"]>, { label: string; cls: string; dot: string; title: string }> = {
  production: { label: "زاتكا: إنتاج",  cls: "bg-emerald-50 text-emerald-700 border-emerald-200", dot: "bg-emerald-500", title: "الشركة مربوطة بزاتكا في بيئة الإنتاج (CSID إنتاجي)" },
  sandbox:    { label: "زاتكا: تجريبي", cls: "bg-amber-50 text-amber-700 border-amber-200",       dot: "bg-amber-500",   title: "الشركة مربوطة في بيئة التجربة فقط (CSID تجريبي/Sandbox)" },
  not_linked: { label: "غير مربوطة",     cls: "bg-slate-50 text-slate-600 border-slate-200",       dot: "bg-slate-400",   title: "الشركة لم تربط حسابها بزاتكا بعد" },
};

// ─── Country display helpers ────────────────────────────────────────────
// Convert an ISO-3166-1 alpha-2 code into the matching emoji flag using
// regional indicator symbols (U+1F1E6 + offset). Pure function, no I/O.
// Returns the placeholder for invalid/missing codes so the UI never shows
// a half-rendered surrogate pair.
function countryFlag(code: string | null | undefined): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return "🌐";
  const cc = code.toUpperCase();
  return String.fromCodePoint(
    0x1F1E6 + (cc.charCodeAt(0) - 65),
    0x1F1E6 + (cc.charCodeAt(1) - 65),
  );
}
// Arabic display names for the codes we care about most. Anything not in
// this map falls back to the raw 2-letter code so the UI is never blank.
const COUNTRY_AR: Record<string, string> = {
  SA: "السعودية", AE: "الإمارات", KW: "الكويت", QA: "قطر", BH: "البحرين",
  OM: "عُمان", YE: "اليمن", EG: "مصر", JO: "الأردن", LB: "لبنان",
  SY: "سوريا", IQ: "العراق", PS: "فلسطين", SD: "السودان", LY: "ليبيا",
  TN: "تونس", DZ: "الجزائر", MA: "المغرب", US: "الولايات المتحدة",
  GB: "بريطانيا", CA: "كندا", DE: "ألمانيا", FR: "فرنسا", IT: "إيطاليا",
  ES: "إسبانيا", TR: "تركيا", IN: "الهند", PK: "باكستان", BD: "بنغلاديش",
  CN: "الصين", JP: "اليابان", KR: "كوريا الجنوبية", RU: "روسيا",
  BR: "البرازيل", AU: "أستراليا", NL: "هولندا", SE: "السويد",
};
function countryName(code: string | null | undefined): string {
  if (!code) return "غير معروف";
  return COUNTRY_AR[code.toUpperCase()] ?? code.toUpperCase();
}
interface LoginHistoryRow {
  id: number; userId: number | null; username: string | null;
  role: string | null; companyId: number | null; companyName: string | null; action: string;
  sessionDurationSec?: number | null;
  module?: string | null;
  method: string | null; path: string | null; statusCode: number | null;
  ip: string | null; userAgent: string | null;
  // audit_log.metadata is a free-form JSON column written by writeAudit.
  // Documented keys we currently surface in this UI: `reason` (e.g. invalid
  // password / company_suspended) and `attemptedAction` (RBAC denial action).
  metadata: { reason?: string; attemptedAction?: string } | Record<string, unknown> | null;
  createdAt: string;
  // Server-side enrichment (admin.ts /security/login-history): country code
  // resolved from `ip` via the 24h-cached resolveCountryForIp helper, and
  // the total auth-attempt count for this username within the filter window
  // (or the past 30d when no window was specified).
  country?: string | null;
  attemptCount?: number | null;
}

// Small helper: extract a human-readable message from an unknown error
// (TanStack Query mutationFn errors are typed as unknown by default).
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "تعذر التحميل";
}
interface AnomalyResp {
  deniedSpikes: { userId: number | null; username: string | null; count: number }[];
  newIps:       { userId: number; username: string; role: string; ip: string; createdAt: string }[];
  superadminNewIps: { userId: number; username: string; ip: string; createdAt: string }[];
  baselineDeviations: {
    userId: number; username: string; role: string;
    todayIps: number; baselineIps: number;
    todayDenied: number; baselineDenied: number;
  }[];
}
type PermCellState = "inherited" | "granted" | "denied" | "none";
interface PermsMatrixResp {
  columns: { key: string }[];
  users: {
    id: number; username: string; email: string | null; role: string;
    companyId: number | null; companyName: string | null;
    cells: Record<string, PermCellState>;
    isActive: boolean; lastLoginAt: string | null;
  }[];
  roleDistribution: { companyId: number | null; companyName: string | null; role: string; count: number }[];
}

// Arabic labels for permission group columns. Keep in sync with PERMISSION_GROUPS
// in the backend `/security/permissions-matrix` endpoint.
const PERM_GROUP_LABEL: Record<string, string> = {
  sales_invoices: "المبيعات",
  purchase_invoices: "المشتريات",
  items: "الأصناف",
  customers: "العملاء",
  suppliers: "الموردون",
  journal_entries: "القيود",
  reports: "التقارير",
  users: "المستخدمون",
};

// ─── Small helpers ──────────────────────────────────────────────────────
function fmtDateTime(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("ar-SA", { hour12: false });
}
// Format a session duration in seconds → human-readable Arabic string.
// Examples: 45 → "٤٥ ث", 130 → "٢ د ١٠ ث", 3700 → "١ س ١ د", 90061 → "١ ي ١ س ١ د".
function formatSessionDuration(sec: number): string {
  if (sec < 60) return `${sec.toLocaleString("ar-SA")} ث`;
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = sec % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days.toLocaleString("ar-SA")} ي`);
  if (hours > 0) parts.push(`${hours.toLocaleString("ar-SA")} س`);
  if (mins > 0 && days === 0) parts.push(`${mins.toLocaleString("ar-SA")} د`);
  if (days === 0 && hours === 0 && secs > 0) parts.push(`${secs.toLocaleString("ar-SA")} ث`);
  return parts.join(" ");
}
function shortUA(ua: string | null): string {
  if (!ua) return "—";
  // Trim down a noisy User-Agent to something readable in a table cell.
  const m = ua.match(/(Chrome|Firefox|Safari|Edg|Opera)\/[\d.]+/);
  return m ? m[0] : ua.slice(0, 40) + (ua.length > 40 ? "…" : "");
}

// ─────────────────────────────────────────────────────────────────────────
//  ACTIVE SESSIONS TAB
// ─────────────────────────────────────────────────────────────────────────
function ActiveSessionsTab({ token }: { token: string | null }) {
  const headers = { Authorization: `Bearer ${token}` };
  const qc = useQueryClient();
  const { toast } = useToast();

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirmEnd, setConfirmEnd] = useState<{ kind: "single" | "bulk"; userId?: number; username?: string } | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery<{ rows: SessionRow[]; total: number }>({
    queryKey: ["security-sessions"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/security/sessions`, { headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    refetchInterval: 30_000,
  });
  const rows = data?.rows ?? [];

  // Helper: optimistically remove the targeted user(s) from the cached sessions
  // list so the row disappears immediately; rolls back if the mutation fails;
  // always invalidates on settle to reconcile with the server. SessionRow keys
  // each row by `userId` (not `id`) — see the interface at the top of this file.
  type SessionsCache = { rows: SessionRow[]; total: number };
  // Snapshot of the cache returned from removeFromCache so onError can roll back.
  type MutationCtx = { previous: SessionsCache | undefined };
  // Bulk-end response shape from /api/admin/security/sessions/bulk-end.
  type BulkEndResp = { ended: number };
  const removeFromCache = async (userIds: number[]): Promise<SessionsCache | undefined> => {
    await qc.cancelQueries({ queryKey: ["security-sessions"] });
    const previous = qc.getQueryData<SessionsCache>(["security-sessions"]);
    if (previous) {
      const set = new Set(userIds);
      const removed = previous.rows.filter(r => set.has(r.userId)).length;
      qc.setQueryData<SessionsCache>(["security-sessions"], {
        rows: previous.rows.filter(r => !set.has(r.userId)),
        total: Math.max(0, previous.total - removed),
      });
    }
    return previous;
  };

  const endOne = useMutation({
    mutationFn: async (userId: number) => {
      const r = await fetch(`${API}/api/admin/security/sessions/${userId}/end`, {
        method: "POST", headers,
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onMutate: async (userId: number): Promise<MutationCtx> => ({
      previous: await removeFromCache([userId]),
    }),
    onError: (e: unknown, _vars: number, ctx: MutationCtx | undefined) => {
      if (ctx?.previous) qc.setQueryData(["security-sessions"], ctx.previous);
      toast({ title: "تعذر إنهاء الجلسة", description: errorMessage(e), variant: "destructive" });
    },
    onSuccess: () => {
      toast({ title: "✓ تم إنهاء الجلسة" });
      setConfirmEnd(null);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["security-sessions"] }),
  });

  const endBulk = useMutation<BulkEndResp, unknown, number[], MutationCtx>({
    mutationFn: async (userIds: number[]): Promise<BulkEndResp> => {
      const r = await fetch(`${API}/api/admin/security/sessions/bulk-end`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ userIds }),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onMutate: async (userIds: number[]): Promise<MutationCtx> => ({
      previous: await removeFromCache(userIds),
    }),
    onError: (e: unknown, _vars: number[], ctx: MutationCtx | undefined) => {
      if (ctx?.previous) qc.setQueryData(["security-sessions"], ctx.previous);
      toast({ title: "تعذر إنهاء الجلسات", description: errorMessage(e), variant: "destructive" });
    },
    onSuccess: (out: BulkEndResp) => {
      toast({ title: `✓ تم إنهاء ${out.ended} جلسة` });
      setConfirmEnd(null);
      setSelected(new Set());
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["security-sessions"] }),
  });

  const toggle = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const allChecked = rows.length > 0 && rows.every(r => selected.has(r.userId));
  const toggleAll = () => {
    if (allChecked) setSelected(new Set());
    else setSelected(new Set(rows.map(r => r.userId)));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          إجمالي الجلسات النشطة:{" "}
          <span className="font-mono font-semibold text-foreground" data-testid="sessions-total">
            {rows.length.toLocaleString("ar-SA")}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="destructive" size="sm" disabled={selected.size === 0 || endBulk.isPending}
            onClick={() => setConfirmEnd({ kind: "bulk" })}
            data-testid="bulk-end-button"
          >
            <LogOut className="h-3.5 w-3.5 ml-1" />
            إنهاء المحدد ({selected.size.toLocaleString("ar-SA")})
          </Button>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-3.5 w-3.5 ml-1 ${isFetching ? "animate-spin" : ""}`} />
            تحديث
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-12 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
          ) : error ? (
            <div className="p-8 text-center text-rose-600">{errorMessage(error)}</div>
          ) : rows.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground">لا توجد جلسات نشطة حالياً.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 border-b">
                  <tr className="text-right text-xs text-muted-foreground">
                    <th className="px-3 py-2 w-10">
                      <Checkbox checked={allChecked} onCheckedChange={toggleAll} data-testid="select-all-sessions" />
                    </th>
                    <th className="px-3 py-2 font-medium">المستخدم</th>
                    <th className="px-3 py-2 font-medium">الدور</th>
                    <th className="px-3 py-2 font-medium">الشركة</th>
                    <th className="px-3 py-2 font-medium">آخر تسجيل دخول</th>
                    <th className="px-3 py-2 font-medium">الدولة</th>
                    <th className="px-3 py-2 font-medium">IP</th>
                    <th className="px-3 py-2 font-medium">المتصفح</th>
                    <th className="px-3 py-2 font-medium w-32">إجراء</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.userId} className="border-b last:border-0 hover:bg-muted/20" data-testid={`session-row-${r.userId}`}>
                      <td className="px-3 py-2">
                        <Checkbox
                          checked={selected.has(r.userId)}
                          onCheckedChange={() => toggle(r.userId)}
                          data-testid={`session-select-${r.userId}`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{r.username}</div>
                        {r.email && <div className="text-[11px] text-muted-foreground">{r.email}</div>}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="outline" className={
                          r.role === "superadmin" ? "bg-purple-50 text-purple-700 border-purple-200" :
                          r.role === "admin"      ? "bg-blue-50 text-blue-700 border-blue-200" :
                                                    "bg-gray-50 text-gray-700 border-gray-200"
                        }>{r.role}</Badge>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span>{r.companyName ?? (r.companyId == null ? "—" : `#${r.companyId}`)}</span>
                          {r.companyLoginCount != null && r.companyLoginCount > 0 && (
                            <Badge
                              variant="outline"
                              className="bg-emerald-50 text-emerald-700 border-emerald-200 text-[10px] font-mono px-1.5 py-0 h-4"
                              title={`إجمالي تسجيلات الدخول لهذه الشركة: ${r.companyLoginCount.toLocaleString("ar-SA")}`}
                              data-testid={`session-company-logins-${r.userId}`}
                            >
                              {r.companyLoginCount.toLocaleString("ar-SA")}
                            </Badge>
                          )}
                          {r.zatcaStatus && (() => {
                            const z = ZATCA_BADGE[r.zatcaStatus];
                            return (
                              <Badge
                                variant="outline"
                                className={`${z.cls} text-[10px] px-1.5 py-0 h-4 inline-flex items-center gap-1`}
                                title={z.title}
                                data-testid={`session-zatca-${r.userId}`}
                              >
                                <span className={`inline-block w-1.5 h-1.5 rounded-full ${z.dot}`} aria-hidden />
                                {z.label}
                              </Badge>
                            );
                          })()}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs font-mono">{fmtDateTime(r.lastLoginAt)}</td>
                      <td className="px-3 py-2" data-testid={`session-country-${r.userId}`}>
                        {r.country ? (
                          <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-gradient-to-l from-sky-50 to-indigo-50 border border-sky-200 text-xs">
                            <span className="text-base leading-none" aria-hidden>{countryFlag(r.country)}</span>
                            <span className="font-medium text-slate-700">{countryName(r.country)}</span>
                            <span className="text-[10px] font-mono text-slate-400">{r.country}</span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{r.ip ?? "—"}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground" title={r.userAgent ?? ""}>{shortUA(r.userAgent)}</td>
                      <td className="px-3 py-2">
                        <Button
                          variant="outline" size="sm" className="text-rose-600 border-rose-200 hover:bg-rose-50"
                          onClick={() => setConfirmEnd({ kind: "single", userId: r.userId, username: r.username })}
                          data-testid={`session-end-${r.userId}`}
                        >
                          <LogOut className="h-3.5 w-3.5 ml-1" />
                          إنهاء
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Destructive force-logout confirmation — pattern: AlertDialog. */}
      <AlertDialog open={!!confirmEnd} onOpenChange={(o) => !o && setConfirmEnd(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>تأكيد إنهاء الجلسة</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmEnd?.kind === "single"
                ? <>سيتم تسجيل خروج المستخدم <strong>{confirmEnd.username}</strong> فوراً وإبطال جلسته.</>
                : <>سيتم إنهاء جلسات <strong>{selected.size.toLocaleString("ar-SA")}</strong> مستخدم.</>}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="confirm-end-cancel">إلغاء</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-700"
              onClick={() => {
                if (confirmEnd?.kind === "single" && confirmEnd.userId != null) endOne.mutate(confirmEnd.userId);
                else endBulk.mutate(Array.from(selected));
              }}
              data-testid="confirm-end-confirm"
            >
              تأكيد الإنهاء
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  LOGIN ATTEMPTS TAB
// ─────────────────────────────────────────────────────────────────────────
function LoginAttemptsTab({ token }: { token: string | null }) {
  const headers = { Authorization: `Bearer ${token}` };
  const [username, setUsername] = useState("");
  const [companyId, setCompanyId] = useState<string>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [success, setSuccess] = useState<"all" | "true" | "false">("all");
  const [pageSize, setPageSize] = useState<number>(25);
  const [page, setPage] = useState<number>(1);

  // Reset to page 1 whenever any filter changes so the user doesn't end up on
  // an empty page after narrowing the result set.
  useEffect(() => { setPage(1); }, [username, companyId, from, to, success, pageSize]);

  // Companies dropdown for the filter — minimal payload from existing endpoint.
  const { data: companies } = useQuery<{ id: number; nameAr: string }[]>({
    queryKey: ["security-history-companies"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/companies`, { headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    staleTime: 5 * 60_000,
  });

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (username.trim())   p.set("username", username.trim());
    if (companyId !== "all") p.set("companyId", companyId);
    if (from)              p.set("from", new Date(from).toISOString());
    if (to)                p.set("to",   new Date(to + "T23:59:59").toISOString());
    if (success !== "all") p.set("success", success);
    p.set("limit", String(pageSize));
    p.set("offset", String((page - 1) * pageSize));
    return p.toString();
  }, [username, companyId, from, to, success, pageSize, page]);

  const { data, isLoading, error, refetch, isFetching } = useQuery<{
    rows: LoginHistoryRow[]; total: number; deniedSeries30d: { day: string; n: number }[];
  }>({
    queryKey: ["security-login-history", params],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/security/login-history?${params}`, { headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });

  const rows = data?.rows ?? [];
  const series = data?.deniedSeries30d ?? [];
  const maxN = Math.max(1, ...series.map(s => s.n));

  return (
    <div className="space-y-3">
      {/* Mini chart of denied attempts per day for 30d */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="h-4 w-4 text-rose-600" />
            محاولات مرفوضة — آخر 30 يوماً
          </CardTitle>
        </CardHeader>
        <CardContent>
          {series.length === 0 ? (
            <div className="text-xs text-muted-foreground py-4 text-center">لا توجد محاولات مرفوضة في الفترة.</div>
          ) : (
            <div className="flex items-end gap-1 h-24">
              {series.map(s => (
                <div key={s.day} className="flex-1 flex flex-col items-center gap-1" title={`${s.day}: ${s.n}`}>
                  <div
                    className="w-full bg-rose-400/80 rounded-t"
                    style={{ height: `${(s.n / maxN) * 100}%`, minHeight: "2px" }}
                  />
                  <div className="text-[9px] text-muted-foreground font-mono">{s.day.slice(5)}</div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-6 gap-2">
            <div className="md:col-span-2">
              <label className="text-xs text-muted-foreground mb-1 block">اسم المستخدم</label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="بحث جزئي…" data-testid="filter-username" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">الشركة</label>
              <Select value={companyId} onValueChange={setCompanyId}>
                <SelectTrigger data-testid="filter-company"><SelectValue placeholder="الكل" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">جميع الشركات</SelectItem>
                  {(companies ?? []).map(c => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.nameAr}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">من تاريخ</label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">إلى تاريخ</label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">الحالة</label>
              <div className="flex items-center gap-1">
                <Button variant={success === "all"   ? "default" : "outline"} size="sm" onClick={() => setSuccess("all")}>الكل</Button>
                <Button variant={success === "true"  ? "default" : "outline"} size="sm" onClick={() => setSuccess("true")}>ناجح</Button>
                <Button variant={success === "false" ? "default" : "outline"} size="sm" onClick={() => setSuccess("false")} data-testid="filter-success-false">مرفوض</Button>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div className="text-xs text-muted-foreground">
              السجلات: <span className="font-mono font-semibold text-foreground">{(data?.total ?? 0).toLocaleString("ar-SA")}</span>
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`h-3.5 w-3.5 ml-1 ${isFetching ? "animate-spin" : ""}`} />
              تحديث
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-12 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
          ) : error ? (
            <div className="p-8 text-center text-rose-600">{errorMessage(error)}</div>
          ) : rows.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground">لا توجد محاولات مطابقة.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 border-b">
                  <tr className="text-right text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">الوقت</th>
                    <th className="px-3 py-2 font-medium">المستخدم</th>
                    <th className="px-3 py-2 font-medium min-w-[180px]">الشركة</th>
                    <th className="px-3 py-2 font-medium">الإجراء</th>
                    <th className="px-3 py-2 font-medium" title="مدة الجلسة من الدخول حتى الخروج">مدة الجلسة</th>
                    <th className="px-3 py-2 font-medium">الوحدة</th>
                    <th className="px-3 py-2 font-medium">السبب</th>
                    <th className="px-3 py-2 font-medium">الدولة</th>
                    <th className="px-3 py-2 font-medium" title="إجمالي محاولات الدخول لهذا المستخدم في الفترة المحددة (أو 30 يوماً افتراضياً)">عدد المحاولات</th>
                    <th className="px-3 py-2 font-medium">IP</th>
                    <th className="px-3 py-2 font-medium">المتصفح</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const denied = r.action === "denied";
                    const isAuth = r.module === "auth";
                    return (
                      <tr key={r.id} className={`border-b last:border-0 ${denied ? "bg-rose-50/40" : ""} hover:bg-muted/20`}>
                        <td className="px-3 py-2 text-xs font-mono whitespace-nowrap">{fmtDateTime(r.createdAt)}</td>
                        <td className="px-3 py-2">
                          <div className="font-medium">{r.username ?? "—"}</div>
                          {r.role && <div className="text-[10px] text-muted-foreground">{r.role}</div>}
                        </td>
                        <td className="px-3 py-2 text-xs min-w-[180px] whitespace-normal break-words">
                          {r.companyName ? (
                            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-gradient-to-l from-violet-50 to-fuchsia-50 border border-violet-200 shadow-sm">
                              <Building2 className="h-3.5 w-3.5 text-violet-600 flex-shrink-0" />
                              <span className="font-medium text-slate-800 text-xs leading-tight">{r.companyName}</span>
                            </div>
                          ) : r.companyId != null ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-50 border border-slate-200 text-xs text-slate-600 font-mono">
                              #{r.companyId}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {r.action === "login" ? (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gradient-to-l from-emerald-500 to-green-500 text-white text-xs font-semibold shadow-sm shadow-emerald-200">
                              <LogIn className="h-3 w-3" />
                              دخول
                            </span>
                          ) : r.action === "logout" ? (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gradient-to-l from-slate-400 to-slate-500 text-white text-xs font-semibold shadow-sm shadow-slate-200">
                              <LogOut className="h-3 w-3" />
                              خروج
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gradient-to-l from-rose-500 to-red-600 text-white text-xs font-semibold shadow-sm shadow-rose-200 animate-pulse">
                              <XCircle className="h-3 w-3" />
                              مرفوض
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs whitespace-nowrap" data-testid={`session-duration-${r.id}`}>
                          {typeof r.sessionDurationSec === "number" ? (
                            <span
                              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border shadow-sm font-mono text-[11px] font-semibold ${
                                r.sessionDurationSec >= 28800
                                  ? "bg-gradient-to-l from-purple-50 to-pink-50 border-purple-200 text-purple-700"
                                  : r.sessionDurationSec >= 3600
                                    ? "bg-gradient-to-l from-indigo-50 to-blue-50 border-indigo-200 text-indigo-700"
                                    : r.sessionDurationSec >= 60
                                      ? "bg-gradient-to-l from-cyan-50 to-teal-50 border-cyan-200 text-cyan-700"
                                      : "bg-gradient-to-l from-amber-50 to-yellow-50 border-amber-200 text-amber-700"
                              }`}
                              title={`${r.sessionDurationSec.toLocaleString("ar-SA")} ثانية`}
                            >
                              <Timer className="h-3 w-3" />
                              {formatSessionDuration(r.sessionDurationSec)}
                            </span>
                          ) : r.action === "denied" ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground italic" title="جلسة لم تنتهِ بعد أو لم يتم تسجيل خروج">
                              <Activity className="h-3 w-3 text-emerald-500 animate-pulse" />
                              نشطة
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {/* Distinguish authentication failures from RBAC permission denials */}
                          {isAuth ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-gradient-to-l from-blue-50 to-sky-50 border border-blue-200 text-blue-700 text-[10px] font-mono font-semibold">
                              <Lock className="h-3 w-3" />
                              {r.module ?? "—"}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-gradient-to-l from-amber-50 to-orange-50 border border-amber-200 text-amber-700 text-[10px] font-mono font-semibold">
                              <AlertTriangle className="h-3 w-3" />
                              {r.module ?? "—"}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {r.metadata?.reason ?? r.metadata?.attemptedAction ?? (r.action === "denied" ? "—" : "")}
                        </td>
                        <td className="px-3 py-2" data-testid={`history-country-${r.id}`}>
                          {r.country ? (
                            <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-gradient-to-l from-sky-50 to-indigo-50 border border-sky-200 text-xs">
                              <span className="text-base leading-none" aria-hidden>{countryFlag(r.country)}</span>
                              <span className="font-medium text-slate-700">{countryName(r.country)}</span>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2" data-testid={`history-attempts-${r.id}`}>
                          {r.attemptCount != null && r.attemptCount > 0 ? (
                            <Badge
                              variant="outline"
                              className={
                                r.attemptCount >= 10
                                  ? "bg-rose-50 text-rose-700 border-rose-300 font-mono text-[11px]"
                                  : r.attemptCount >= 5
                                    ? "bg-amber-50 text-amber-700 border-amber-300 font-mono text-[11px]"
                                    : "bg-slate-50 text-slate-700 border-slate-200 font-mono text-[11px]"
                              }
                              title={`${r.attemptCount.toLocaleString("ar-SA")} محاولة دخول لهذا المستخدم`}
                            >
                              {r.attemptCount.toLocaleString("ar-SA")}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{r.ip ?? "—"}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground" title={r.userAgent ?? ""}>{shortUA(r.userAgent)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
        {!isLoading && !error && rows.length > 0 && (
          <PaginationFooter
            page={page}
            pageSize={pageSize}
            total={data?.total ?? 0}
            isFetching={isFetching}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        )}
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  PAGINATION FOOTER — reusable, RTL-aware, responsive
// ─────────────────────────────────────────────────────────────────────────
function PaginationFooter({
  page, pageSize, total, isFetching, onPageChange, onPageSizeChange,
}: {
  page: number; pageSize: number; total: number; isFetching: boolean;
  onPageChange: (p: number) => void; onPageSizeChange: (s: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const fromIdx = (page - 1) * pageSize + 1;
  const toIdx = Math.min(page * pageSize, total);

  // Build a windowed list of page numbers around the current page with
  // ellipses for gaps. Always shows first + last + 1 neighbour each side.
  const pageList = useMemo<(number | "…")[]>(() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const out: (number | "…")[] = [1];
    const left = Math.max(2, page - 1);
    const right = Math.min(totalPages - 1, page + 1);
    if (left > 2) out.push("…");
    for (let i = left; i <= right; i++) out.push(i);
    if (right < totalPages - 1) out.push("…");
    out.push(totalPages);
    return out;
  }, [page, totalPages]);

  const canPrev = page > 1;
  const canNext = page < totalPages;

  return (
    <div className="border-t bg-gradient-to-l from-slate-50 via-white to-slate-50 px-3 sm:px-4 py-3">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
        {/* Range + page-size selector */}
        <div className="flex items-center gap-3 text-xs">
          <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-slate-200 shadow-sm">
            <span className="text-muted-foreground">عرض</span>
            <span className="font-mono font-semibold text-slate-800">{fromIdx.toLocaleString("ar-SA")}</span>
            <span className="text-muted-foreground">–</span>
            <span className="font-mono font-semibold text-slate-800">{toIdx.toLocaleString("ar-SA")}</span>
            <span className="text-muted-foreground">من</span>
            <span className="font-mono font-bold text-indigo-700">{total.toLocaleString("ar-SA")}</span>
          </div>
          <div className="hidden sm:flex items-center gap-1.5">
            <span className="text-muted-foreground">لكل صفحة:</span>
            <select
              className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-mono shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              data-testid="pagination-page-size"
            >
              {[10, 25, 50, 100, 200].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
          {isFetching && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-500" />
          )}
        </div>

        {/* Page navigation */}
        <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-white border border-slate-200 shadow-sm">
          <button
            type="button"
            disabled={!canPrev}
            onClick={() => onPageChange(1)}
            className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-indigo-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="الصفحة الأولى"
            data-testid="pagination-first"
          >
            <ChevronsRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={!canPrev}
            onClick={() => onPageChange(page - 1)}
            className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-indigo-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="السابق"
            data-testid="pagination-prev"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          {pageList.map((p, i) =>
            p === "…" ? (
              <span key={`e${i}`} className="px-2 text-slate-400 select-none">…</span>
            ) : (
              <button
                key={p}
                type="button"
                onClick={() => onPageChange(p)}
                aria-current={p === page ? "page" : undefined}
                className={`min-w-[2rem] h-8 px-2 rounded-lg text-xs font-mono font-semibold transition-all ${
                  p === page
                    ? "bg-gradient-to-l from-indigo-500 to-violet-500 text-white shadow-md shadow-indigo-200 scale-105"
                    : "text-slate-700 hover:bg-slate-100 hover:text-indigo-600"
                }`}
                data-testid={`pagination-page-${p}`}
              >
                {p.toLocaleString("ar-SA")}
              </button>
            )
          )}
          <button
            type="button"
            disabled={!canNext}
            onClick={() => onPageChange(page + 1)}
            className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-indigo-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="التالي"
            data-testid="pagination-next"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={!canNext}
            onClick={() => onPageChange(totalPages)}
            className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-indigo-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="الصفحة الأخيرة"
            data-testid="pagination-last"
          >
            <ChevronsLeft className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  PERMISSIONS & ACCESS TAB
// ─────────────────────────────────────────────────────────────────────────
function PermissionsTab({ token }: { token: string | null }) {
  const headers = { Authorization: `Bearer ${token}` };
  const [, setLocation] = useLocation();

  const { data, isLoading, error } = useQuery<PermsMatrixResp>({
    queryKey: ["security-perms-matrix"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/security/permissions-matrix`, { headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });

  // Group role distribution by company for the side panel. We retain the first
  // companyName seen per companyId so the panel can show the friendly name
  // instead of a bare numeric id (the backend sends the same name on every row
  // for a given company, so first-seen is canonical).
  const distByCompany = useMemo(() => {
    const map = new Map<number | null, { name: string | null; rows: { role: string; count: number }[] }>();
    for (const r of data?.roleDistribution ?? []) {
      const entry = map.get(r.companyId) ?? { name: r.companyName, rows: [] };
      entry.rows.push({ role: r.role, count: r.count });
      map.set(r.companyId, entry);
    }
    return Array.from(map.entries());
  }, [data?.roleDistribution]);

  if (isLoading) return <div className="p-12 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>;
  if (error)     return <div className="p-8 text-center text-rose-600">{errorMessage(error)}</div>;

  const users = data?.users ?? [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
      <Card className="lg:col-span-2">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" />
            مستخدمو الإدارة والمالكون ({users.length.toLocaleString("ar-SA")})
          </CardTitle>
          <CardDescription className="text-xs">
            انقر على أي مستخدم لتعديل صلاحياته في صفحة المستخدمين.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {users.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">لا يوجد مستخدمون مطابقون.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="perms-matrix-table">
                <thead className="bg-muted/40 border-b">
                  <tr className="text-right text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium sticky right-0 bg-muted/40">المستخدم</th>
                    <th className="px-2 py-2 font-medium">الدور</th>
                    <th className="px-2 py-2 font-medium">الشركة</th>
                    {(data?.columns ?? []).map(col => (
                      <th key={col.key} className="px-2 py-2 font-medium text-center min-w-[90px]" title={col.key}>
                        {PERM_GROUP_LABEL[col.key] ?? col.key}
                      </th>
                    ))}
                    <th className="px-2 py-2 font-medium">الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map(u => (
                    <tr
                      key={u.id}
                      className="border-b last:border-0 hover:bg-muted/20 cursor-pointer"
                      onClick={() => setLocation(
                        // Include companyId so the superadmin can open users in
                        // any tenant (the /api/users endpoint is tenant-scoped
                        // and only honours ?companyId for superadmin callers).
                        u.companyId != null
                          ? `/users?companyId=${u.companyId}&selected=${u.id}`
                          : `/users?selected=${u.id}`
                      )}
                      data-testid={`perms-user-row-${u.id}`}
                      title="فتح صفحة المستخدمين"
                    >
                      <td className="px-3 py-2 sticky right-0 bg-background">
                        <div className="font-medium">{u.username}</div>
                        {u.email && <div className="text-[11px] text-muted-foreground">{u.email}</div>}
                      </td>
                      <td className="px-2 py-2">
                        <Badge variant="outline" className={
                          u.role === "superadmin" ? "bg-purple-50 text-purple-700 border-purple-200" :
                          u.role === "owner"      ? "bg-amber-50 text-amber-700 border-amber-200" :
                                                    "bg-blue-50 text-blue-700 border-blue-200"
                        }>{u.role}</Badge>
                      </td>
                      <td className="px-2 py-2 text-xs">{u.companyName ?? (u.companyId == null ? "—" : `#${u.companyId}`)}</td>
                      {(data?.columns ?? []).map(col => {
                        const state = u.cells[col.key] ?? "none";
                        // Each cell shows one of four explicit states with colour cues:
                        //   inherited (الدور كامل) — green outline, role bypass
                        //   granted   (مُمنوح)      — green filled, explicit allow
                        //   denied    (ممنوع)       — red,           explicit block
                        //   none      (—)           — neutral muted
                        const cls =
                          state === "inherited" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                          state === "granted"   ? "bg-emerald-100 text-emerald-800 border-emerald-300 font-semibold" :
                          state === "denied"    ? "bg-rose-100 text-rose-800 border-rose-300 font-semibold" :
                                                  "bg-slate-50 text-slate-400 border-slate-200";
                        const label =
                          state === "inherited" ? "كامل" :
                          state === "granted"   ? "مُمنوح" :
                          state === "denied"    ? "ممنوع" :
                                                  "—";
                        return (
                          <td key={col.key} className="px-2 py-2 text-center" data-testid={`perms-cell-${u.id}-${col.key}`} data-state={state}>
                            <Badge variant="outline" className={`${cls} text-[10px] w-full justify-center`}>
                              {label}
                            </Badge>
                          </td>
                        );
                      })}
                      <td className="px-2 py-2">
                        <Badge variant="outline" className={u.isActive
                          ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                          : "bg-rose-50 text-rose-700 border-rose-200"
                        }>{u.isActive ? "نشط" : "موقوف"}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            توزيع الأدوار
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {distByCompany.length === 0 ? (
            <div className="text-xs text-muted-foreground">لا توجد بيانات.</div>
          ) : distByCompany.map(([cid, entry]) => (
            <div key={cid ?? "global"} className="border rounded p-2">
              <div className="text-xs font-semibold mb-1">
                {cid == null
                  ? "بدون شركة (مشرف عام)"
                  : entry.name ?? `شركة #${cid}`}
                {cid != null && entry.name && (
                  <span className="text-[10px] text-muted-foreground font-normal mx-1">#{cid}</span>
                )}
              </div>
              <div className="flex flex-wrap gap-1">
                {entry.rows.map(r => (
                  <Badge key={r.role} variant="outline" className="text-[10px] font-mono">
                    {r.role}: {r.count}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  ANOMALIES BANNER
// ─────────────────────────────────────────────────────────────────────────
function AnomaliesBanner({ token }: { token: string | null }) {
  const headers = { Authorization: `Bearer ${token}` };
  const { data } = useQuery<AnomalyResp>({
    queryKey: ["security-anomalies"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/security/anomalies`, { headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    refetchInterval: 60_000,
  });
  if (!data) return null;
  const total = data.deniedSpikes.length + data.newIps.length
    + data.superadminNewIps.length + data.baselineDeviations.length;
  if (total === 0) {
    return (
      <div className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 flex items-center gap-2">
        <Shield className="h-4 w-4" />
        لا توجد تنبيهات أمنية حالياً.
      </div>
    );
  }
  return (
    <div className="rounded border border-amber-300 bg-amber-50 p-3 space-y-2" data-testid="anomalies-banner">
      <div className="text-sm font-semibold text-amber-900 flex items-center gap-2">
        <ShieldAlert className="h-4 w-4" />
        تنبيهات أمنية ({total.toLocaleString("ar-SA")})
      </div>
      {data.deniedSpikes.length > 0 && (
        <div className="text-xs text-amber-900">
          <strong>محاولات وصول مرفوضة مرتفعة (آخر ساعة):</strong>{" "}
          {data.deniedSpikes.map(s => `${s.username ?? `#${s.userId ?? "?"}`} (${s.count})`).join("، ")}
        </div>
      )}
      {data.superadminNewIps.length > 0 && (
        <div className="text-xs text-rose-800">
          <strong>دخول مشرف عام من IP جديد:</strong>{" "}
          {data.superadminNewIps.map(r => `${r.username} من ${r.ip}`).join("، ")}
        </div>
      )}
      {data.newIps.length > 0 && (
        <div className="text-xs text-amber-900">
          <strong>دخول من IP جديد (آخر 24س):</strong>{" "}
          {data.newIps.slice(0, 5).map(r => `${r.username} (${r.ip})`).join("، ")}
          {data.newIps.length > 5 && ` +${data.newIps.length - 5}`}
        </div>
      )}
      {data.baselineDeviations.length > 0 && (
        <div className="text-xs text-amber-900" data-testid="anomalies-baseline">
          <strong>انحرافات عن السلوك المعتاد (مقارنة بآخر 7 أيام):</strong>{" "}
          {data.baselineDeviations.slice(0, 5).map(r =>
            `${r.username}: ${r.todayIps} IP اليوم (المعتاد ${r.baselineIps})، ${r.todayDenied} مرفوضة (المعتاد ${r.baselineDenied})`
          ).join("؛ ")}
          {data.baselineDeviations.length > 5 && ` +${data.baselineDeviations.length - 5}`}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  ROOT
// ─────────────────────────────────────────────────────────────────────────
export default function SecurityCenter() {
  const { token } = useAuth();

  return (
    <div dir="rtl" className="space-y-4" data-testid="security-center">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            مركز الأمان المركزي
          </CardTitle>
          <CardDescription>
            الجلسات النشطة، تاريخ تسجيل الدخول، التنبيهات الأمنية، ونظرة عامة على الصلاحيات عبر الشركات.
          </CardDescription>
        </CardHeader>
      </Card>

      <AnomaliesBanner token={token} />

      <Tabs defaultValue="sessions" dir="rtl">
        <TabsList>
          <TabsTrigger value="sessions" data-testid="tab-sessions">
            <Users className="h-4 w-4 ml-1" /> الجلسات النشطة
          </TabsTrigger>
          <TabsTrigger value="history" data-testid="tab-history">
            <History className="h-4 w-4 ml-1" /> محاولات الدخول
          </TabsTrigger>
          <TabsTrigger value="perms" data-testid="tab-perms">
            <KeyRound className="h-4 w-4 ml-1" /> الصلاحيات والوصول
          </TabsTrigger>
        </TabsList>
        <TabsContent value="sessions" className="mt-3"><ActiveSessionsTab token={token} /></TabsContent>
        <TabsContent value="history"  className="mt-3"><LoginAttemptsTab  token={token} /></TabsContent>
        <TabsContent value="perms"    className="mt-3"><PermissionsTab    token={token} /></TabsContent>
      </Tabs>
    </div>
  );
}
