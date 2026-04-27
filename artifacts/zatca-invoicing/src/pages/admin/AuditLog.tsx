import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, ScrollText, ShieldAlert, ChevronLeft, ChevronRight, RefreshCw, Scissors } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const ACTION_CLS: Record<string, string> = {
  create: "bg-emerald-50 text-emerald-700 border-emerald-200",
  edit:   "bg-blue-50 text-blue-700 border-blue-200",
  delete: "bg-rose-50 text-rose-700 border-rose-200",
  post:   "bg-violet-50 text-violet-700 border-violet-200",
  export: "bg-amber-50 text-amber-800 border-amber-200",
  view:   "bg-gray-50 text-gray-700 border-gray-200",
  login:  "bg-sky-50 text-sky-700 border-sky-200",
  denied: "bg-rose-100 text-rose-800 border-rose-300",
};

const ACTION_KEYS = ["view", "create", "edit", "delete", "post", "export", "login", "logout", "denied"];

interface AuditRow {
  id: number;
  userId: number | null;
  username: string | null;
  role: string | null;
  companyId: number | null;
  module: string;
  action: string;
  method: string | null;
  path: string | null;
  entityType: string | null;
  entityId: string | null;
  statusCode: number | null;
  ip: string | null;
  userAgent: string | null;
  metadata: any;
  createdAt: string;
}

const PAGE_SIZE = 50;

