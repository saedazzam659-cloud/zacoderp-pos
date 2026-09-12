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
import { Play, Square, Clock, ArrowDownToLine, ArrowUpFromLine, Activity, User, Save, AlertTriangle, RotateCcw, Check, ChevronRight, ChevronLeft } from "lucide-react";
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
  
  const previousOrderId = useRef(orderId);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const isExecuting = ["in_production", "quality_check"].includes(orderStatus);

  useEffect(() => {
    if (previousOrderId.current !== orderId) {
      setActiveTabId(null);
      dirtyStages.current.clear();
      previousOrderId.current = orderId;
    }
  }, [orderId]);

  useEffect(() => {
    if (stages.length > 0 && !stages.some(s => s.id === activeTabId)) {
      const firstActive = stages.find(s => s.status === "in_progress") || stages.find(s => s.status === "pending") || stages[0];
      setActiveTabId(firstActive.id);
    }
  }, [stages, activeTabId]);

  const navigateToTab = (id: string, focusIdx?: number) => {
    if (activeTabId && activeTabId !== id && dirtyStages.current.has(activeTabId)) {
      if (!window.confirm("هناك تعديلات غير محفوظة في هذه المرحلة. هل تريد الانتقال؟ (ستبقى التعديلات كمسودة)")) {
        return;
      }
    }
    setActiveTabId(id);
    if (focusIdx !== undefined) {
      setTimeout(() => tabRefs.current[focusIdx]?.focus(), 0);
    }
  };

  const handleTabKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const dir = e.key === 'ArrowLeft' ? 1 : -1; // RTL: ArrowLeft = next
      const nextIdx = (idx + dir + stages.length) % stages.length;
      navigateToTab(stages[nextIdx].id, nextIdx);
    }
  };

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

      {stages.length > 0 && (
        <div className="flex flex-col rounded-xl border bg-white shadow-sm overflow-hidden transition-all">
          <div 
            className="flex border-b overflow-x-auto rtl:space-x-reverse hide-scrollbar bg-slate-50/50" 
            role="tablist" 
             aria-label="مراحل التصنيع"
            aria-orientation="horizontal"
          >
            {stages.map((stage, idx) => {
              const isActive = stage.id === activeTabId;
              const isDone = stage.status === "done";
              return (
                <button
                  key={stage.id}
                  ref={el => { tabRefs.current[idx] = el; }}
                  type="button"
                  role="tab"
                   id={`stage-tab-${orderId}-${stage.id}`}
                   aria-controls={`stage-panel-${orderId}-${stage.id}`}
                   tabIndex={isActive ? 0 : -1}
                  aria-selected={isActive}
                  onClick={() => navigateToTab(stage.id)}
                  onKeyDown={e => handleTabKeyDown(e, idx)}
                  className={`px-5 py-3.5 border-b-2 flex items-center gap-2.5 font-medium text-sm whitespace-nowrap transition-colors outline-none focus-visible:bg-slate-100 ${
                    isActive ? 'border-violet-600 text-violet-800 bg-white shadow-[0_-1px_0_0_inset_#e5e7eb] z-10' : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-100/70'
                  }`}
                >
                  <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${
                    isDone ? 'bg-emerald-100 text-emerald-700' : 
                    isActive ? 'bg-violet-600 text-white' : 
                    'bg-slate-200 text-slate-600'
                  }`}>
                    {isDone ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : (idx + 1)}
                  </span>
                  {stage.nameAr}
                   <span className={`text-[10px] rounded-full px-2 py-0.5 ${isDone ? "bg-emerald-50 text-emerald-700" : stage.status === "in_progress" ? "bg-amber-50 text-amber-800" : "bg-slate-100 text-slate-500"}`}>
                     {isDone ? "مكتملة" : stage.status === "in_progress" ? "قيد التنفيذ" : stage.status === "skipped" ? "تم التخطي" : "لم تبدأ"}
                   </span>
                  {dirtyStages.current.has(stage.id) && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 ms-0.5" title="تعديلات غير محفوظة"></span>}
                </button>
              );
            })}
          </div>

          {activeTabId && (
            (() => {
              const activeStage = stages.find(s => s.id === activeTabId);
              const currentIndex = stages.findIndex(s => s.id === activeTabId);
              if (!activeStage) return null;
              
              return (
                <div role="tabpanel" id={`stage-panel-${orderId}-${activeStage.id}`} aria-labelledby={`stage-tab-${orderId}-${activeStage.id}`} className="animate-in fade-in duration-200 motion-reduce:animate-none" key={activeStage.id}>
                  {/* Header */}
                  <div className="flex flex-wrap gap-3 items-center justify-between p-4 bg-white border-b border-slate-100">
                    <div className="flex items-center gap-3">
                      <div className="font-semibold text-slate-800 text-lg flex items-center gap-2">
                        {activeStage.nameAr}
                      </div>
                      <Badge variant="outline" className={
                        activeStage.status === "done" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                        activeStage.status === "skipped" ? "bg-slate-50 text-slate-500 border-slate-200" :
                        activeStage.status === "in_progress" ? "bg-amber-50 text-amber-700 border-amber-200 animate-pulse" :
                        "bg-slate-100 text-slate-600 border-slate-200"
                      }>
                        {activeStage.status === "pending" ? "قيد الانتظار" : 
                         activeStage.status === "in_progress" ? "جاري التنفيذ" : 
                         activeStage.status === "skipped" ? "تم التخطي" : "مكتمل"}
                      </Badge>
                    </div>
                    
                    <div className="flex gap-2">
                      {(activeStage.status === "done" || activeStage.status === "skipped") && isExecuting && canEdit && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 bg-white border-amber-200 text-amber-700 hover:bg-amber-50"
                          disabled={busyStage === activeStage.id}
                          onClick={() => void reopenStage(activeStage)}
                        >
                          <RotateCcw className="h-3.5 w-3.5 me-1" /> إعادة فتح للتصحيح
                        </Button>
                      )}
                      {activeStage.status !== "done" && activeStage.status !== "skipped" && isExecuting && canEdit && (
                        <>
                          {activeStage.status === "pending" && (
                            <Button 
                              size="sm" variant="outline" className="h-8 bg-white" 
                              disabled={busyStage === activeStage.id}
                              onClick={() => sendStageAction(activeStage.id, "start", activeStage)}
                            >
                              <Play className="h-3.5 w-3.5 me-1 text-amber-600" /> بدء التنفيذ
                            </Button>
                          )}
                          {activeStage.status === "in_progress" && (
                            <Button 
                              size="sm" variant="outline" className="h-8 bg-emerald-50 hover:bg-emerald-100 border-emerald-200 text-emerald-700" 
                              disabled={busyStage === activeStage.id}
                              onClick={() => sendStageAction(activeStage.id, "complete", activeStage)}
                            >
                              <Square className="h-3.5 w-3.5 me-1" /> إنهاء المرحلة
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                  
                  {/* Body */}
                  <div className="p-5 grid md:grid-cols-2 gap-8 bg-slate-50/30">
                    <div className="space-y-5">
                      <StageUnitSelector
                        value={activeStage.quantityUnit}
                        factor={activeStage.quantityUnitFactor}
                        baseUnit={orderUnitCode}
                        unitCatalog={unitCatalog}
                        amount={activeStage.inputQty}
                        label="وحدة كميات المرحلة"
                        kind="quantity"
                        stageId={activeStage.id}
                        customMode={activeStage.quantityUnitCustomMode}
                        onUnitChange={(unit, factor, customMode) => handleStageUnitChange(activeStage.id, "quantity", unit, factor, customMode)}
                        onFactorChange={factor => handleStageUnitFactorChange(activeStage.id, "quantity", factor)}
                        onCustomModeChange={customMode => handleUpdateStage(activeStage.id, { quantityUnitCustomMode: customMode })}
                        disabled={!isExecuting || !canEdit || activeStage.status === "done" || activeStage.status === "skipped" || busyStage === activeStage.id}
                      />
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                          <Label className="text-xs font-semibold text-slate-600 flex items-center gap-1.5"><ArrowDownToLine className="h-3.5 w-3.5 text-slate-400" /> الكمية المدخلة</Label>
                          <Input type="number" step="0.01" value={activeStage.inputQty} onChange={e => handleUpdateStage(activeStage.id, { inputQty: Number(e.target.value) })} disabled={!isExecuting || !canEdit || (activeStage.status === "done" || activeStage.status === "skipped")} className="bg-white border-slate-200 focus-visible:ring-violet-500" />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs font-semibold text-slate-600 flex items-center gap-1.5"><ArrowUpFromLine className="h-3.5 w-3.5 text-slate-400" /> الكمية المنتجة</Label>
                          <Input type="number" step="0.01" value={activeStage.outputQty} onChange={e => handleUpdateStage(activeStage.id, { outputQty: Number(e.target.value) })} disabled={!isExecuting || !canEdit || (activeStage.status === "done" || activeStage.status === "skipped")} className="bg-white border-slate-200 focus-visible:ring-violet-500" />
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <Label className="text-xs font-semibold text-slate-600 flex items-center gap-1.5"><Clock className="h-3.5 w-3.5 text-slate-400" /> وقت العمل الفعلي (محرك تحميل)</Label>
                        <div className="grid grid-cols-2 gap-3 bg-white p-2 border rounded-md shadow-sm">
                          <label className="text-xs font-medium text-slate-500">ساعات
                            <Input className="mt-1 bg-slate-50 border-slate-200" dir="ltr" inputMode="numeric" value={Math.floor(activeStage.actualDurationMinutes / 60)} onChange={e => handleUpdateStage(activeStage.id, { actualDurationMinutes: Math.max(0, Math.floor(Number(e.target.value) || 0)) * 60 + activeStage.actualDurationMinutes % 60 })} disabled={!isExecuting || !canEdit || activeStage.status === "done" || activeStage.status === "skipped"} />
                          </label>
                          <label className="text-xs font-medium text-slate-500">دقائق
                            <Input className="mt-1 bg-slate-50 border-slate-200" dir="ltr" inputMode="decimal" value={Number((activeStage.actualDurationMinutes % 60).toFixed(4))} onChange={e => handleUpdateStage(activeStage.id, { actualDurationMinutes: Math.floor(activeStage.actualDurationMinutes / 60) * 60 + Math.min(59.9999, Math.max(0, Number(e.target.value) || 0)) })} disabled={!isExecuting || !canEdit || activeStage.status === "done" || activeStage.status === "skipped"} />
                          </label>
                        </div>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                          <Label className="text-xs font-semibold text-slate-600">عدد العمالة المشاركة</Label>
                          <Input dir="ltr" inputMode="numeric" value={activeStage.workerCount} onChange={e => handleUpdateStage(activeStage.id, { workerCount: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} disabled={!isExecuting || !canEdit || activeStage.status === "done" || activeStage.status === "skipped"} className="bg-white" />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs font-semibold text-slate-600 flex items-center gap-1.5"><User className="h-3.5 w-3.5 text-slate-400" /> العامل</Label>
                          <SearchCombobox 
                            value={activeStage.workerUserId} 
                            onValueChange={(val) => handleUpdateStage(activeStage.id, { workerUserId: val })}
                            items={[{value: "", label: "غير محدد"}, ...users]}
                            disabled={!isExecuting || !canEdit || (activeStage.status === "done" || activeStage.status === "skipped")}
                            placeholder="ابحث..."
                          />
                        </div>
                      </div>
                      
                      <ProductionResourcePicker
                        workCenterId={activeStage.workCenterId}
                        machineId={activeStage.machineId}
                        catalog={resourceCatalog}
                        disabled={!isExecuting || !canEdit || activeStage.status === "done" || activeStage.status === "skipped" || busyStage === activeStage.id}
                        canCreate={canCreate}
                        endpoint={`${apiBase}/orders/${orderId}`}
                        headers={headers}
                        onChange={values => handleUpdateStage(activeStage.id, values)}
                        onCreated={(kind, row) => setResourceCatalog(previous => kind === "work-centers"
                          ? { ...previous, workCenters: [...previous.workCenters.filter(x => x.id !== row.id), row] }
                          : { ...previous, machines: [...previous.machines.filter(x => x.id !== row.id), row] })}
                      />
                    </div>

                    <div className="space-y-5">
                      <div className="rounded-xl border border-rose-100 bg-rose-50/40 p-4 space-y-4 shadow-sm">
                        <div className="font-bold text-sm text-rose-800 flex items-center gap-1.5 border-b border-rose-100 pb-2">
                          <Activity className="h-4 w-4" /> فاقد العملية (هذه المرحلة — لا ينشئ مصروفاً مستقلاً)
                        </div>
                        <StageUnitSelector
                          value={activeStage.wasteUnit}
                          factor={activeStage.wasteUnitFactor}
                          baseUnit={orderUnitCode}
                          unitCatalog={unitCatalog}
                          amount={activeStage.wasteQty}
                          label="وحدة كمية الهالك"
                          kind="waste"
                          stageId={activeStage.id}
                          customMode={activeStage.wasteUnitCustomMode}
                          onUnitChange={(unit, factor, customMode) => handleStageUnitChange(activeStage.id, "waste", unit, factor, customMode)}
                          onFactorChange={factor => handleStageUnitFactorChange(activeStage.id, "waste", factor)}
                          onCustomModeChange={customMode => handleUpdateStage(activeStage.id, { wasteUnitCustomMode: customMode, wasteUnitExplicit: true })}
                          disabled={!isExecuting || !canEdit || activeStage.status === "done" || activeStage.status === "skipped" || busyStage === activeStage.id}
                        />
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-1.5">
                            <Label className="text-xs font-semibold text-rose-900">كمية الهالك</Label>
                            <Input type="number" step="0.01" value={activeStage.wasteQty} onChange={e => handleUpdateStage(activeStage.id, { wasteQty: Number(e.target.value) })} disabled={!isExecuting || !canEdit || (activeStage.status === "done" || activeStage.status === "skipped")} className="bg-white border-rose-200 focus-visible:ring-rose-500" />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs font-semibold text-rose-900">طبيعي أم تالف</Label>
                            <SearchCombobox 
                              value={activeStage.wasteClassification} 
                              onValueChange={(val: any) => handleUpdateStage(activeStage.id, { wasteClassification: val })} 
                              items={[
                                 { value: "normal", label: "فاقد طبيعي (مخطط — بلا مصروف مستقل)" },
                                 { value: "abnormal", label: "تالف/فاقد غير طبيعي (استثنائي)" }
                              ]}
                              disabled={!isExecuting || !canEdit || (activeStage.status === "done" || activeStage.status === "skipped")}
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs font-semibold text-rose-900">نوع الفاقد (wasteType)</Label>
                            <Input placeholder="مثال: تلف خام أو فاقد حراري" value={activeStage.wasteType} onChange={e => handleUpdateStage(activeStage.id, { wasteType: e.target.value })} disabled={!isExecuting || !canEdit || (activeStage.status === "done" || activeStage.status === "skipped")} className="bg-white border-rose-200 focus-visible:ring-rose-500" />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs font-semibold text-rose-900">سبب الهالك</Label>
                            <Input placeholder="مثال: خطأ في الحرارة..." value={activeStage.wasteReason} onChange={e => handleUpdateStage(activeStage.id, { wasteReason: e.target.value })} disabled={!isExecuting || !canEdit || (activeStage.status === "done" || activeStage.status === "skipped")} className="bg-white border-rose-200 focus-visible:ring-rose-500" />
                          </div>
                        </div>
                      </div>

                      <div className="space-y-1.5 bg-white p-4 border rounded-xl shadow-sm">
                        <Label className="text-xs font-semibold text-slate-700">ملاحظات المرحلة</Label>
                        <Textarea 
                          rows={3} 
                          className="resize-none border-slate-200 bg-slate-50 focus-visible:bg-white transition-colors"
                          placeholder="أضف أي ملاحظات حول الأداء، الأعطال، إلخ..."
                          value={activeStage.notes}
                          onChange={e => handleUpdateStage(activeStage.id, { notes: e.target.value })}
                          disabled={!isExecuting || !canEdit || (activeStage.status === "done" || activeStage.status === "skipped")}
                        />
                      </div>
                    </div>

                    <div className="md:col-span-2 flex flex-wrap gap-3 items-center justify-between pt-5 border-t border-slate-200 mt-2">
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-9 bg-white shadow-sm hover:bg-slate-50"
                          disabled={currentIndex === 0}
                          onClick={() => navigateToTab(stages[currentIndex - 1].id)}
                        >
                          <ChevronRight className="h-4 w-4 ms-1" /> السابق
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-9 bg-white shadow-sm hover:bg-slate-50"
                          disabled={currentIndex === stages.length - 1}
                          onClick={() => navigateToTab(stages[currentIndex + 1].id)}
                        >
                          التالي <ChevronLeft className="h-4 w-4 me-1" />
                        </Button>
                      </div>

                      {isExecuting && canEdit && activeStage.status !== "done" && activeStage.status !== "skipped" && (
                        <Button 
                          disabled={busyStage === activeStage.id} 
                          onClick={() => sendStageAction(activeStage.id, "update", activeStage)} 
                          className="h-9 bg-violet-600 hover:bg-violet-700 shadow-sm px-5"
                        >
                          <Save className="h-4 w-4 me-2" /> حفظ مسودة المرحلة
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()
          )}
        </div>
      )}
    </div>
  );
}
