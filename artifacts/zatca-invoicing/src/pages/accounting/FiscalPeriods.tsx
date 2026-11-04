import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useFormatters } from "@/lib/format";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { usePermission } from "@/hooks/usePermission";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { Plus, Pencil, Trash2, Calendar, Lock, Unlock, ShieldX, Clock, AlertCircle, Sparkles, ShieldCheck } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { PeriodClosingWizard } from "./PeriodClosingWizard";
import { DateField } from "@/components/ui/date-field";

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

type OpeningBalanceDifference = {
  accountId: number;
  accountCode: string;
  accountName: string;
  priorClosingBalance: number;
  successorOpeningBalance: number;
  difference: number;
};

type NegativeStockYearEndRow = {
  itemId: number;
  itemCode: string | null;
  itemNameAr: string | null;
  itemNameEn: string | null;
  warehouseId: number;
  warehouseNameAr: string | null;
  warehouseNameEn: string | null;
  negativeQuantity: number;
};

const EMPTY_YEAR = {
  name: "",
  startDate: `${new Date().getUTCFullYear()}-01-01`,
  endDate: `${new Date().getUTCFullYear()}-12-31`,
  periodCount: 12,
};

function successorRange(endDate: string) {
  const [year, month, day] = endDate.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, day + 1));
  const nextYear = year + 1;
  const endDay = Math.min(day, new Date(Date.UTC(nextYear, month, 0)).getUTCDate());
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: `${nextYear}-${String(month).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`,
  };
}

