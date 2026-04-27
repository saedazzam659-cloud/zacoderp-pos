import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import {
  ShieldAlert, Plus, Search, Trash2, Pencil, RefreshCw, Filter, Camera,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectTrigger, SelectContent, SelectItem, SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  securityEventsApi, mediaUrl,
  type SecurityEvent, type SecurityEventsFilter,
} from "@/lib/securityEventsApi";
import SecurityEventForm from "./SecurityEventForm";

const SEVERITY_TONE: Record<string, string> = {
  low:      "bg-slate-100 text-slate-800 border-slate-200",
  medium:   "bg-amber-100 text-amber-900 border-amber-200",
  high:     "bg-orange-100 text-orange-900 border-orange-200",
  critical: "bg-rose-100 text-rose-900 border-rose-200",
};
const STATUS_TONE: Record<string, string> = {
  open:           "bg-rose-100 text-rose-800 border-rose-200",
  investigating:  "bg-amber-100 text-amber-900 border-amber-200",
  closed:         "bg-emerald-100 text-emerald-900 border-emerald-200",
  false_positive: "bg-slate-100 text-slate-700 border-slate-200",
};

const TYPES = [
  "intrusion", "theft", "suspicious_movement", "unknown_person",
  "after_hours_presence", "missing_item", "unusual_gathering",
  "tampering", "other",
];
const SEVERITIES = ["low", "medium", "high", "critical"];
const STATUSES = ["open", "investigating", "closed", "false_positive"];

function fmtDate(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleString("ar-SA", { dateStyle: "short", timeStyle: "short" });
}

