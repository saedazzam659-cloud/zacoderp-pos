import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Badge } from "@/components/ui/badge";
import { Play, Pause, Square, Clock, ArrowDownToLine, ArrowUpFromLine, Activity, User, Cog, Save, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { usePermission } from "@/hooks/usePermission";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

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
  inputQty: number;
  outputQty: number;
  wasteQty: number;
  wasteReason: string;
  wasteType: string;
  wasteClassification: "normal" | "abnormal";
  workerUserId: string;
  machineId: string;
  notes: string;
};

export function ProductionStageExecution({ orderId, orderStatus, plannedQty, token, apiBase, permissionKey, isSimple, onReload }: StageExecutionProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const canEdit = usePermission(permissionKey as any, "edit");
  const [stages, setStages] = useState<Stage[]>([]);
  const [activeStage, setActiveStage] = useState<string | null>(null);
  const [users, setUsers] = useState<{value: string, label: string}[]>([]);
  const [machines, setMachines] = useState<{value: string, label: string}[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyStage, setBusyStage] = useState<string | null>(null);
  
  const isExecuting = ["in_production", "quality_check"].includes(orderStatus);

  const fetchStages = useCallback(async () => {
    if (!token) return;
    try {
      const response = await fetch(`${apiBase}/orders/${orderId}/stages`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        // Fallback: If there's no stages endpoint, the contract says they are in /orders/:id
        const orderRes = await fetch(`${apiBase}/orders/${orderId}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (orderRes.ok) {
          const j = await orderRes.json();
          setStages(mapStages(j.stages || []));
        }
        return;
      }
      const data = await response.json();
      setStages(mapStages(Array.isArray(data) ? data : data.stages || []));
    } catch (e) {
      console.error(e);
    }
  }, [apiBase, orderId, token]);

  const mapStages = (rawStages: any[]): Stage[] => {
    return rawStages.map(s => ({
      id: String(s.id),
      nameAr: s.nameAr || "مرحلة",
      status: s.status || "pending",
      actualDurationMinutes: Number(s.actualDurationMinutes || s.actualMinutes || 0),
      inputQty: Number(s.inputQty ?? plannedQty),
      outputQty: Number(s.outputQty ?? 0),
      wasteQty: Number(s.wasteQty ?? 0),
      wasteReason: s.wasteReason || "",
      wasteType: s.wasteType || "",
      wasteClassification: s.wasteClassification === "abnormal" ? "abnormal" : "normal",
      workerUserId: s.workerUserId ? String(s.workerUserId) : s.operatorUserId ? String(s.operatorUserId) : "",
      machineId: s.machineId ? String(s.machineId) : s.resourceId ? String(s.resourceId) : "",
      notes: s.notes || ""
    }));
  };

  const fetchLookups = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${apiBase}/execution-catalog`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        const workersList = Array.isArray(data.workers) ? data.workers : [];
        const machinesList = Array.isArray(data.machines) ? data.machines : [];
        
        setUsers(workersList.map((x: any) => ({ value: String(x.id), label: x.nameAr || x.nameEn || x.username || `User #${x.id}` })));
        setMachines(machinesList.map((x: any) => ({ value: String(x.id), label: x.name || `Machine #${x.id}` })));
      }
    } catch (e) {
      console.error(e);
    }
  }, [apiBase, token]);

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchStages(), fetchLookups()]).finally(() => setLoading(false));
  }, [fetchStages, fetchLookups]);

  useRefetchOnFocus(fetchStages);

  const handleUpdateStage = (id: string, updates: Partial<Stage>) => {
    setStages(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));
  };

  const sendStageAction = async (stageId: string, action: "start" | "complete" | "update", stageData: Stage) => {
    if (!canEdit || !isExecuting) return;
    setBusyStage(stageId);
    try {
      const payload = {
        actualDurationMinutes: stageData.actualDurationMinutes || 0,
        inputQty: stageData.inputQty || 0,
        outputQty: stageData.outputQty || 0,
        wasteQty: stageData.wasteQty || 0,
        workerUserId: stageData.workerUserId ? Number(stageData.workerUserId) : null,
        machineId: stageData.machineId ? Number(stageData.machineId) : null,
        wasteReason: stageData.wasteReason || null,
        wasteType: stageData.wasteType || null,
        wasteClassification: stageData.wasteClassification || "normal",
        notes: stageData.notes || null,
      };

      let url = `${API}/api/simple-manufacturing/orders/${orderId}/stages/${stageId}`;
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
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload)
      });
      
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      
      toast({ title: action === "update" ? "تم الحفظ" : action === "start" ? "تم بدء المرحلة" : "تم إنهاء المرحلة" });
      await fetchStages();
      if (onReload) onReload();
    } catch (e: any) {
      toast({ title: "خطأ", description: e.message, variant: "destructive" });
    } finally {
      setBusyStage(null);
    }
  };

  if (loading) return <div className="p-8 text-center text-slate-500">جاري التحميل...</div>;

  return (
    <div className="space-y-4">
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
              className="flex items-center justify-between p-4 bg-slate-50 cursor-pointer hover:bg-slate-100"
              onClick={() => setActiveStage(activeStage === stage.id ? null : stage.id)}
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
            {activeStage === stage.id && (
              <div className="p-4 border-t border-slate-100 grid md:grid-cols-2 gap-6 animate-in slide-in-from-top-2">
                
                <div className="space-y-4">
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
                    <Label className="text-xs text-slate-500 flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" /> المدة الفعلية (محرك التكلفة) - دقيقة</Label>
                    <Input type="number" value={stage.actualDurationMinutes} onChange={e => handleUpdateStage(stage.id, { actualDurationMinutes: Number(e.target.value) })} disabled={!isExecuting || !canEdit || (stage.status === "done" || stage.status === "skipped")} />
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
                    <div className="space-y-1.5">
                      <Label className="text-xs text-slate-500 flex items-center gap-1.5"><Cog className="h-3.5 w-3.5" /> الآلة / المركز</Label>
                      <SearchCombobox 
                        value={stage.machineId} 
                        onValueChange={(val) => handleUpdateStage(stage.id, { machineId: val })}
                        items={[{value: "", label: "غير محدد"}, ...machines]}
                        disabled={!isExecuting || !canEdit || (stage.status === "done" || stage.status === "skipped")}
                        placeholder="ابحث..."
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="rounded-lg border border-rose-100 bg-rose-50/30 p-3 space-y-3">
                    <div className="font-semibold text-sm text-rose-800 flex items-center gap-1.5">
                      <Activity className="h-4 w-4" /> تسجيل الهالك (هذه المرحلة)
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs">كمية الهالك</Label>
                        <Input type="number" step="0.01" value={stage.wasteQty} onChange={e => handleUpdateStage(stage.id, { wasteQty: Number(e.target.value) })} disabled={!isExecuting || !canEdit || (stage.status === "done" || stage.status === "skipped")} className="bg-white border-rose-200" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">التصنيف</Label>
                        <SearchCombobox 
                          value={stage.wasteClassification} 
                          onValueChange={(val: any) => handleUpdateStage(stage.id, { wasteClassification: val })} 
                          items={[
                            { value: "normal", label: "طبيعي (مخطط)" },
                            { value: "abnormal", label: "غير طبيعي (استثنائي)" }
                          ]}
                          disabled={!isExecuting || !canEdit || (stage.status === "done" || stage.status === "skipped")}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">النوع (كود/تصنيف فرعي)</Label>
                        <Input placeholder="مثال: تلف خام" value={stage.wasteType} onChange={e => handleUpdateStage(stage.id, { wasteType: e.target.value })} disabled={!isExecuting || !canEdit || (stage.status === "done" || stage.status === "skipped")} className="bg-white border-rose-200" />
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