export default function FiscalPeriods() {
  const { user, token, actingCompanyId } = useAuth() as any;
  const { t } = useTranslation();
  const { isRtl } = useFormatters();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const canCreatePurchaseInvoice = usePermission("purchase_invoices", "create");
  const todayIso = new Date().toISOString().slice(0, 10);
  // For a SuperAdmin we have no own company. Use the impersonated tenant's
  // id (set via the "دخول إلى الشركة" flow) so this page operates on the
  // company the SA is currently fixing. This page uses raw fetch() and so
  // does NOT pick up the global x-acting-company-id header injection — we
  // pass `?companyId=` explicitly instead.
  const cid = user?.role === "superadmin"
    ? (actingCompanyId ?? undefined)
    : user?.company?.id;
  // Headers used by every raw-fetch call on this page. We attach
  // `x-acting-company-id` as a defensive backup so the request still
  // resolves to the impersonated tenant even if `cid` is somehow falsy
  // (e.g. cache / hydration race) and the `?companyId=` query param is
  // missing. The server validates the role before honouring this header.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (user?.role === "superadmin" && actingCompanyId) {
    headers["x-acting-company-id"] = String(actingCompanyId);
  }

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
  const [closingPeriod, setClosingPeriod] = useState<FiscalPeriod | null>(null);
  const [openingBalanceDifferences, setOpeningBalanceDifferences] = useState<OpeningBalanceDifference[]>([]);
  const [closePreviousOnly, setClosePreviousOnly] = useState(false);
  const [sequenceNumberingPolicy, setSequenceNumberingPolicy] = useState<"continue" | "reset" | null>(null);

  const { data: years = [], isLoading: yearsLoading } = useQuery<FiscalYear[]>({
    queryKey: ["fiscal-years", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/fiscal/years?companyId=${cid}` : `${API}/api/fiscal/years`;
      const r = await fetch(url, { headers });
      return r.ok ? r.json() : [];
    },
  });

  const { data: yearPolicy } = useQuery<{ mode: "calendar" | "custom"; startDate: string; endDate: string }>({
    queryKey: ["fiscal-year-policy", cid],
    enabled: !!cid,
    queryFn: async () => {
      const r = await fetch(`${API}/api/fiscal/year-policy?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("تعذر تحميل سياسة السنة المالية");
      return r.json();
    },
  });

  const { data: periods = [] } = useQuery<FiscalPeriod[]>({
    queryKey: ["fiscal-periods", selectedYearId],
    enabled: !!selectedYearId,
    queryFn: async () => {
      const r = await fetch(`${API}/api/fiscal/years/${selectedYearId}`, { headers });
      if (!r.ok) return [];
      const d = await r.json();
      return d?.periods ?? [];
    },
  });

  const negativeStockQ = useQuery<{
    asOf: string;
    count: number;
    totalNegativeQuantity: number;
    items: NegativeStockYearEndRow[];
  }>({
    queryKey: ["fiscal-year-negative-stock", selectedYearId],
    enabled: !!selectedYearId && !!token,
    queryFn: async () => {
      const r = await fetch(`${API}/api/fiscal/years/${selectedYearId}/negative-stock?companyId=${cid}`, { headers });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || "تعذر فحص أرصدة المخزون");
      return data;
    },
  });

  const selectedYear = useMemo(() => years.find(y => y.id === selectedYearId) ?? null, [years, selectedYearId]);
  const openSuccessor = useMemo(() => {
    if (!selectedYear || selectedYear.status !== "closed") return null;
    const range = successorRange(selectedYear.endDate);
    return years.find(year =>
      year.startDate === range.startDate &&
      year.endDate === range.endDate &&
      year.status === "open",
    ) ?? null;
  }, [selectedYear, years]);
  useEffect(() => {
    setClosePreviousOnly(false);
    setSequenceNumberingPolicy(null);
  }, [selectedYearId]);
  const openYearForm = () => {
    if (yearPolicy?.mode === "custom" && yearPolicy.startDate && yearPolicy.endDate) {
      setYearForm({
        name: `السنة المالية ${yearPolicy.startDate.slice(0, 4)}`,
        startDate: yearPolicy.startDate,
        endDate: yearPolicy.endDate,
        periodCount: 12,
      });
    } else {
      setYearForm(EMPTY_YEAR);
    }
    setShowForm(true);
  };

  const periodStats = useMemo(() => {
    const open = periods.filter(p => p.status === "open").length;
    const closed = periods.filter(p => p.status === "closed").length;
    const perm = periods.filter(p => p.status === "permanently_closed").length;
    return { open, closed, perm };
  }, [periods]);

  const safeJson = async (r: Response, fallbackMsg: string) => {
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      if (!r.ok) throw new Error(`${fallbackMsg} (HTTP ${r.status})`);
      return {};
    }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d as any)?.error || fallbackMsg);
    return d;
  };

  const createYearMut = useMutation({
    mutationFn: async (data: typeof EMPTY_YEAR) => {
      const r = await fetch(`${API}/api/fiscal/years`, {
        method: "POST", headers, body: JSON.stringify({ ...data, companyId: cid }),
      });
      return await safeJson(r, t("fiscalPeriods.createFailed"));
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
      const r = await fetch(`${API}/api/fiscal/periods/${id}/status`, {
        method: "PATCH", headers, body: JSON.stringify({ status }),
      });
      return await safeJson(r, t("fiscalPeriods.updateFailed"));
    },
    onSuccess: () => {
      toast({ title: t("fiscalPeriods.periodStatusUpdated") });
      qc.invalidateQueries({ queryKey: ["fiscal-periods", selectedYearId] });
    },
    onError: (e: any) => toast({ title: t("fiscalPeriods.error"), description: e.message, variant: "destructive" }),
  });

  const updateYearStatusMut = useMutation({
    mutationFn: async ({ id, status, closePreviousOnly: closeOnly = false, sequenceNumberingPolicy: policy }: {
      id: number; status: string; closePreviousOnly?: boolean; sequenceNumberingPolicy?: "continue" | "reset" | null;
    }) => {
      const r = await fetch(`${API}/api/fiscal/years/${id}/status`, {
        method: "PATCH", headers, body: JSON.stringify({
          status,
          ...(closeOnly ? { closePreviousOnly: true } : {}),
          ...(!closeOnly && policy ? { sequenceNumberingPolicy: policy } : {}),
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const error = new Error(data?.error || t("fiscalPeriods.updateFailed")) as Error & {
          openingBalanceDifferences?: OpeningBalanceDifference[];
          negativeStockItems?: NegativeStockYearEndRow[];
          asOf?: string;
        };
        error.openingBalanceDifferences = data?.openingBalanceDifferences;
        error.negativeStockItems = data?.negativeStockItems;
        error.asOf = data?.asOf;
        throw error;
      }
      return data;
    },
    onSuccess: (d: any, variables: {
      id: number; status: string; closePreviousOnly?: boolean; sequenceNumberingPolicy?: "continue" | "reset" | null;
    }) => {
      setOpeningBalanceDifferences([]);
      if (variables.status === "permanently_closed" && d?.successorYear) {
        if (d.successorUnaffected) {
          toast({
            title: "تم إقفال السنة السابقة فقط",
            description: `تم الاحتفاظ بالسنة التالية «${d.successorYear.name}» دون تعديل أو إعادة مطابقة للأرصدة الافتتاحية.`,
          });
        } else {
          toast({
            title: "تم اعتماد إقفال السنة",
            description: `${d.successorYear.name} — ${d.successorYear.startDate} إلى ${d.successorYear.endDate} — ${d.successorCreated ? "تم إنشاؤها وفتحها" : "تم استخدام السنة المفتوحة الموجودة"}. الأرصدة مستمرة من الحركات السابقة دون إنشاء قيد افتتاحي مكرر.`,
          });
          setSelectedYearId(d.successorYear.id);
        }
      } else {
        toast({ title: t("fiscalPeriods.yearStatusUpdated") });
      }
      qc.invalidateQueries({ queryKey: ["fiscal-years", cid] });
      qc.invalidateQueries({ queryKey: ["fiscal-periods", selectedYearId] });
      if (d?.successorYear?.id && !d.successorUnaffected) {
        qc.invalidateQueries({ queryKey: ["fiscal-periods", d.successorYear.id] });
      }
    },
    onError: (e: any) => {
      if (Array.isArray(e?.openingBalanceDifferences)) {
        setOpeningBalanceDifferences(e.openingBalanceDifferences);
      }
      if (Array.isArray(e?.negativeStockItems)) {
        qc.setQueryData(
          ["fiscal-year-negative-stock", selectedYearId],
          {
            asOf: e.asOf ?? selectedYear?.endDate ?? "",
            count: e.negativeStockItems.length,
            totalNegativeQuantity: e.negativeStockItems.reduce(
              (sum: number, row: NegativeStockYearEndRow) => sum + row.negativeQuantity,
              0,
            ),
            items: e.negativeStockItems,
          },
        );
      }
      toast({ title: t("fiscalPeriods.error"), description: e.message, variant: "destructive" });
    },
  });

  // SuperAdmin-only recovery for periods that were prematurely hard-closed
  // without the required closing entries. Calls the dedicated force-reopen
  // endpoint which requires a non-empty justification (logged on the server).
  const forceReopenMut = useMutation({
    mutationFn: async ({ id, reason }: { id: number; reason: string }) => {
      const r = await fetch(`${API}/api/fiscal/periods/${id}/force-reopen`, {
        method: "POST", headers, body: JSON.stringify({ reason }),
      });
      return await safeJson(r, "تعذر فك القفل النهائي");
    },
    onSuccess: () => {
      toast({
        title: "تم فك القفل النهائي",
        description: "الفترة مفتوحة الآن — أعد تشغيل خطوات الإقفال بالترتيب الصحيح",
      });
      qc.invalidateQueries({ queryKey: ["fiscal-periods", selectedYearId] });
      qc.invalidateQueries({ queryKey: ["fiscal-years", cid] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const delYearMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/fiscal/years/${id}`, { method: "DELETE", headers });
      return await safeJson(r, t("fiscalPeriods.deleteFailed"));
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
          onClick={openYearForm}
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
           saveDisabled={!yearForm.name.trim() || yearForm.startDate > todayIso}
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
              <DateField value={yearForm.startDate} onChange={(e) => setYearForm(p => ({ ...p, startDate: e.target.value }))} />
            </Field>
            <Field label={t("fiscalPeriods.endDate")} required>
              <DateField value={yearForm.endDate} onChange={(e) => setYearForm(p => ({ ...p, endDate: e.target.value }))} />
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
            <div className="space-y-1">
              <p>{t("fiscalPeriods.autoSplitNote")}</p>
              <p>
                {isRtl
                  ? "يمكن إنشاء السنوات السابقة أو السنة الحالية يدويًا. لا يمكن إنشاء سنة مستقبلية؛ ستُفتح تلقائيًا بعد اعتماد إقفال السنة السابقة."
                  : "You can create past or current years manually. Future years open automatically after the prior year is finally approved and closed."}
              </p>
            </div>
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
              <Button size="sm" variant="outline" onClick={openYearForm}>
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
                    onClick={() => {
                      setSelectedYearId(y.id);
                      setOpeningBalanceDifferences([]);
                    }}
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
                            disabled={updateYearStatusMut.isPending || (!closePreviousOnly && !sequenceNumberingPolicy)}
                            onClick={() => {
                              const approved = window.confirm(
                                `اعتماد الإقفال النهائي للسنة «${selectedYear.name}»؟\n\n` +
                                (closePreviousOnly
                                  ? "سيُقفل العام السابق فقط. لن تُنشأ السنة التالية ولن يتم تعديلها أو إعادة ترحيل أرصدتها الافتتاحية. "
                                  : `سيُعاد فحص القيود والتسويات. عند النجاح ستُفتح السنة التالية مع ${sequenceNumberingPolicy === "continue" ? "استمرار أرقام المسلسلات الداخلية" : "بدء المسلسلات الداخلية من إعداداتها"}. `) +
                                (closePreviousOnly
                                  ? "لا يمكن التراجع عن الإقفال النهائي إلا بصلاحية استثنائية."
                                  : "الأرصدة تستمر من الحركات السابقة دون إنشاء قيد افتتاحي مكرر. لا يمكن التراجع عن الإقفال النهائي إلا بصلاحية استثنائية.")
                              );
                              if (approved) updateYearStatusMut.mutate({
                                id: selectedYear.id,
                                status: "permanently_closed",
                                closePreviousOnly,
                                sequenceNumberingPolicy,
                              });
                            }}
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
                  {openSuccessor && selectedYear.status === "closed" && (
                    <label className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50/70 p-3 text-sm cursor-pointer">
                      <Checkbox
                        checked={closePreviousOnly}
                        onCheckedChange={(checked) => setClosePreviousOnly(checked === true)}
                        aria-label="إقفال السنة السابقة فقط دون التأثير على السنة التالية"
                        className="mt-0.5"
                      />
                      <span>
                        <span className="font-medium text-blue-900">إقفال السنة السابقة فقط دون التأثير على السنة التالية</span>
                        <span className="block text-xs text-blue-800 mt-1">
                          السنة التالية «{openSuccessor.name}» موجودة ومفتوحة؛ عند التفعيل لن تُنشأ أو تُعدّل ولن تُراجع أرصدتها الافتتاحية.
                        </span>
                      </span>
                    </label>
                  )}
                  {selectedYear.status === "closed" && !closePreviousOnly && (
                    <fieldset className="rounded-md border border-violet-200 bg-white p-3">
                      <legend className="px-1 text-sm font-semibold">
                        طريقة تسلسل المستندات في السنة التالية
                      </legend>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <button type="button" aria-pressed={sequenceNumberingPolicy === "continue"}
                          onClick={() => setSequenceNumberingPolicy("continue")}
                          className={cn("rounded-md border p-3 text-start text-sm", sequenceNumberingPolicy === "continue" ? "border-violet-500 bg-violet-50 ring-1 ring-violet-300" : "border-slate-200 hover:bg-slate-50")}>
                          <span className="block font-medium">استمرار التسلسل</span>
                          <span className="mt-1 block text-xs text-muted-foreground">يكمل كل مسلسل داخلي من آخر رقم سابق.</span>
                        </button>
                        <button type="button" aria-pressed={sequenceNumberingPolicy === "reset"}
                          onClick={() => setSequenceNumberingPolicy("reset")}
                          className={cn("rounded-md border p-3 text-start text-sm", sequenceNumberingPolicy === "reset" ? "border-violet-500 bg-violet-50 ring-1 ring-violet-300" : "border-slate-200 hover:bg-slate-50")}>
                          <span className="block font-medium">تصفير التسلسل</span>
                          <span className="mt-1 block text-xs text-muted-foreground">يبدأ من أرقام البداية المضبوطة للشركة.</span>
                        </button>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        يسري الاختيار على المسلسلات الداخلية للسنة التالية فقط. لا يتغير أي رقم سابق أو تسلسل ZATCA و ICV/PIH.
                      </p>
                    </fieldset>
                  )}

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

              {selectedYear && (
                <Card className={cn(
                  "border",
                  negativeStockQ.data?.items.length
                    ? "border-amber-300 bg-amber-50/70"
                    : "border-slate-200",
                )}>
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="font-semibold">
                          {isRtl ? "فحص المخزون حتى نهاية السنة" : "Stock check through fiscal year-end"}
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {negativeStockQ.data
                            ? (isRtl
                              ? `تاريخ الفحص: ${negativeStockQ.data.asOf}`
                              : `Checked through ${negativeStockQ.data.asOf}`)
                            : (isRtl ? "جارٍ فحص حركات الأصناف والمخازن..." : "Checking item and warehouse movements...")}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={negativeStockQ.isFetching}
                        onClick={() => void negativeStockQ.refetch()}
                      >
                        {negativeStockQ.isFetching
                          ? (isRtl ? "جارٍ الفحص..." : "Checking...")
                          : (isRtl ? "إعادة الفحص" : "Run check again")}
                      </Button>
                    </div>

                    {negativeStockQ.isError && (
                      <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                        {negativeStockQ.error instanceof Error
                          ? negativeStockQ.error.message
                          : (isRtl ? "تعذر فحص المخزون؛ لن يُسمح بالإقفال دون نجاح الفحص." : "Stock check failed; closing remains blocked until it succeeds.")}
                      </p>
                    )}

                    {negativeStockQ.data?.items.length === 0 && (
                      <p className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800">
                        {isRtl
                          ? "لا توجد أرصدة سالبة حتى نهاية هذه السنة. سيعيد الخادم الفحص عند تنفيذ الإقفال."
                          : "No negative stock through year-end. The server checks again when closing."}
                      </p>
                    )}

                    {!!negativeStockQ.data?.items.length && (
                      <>
                        <p className="text-sm text-amber-900">
                          {isRtl
                            ? `يوجد ${negativeStockQ.data.count} صنف/مخزن يحتاج إلى تسوية. لن يتم الإقفال قبل تصحيح الأرصدة.`
                            : `${negativeStockQ.data.count} item/warehouse balance${negativeStockQ.data.count === 1 ? "" : "s"} need resolution. The year cannot close until corrected.`}
                        </p>
                        <div className="max-h-80 overflow-auto rounded-md border bg-white">
                          <table className="w-full text-xs text-start">
                            <thead className="sticky top-0 bg-amber-50 text-amber-950">
                              <tr>
                                <th className="px-2 py-2">{isRtl ? "الصنف" : "Item"}</th>
                                <th className="px-2 py-2">{isRtl ? "المخزن" : "Warehouse"}</th>
                                <th className="px-2 py-2">{isRtl ? "الكمية السالبة" : "Negative quantity"}</th>
                                <th className="px-2 py-2">{isRtl ? "الإجراء" : "Action"}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {negativeStockQ.data.items.map((row) => (
                                <tr key={`${row.itemId}:${row.warehouseId}`} className="border-t">
                                  <td className="px-2 py-2">
                                    <span className="font-mono">{row.itemCode || `#${row.itemId}`}</span>
                                    <span className="ms-2">{isRtl ? row.itemNameAr : (row.itemNameEn || row.itemNameAr)}</span>
                                  </td>
                                  <td className="px-2 py-2">{isRtl ? row.warehouseNameAr : (row.warehouseNameEn || row.warehouseNameAr)}</td>
                                  <td className="px-2 py-2 font-semibold tabular-nums" dir="ltr">
                                    -{row.negativeQuantity.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                                  </td>
                                  <td className="px-2 py-2">
                                    {canCreatePurchaseInvoice ? (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-7 whitespace-nowrap"
                                        onClick={() => {
                                          const params = new URLSearchParams({
                                            negativeStockItemId: String(row.itemId),
                                            negativeStockWarehouseId: String(row.warehouseId),
                                            negativeStockQty: String(row.negativeQuantity),
                                            negativeStockYearEnd: negativeStockQ.data?.asOf ?? selectedYear.endDate,
                                          });
                                          navigate(`/purchasing/invoices/new?${params.toString()}`);
                                        }}
                                      >
                                        {isRtl ? "إنشاء فاتورة شراء" : "New purchase invoice"}
                                      </Button>
                                    ) : (
                                      <span className="text-muted-foreground">
                                        {isRtl ? "لا توجد صلاحية إنشاء" : "Create permission required"}
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <p className="text-xs text-amber-900">
                          {isRtl
                            ? "تاريخ الفاتورة يجب أن يطابق تاريخ الشراء الحقيقي. الشراء بعد نهاية السنة لا يغيّر رصيد المخزون بتاريخ الإقفال. إذا كانت الفترة مغلقة، افتحها لإدخال فاتورة مستحقة ثم أعد الإقفال."
                            : "Use the actual purchase date. A later purchase does not change year-end stock. If its period is closed, reopen it to enter the due invoice, then close again."}
                        </p>
                      </>
                    )}
                  </CardContent>
                </Card>
              )}

              {openingBalanceDifferences.length > 0 && (
                <Card className="border-red-300 bg-red-50/70">
                  <CardContent className="p-4 space-y-3">
                    <div>
                      <h3 className="font-semibold text-red-800">
                        {isRtl ? "تم إيقاف الإقفال لوجود فروقات افتتاحية" : "Year close paused due to opening-balance differences"}
                      </h3>
                      <p className="text-xs text-red-700 mt-1">
                        {isRtl
                          ? "لم يتم تعديل أي قيد أو سنة. راجع الفروقات وسوِّها يدويًا ثم أعد اعتماد الإقفال."
                          : "No entry or fiscal year was changed. Review and resolve the differences, then retry final approval."}
                      </p>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs text-start">
                        <thead>
                          <tr className="border-b border-red-200 text-red-800">
                            <th className="py-2 px-2">{isRtl ? "الحساب" : "Account"}</th>
                            <th className="py-2 px-2">{isRtl ? "ختامي السنة السابقة" : "Prior closing"}</th>
                            <th className="py-2 px-2">{isRtl ? "افتتاحي السنة التالية" : "Successor opening"}</th>
                            <th className="py-2 px-2">{isRtl ? "الفرق" : "Difference"}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {openingBalanceDifferences.map(row => (
                            <tr key={row.accountId} className="border-b border-red-100">
                              <td className="py-2 px-2">
                                <span className="font-mono">{row.accountCode}</span>
                                <span className={cn("ms-2", "text-red-900")}>{row.accountName}</span>
                              </td>
                              <td className="py-2 px-2 tabular-nums" dir="ltr">{row.priorClosingBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                              <td className="py-2 px-2 tabular-nums" dir="ltr">{row.successorOpeningBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                              <td className="py-2 px-2 tabular-nums font-semibold" dir="ltr">{row.difference.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              )}

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
                              {/* Single entry point for closing — the wizard runs validation,
                                  posts the closing JEs (إيرادات/مصروفات → ملخص الأرباح
                                  والخسائر، ثم ترحيل لصافي الربح للأرباح المحتجزة) and finally
                                  calls /soft-close + /hard-close. Direct PATCH /status flips
                                  to closed/permanently_closed are blocked server-side because
                                  they were the source of "مغلقة نهائياً بدون قيود إقفال" bugs. */}
                              <Button size="sm" variant="ghost" className="h-7 px-2 text-violet-700"
                                onClick={() => setClosingPeriod(p)}
                                title="معالج الإقفال — يحقّق ويولّد قيود الإقفال ثم يقفل الفترة">
                                <ShieldCheck className="h-3 w-3" />
                                <span className={cn("text-[10px]", isRtl ? "mr-1" : "ml-1")}>
                                  {p.status === "open" ? "بدء الإقفال" : "متابعة الإقفال"}
                                </span>
                              </Button>
                              {p.status === "closed" && (
                                <Button size="sm" variant="ghost" className="h-7 px-2 text-green-700"
                                  onClick={() => updatePeriodStatusMut.mutate({ id: p.id, status: "open" })}>
                                  <Unlock className="h-3 w-3" />
                                  <span className={cn("text-[10px]", isRtl ? "mr-1" : "ml-1")}>{t("fiscalPeriods.reopenPeriod")}</span>
                                </Button>
                              )}
                            </div>
                          ) : (
                            <div className="flex items-center gap-1">
                              <span className="text-[10px] text-muted-foreground italic">{t("fiscalPeriods.cannotEditPeriod")}</span>
                              {/* SuperAdmin-only escape hatch: prematurely
                                  hard-closed periods (no closing entries
                                  generated) can be reopened with a
                                  justification logged on the server. */}
                              {user?.role === "superadmin" && p.status === "permanently_closed" && (
                                <Button size="sm" variant="ghost" className="h-7 px-2 text-orange-700"
                                  disabled={forceReopenMut.isPending}
                                  onClick={() => {
                                    const reason = window.prompt(
                                      "سبب فك القفل النهائي (10 أحرف على الأقل):\n" +
                                      "هذا الإجراء يخالف مبدأ تكامل البيانات المحاسبية ويُسجَّل في سجل التدقيق.",
                                      "إعادة تشغيل قيود الإقفال — لم تُولَّد عند الإقفال السابق"
                                    );
                                    if (reason && reason.trim().length >= 10) {
                                      forceReopenMut.mutate({ id: p.id, reason: reason.trim() });
                                    } else if (reason !== null) {
                                      toast({
                                        title: "السبب قصير جداً",
                                        description: "يجب أن يكون السبب 10 أحرف على الأقل",
                                        variant: "destructive",
                                      });
                                    }
                                  }}>
                                  <Unlock className="h-3 w-3" />
                                  <span className={cn("text-[10px]", isRtl ? "mr-1" : "ml-1")}>فك القفل (سوبر أدمن)</span>
                                </Button>
                              )}
                            </div>
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

      {closingPeriod && (
        <PeriodClosingWizard
          period={closingPeriod}
          onClose={() => setClosingPeriod(null)}
          onPeriodUpdated={() => {
            qc.invalidateQueries({ queryKey: ["fiscal-periods", selectedYearId] });
            qc.invalidateQueries({ queryKey: ["fiscal-years", cid] });
            setClosingPeriod(null);
          }}
        />
      )}
    </div>
  );
}
