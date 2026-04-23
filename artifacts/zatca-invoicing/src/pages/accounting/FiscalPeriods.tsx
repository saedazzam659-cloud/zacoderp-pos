import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useFormatters } from "@/lib/format";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { Plus, Pencil, Trash2, Calendar, Lock, Unlock, ShieldX, Clock, AlertCircle, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type FiscalYear = {
  id: number; companyId: number; name: string;
  startDate: string; endDate: string;
  periodCount: number; status: "open" | "closed" | "permanently_closed";
  createdAt: string;
};

type FiscalPeriod = {
  id: number; fiscalYearId: number; periodNumber: number;
  name: string; startDate: string; endDate: string;
  status: "open" | "closed" | "permanently_closed";
};

const EMPTY_YEAR = {
  name: "",
  startDate: new Date().toISOString().slice(0, 10),
  endDate: new Date(new Date().setFullYear(new Date().getFullYear() + 1) - 1).toISOString().slice(0, 10),
  periodCount: 12,
};

export default function FiscalPeriods() {
  const { user, token } = useAuth() as any;
  const { t } = useTranslation();
  const { isRtl } = useFormatters();
  const { toast } = useToast();
  const qc = useQueryClient();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const STATUS_CONFIG = {
    open: {
      label: t("fiscalPeriods.statusOpen"), color: "bg-green-50 text-green-700 border-green-200",
      icon: Unlock, dotColor: "bg-green-500",
    },
    closed: {
      label: t("fiscalPeriods.statusClosed"), color: "bg-amber-50 text-amber-700 border-amber-200",
      icon: Lock, dotColor: "bg-amber-500",
    },
    permanently_closed: {
      label: t("fiscalPeriods.statusPermClosed"), color: "bg-red-50 text-red-700 border-red-200",
      icon: ShieldX, dotColor: "bg-red-500",
    },
  } as const;

  const [showForm, setShowForm] = useState(false);
  const [yearForm, setYearForm] = useState(EMPTY_YEAR);
  const [selectedYearId, setSelectedYearId] = useState<number | null>(null);
  const [confirmDelId, setConfirmDelId] = useState<number | null>(null);

  const { data: years = [], isLoading: yearsLoading } = useQuery<FiscalYear[]>({
    queryKey: ["fiscal-years", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/fiscal/years?companyId=${cid}` : `${API}/api/fiscal/years`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      return r.ok ? r.json() : [];
    },
  });

  const { data: periods = [] } = useQuery<FiscalPeriod[]>({
    queryKey: ["fiscal-periods", selectedYearId],
    enabled: !!selectedYearId,
    queryFn: async () => {
      const r = await fetch(`${API}/api/fiscal/years/${selectedYearId}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return [];
      const d = await r.json();
      return d?.periods ?? [];
    },
  });

  const selectedYear = useMemo(() => years.find(y => y.id === selectedYearId) ?? null, [years, selectedYearId]);

  const periodStats = useMemo(() => {
    const open = periods.filter(p => p.status === "open").length;
    const closed = periods.filter(p => p.status === "closed").length;
    const perm = periods.filter(p => p.status === "permanently_closed").length;
    return { open, closed, perm };
  }, [periods]);

  const createYearMut = useMutation({
    mutationFn: async (data: typeof EMPTY_YEAR) => {
      const r = await fetch(`${API}/api/fiscal-years`, {
        method: "POST", headers, body: JSON.stringify({ ...data, companyId: cid }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || t("fiscalPeriods.createFailed"));
      return d;
    },
    onSuccess: (d: any) => {
      toast({
        title: t("fiscalPeriods.yearCreated"),
        description: t("fiscalPeriods.yearCreatedDesc", { count: d.year?.periodCount || yearForm.periodCount }),
      });
      qc.invalidateQueries({ queryKey: ["fiscal-years", cid] });
      setShowForm(false);
      setYearForm(EMPTY_YEAR);
      if (d.year?.id) setSelectedYearId(d.year.id);
    },
    onError: (e: any) => toast({ title: t("fiscalPeriods.error"), description: e.message, variant: "destructive" }),
  });

  const updatePeriodStatusMut = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      const r = await fetch(`${API}/api/fiscal-periods/${id}/status`, {
        method: "PATCH", headers, body: JSON.stringify({ status }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || t("fiscalPeriods.updateFailed"));
      return d;
    },
    onSuccess: () => {
      toast({ title: t("fiscalPeriods.periodStatusUpdated") });
      qc.invalidateQueries({ queryKey: ["fiscal-periods", selectedYearId] });
    },
    onError: (e: any) => toast({ title: t("fiscalPeriods.error"), description: e.message, variant: "destructive" }),
  });

  const updateYearStatusMut = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      const r = await fetch(`${API}/api/fiscal/years/${id}/status`, {
        method: "PATCH", headers, body: JSON.stringify({ status }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || t("fiscalPeriods.updateFailed"));
      return d;
    },
    onSuccess: () => {
      toast({ title: t("fiscalPeriods.yearStatusUpdated") });
      qc.invalidateQueries({ queryKey: ["fiscal-years", cid] });
      qc.invalidateQueries({ queryKey: ["fiscal-periods", selectedYearId] });
    },
    onError: (e: any) => toast({ title: t("fiscalPeriods.error"), description: e.message, variant: "destructive" }),
  });

  const delYearMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/fiscal-years/${id}`, { method: "DELETE", headers });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || t("fiscalPeriods.deleteFailed"));
      return d;
    },
    onSuccess: () => {
      toast({ title: t("fiscalPeriods.yearDeleted") });
      qc.invalidateQueries({ queryKey: ["fiscal-years", cid] });
      setSelectedYearId(null);
      setConfirmDelId(null);
    },
    onError: (e: any) => toast({ title: t("fiscalPeriods.error"), description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-xl bg-gradient-to-br from-violet-500 via-purple-500 to-fuchsia-500 text-white shadow-md">
            <Calendar className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{t("fiscalPeriods.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("fiscalPeriods.subtitle")}</p>
          </div>
        </div>
        <Button
          size="lg"
          onClick={() => { setYearForm(EMPTY_YEAR); setShowForm(true); }}
          className="gap-2 bg-gradient-to-l from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 shadow-md"
        >
          <Plus className="h-5 w-5" />
          {t("fiscalPeriods.newYear")}
        </Button>
      </div>

      {/* Year creation form */}
      {showForm && (
        <FormPanel
          icon={Sparkles}
          title={t("fiscalPeriods.newYearTitle")}
          subtitle={t("fiscalPeriods.autoSplitNote")}
          width="2xl"
          onClose={() => setShowForm(false)}
          onSave={() => createYearMut.mutate(yearForm)}
          saving={createYearMut.isPending}
          saveDisabled={!yearForm.name.trim()}
          saveLabel={t("fiscalPeriods.create")}
        >
          <FormGrid>
            <Field label={t("fiscalPeriods.fiscalYearName")} required className="md:col-span-2">
              <Input
                placeholder={t("fiscalPeriods.yearNamePlaceholder")}
                value={yearForm.name}
                onChange={(e) => setYearForm(p => ({ ...p, name: e.target.value }))}
              />
            </Field>
            <Field label={t("fiscalPeriods.startDate")} required>
              <Input type="date" value={yearForm.startDate} onChange={(e) => setYearForm(p => ({ ...p, startDate: e.target.value }))} />
            </Field>
            <Field label={t("fiscalPeriods.endDate")} required>
              <Input type="date" value={yearForm.endDate} onChange={(e) => setYearForm(p => ({ ...p, endDate: e.target.value }))} />
            </Field>
            <Field label={t("fiscalPeriods.monthlyPeriodsCount")} className="md:col-span-2">
              <div className="flex gap-2">
                <Input
                  type="number" min={1} max={24}
                  value={yearForm.periodCount}
                  onChange={(e) => setYearForm(p => ({ ...p, periodCount: parseInt(e.target.value) || 12 }))}
                  className="w-32"
                />
                <span className="text-sm text-muted-foreground self-center">{t("fiscalPeriods.periodWord")}</span>
              </div>
            </Field>
          </FormGrid>
          <div className={cn("rounded-md p-3 mt-3 flex gap-2 text-xs text-violet-800 bg-violet-50 border border-violet-200")}>
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <p>{t("fiscalPeriods.autoSplitNote")}</p>
          </div>
        </FormPanel>
      )}

      {/* Years grid + Periods detail */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left: Years list */}
        <div className="space-y-3">
          <div className="text-sm font-semibold text-muted-foreground">{t("fiscalPeriods.fiscalYears")}</div>
          {yearsLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}
            </div>
          ) : years.length === 0 ? (
            <Card className="p-6 text-center">
              <Calendar className="h-10 w-10 mx-auto mb-2 opacity-20" />
              <p className="text-sm font-semibold mb-1">{t("fiscalPeriods.noYears")}</p>
              <p className="text-xs text-muted-foreground mb-3">{t("fiscalPeriods.noYearsHint")}</p>
              <Button size="sm" variant="outline" onClick={() => { setYearForm(EMPTY_YEAR); setShowForm(true); }}>
                <Plus className={cn("h-4 w-4", isRtl ? "ml-1" : "mr-1")} />{t("fiscalPeriods.createYear")}
              </Button>
            </Card>
          ) : (
            <div className="space-y-2">
              {years.map(y => {
                const cfg = STATUS_CONFIG[y.status];
                const Icon = cfg.icon;
                const isSelected = y.id === selectedYearId;
                return (
                  <Card
                    key={y.id}
                    onClick={() => setSelectedYearId(y.id)}
                    className={cn(
                      "cursor-pointer transition-all hover:shadow-md",
                      isSelected && "ring-2 ring-violet-500 shadow-md",
                    )}
                  >
                    <CardContent className="p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={cn("h-2 w-2 rounded-full", cfg.dotColor)} />
                            <span className="font-semibold text-sm truncate">{y.name}</span>
                          </div>
                          <div className="text-[11px] text-muted-foreground space-y-0.5">
                            <div className="flex items-center gap-1">
                              <Calendar className="h-3 w-3" />
                              <span dir="ltr">{y.startDate}</span>
                              <span>—</span>
                              <span dir="ltr">{y.endDate}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              <span>{y.periodCount} {t("fiscalPeriods.periodWord")}</span>
                            </div>
                          </div>
                        </div>
                        <Badge variant="outline" className={cn("text-[10px] flex-shrink-0", cfg.color)}>
                          <Icon className={cn("h-2.5 w-2.5", isRtl ? "ml-0.5" : "mr-0.5")} />
                          {cfg.label}
                        </Badge>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: selected year details */}
        <div className="lg:col-span-2 space-y-3">
          {!selectedYear ? (
            <Card className="p-12 text-center text-muted-foreground">
              <Calendar className="h-16 w-16 mx-auto mb-3 opacity-10" />
              <p className="text-sm">{t("fiscalPeriods.fiscalYearWord")}</p>
            </Card>
          ) : (
            <>
              {/* Year actions */}
              <Card className="border-violet-200 bg-gradient-to-bl from-violet-50/40 to-transparent">
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div>
                      <h3 className="text-base font-bold">{selectedYear.name}</h3>
                      <p className="text-xs text-muted-foreground">
                        <span dir="ltr">{selectedYear.startDate}</span> — <span dir="ltr">{selectedYear.endDate}</span>
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {selectedYear.status === "open" && (
                        <Button size="sm" variant="outline"
                          onClick={() => updateYearStatusMut.mutate({ id: selectedYear.id, status: "closed" })}
                          className="text-amber-700 border-amber-300 hover:bg-amber-50">
                          <Lock className={cn("h-3.5 w-3.5", isRtl ? "ml-1" : "mr-1")} />{t("fiscalPeriods.closeYear")}
                        </Button>
                      )}
                      {selectedYear.status === "closed" && (
                        <>
                          <Button size="sm" variant="outline"
                            onClick={() => updateYearStatusMut.mutate({ id: selectedYear.id, status: "open" })}
                            className="text-green-700 border-green-300 hover:bg-green-50">
                            <Unlock className={cn("h-3.5 w-3.5", isRtl ? "ml-1" : "mr-1")} />{t("fiscalPeriods.reopenYear")}
                          </Button>
                          <Button size="sm" variant="outline"
                            onClick={() => updateYearStatusMut.mutate({ id: selectedYear.id, status: "permanently_closed" })}
                            className="text-red-700 border-red-300 hover:bg-red-50">
                            <ShieldX className={cn("h-3.5 w-3.5", isRtl ? "ml-1" : "mr-1")} />{t("fiscalPeriods.permanentlyClose")}
                          </Button>
                        </>
                      )}

                      {confirmDelId === selectedYear.id ? (
                        <div className="flex items-center gap-1 bg-red-50 border border-red-300 rounded-md px-2 py-1">
                          <span className="text-[10px] text-red-700 font-medium">{t("fiscalPeriods.confirmDelete")}</span>
                          <Button size="sm" variant="ghost" onClick={() => setConfirmDelId(null)} className="h-6 px-2 text-[10px]">{t("fiscalPeriods.cancel")}</Button>
                          <Button size="sm" variant="destructive" onClick={() => delYearMut.mutate(selectedYear.id)} className="h-6 px-2 text-[10px]">{t("fiscalPeriods.confirmShort")}</Button>
                        </div>
                      ) : (
                        <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-50" onClick={() => setConfirmDelId(selectedYear.id)}>
                          <Trash2 className={cn("h-3.5 w-3.5", isRtl ? "ml-1" : "mr-1")} />{t("fiscalPeriods.deleteYear")}
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Period stats */}
                  <div className="grid grid-cols-3 gap-2">
                    <div className="rounded-md bg-green-50 border border-green-200 p-2 text-center">
                      <div className="text-lg font-bold text-green-700">{periodStats.open}</div>
                      <div className="text-[10px] text-green-600">{t("fiscalPeriods.openPeriods")}</div>
                    </div>
                    <div className="rounded-md bg-amber-50 border border-amber-200 p-2 text-center">
                      <div className="text-lg font-bold text-amber-700">{periodStats.closed}</div>
                      <div className="text-[10px] text-amber-600">{t("fiscalPeriods.closedPeriods")}</div>
                    </div>
                    <div className="rounded-md bg-red-50 border border-red-200 p-2 text-center">
                      <div className="text-lg font-bold text-red-700">{periodStats.perm}</div>
                      <div className="text-[10px] text-red-600">{t("fiscalPeriods.permClosedPeriods")}</div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Periods list */}
              <Card>
                <CardContent className="p-0">
                  <div className="p-3 border-b bg-muted/30 flex items-center gap-2">
                    <Calendar className="h-4 w-4 text-violet-600" />
                    <span className="text-sm font-semibold">{t("fiscalPeriods.monthlyPeriods")}</span>
                    <Badge variant="secondary" className="text-[10px]">{periods.length}</Badge>
                  </div>
                  <div className="divide-y">
                    {periods.length === 0 ? (
                      <div className="p-6 text-center text-sm text-muted-foreground">{t("fiscalPeriods.noEntriesInPeriod")}</div>
                    ) : periods.map(p => {
                      const cfg = STATUS_CONFIG[p.status];
                      const Icon = cfg.icon;
                      const editable = p.status !== "permanently_closed" && selectedYear.status !== "permanently_closed";
                      return (
                        <div key={p.id} className="flex items-center gap-3 p-3 hover:bg-muted/30">
                          <div className={cn("h-8 w-8 rounded-lg flex items-center justify-center text-xs font-bold", cfg.color)}>
                            {p.periodNumber}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-semibold truncate">{p.name}</div>
                            <div className="text-[11px] text-muted-foreground">
                              <span dir="ltr">{p.startDate}</span> — <span dir="ltr">{p.endDate}</span>
                            </div>
                          </div>
                          <Badge variant="outline" className={cn("text-[10px]", cfg.color)}>
                            <Icon className={cn("h-2.5 w-2.5", isRtl ? "ml-0.5" : "mr-0.5")} />
                            {cfg.label}
                          </Badge>
                          {editable ? (
                            <div className="flex items-center gap-1">
                              {p.status === "open" && (
                                <Button size="sm" variant="ghost" className="h-7 px-2 text-amber-700"
                                  onClick={() => updatePeriodStatusMut.mutate({ id: p.id, status: "closed" })}>
                                  <Lock className="h-3 w-3" />
                                  <span className={cn("text-[10px]", isRtl ? "mr-1" : "ml-1")}>{t("fiscalPeriods.closePeriod")}</span>
                                </Button>
                              )}
                              {p.status === "closed" && (
                                <>
                                  <Button size="sm" variant="ghost" className="h-7 px-2 text-green-700"
                                    onClick={() => updatePeriodStatusMut.mutate({ id: p.id, status: "open" })}>
                                    <Unlock className="h-3 w-3" />
                                    <span className={cn("text-[10px]", isRtl ? "mr-1" : "ml-1")}>{t("fiscalPeriods.reopenPeriod")}</span>
                                  </Button>
                                  <Button size="sm" variant="ghost" className="h-7 px-2 text-red-700"
                                    onClick={() => updatePeriodStatusMut.mutate({ id: p.id, status: "permanently_closed" })}>
                                    <ShieldX className="h-3 w-3" />
                                    <span className={cn("text-[10px]", isRtl ? "mr-1" : "ml-1")}>{t("fiscalPeriods.permanentlyClosePeriod")}</span>
                                  </Button>
                                </>
                              )}
                            </div>
                          ) : (
                            <span className="text-[10px] text-muted-foreground italic">{t("fiscalPeriods.cannotEditPeriod")}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
