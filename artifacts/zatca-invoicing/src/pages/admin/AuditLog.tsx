import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useLocation, useSearch } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Loader2,
  ScrollText,
  ShieldAlert,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Scissors,
  Copy,
  Check,
  Link2,
  CheckCircle2,
  FileSearch,
} from "lucide-react";

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

  // ── Shareable permalinks (task #126) ───────────────────────────────────
  // The currently-open details dialog is encoded as `?entry=N` in the URL
  // so any audit row can be linked to directly. The URL is the single
  // source of truth for which row is selected:
  //   • Clicking a row from a closed dialog pushes `?entry=N` so the
  //     browser back button closes the dialog (task #132 — matches the
  //     web convention for modal overlays opened via URL state).
  //   • Switching from one open row to another replaces the current
  //     history entry so a session of clicks doesn't pollute history.
  //   • Closing the dialog via the UI pops the pushed entry (if any) so
  //     forward/back stays sane; if the dialog was opened directly via
  //     a permalink (no entry of ours to pop) we just drop the param.
  //   • Pressing the browser back button while the dialog is open lets
  //     popstate flow naturally — the URL changes, `entryId` recomputes
  //     to null, and the Dialog closes itself.
  //   • Loading the page with `?entry=N` already present opens the dialog
  //     immediately — even if that entry isn't on the current filter page.
  // When the entry isn't in the loaded rows we fall back to a single-entry
  // fetch (`GET /api/audit-log/:id`) so the dialog still opens with full
  // details. The entry-fetch query is only enabled while we don't already
  // have the row in the listing, which keeps the network chatter minimal.
  const search$ = useSearch();
  const [, setLocation] = useLocation();

  const entryId = useMemo(() => {
    const v = new URLSearchParams(search$).get("entry");
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [search$]);

  // Tracks whether the currently-open dialog corresponds to a history
  // entry *we* pushed (vs. a permalink the user landed on directly). On
  // UI close we pop our entry when this is true so back/forward stays
  // intuitive; when the user closes via the browser back button this
  // gets reset by the effect below so a subsequent open re-pushes
  // correctly.
  const pushedDialogEntryRef = useRef(false);
  useEffect(() => {
    if (entryId == null) pushedDialogEntryRef.current = false;
  }, [entryId]);

  const setSelectedId = useCallback(
    (id: number | null) => {
      if (id == null) {
        // Closing via the UI. If we own a pushed history entry, pop it
        // so back/forward behaves like the user expects (one back from
        // the listing leaves the page). The popstate will clear `entry`
        // from the URL and the dialog will close via the URL-derived
        // `entryId`.
        if (pushedDialogEntryRef.current && typeof window !== "undefined") {
          pushedDialogEntryRef.current = false;
          window.history.back();
          return;
        }
        // No pushed entry to pop (permalink landing): just drop the
        // `entry` param in place.
        const params = new URLSearchParams(search$);
        params.delete("entry");
        const qs = params.toString();
        setLocation(qs ? `/admin/audit-log?${qs}` : "/admin/audit-log", { replace: true });
        return;
      }

      const params = new URLSearchParams(search$);
      params.set("entry", String(id));
      const qs = params.toString();
      const url = qs ? `/admin/audit-log?${qs}` : "/admin/audit-log";

      if (entryId == null) {
        // Opening the dialog from a closed state — push so the browser
        // back button closes it instead of leaving the page.
        pushedDialogEntryRef.current = true;
        setLocation(url);
      } else {
        // Switching between rows while the dialog is already open —
        // replace so consecutive clicks don't grow history.
        setLocation(url, { replace: true });
      }
    },
    [search$, setLocation, entryId],
  );

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

  // Resolve the entry that the URL currently points at. Prefer the row from
  // the loaded listing so we don't re-fetch when the user simply clicked a
  // visible row; fall back to the single-entry endpoint when the entry is
  // outside the current filter / page (the permalink case). Errors here
  // (404 cross-tenant, 404 missing, 500) are surfaced inside the dialog so
  // the rest of the listing keeps working.
  const inListEntry = useMemo(
    () => (entryId != null ? rows.find(r => r.id === entryId) ?? null : null),
    [entryId, rows],
  );

  const {
    data: standaloneEntry,
    isLoading: standaloneLoading,
    error: standaloneError,
  } = useQuery<AuditRow>({
    queryKey: ["audit-log-entry", entryId],
    enabled: entryId != null && !inListEntry,
    queryFn: async () => {
      const r = await fetch(`${API}/api/audit-log/${entryId}`, { headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    retry: false,
  });

  const selectedRow = inListEntry ?? standaloneEntry ?? null;

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
                      <tr
                        key={r.id}
                        data-testid="audit-row"
                        className="border-b last:border-0 hover:bg-muted/30 cursor-pointer focus:outline-none focus:bg-muted/40"
                        tabIndex={0}
                        role="button"
                        aria-label={tr("openDetails")}
                        onClick={() => setSelectedId(r.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSelectedId(r.id);
                          }
                        }}
                      >
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

      <AuditDetailsDialog
        open={entryId != null}
        row={selectedRow}
        loading={entryId != null && !inListEntry && standaloneLoading}
        error={standaloneError as Error | null}
        entryId={entryId}
        onClose={() => setSelectedId(null)}
        isRtl={isRtl}
        locale={locale}
        tr={tr}
        trAction={trAction}
      />
    </div>
  );
}

function AuditDetailsDialog({
  open,
  row,
  loading,
  error,
  entryId,
  onClose,
  isRtl,
  locale,
  tr,
  trAction,
}: {
  open: boolean;
  row: AuditRow | null;
  loading: boolean;
  error: Error | null;
  entryId: number | null;
  onClose: () => void;
  isRtl: boolean;
  locale: string;
  tr: (k: string, opts?: any) => string;
  trAction: (a: string) => string;
}) {
  // Metadata can be any JSON shape — usually an object for our writers, but
  // we don't want to silently drop primitives (string/number/array) if a
  // future caller stores one. Treat "no metadata" as null/undefined or an
  // empty object/array; everything else gets pretty-printed via
  // JSON.stringify so the reviewer sees the raw payload regardless of shape.
  const rawMeta = row?.metadata;
  const isEmptyMeta =
    rawMeta == null ||
    (typeof rawMeta === "object" &&
      !Array.isArray(rawMeta) &&
      Object.keys(rawMeta as Record<string, unknown>).length === 0) ||
    (Array.isArray(rawMeta) && rawMeta.length === 0);
  const prettyMeta = !isEmptyMeta ? JSON.stringify(rawMeta, null, 2) : null;

  const ok = row?.statusCode != null && row.statusCode >= 200 && row.statusCode < 400;

  // Build the copyable request path string (method + path) so the inline
  // copy button next to the field grabs the same text the user sees.
  const pathCopyValue = row
    ? [row.method, row.path].filter((v) => v != null && v !== "").join(" ").trim()
    : "";

  // Permanent share link to this entry. We rebuild it from `window.location`
  // so it always reflects the live origin (development domain, deployed
  // domain, etc.) and includes the artifact's base path. Only the `entry`
  // query param is preserved — other listing filters are intentionally
  // dropped so the link reliably opens the same entry regardless of who
  // clicks it. Computed lazily inside the click handler so SSR / non-browser
  // contexts don't break component rendering.
  const buildShareLink = () => {
    if (entryId == null || typeof window === "undefined") return "";
    const { origin, pathname } = window.location;
    return `${origin}${pathname}?entry=${entryId}`;
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        dir={isRtl ? "rtl" : "ltr"}
        data-testid="audit-details-dialog"
        className="max-w-2xl max-h-[85vh] overflow-y-auto"
      >
        <DialogHeader className={isRtl ? "text-right sm:text-right" : undefined}>
          <DialogTitle className="flex items-center gap-2">
            <ScrollText className="h-5 w-5 text-primary" />
            {tr("detailsTitle")}
          </DialogTitle>
          <DialogDescription>
            {row ? (
              <span className="font-mono text-xs">
                {new Date(row.createdAt).toLocaleString(locale, { hour12: false })}
                {" · "}
                {trAction(row.action)}
                {row.module ? ` · ${row.module}` : ""}
              </span>
            ) : loading ? (
              <span className="text-xs text-muted-foreground">{tr("loadingEntry")}</span>
            ) : error ? (
              <span className="text-xs text-rose-600">{tr("loadEntryFailed")}</span>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {/* Loading / error states for the permalink fetch — we never block
            the listing UI, just the dialog body. */}
        {!row && loading && (
          <div className="py-8 flex justify-center" data-testid="audit-details-loading">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        )}
        {!row && !loading && error && (
          <div
            className="py-8 text-center text-rose-600 flex flex-col items-center gap-2"
            data-testid="audit-details-error"
          >
            <ShieldAlert className="h-8 w-8" />
            <span className="text-sm">{tr("loadEntryFailed")}</span>
            {entryId != null && (
              <span className="text-xs text-muted-foreground font-mono">#{entryId}</span>
            )}
          </div>
        )}

        {row && (
          <div className="space-y-4 text-sm">
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
              <DetailField label={tr("detailsUser")}>
                <span className="font-medium">{row.username ?? "—"}</span>
                {row.role && (
                  <span className="text-[10px] text-muted-foreground ms-1">({row.role})</span>
                )}
              </DetailField>
              <DetailField label={tr("detailsIp")}>
                <span className="font-mono text-xs">{row.ip ?? "—"}</span>
              </DetailField>
              <DetailField label={tr("detailsEntityType")}>
                <span className="font-mono text-xs">{row.entityType ?? "—"}</span>
              </DetailField>
              <DetailField label={tr("detailsEntityId")}>
                <div className="flex items-start gap-1.5">
                  <span className="font-mono text-xs break-all flex-1">{row.entityId ?? "—"}</span>
                  {row.entityId && (
                    <CopyIconButton
                      value={row.entityId}
                      label={tr("copyEntityId")}
                      tr={tr}
                      testId="audit-details-copy-entity-id"
                    />
                  )}
                </div>
              </DetailField>
              <DetailField label={tr("detailsStatusCode")}>
                {row.statusCode != null ? (
                  <span
                    data-testid="audit-details-status"
                    className={`font-mono text-xs ${ok ? "text-emerald-600" : "text-rose-600"}`}
                  >
                    {row.statusCode}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </DetailField>
              <DetailField label={tr("detailsPath")}>
                <div className="flex items-start gap-1.5">
                  <span className="font-mono text-xs break-all flex-1">
                    {row.method ? <span className="text-foreground/70">{row.method} </span> : null}
                    {row.path ?? "—"}
                  </span>
                  {pathCopyValue && (
                    <CopyIconButton
                      value={pathCopyValue}
                      label={tr("copyPath")}
                      tr={tr}
                      testId="audit-details-copy-path"
                    />
                  )}
                </div>
              </DetailField>
              <DetailField label={tr("detailsUserAgent")} fullWidth>
                <div className="flex items-start gap-1.5">
                  <span
                    data-testid="audit-details-user-agent"
                    className="font-mono text-xs break-all text-muted-foreground flex-1"
                  >
                    {row.userAgent ?? "—"}
                  </span>
                  {row.userAgent && (
                    <CopyIconButton
                      value={row.userAgent}
                      label={tr("copyUserAgent")}
                      tr={tr}
                      testId="audit-details-copy-user-agent"
                    />
                  )}
                </div>
              </DetailField>
            </dl>

            {row.action === "export_csv" ? (
              <ExportInspectorBody row={row} tr={tr} locale={locale} />
            ) : (
              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="text-xs font-medium text-muted-foreground">
                    {tr("detailsMetadata")}
                  </div>
                  {prettyMeta && (
                    <CopyIconButton
                      value={prettyMeta}
                      label={tr("copyMetadata")}
                      tr={tr}
                      testId="audit-details-copy-metadata"
                      showText
                    />
                  )}
                </div>
                {prettyMeta ? (
                  <pre
                    dir="ltr"
                    data-testid="audit-details-metadata"
                    className="text-xs font-mono bg-muted/40 border rounded p-3 overflow-x-auto whitespace-pre-wrap break-all max-h-80 overflow-y-auto"
                  >
                    {prettyMeta}
                  </pre>
                ) : (
                  <div className="text-xs text-muted-foreground italic">
                    {tr("detailsMetadataEmpty")}
                  </div>
                )}
              </div>
            )}

            {/* Permanent share link (task #126) — shows the full URL so the
                reviewer can spot-check it visually before sharing, with an
                inline copy button that puts the same string on the
                clipboard. The whole row is selectable text too, so a
                manual copy is always possible if the clipboard API is
                blocked. */}
            <div data-testid="audit-details-share">
              <div className="text-xs font-medium text-muted-foreground mb-1">
                {tr("detailsShareLink")}
              </div>
              <div className="flex items-start gap-1.5 bg-muted/40 border rounded p-2">
                <Link2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                <span
                  dir="ltr"
                  data-testid="audit-details-share-link"
                  className="font-mono text-xs break-all flex-1 select-all"
                >
                  {buildShareLink()}
                </span>
                <CopyIconButton
                  value={buildShareLink()}
                  label={tr("copyShareLink")}
                  tr={tr}
                  testId="audit-details-copy-share-link"
                  showText
                />
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// Friendly inspector for `action === "export_csv"` audit rows. Mirrors the
// maintenance-history inspector on /admin/ai-fix (task #122) so power users
// see the same metric grid (count / total / cap), truncation pill, and
// labelled filters list regardless of which surface they are reviewing
// from. Anything outside the documented metadata shape is still surfaced —
// pretty-printed in an "extras" pre block — so we never silently drop
// fields a future writer attaches.
function ExportInspectorBody({
  row,
  tr,
  locale,
}: {
  row: AuditRow;
  tr: (k: string, opts?: any) => string;
  locale: string;
}) {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const truncated = meta.truncated === true;
  const count = typeof meta.count === "number" ? meta.count : null;
  const totalAvailable =
    typeof meta.totalAvailable === "number" ? meta.totalAvailable : null;
  const rowCap = typeof meta.rowCap === "number" ? meta.rowCap : null;
  const format = typeof meta.format === "string" ? meta.format : null;
  const filters =
    meta.filters && typeof meta.filters === "object" && !Array.isArray(meta.filters)
      ? (meta.filters as Record<string, unknown>)
      : null;

  const wellKnown = new Set([
    "truncated", "count", "totalAvailable", "rowCap", "format", "filters",
  ]);
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!wellKnown.has(k)) extras[k] = v;
  }
  const hasExtras = Object.keys(extras).length > 0;

  const fmt = (n: number) => n.toLocaleString(locale);

  // Resolve known maintenance-history action / entityType values to the
  // friendly translated label; fall back to the raw machine value if no
  // translation key is registered. Keeps the inspector forward-compatible
  // — a new writer that introduces a fresh action/entityType will appear
  // immediately, just without a localised label.
  const resolveAction = (v: string) =>
    tr(`historyActions.${v}`, { defaultValue: v });
  const resolveEntityType = (v: string) =>
    tr(`historyEntityTypes.${v}`, { defaultValue: v });

  return (
    <div className="space-y-4 text-sm" data-testid="audit-details-export-inspector">
      <div className="flex flex-wrap items-center gap-2">
        {truncated ? (
          <span
            data-testid="audit-details-export-truncated-pill"
            className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800"
          >
            <Scissors className="h-3 w-3" />
            <span>{tr("exportTruncatedPill")}</span>
            {rowCap != null && totalAvailable != null && (
              <span className="font-mono text-[10px] opacity-80">
                {tr("exportTruncatedRows", {
                  cap: fmt(rowCap),
                  total: fmt(totalAvailable),
                })}
              </span>
            )}
          </span>
        ) : (
          <span
            data-testid="audit-details-export-full-pill"
            className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800"
          >
            <CheckCircle2 className="h-3 w-3" />
            <span>{tr("exportFullPill")}</span>
          </span>
        )}
        {format && (
          <span className="inline-flex items-center rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-mono uppercase text-slate-700">
            {format}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <FileSearch className="h-3.5 w-3.5" />
        <span>{tr("exportInspectorTitle")}</span>
      </div>

      <dl
        data-testid="audit-details-export-metrics"
        className="grid grid-cols-1 sm:grid-cols-3 gap-3"
      >
        <div className="border rounded p-2 bg-muted/20">
          <dt className="text-[11px] text-muted-foreground">{tr("exportMetricCount")}</dt>
          <dd className="font-mono text-base text-foreground">
            {count != null ? fmt(count) : "—"}
          </dd>
        </div>
        <div className="border rounded p-2 bg-muted/20">
          <dt className="text-[11px] text-muted-foreground">{tr("exportMetricTotalAvailable")}</dt>
          <dd className="font-mono text-base text-foreground">
            {totalAvailable != null ? fmt(totalAvailable) : "—"}
          </dd>
        </div>
        <div className="border rounded p-2 bg-muted/20">
          <dt className="text-[11px] text-muted-foreground">{tr("exportMetricRowCap")}</dt>
          <dd className="font-mono text-base text-foreground">
            {rowCap != null ? fmt(rowCap) : "—"}
          </dd>
        </div>
      </dl>

      <div data-testid="audit-details-export-filters">
        <div className="text-xs font-medium text-muted-foreground mb-1">
          {tr("exportFiltersTitle")}
        </div>
        {!filters || Object.values(filters).every((v) => v == null) ? (
          <p className="text-xs italic text-muted-foreground">
            {tr("exportFiltersEmpty")}
          </p>
        ) : (
          <ul className="text-xs space-y-1">
            {Object.entries(filters).map(([k, v]) => {
              if (v == null) return null;
              let label = k;
              if (k === "from") label = tr("exportFilterFrom");
              else if (k === "to") label = tr("exportFilterTo");
              else if (k === "action") label = tr("exportFilterAction");
              else if (k === "entityType") label = tr("exportFilterEntityType");
              let display = String(v);
              if (k === "action" && typeof v === "string") {
                display = resolveAction(v);
              } else if (k === "entityType" && typeof v === "string") {
                display = resolveEntityType(v);
              }
              return (
                <li key={k} className="flex items-center gap-2">
                  <span className="text-muted-foreground">{label}:</span>
                  <span className="font-mono">{display}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {hasExtras && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">
            {tr("exportExtras")}
          </div>
          <pre
            dir="ltr"
            data-testid="audit-details-export-extras"
            className="text-xs font-mono bg-muted/40 border rounded p-3 overflow-x-auto whitespace-pre-wrap break-all max-h-60 overflow-y-auto"
          >
            {JSON.stringify(extras, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function DetailField({
  label,
  children,
  fullWidth = false,
}: {
  label: string;
  children: React.ReactNode;
  fullWidth?: boolean;
}) {
  return (
    <div className={fullWidth ? "sm:col-span-2" : undefined}>
      <dt className="text-xs font-medium text-muted-foreground mb-0.5">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// Small reusable copy-to-clipboard button used inside the audit details
// dialog (metadata JSON, entityId, userAgent, request path). It briefly
// swaps the icon to a check after a successful copy and surfaces a toast
// either way so the reviewer always gets confirmation.
//
// `showText` renders a textual "Copy" label next to the icon (used on the
// metadata panel header where there's room); the inline buttons next to
// long fields stay icon-only to keep the layout compact. The component
// uses logical sizing/flex so it aligns correctly in both LTR and RTL —
// the parent container's `dir` attribute already mirrors the row.
function CopyIconButton({
  value,
  label,
  tr,
  testId,
  showText = false,
}: {
  value: string;
  label: string;
  tr: (k: string, opts?: any) => string;
  testId?: string;
  showText?: boolean;
}) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = async () => {
    // Prefer the async Clipboard API; fall back to a hidden textarea +
    // execCommand for older / insecure-context browsers so the button still
    // works during local development over plain HTTP.
    let ok = false;
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === "function"
      ) {
        await navigator.clipboard.writeText(value);
        ok = true;
      } else if (typeof document !== "undefined") {
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.setAttribute("readonly", "");
        ta.style.position = "absolute";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      }
    } catch {
      ok = false;
    }

    if (ok) {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
      toast({
        title: tr("copySuccessTitle"),
        description: label,
      });
    } else {
      toast({
        title: tr("copyFailureTitle"),
        description: tr("copyFailureDescription"),
        variant: "destructive",
      });
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={handleCopy}
      aria-label={label}
      title={label}
      data-testid={testId}
      className={`h-7 ${showText ? "px-2" : "w-7 p-0"} shrink-0`}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-600" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      {showText && (
        <span className="ms-1 text-xs">
          {copied ? tr("copiedLabel") : tr("copyLabel")}
        </span>
      )}
    </Button>
  );
}