export default function SecurityEvents() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [location] = useLocation();

  // Read ?status=… from URL once on mount so SecurityHub tile links land
  // pre-filtered (open / investigating / closed).
  const initialStatus = useMemo(() => {
    const idx = location.indexOf("?");
    if (idx < 0) return "";
    const q = new URLSearchParams(location.slice(idx + 1));
    return q.get("status") ?? "";
  }, [location]);

  const [filter, setFilter] = useState<SecurityEventsFilter>({
    status: initialStatus || undefined,
  });
  const [editing, setEditing] = useState<SecurityEvent | null>(null);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const eventsQ = useQuery({
    queryKey: ["security-events", filter],
    queryFn: () => securityEventsApi.list(filter),
  });

  const removeM = useMutation({
    mutationFn: (id: number) => securityEventsApi.remove(id),
    onSuccess: () => {
      toast({ title: t("security.toast.deleted") });
      qc.invalidateQueries({ queryKey: ["security-events"] });
    },
    onError: (e: any) => toast({ title: t("common.error"), description: e?.message, variant: "destructive" }),
  });

  function applySearch() {
    setFilter(f => ({ ...f, search: search.trim() || undefined }));
  }

  return (
    <div className="space-y-4" data-testid="security-events-page">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-rose-600" />
            {t("security.eventsTitle")}
          </CardTitle>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => eventsQ.refetch()} data-testid="btn-refresh-events">
              <RefreshCw className="h-4 w-4 me-1" />
              {t("common.refresh")}
            </Button>
            <Button size="sm" onClick={() => setCreating(true)} data-testid="btn-new-security-event">
              <Plus className="h-4 w-4 me-1" />
              {t("security.newEvent")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Filters */}
          <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
            <div className="md:col-span-2 flex gap-2">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("security.searchPlaceholder")}
                onKeyDown={(e) => e.key === "Enter" && applySearch()}
                data-testid="input-search-events"
              />
              <Button variant="secondary" size="icon" onClick={applySearch} data-testid="btn-apply-search">
                <Search className="h-4 w-4" />
              </Button>
            </div>
            <Select value={filter.status ?? "all"} onValueChange={(v) => setFilter(f => ({ ...f, status: v === "all" ? undefined : v }))}>
              <SelectTrigger data-testid="select-filter-status"><SelectValue placeholder={t("security.filter.status")} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("security.filter.allStatuses")}</SelectItem>
                {STATUSES.map(s => <SelectItem key={s} value={s}>{t(`security.status.${s}`)}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={filter.severity ?? "all"} onValueChange={(v) => setFilter(f => ({ ...f, severity: v === "all" ? undefined : v }))}>
              <SelectTrigger data-testid="select-filter-severity"><SelectValue placeholder={t("security.filter.severity")} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("security.filter.allSeverities")}</SelectItem>
                {SEVERITIES.map(s => <SelectItem key={s} value={s}>{t(`security.severity.${s}`)}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={filter.type ?? "all"} onValueChange={(v) => setFilter(f => ({ ...f, type: v === "all" ? undefined : v }))}>
              <SelectTrigger data-testid="select-filter-type"><SelectValue placeholder={t("security.filter.type")} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("security.filter.allTypes")}</SelectItem>
                {TYPES.map(s => <SelectItem key={s} value={s}>{t(`security.type.${s}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {/* List */}
          {eventsQ.isLoading && <div className="text-sm text-muted-foreground">{t("common.loading")}</div>}
          {eventsQ.isError && <div className="text-sm text-rose-600">{t("common.error")}</div>}
          {eventsQ.data && eventsQ.data.length === 0 && (
            <div className="text-center py-8 text-sm text-muted-foreground">
              <Filter className="h-8 w-8 mx-auto mb-2 opacity-40" />
              {t("security.empty")}
            </div>
          )}
          {eventsQ.data && eventsQ.data.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-right text-xs text-muted-foreground border-b">
                  <tr>
                    <th className="py-2 px-2 w-14">{t("security.col.preview")}</th>
                    <th className="py-2 px-2">{t("security.col.dateTime")}</th>
                    <th className="py-2 px-2">{t("security.col.title")}</th>
                    <th className="py-2 px-2">{t("security.col.type")}</th>
                    <th className="py-2 px-2">{t("security.col.severity")}</th>
                    <th className="py-2 px-2">{t("security.col.status")}</th>
                    <th className="py-2 px-2">{t("security.col.location")}</th>
                    <th className="py-2 px-2">{t("security.col.assignedTo")}</th>
                    <th className="py-2 px-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {eventsQ.data.map(ev => (
                    <tr key={ev.id} className="border-b hover:bg-slate-50/60" data-testid={`row-event-${ev.id}`}>
                      <td className="py-2 px-2">
                        {ev.imageUrl ? (
                          <button
                            type="button"
                            onClick={() => setLightboxUrl(ev.imageUrl)}
                            className="block w-10 h-10 rounded border bg-muted overflow-hidden hover-elevate"
                            title={t("security.col.viewPreview")}
                            data-testid={`btn-thumb-event-${ev.id}`}
                          >
                            <img
                              src={mediaUrl(ev.imageUrl)}
                              alt=""
                              className="w-full h-full object-cover"
                            />
                          </button>
                        ) : (
                          <div className="w-10 h-10 rounded border bg-muted/40 grid place-items-center">
                            <Camera className="h-4 w-4 text-muted-foreground/40" />
                          </div>
                        )}
                      </td>
                      <td className="py-2 px-2 whitespace-nowrap text-xs">{fmtDate(ev.eventDateTime)}</td>
                      <td className="py-2 px-2 font-medium">{ev.title}</td>
                      <td className="py-2 px-2 text-xs">{t(`security.type.${ev.eventType}`, ev.eventType)}</td>
                      <td className="py-2 px-2">
                        <Badge variant="outline" className={SEVERITY_TONE[ev.severity] ?? ""}>
                          {t(`security.severity.${ev.severity}`, ev.severity)}
                        </Badge>
                      </td>
                      <td className="py-2 px-2">
                        <Badge variant="outline" className={STATUS_TONE[ev.status] ?? ""}>
                          {t(`security.status.${ev.status}`, ev.status)}
                        </Badge>
                      </td>
                      <td className="py-2 px-2 text-xs">
                        {ev.cameraLabel || ev.branchName || "—"}
                      </td>
                      <td className="py-2 px-2 text-xs">{ev.assignedToUsername ?? "—"}</td>
                      <td className="py-2 px-2 text-end">
                        <Button variant="ghost" size="icon" onClick={() => setEditing(ev)} data-testid={`btn-edit-event-${ev.id}`}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            if (confirm(t("security.confirmDelete"))) removeM.mutate(ev.id);
                          }}
                          data-testid={`btn-delete-event-${ev.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-rose-600" />
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

      {(creating || editing) && (
        <SecurityEventForm
          event={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            qc.invalidateQueries({ queryKey: ["security-events"] });
          }}
        />
      )}

      {lightboxUrl && (
        <Dialog open onOpenChange={(o) => { if (!o) setLightboxUrl(null); }}>
          <DialogContent className="max-w-4xl p-2 bg-black border-0">
            <img
              src={mediaUrl(lightboxUrl)}
              alt=""
              className="w-full h-auto max-h-[85vh] object-contain"
              data-testid="security-list-lightbox"
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
