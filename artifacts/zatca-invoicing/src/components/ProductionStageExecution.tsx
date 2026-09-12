import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";
import { useAuth } from "@/contexts/AuthContext";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Badge } from "@/components/ui/badge";
import { Play, Square, Clock, ArrowDownToLine, ArrowUpFromLine, Activity, User, Save, AlertTriangle, RotateCcw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { usePermission } from "@/hooks/usePermission";
import { ProductionResourcePicker, type ResourceCatalog } from "@/components/ProductionResourcePicker";
import { StageUnitSelector, type StageUnitCatalogOption } from "@/components/StageUnitSelector";

type StageExecutionProps = {
  orderId: number;
  orderStatus: string;
  plannedQty: string;
  token: string;
  apiBase: string;
  permissionKey: string;
  isSimple: boolean;
  onReload?: () => void;
};

type Stage = {
  id: string; // the integer id but as string for UI
  nameAr: string;
  status: "pending" | "in_progress" | "done" | "skipped";
  actualDurationMinutes: number;
  workerCount: number;
  inputQty: number;
  outputQty: number;
  quantityUnit: string | null;
  quantityUnitFactor: number;
  quantityUnitCustomMode: boolean;
  wasteQty: number;
  wasteUnit: string | null;
  wasteUnitFactor: number;
  wasteUnitCustomMode: boolean;
  wasteUnitExplicit: boolean;
  wasteReason: string;
  wasteType: string;
  wasteClassification: "normal" | "abnormal";
  workerUserId: string;
  machineId: string;
  workCenterId: string;
  notes: string;
};

export function ProductionStageExecution({ orderId, orderStatus, plannedQty, token, apiBase, permissionKey, isSimple, onReload }: StageExecutionProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { actingCompanyId } = useAuth();
  const headers = useMemo(() => ({
    Authorization: `Bearer ${token}`,
    ...(actingCompanyId ? { "x-acting-company-id": String(actingCompanyId) } : {}),
  }), [token, actingCompanyId]);
  const canEdit = usePermission(permissionKey as any, "edit");
  const canCreate = usePermission(permissionKey as any, "create");
  const [stages, setStages] = useState<Stage[]>([]);
  const [users, setUsers] = useState<{value: string, label: string}[]>([]);
  const [resourceCatalog, setResourceCatalog] = useState<ResourceCatalog>({ workCenters: [], machines: [], assets: [] });
  const [orderUnitCode, setOrderUnitCode] = useState("");
  const [unitCatalog, setUnitCatalog] = useState<StageUnitCatalogOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyStage, setBusyStage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const dirtyStages = useRef(new Set<string>());
  
  const isExecuting = ["in_production", "quality_check"].includes(orderStatus);

  const normalizeStageUnitFactor = (unit: string | null, factor: unknown): number => {
    // A null unit is the legacy/order unit, whose conversion is intrinsically
    // one. Explicit units never receive an invented kg/piece-style fallback.
    if (!unit) return 1;
    const parsed = Number(factor);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };

  const normalizeStageUnit = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed || null;
  };

  const fetchStages = useCallback(async (savedStageId?: string) => {
    if (!token) return;
    try {
      setLoadError(null);
      const response = await fetch(`${apiBase}/orders/${orderId}/stages`, {
        headers,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || "تعذر تحميل مراحل التنفيذ");
      }
      const data = await response.json();
      const rows = Array.isArray(data) ? data : (Array.isArray(data?.stages) ? data.stages : []);
      if (data && !Array.isArray(data)) {
        if (typeof data.orderUnitCode === "string") setOrderUnitCode(data.orderUnitCode.trim());
        if (Array.isArray(data.unitCatalog)) setUnitCatalog(data.unitCatalog);
      }
      const latest = mapStages(rows);
      if (savedStageId) dirtyStages.current.delete(savedStageId);
      setStages(previous => latest.map(stage => dirtyStages.current.has(stage.id)
        ? previous.find(row => row.id === stage.id) ?? stage : stage));
    } catch (e: any) {
      setLoadError(e.message || "تعذر تحميل مراحل التنفيذ");
    }
  }, [apiBase, orderId, headers]);

  const mapStages = (rawStages: any[]): Stage[] => {
    return rawStages.map(s => {
      const quantityUnit = normalizeStageUnit(s.quantityUnit);
      const quantityUnitFactor = normalizeStageUnitFactor(quantityUnit, s.quantityUnitFactor);
      const rawWasteUnit = normalizeStageUnit(s.wasteUnit);
      // Null is deliberately the order's base unit, never an alias for the
      // stage unit. A stage-unit inheritance choice is persisted as the
      // concrete unit and factor, so it will remain visible after reload.
      const wasteUnit = rawWasteUnit;
      const wasteUnitFactor = rawWasteUnit
        ? normalizeStageUnitFactor(rawWasteUnit, s.wasteUnitFactor)
        : 1;
      const wasteUnitExplicit = rawWasteUnit !== null;
      return {
      id: String(s.id),
      nameAr: s.nameAr || "مرحلة",
      status: s.status || "pending",
      actualDurationMinutes: Number(s.actualDurationMinutes || s.actualMinutes || 0),
      workerCount: Number(s.workerCount ?? 0),
      inputQty: Number(s.inputQty ?? plannedQty),
      outputQty: Number(s.outputQty ?? 0),
      quantityUnit,
      quantityUnitFactor,
      quantityUnitCustomMode: Boolean(quantityUnit && !/^[A-Za-z0-9._-]+$/.test(quantityUnit)),
      wasteQty: Number(s.wasteQty ?? 0),
      wasteUnit,
      wasteUnitFactor,
      wasteUnitCustomMode: Boolean(rawWasteUnit && !/^[A-Za-z0-9._-]+$/.test(rawWasteUnit)),
      wasteUnitExplicit,
      wasteReason: s.wasteReason || "",
      wasteType: s.wasteType || "",
      wasteClassification: s.wasteClassification === "abnormal" ? "abnormal" : "normal",
      workerUserId: s.workerUserId ? String(s.workerUserId) : s.operatorUserId ? String(s.operatorUserId) : "",
      machineId: s.machineId ? String(s.machineId) : s.resourceId ? String(s.resourceId) : "",
      workCenterId: s.workCenterId ? String(s.workCenterId) : "",
      notes: s.notes || ""
      };
    });
  };

  const fetchLookups = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${apiBase}/execution-catalog`, {
        headers,
      });
      if (res.ok) {
        const data = await res.json();
        const workersList = Array.isArray(data.workers) ? data.workers : [];
        
        setUsers(workersList.map((x: any) => ({ value: String(x.id), label: x.nameAr || x.nameEn || x.username || `User #${x.id}` })));
      } else {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || "تعذر تحميل قائمة العمال والآلات");
      }
      const resources = await fetch(`${apiBase}/orders/${orderId}/resource-catalog`, { headers });
      const catalog = await resources.json().catch(() => ({}));
      if (!resources.ok) throw new Error(catalog.error || "تعذر تحميل مراكز العمل والآلات");
      if (!Array.isArray(catalog.workCenters) || !Array.isArray(catalog.machines) || !Array.isArray(catalog.assets)) throw new Error("بيانات مراكز العمل والآلات غير صالحة");
      setResourceCatalog(catalog);
    } catch (e: any) {
      toast({ title: "تعذر تحميل قائمة العمال والآلات", description: e.message, variant: "destructive" });
    }
  }, [apiBase, orderId, headers]);

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchStages(), fetchLookups()]).finally(() => setLoading(false));
  }, [fetchStages, fetchLookups]);

  useRefetchOnFocus(useCallback(async () => {
    if (!busyStage) await fetchStages();
  }, [busyStage, fetchStages]));

  const handleUpdateStage = (id: string, updates: Partial<Stage>) => {
    dirtyStages.current.add(id);
    setStages(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));
  };

  const handleStageUnitChange = (
    id: string,
    kind: "quantity" | "waste",
    unit: string | null,
    factor: number,
    customMode: boolean,
  ) => {
    dirtyStages.current.add(id);
    setStages(prev => prev.map(stage => {
      if (stage.id !== id) return stage;
      if (kind === "waste") {
        return {
          ...stage,
          wasteUnit: unit,
          wasteUnitFactor: factor,
          wasteUnitCustomMode: customMode,
          wasteUnitExplicit: true,
        };
      }
      const next = {
        ...stage,
        quantityUnit: unit,
        quantityUnitFactor: factor,
        quantityUnitCustomMode: customMode,
      };
      // Waste follows the stage unit until the operator changes the waste
      // selector or its factor separately.
      if (!stage.wasteUnitExplicit) {
        next.wasteUnit = unit;
        next.wasteUnitFactor = factor;
        next.wasteUnitCustomMode = customMode;
      }
      return next;
    }));
  };

  const handleStageUnitFactorChange = (
    id: string,
    kind: "quantity" | "waste",
    factor: number,
  ) => {
    dirtyStages.current.add(id);
    setStages(prev => prev.map(stage => {
      if (stage.id !== id) return stage;
      if (kind === "waste") {
        return { ...stage, wasteUnitFactor: factor, wasteUnitExplicit: true };
      }
      const next = { ...stage, quantityUnitFactor: factor };
      if (!stage.wasteUnitExplicit) next.wasteUnitFactor = factor;
      return next;
    }));
  };

  const stageUnitIsValid = (unit: string | null, factor: number) =>
    (!unit || (Number.isFinite(factor) && factor > 0));

  const sendStageAction = async (stageId: string, action: "start" | "complete" | "update", stageData: Stage) => {
    if (!canEdit || !isExecuting) return;
    if (
      (stageData.quantityUnitCustomMode && !stageData.quantityUnit) ||
      (stageData.wasteUnitCustomMode && !stageData.wasteUnit) ||
      !stageUnitIsValid(stageData.quantityUnit, stageData.quantityUnitFactor) ||
      !stageUnitIsValid(stageData.wasteUnit, stageData.wasteUnitFactor)
    ) {
      toast({
        title: "معامل التحويل مطلوب",
        description: "أدخل معامل تحويل موجباً لكل وحدة مخصصة قبل حفظ المرحلة.",
        variant: "destructive",
      });
      return;
    }
    setBusyStage(stageId);
    try {
      const payload = {
        actualDurationMinutes: stageData.actualDurationMinutes || 0,
        workerCount: stageData.workerCount,
        inputQty: stageData.inputQty || 0,
        outputQty: stageData.outputQty || 0,
        quantityUnit: stageData.quantityUnit || null,
        quantityUnitFactor: stageData.quantityUnit ? stageData.quantityUnitFactor : 1,
        wasteQty: stageData.wasteQty || 0,
        wasteUnit: stageData.wasteUnit || null,
        wasteUnitFactor: stageData.wasteUnit ? stageData.wasteUnitFactor : 1,
        workerUserId: stageData.workerUserId ? Number(stageData.workerUserId) : null,
        machineId: stageData.machineId ? Number(stageData.machineId) : null,
        workCenterId: stageData.workCenterId ? Number(stageData.workCenterId) : null,
        wasteReason: stageData.wasteReason || null,
        wasteType: stageData.wasteType || null,
        wasteClassification: stageData.wasteClassification || "normal",
        notes: stageData.notes || null,
      };

      let url = `${apiBase}/orders/${orderId}/stages/${stageId}`;
      let method = "PATCH";
      
      if (action === "start") {
        url = `${url}/start`;
        method = "POST";
      } else if (action === "complete") {
        url = `${url}/complete`;
        method = "POST";
      }

      const res = await fetch(url, {
        method,
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      
      toast({ title: action === "update" ? "تم الحفظ" : action === "start" ? "تم بدء المرحلة" : "تم إنهاء المرحلة" });
      await fetchStages(stageId);
      if (onReload) onReload();
    } catch (e: any) {
      toast({ title: "خطأ", description: e.message, variant: "destructive" });
    } finally {
      setBusyStage(null);
    }
  };

  const reopenStage = async (stage: Stage) => {
    if (!canEdit || !isExecuting || !["done", "skipped"].includes(stage.status)) return;
    if (!window.confirm("ستُعاد المرحلة للتصحيح وقد تتأثر مراحل لاحقة. هل تريد إعادة فتحها؟")) return;
    setBusyStage(stage.id);
    try {
      const res = await fetch(`${apiBase}/orders/${orderId}/stages/${stage.id}/reopen`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);
      toast({ title: "تمت إعادة فتح المرحلة للتصحيح" });
      await fetchStages(stage.id);
      if (onReload) onReload();
    } catch (e: any) {
      toast({ title: "تعذر إعادة فتح المرحلة", description: e.message, variant: "destructive" });
    } finally {
      setBusyStage(null);
    }
  };

  if (loading) return <div className="p-8 text-center text-slate-500">جاري التحميل...</div>;

  return (
    <div className="space-y-4">
      {loadError && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-800">{loadError}<Button variant="outline" className="ms-3" onClick={() => void fetchStages()}>إعادة المحاولة</Button></div>}
      {!isExecuting && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          تنفيذ المراحل متاح فقط عندما يكون الأمر "قيد الإنتاج" أو "فحص الجودة".
        </div>
      )}

      {stages.length === 0 && (
        <div className="text-center p-8 border-2 border-dashed rounded-lg text-slate-500">
          لا توجد مراحل مسجلة لهذا الأمر. تأكد من أن قالب المسار يحتوي على مراحل.
        </div>
      )}

      <div className="grid gap-4">
        {stages.map((stage, idx) => (
          <div key={stage.id} className="rounded-xl border bg-white shadow-sm overflow-hidden transition-all">
            {/* Header */}
            <div 
              className="flex flex-wrap gap-3 items-center justify-between p-4 bg-slate-50"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-violet-100 text-violet-700 font-bold text-sm">
                  {idx + 1}
                </div>
                <div className="font-semibold text-slate-800">{stage.nameAr}</div>
                <Badge variant="outline" className={
                  stage.status === "done" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                  stage.status === "skipped" ? "bg-slate-50 text-slate-500 border-slate-200" :
                  stage.status === "in_progress" ? "bg-amber-50 text-amber-700 border-amber-200 animate-pulse" :
                  "bg-slate-100 text-slate-600 border-slate-200"
                }>
                  {stage.status === "pending" ? "قيد الانتظار" : 
                   stage.status === "in_progress" ? "جاري التنفيذ" : 
                   stage.status === "skipped" ? "تم التخطي" : "مكتمل"}
                </Badge>
              </div>
              <div className="flex gap-2">
                {(stage.status === "done" || stage.status === "skipped") && isExecuting && canEdit && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 bg-white border-amber-200 text-amber-700 hover:bg-amber-50"
                    disabled={busyStage === stage.id}
                    onClick={(e) => { e.stopPropagation(); void reopenStage(stage); }}
                    data-testid={`button-reopen-stage-${stage.id}`}
                  >
                    <RotateCcw className="h-3.5 w-3.5 me-1" /> إعادة فتح للتصحيح
                  </Button>
                )}
                {stage.status !== "done" && stage.status !== "skipped" && isExecuting && canEdit && (
                  <>
                    {(stage.status === "pending") && (
                      <Button 
                        size="sm" variant="outline" className="h-8 bg-white" 
                        disabled={busyStage === stage.id}
                        onClick={(e) => { e.stopPropagation(); sendStageAction(stage.id, "start", stage); }}
                      >
                        <Play className="h-3.5 w-3.5 me-1 text-amber-600" /> بدء
                      </Button>
                    )}
                    {stage.status === "in_progress" && (
                      <Button 
                        size="sm" variant="outline" className="h-8 bg-emerald-50 hover:bg-emerald-100 border-emerald-200 text-emerald-700" 
                        disabled={busyStage === stage.id}
                        onClick={(e) => { e.stopPropagation(); sendStageAction(stage.id, "complete", stage); }}
                      >
                        <Square className="h-3.5 w-3.5 me-1" /> إنهاء
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Body */}
            {(
              <div className="p-4 border-t border-slate-100 grid md:grid-cols-2 gap-6 animate-in slide-in-from-top-2">
                
                <div className="space-y-4">
                  <StageUnitSelector
                    value={stage.quantityUnit}
                    factor={stage.quantityUnitFactor}
                    baseUnit={orderUnitCode}
                    unitCatalog={unitCatalog}
                    amount={stage.inputQty}
                    label="وحدة كميات المرحلة"
                    kind="quantity"
                    stageId={stage.id}
                    customMode={stage.quantityUnitCustomMode}
                    onUnitChange={(unit, factor, customMode) => handleStageUnitChange(stage.id, "quantity", unit, factor, customMode)}
                    onFactorChange={factor => handleStageUnitFactorChange(stage.id, "quantity", factor)}
                    onCustomModeChange={customMode => handleUpdateStage(stage.id, { quantityUnitCustomMode: customMode })}
                    disabled={!isExecuting || !canEdit || stage.status === "done" || stage.status === "skipped" || busyStage === stage.id}
                  />
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs text-slate-500 flex items-center gap-1.5"><ArrowDownToLine className="h-3.5 w-3.5" /> الكمية المدخلة</Label>
                      <Input type="number" step="0.01" value={stage.inputQty} onChange={e => handleUpdateStage(stage.id, { inputQty: Number(e.target.value) })} disabled={!isExecuting || !canEdit || (stage.status === "done" || stage.status === "skipped")} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs text-slate-500 flex items-center gap-1.5"><ArrowUpFromLine className="h-3.5 w-3.5" /> الكمية المنتجة</Label>
                      <Input type="number" step="0.01" value={stage.outputQty} onChange={e => handleUpdateStage(stage.id, { outputQty: Number(e.target.value) })} disabled={!isExecuting || !canEdit || (stage.status === "done" || stage.status === "skipped")} />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs text-slate-500 flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" /> وقت العمل الفعلي (محرك تحميل، وليس مصروفًا جديدًا)</Label>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="text-xs">ساعات
                        <Input dir="ltr" inputMode="numeric" value={Math.floor(stage.actualDurationMinutes / 60)} onChange={e => handleUpdateStage(stage.id, { actualDurationMinutes: Math.max(0, Math.floor(Number(e.target.value) || 0)) * 60 + stage.actualDurationMinutes % 60 })} disabled={!isExecuting || !canEdit || stage.status === "done" || stage.status === "skipped"} />
                      </label>
                      <label className="text-xs">دقائق
                        <Input dir="ltr" inputMode="decimal" value={Number((stage.actualDurationMinutes % 60).toFixed(4))} onChange={e => handleUpdateStage(stage.id, { actualDurationMinutes: Math.floor(stage.actualDurationMinutes / 60) * 60 + Math.min(59.9999, Math.max(0, Number(e.target.value) || 0)) })} disabled={!isExecuting || !canEdit || stage.status === "done" || stage.status === "skipped"} />
                      </label>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">عدد العمالة المشاركة</Label>
                    <Input dir="ltr" inputMode="numeric" value={stage.workerCount} onChange={e => handleUpdateStage(stage.id, { workerCount: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} disabled={!isExecuting || !canEdit || stage.status === "done" || stage.status === "skipped"} />
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs text-slate-500 flex items-center gap-1.5"><User className="h-3.5 w-3.5" /> العامل</Label>
                      <SearchCombobox 
                        value={stage.workerUserId} 
                        onValueChange={(val) => handleUpdateStage(stage.id, { workerUserId: val })}
                        items={[{value: "", label: "غير محدد"}, ...users]}
                        disabled={!isExecuting || !canEdit || (stage.status === "done" || stage.status === "skipped")}
                        placeholder="ابحث..."
                      />
                    </div>
                  </div>
                  <ProductionResourcePicker
                    workCenterId={stage.workCenterId}
                    machineId={stage.machineId}
                    catalog={resourceCatalog}
                    disabled={!isExecuting || !canEdit || stage.status === "done" || stage.status === "skipped" || busyStage === stage.id}
                    canCreate={canCreate}
                    endpoint={`${apiBase}/orders/${orderId}`}
                    headers={headers}
                    onChange={values => handleUpdateStage(stage.id, values)}
                    onCreated={(kind, row) => setResourceCatalog(previous => kind === "work-centers"
                      ? { ...previous, workCenters: [...previous.workCenters.filter(x => x.id !== row.id), row] }
                      : { ...previous, machines: [...previous.machines.filter(x => x.id !== row.id), row] })}
                  />
                </div>

                <div className="space-y-4">
                  <div className="rounded-lg border border-rose-100 bg-rose-50/30 p-3 space-y-3">
                    <div className="font-semibold text-sm text-rose-800 flex items-center gap-1.5">
                      <Activity className="h-4 w-4" /> فاقد العملية (هذه المرحلة — لا ينشئ مصروفاً مستقلاً)
                    </div>
                    <StageUnitSelector
                      value={stage.wasteUnit}
                      factor={stage.wasteUnitFactor}
                      baseUnit={orderUnitCode}
                      unitCatalog={unitCatalog}
                      amount={stage.wasteQty}
                      label="وحدة كمية الهالك"
                      kind="waste"
                      stageId={stage.id}
                      customMode={stage.wasteUnitCustomMode}
                      onUnitChange={(unit, factor, customMode) => handleStageUnitChange(stage.id, "waste", unit, factor, customMode)}
                      onFactorChange={factor => handleStageUnitFactorChange(stage.id, "waste", factor)}
                      onCustomModeChange={customMode => handleUpdateStage(stage.id, { wasteUnitCustomMode: customMode, wasteUnitExplicit: true })}
                      disabled={!isExecuting || !canEdit || stage.status === "done" || stage.status === "skipped" || busyStage === stage.id}
                    />
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs">كمية الهالك</Label>
                        <Input type="number" step="0.01" value={stage.wasteQty} onChange={e => handleUpdateStage(stage.id, { wasteQty: Number(e.target.value) })} disabled={!isExecuting || !canEdit || (stage.status === "done" || stage.status === "skipped")} className="bg-white border-rose-200" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">طبيعي أم تالف</Label>
                        <SearchCombobox 
                          value={stage.wasteClassification} 
                          onValueChange={(val: any) => handleUpdateStage(stage.id, { wasteClassification: val })} 
                          items={[
                             { value: "normal", label: "فاقد طبيعي (مخطط — بلا مصروف مستقل)" },
                             { value: "abnormal", label: "تالف/فاقد غير طبيعي (استثنائي)" }
                          ]}
                          disabled={!isExecuting || !canEdit || (stage.status === "done" || stage.status === "skipped")}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">نوع الفاقد/التالف (wasteType)</Label>
                        <Input placeholder="مثال: تلف خام أو فاقد حراري" value={stage.wasteType} onChange={e => handleUpdateStage(stage.id, { wasteType: e.target.value })} disabled={!isExecuting || !canEdit || (stage.status === "done" || stage.status === "skipped")} className="bg-white border-rose-200" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">سبب الهالك</Label>
                        <Input placeholder="مثال: خطأ في الحرارة..." value={stage.wasteReason} onChange={e => handleUpdateStage(stage.id, { wasteReason: e.target.value })} disabled={!isExecuting || !canEdit || (stage.status === "done" || stage.status === "skipped")} className="bg-white border-rose-200" />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs text-slate-500">ملاحظات المرحلة</Label>
                    <Textarea 
                      rows={2} 
                      className="resize-none"
                      placeholder="أضف أي ملاحظات حول الأداء، الأعطال، إلخ..."
                      value={stage.notes}
                      onChange={e => handleUpdateStage(stage.id, { notes: e.target.value })}
                      disabled={!isExecuting || !canEdit || (stage.status === "done" || stage.status === "skipped")}
                    />
                  </div>
                </div>

                {isExecuting && canEdit && stage.status !== "done" && stage.status !== "skipped" && (
                  <div className="md:col-span-2 flex justify-end pt-2">
                    <Button 
                      disabled={busyStage === stage.id} 
                      onClick={() => sendStageAction(stage.id, "update", stage)} 
                      className="bg-violet-600 hover:bg-violet-700"
                    >
                      <Save className="h-4 w-4 me-2" /> حفظ بيانات المرحلة
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}