export default function AuditLog() {
  const { token } = useAuth();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`adminPages.auditLog.${k}`, opts) as string;
  const trAction = (a: string) => t(`adminPages.auditLog.actions.${a}`, { defaultValue: a }) as string;
  const locale = isRtl ? "ar-SA" : "en-US";
  const headers = { Authorization: `Bearer ${token}` };

  const [module, setModule] = useState<string>("__all");
  const [action, setAction] = useState<string>("__all");
  const [q,      setQ]      = useState("");
  const [from,   setFrom]   = useState("");
  const [to,     setTo]     = useState("");
  const [page,   setPage]   = useState(0);

  useEffect(() => { setPage(0); }, [module, action, q, from, to]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (module !== "__all") p.set("module", module);
    if (action !== "__all") p.set("action", action);
    if (q.trim())            p.set("q", q.trim());
    if (from)                p.set("from", new Date(from).toISOString());
    if (to)                  p.set("to",   new Date(to + "T23:59:59").toISOString());
    p.set("limit",  String(PAGE_SIZE));
    p.set("offset", String(page * PAGE_SIZE));
    return p.toString();
  }, [module, action, q, from, to, page]);

  const { data, isLoading, error, refetch, isFetching } = useQuery<{ rows: AuditRow[]; total: number }>({
    queryKey: ["audit-log", params],
    queryFn: async () => {
      const r = await fetch(`${API}/api/audit-log?${params}`, { headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });

  const { data: modules = [] } = useQuery<string[]>({
    queryKey: ["audit-log-modules"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/audit-log/modules`, { headers });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const total = data?.total ?? 0;
  const rows  = data?.rows  ?? [];
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  const PrevIcon = isRtl ? ChevronRight : ChevronLeft;
  const NextIcon = isRtl ? ChevronLeft : ChevronRight;

  return (
    <div dir={isRtl ? "rtl" : "ltr"} className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ScrollText className="h-5 w-5 text-primary" />
            {tr("title")}
          </CardTitle>
          <CardDescription>
            {tr("subtitle")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-6 gap-2">
            <div className="md:col-span-2">
              <label className="text-xs text-muted-foreground mb-1 block">{tr("searchLabel")}</label>
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("searchPh")} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{tr("moduleLabel")}</label>
              <Select value={module} onValueChange={setModule}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all">{tr("all")}</SelectItem>
                  {modules.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{tr("actionLabel")}</label>
              <Select value={action} onValueChange={setAction}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all">{tr("all")}</SelectItem>
                  {ACTION_KEYS.map(v => (
                    <SelectItem key={v} value={v}>{trAction(v)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{tr("fromLabel")}</label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{tr("toLabel")}</label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground">
              {tr("totalLabel")} <span className="font-mono font-semibold text-foreground">{total.toLocaleString(locale)}</span>
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`h-3.5 w-3.5 ${isRtl ? "ml-1" : "mr-1"} ${isFetching ? "animate-spin" : ""}`} />
              {tr("refresh")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-12 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
          ) : error ? (
            <div className="p-8 text-center text-rose-600 flex flex-col items-center gap-2">
              <ShieldAlert className="h-8 w-8" />
              <span>{tr("loadFailed")}</span>
              <span className="text-xs text-muted-foreground">{(error as any)?.message}</span>
            </div>
          ) : rows.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground">{tr("noRows")}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 border-b">
                  <tr className={`${isRtl ? "text-right" : "text-left"} text-xs text-muted-foreground`}>
                    <th className="px-3 py-2 font-medium">{tr("colTime")}</th>
                    <th className="px-3 py-2 font-medium">{tr("colUser")}</th>
                    <th className="px-3 py-2 font-medium">{tr("colAction")}</th>
                    <th className="px-3 py-2 font-medium">{tr("colModule")}</th>
                    <th className="px-3 py-2 font-medium">{tr("colPath")}</th>
                    <th className="px-3 py-2 font-medium">{tr("colStatus")}</th>
                    <th className="px-3 py-2 font-medium">{tr("colIp")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const cls = ACTION_CLS[r.action] ?? "bg-gray-50 text-gray-700 border-gray-200";
                    const label = trAction(r.action);
                    const tt = new Date(r.createdAt);
                    const ok = (r.statusCode ?? 0) >= 200 && (r.statusCode ?? 0) < 400;
                    // Truncation badge — task #115. The maintenance CSV exports
                    // (entityType maintenance_error_summary / maintenance_recent_recoveries,
                    // task #111) record `truncated`/`rowCap`/`totalAvailable` in
                    // metadata when the 1000-row cap clips the file. Surface that
                    // at a glance so a reviewer doesn't have to drill into the
                    // raw JSON to spot a clipped export. Numeric guards keep
                    // unrelated metadata shapes (or future flag-only callers)
                    // safe — we only render the count subtitle when both numbers
                    // are present.
                    const meta = (r.metadata ?? {}) as Record<string, unknown>;
                    const isTruncated = meta.truncated === true;
                    const rowCap = typeof meta.rowCap === "number" ? meta.rowCap : null;
                    const totalAvailable =
                      typeof meta.totalAvailable === "number" ? meta.totalAvailable : null;
                    return (
                      <tr key={r.id} className="border-b last:border-0 hover:bg-muted/20">
                        <td className="px-3 py-2 whitespace-nowrap text-xs font-mono">
                          {tt.toLocaleString(locale, { hour12: false })}
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-medium">{r.username ?? "—"}</div>
                          {r.role && <div className="text-[10px] text-muted-foreground">{r.role}</div>}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap items-center gap-1">
                            <Badge variant="outline" className={`${cls} font-normal`}>{label}</Badge>
                            {isTruncated && (
                              <Badge
                                variant="outline"
                                data-testid="audit-truncated-badge"
                                title={
                                  rowCap != null && totalAvailable != null
                                    ? tr("truncatedTooltip", {
                                        cap: rowCap.toLocaleString(locale),
                                        total: totalAvailable.toLocaleString(locale),
                                      })
                                    : tr("truncatedLabel")
                                }
                                className="bg-amber-50 text-amber-800 border-amber-300 font-normal gap-1"
                              >
                                <Scissors className="h-3 w-3" />
                                <span>{tr("truncatedLabel")}</span>
                                {rowCap != null && totalAvailable != null && (
                                  <span className="font-mono text-[10px] opacity-80">
                                    {tr("truncatedCount", {
                                      cap: rowCap.toLocaleString(locale),
                                      total: totalAvailable.toLocaleString(locale),
                                    })}
                                  </span>
                                )}
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-xs font-mono">{r.module}</td>
                        <td className="px-3 py-2 text-xs font-mono text-muted-foreground max-w-[300px] truncate" title={`${r.method ?? ""} ${r.path ?? ""}`}>
                          <span className="text-foreground/70">{r.method}</span> {r.path}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {r.statusCode != null && (
                            <span className={`font-mono ${ok ? "text-emerald-600" : "text-rose-600"}`}>{r.statusCode}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{r.ip ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between px-4 py-3 border-t bg-muted/20">
              <div className="text-xs text-muted-foreground">
                {tr("pageOf", { page: (page + 1).toLocaleString(locale), total: (lastPage + 1).toLocaleString(locale) })}
              </div>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>
                  <PrevIcon className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(lastPage, p + 1))} disabled={page >= lastPage}>
                  <NextIcon className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
