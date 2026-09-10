import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";
import { Link, useLocation } from "wouter";
import { Plus, Search, Factory, ArrowRight, X, ClipboardList, Boxes, Route, Cog, Calculator, CheckCircle2, Save, Repeat2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  rowToneFor, DocColorLegend, buildToneTooltip, type LegendItem,
} from "@/lib/docRowTone";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Label } from "@/components/ui/label";
import ProductionAIAssistant from "@/components/ProductionAIAssistant";
import UnitCodeSelect from "@/components/UnitCodeSelect";
import { useNextSequenceNumber } from "@/hooks/useNextSequenceNumber";
import { useScreenItemModes, annotateItemCombo } from "@/lib/itemUsageClient";

const API = import.meta.env.VITE_API_URL || "";

const STATUSES = [
  "draft",
  "approved",
  "in_production",
  "paused",
  "quality_check",
  "completed",
  "cancelled",
  "reversed",
] as const;

type Order = {
  id: number;
  orderNumber: string;
  title: string;
  status: string;
  plannedQty: string;
  producedQty: string;
  unitCode: string;
  createdAt: string;
};

const STATUS_TONES: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  approved: "bg-blue-100 text-blue-700",
  in_production: "bg-amber-100 text-amber-800",
  paused: "bg-slate-200 text-slate-800",
  quality_check: "bg-violet-100 text-violet-700",
  completed: "bg-emerald-100 text-emerald-700",
  cancelled: "bg-red-100 text-red-700",
  reversed: "bg-orange-100 text-orange-800",
};

export default function ProductionOrders() {
  const { t } = useTranslation();
  const { token, user } = useAuth() as any;
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [rows, setRows] = useState<Order[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [openCreate, setOpenCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [wizardTab, setWizardTab] = useState<"basic"|"materials"|"routing"|"resources"|"costs"|"review">("basic");
  // Peek the next production-order number from the central sequence engine
  // so the user sees the upcoming auto-assigned number before saving.
  const nextCode = useNextSequenceNumber("production_order", openCreate);
  const [form, setForm] = useState({
    title: "",
    productItemId: "" as number | "",
    plannedQty: "",
    unitCode: "PCE",
    notes: "",
    plannedStartDate: new Date().toISOString().slice(0,10),
    plannedEndDate: "",
    rawWarehouseId: "", finishedWarehouseId: "", workCenterId: "", plannedHours: "",
    costPeriod: new Date().toISOString().slice(0,7),
  });
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [workCenters, setWorkCenters] = useState<any[]>([]);
  const [costSources, setCostSources] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [sourceOrderId, setSourceOrderId] = useState<number | null>(null);
  const [costPolicy, setCostPolicy] = useState({
    packaging:"primary", quality:"appraisal", wasteTreatment:"normal_manufacturing",
    reworkTreatment:"internal_failure", certificationLayer:"manufacturing",
    royaltyLayer:"economic", warrantyLayer:"operating",
  });
  const [allocations, setAllocations] = useState<Record<string,string>>({});
  const [sourceTreatments, setSourceTreatments] = useState<Record<string,string>>({});
  const canClassifySources = user?.role === "admin" || user?.role === "superadmin" ||
    user?.permissions?.production?.post === true;
  const derivedSourceAmount = (s:any) => {
    const method=s.meta?.allocationMethod || s.basis;
    if (s.sourceType==="prepaid_amortization")
      return Number(s.sourceAmount)*Number(form.plannedQty||0)/Number(s.meta?.approvedProductionQuantity||0);
    if (s.sourceType==="fixed_asset_depreciation" && method==="fixed_hourly_rate")
      return Number(form.plannedHours||0)*Number(s.meta?.fixedManufacturingRate||0);
    return Number(s.sourceAmount)*Number(form.plannedHours||0)/
      Number(s.meta?.approvedManufacturingHours||s.meta?.approvedOperatingHours||0);
  };
  const [bomPreview, setBomPreview] = useState<any>(null);
  const [routingPreview, setRoutingPreview] = useState<any>(null);
  // Manufactured items (finished + semi) used as the FG product picker.
  // BOM templates auto-copy raw lines to the order based on this id.
  const [items, setItems] = useState<{ id: number; code: string; nameAr: string; itemNature?: string | null; unitCode?: string | null }[]>([]);
  const loadItems = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch(`${API}/api/inventory/items?includeHidden=1&limit=5000`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return;
      const j = await r.json();
      setItems(Array.isArray(j) ? j : (j.rows ?? []));
    } catch { /* silent */ }
  }, [token]);
  useEffect(() => { void loadItems(); }, [loadItems]);
  useRefetchOnFocus(loadItems);
  const fgItems = useMemo(
    () => items.filter((i) => !i.itemNature || i.itemNature === "finished" || i.itemNature === "semi"),
    [items],
  );
  // Item Usage Control (Phase ب): the finished-good product picker honours the
  // per-item "finished_goods" routing rules (hidden/readonly/requires_*).
  const fgUsageModes = useScreenItemModes("finished_goods");
  const fgComboItems = useMemo(
    () => annotateItemCombo(
      [
        { value: "", label: "—" },
        ...fgItems.map((i) => ({ value: String(i.id), code: i.code ?? undefined, label: i.nameAr ?? `#${i.id}` })),
      ],
      fgUsageModes,
    ),
    [fgItems, fgUsageModes],
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wizardRequestIdRef = useRef(crypto.randomUUID());
  const panelRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  function closePanel() {
    setOpenCreate(false);
    setForm({ title: "", productItemId: "", plannedQty: "", unitCode: "PCE", notes: "",
      plannedStartDate:new Date().toISOString().slice(0,10), plannedEndDate:"",
      rawWarehouseId:"", finishedWarehouseId:"", workCenterId:"", plannedHours:"",
      costPeriod:new Date().toISOString().slice(0,7) });
    setAllocations({}); setSourceTreatments({}); setWizardTab("basic"); setSelectedTemplateId(""); setSourceOrderId(null);
    wizardRequestIdRef.current = crypto.randomUUID();
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function openNewPanel() {
    wizardRequestIdRef.current = crypto.randomUUID();
    setSelectedTemplateId("");
    setSourceOrderId(null);
    setAllocations({});
    setSourceTreatments({});
    setOpenCreate(true);
  }

  useEffect(() => {
    if (!openCreate) return;
    requestAnimationFrame(() => {
      panelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      firstFieldRef.current?.focus();
    });
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closePanel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCreate]);

  useEffect(() => {
    if (!openCreate || !token) return;
    void Promise.all([
      fetch(`${API}/api/inventory/warehouses`, { headers:{Authorization:`Bearer ${token}`} }).then(r=>r.ok?r.json():[]),
      fetch(`${API}/api/production/work-centers`, { headers:{Authorization:`Bearer ${token}`} }).then(r=>r.ok?r.json():[]),
      fetch(`${API}/api/production/manufacturing-settings`, { headers:{Authorization:`Bearer ${token}`} }).then(r=>r.ok?r.json():null),
      fetch(`${API}/api/production/wizard-templates`, { headers:{Authorization:`Bearer ${token}`} }).then(r=>r.ok?r.json():[]),
    ]).then(([w,c,s,ts]) => {
      setWarehouses(Array.isArray(w)?w:(w.rows??[])); setWorkCenters(Array.isArray(c)?c:(c.rows??[]));
      setTemplates(Array.isArray(ts)?ts:[]);
      if (s) setForm(f=>({...f,rawWarehouseId:f.rawWarehouseId||String(s.defaultRawWarehouseId||""),
        finishedWarehouseId:f.finishedWarehouseId||String(s.defaultFinishedWarehouseId||"")}));
    });
  }, [openCreate, token]);

  useEffect(() => {
    if (!openCreate || !token || !form.costPeriod) return;
    void fetch(`${API}/api/production/cost-sources?period=${form.costPeriod}`, { headers:{Authorization:`Bearer ${token}`} })
      .then(async r => { const j=await r.json(); if(!r.ok) throw new Error(j.error); return j; })
      .then(setCostSources).catch(e=>toast({title:"تعذر تحميل مصادر التكلفة",description:e.message,variant:"destructive"}));
  }, [openCreate, token, form.costPeriod, toast]);

  useEffect(() => {
    if (!openCreate || !token || !form.productItemId) { setBomPreview(null); setRoutingPreview(null); return; }
    const id=Number(form.productItemId);
    void Promise.all([
      fetch(`${API}/api/production/bom-templates?productItemId=${id}`,{headers:{Authorization:`Bearer ${token}`}}).then(r=>r.json()),
      fetch(`${API}/api/production/routings?productItemId=${id}`,{headers:{Authorization:`Bearer ${token}`}}).then(r=>r.json()),
    ]).then(async ([bs,rs])=>{
      const b=(Array.isArray(bs)?bs:bs.rows??[])[0]; const rt=(Array.isArray(rs)?rs:rs.rows??[])[0];
      setBomPreview(b ? await fetch(`${API}/api/production/bom-templates/${b.id}`,{headers:{Authorization:`Bearer ${token}`}}).then(r=>r.json()) : null);
      setRoutingPreview(rt ? await fetch(`${API}/api/production/routings/${rt.id}`,{headers:{Authorization:`Bearer ${token}`}}).then(r=>r.json()) : null);
    }).catch(()=>{setBomPreview(null);setRoutingPreview(null);});
  }, [openCreate, token, form.productItemId]);

  async function load() {
    if (!token) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (search.trim()) params.set("search", search.trim());
      const r = await fetch(`${API}/api/production/orders?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRows(await r.json());
    } catch (e: any) {
      toast({ title: t("production.errorOccurred"), description: e?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, statusFilter]);

  // Debounce search
  useEffect(() => {
    const id = setTimeout(() => { void load(); }, 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const createMode = submitter?.dataset.mode === "execute" ? "execute" : "draft";
    if (!form.title.trim()) {
      toast({ title: t("production.errorOccurred"), description: t("production.title_field"), variant: "destructive" });
      setWizardTab("basic");
      return;
    }
    if (!form.productItemId || !(Number(form.plannedQty) > 0)) {
      toast({ title: t("production.errorOccurred"), description: "اختر المنتج النهائي وأدخل كمية موجبة", variant: "destructive" });
      setWizardTab("basic");
      return;
    }
    if (!bomPreview?.lines?.length) {
      toast({ title: t("production.errorOccurred"), description: "لا يوجد قالب مكونات نشط وقابل للتحميل للمنتج", variant: "destructive" });
      setWizardTab("materials");
      return;
    }
    if (!form.rawWarehouseId || !form.finishedWarehouseId) {
      toast({ title: t("production.errorOccurred"), description: "اختر مخزن الخامات ومخزن الإنتاج التام", variant: "destructive" });
      setWizardTab("resources");
      return;
    }
    setCreating(true);
    try {
      const r = await fetch(`${API}/api/production/orders/wizard`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          wizardRequestId: wizardRequestIdRef.current,
          title: form.title.trim(),
          productItemId: Number(form.productItemId),
          plannedQty: Number(form.plannedQty) || 0,
          unitCode: form.unitCode || "PCE",
          notes: form.notes || null,
          plannedStartDate: form.plannedStartDate || null,
          plannedEndDate: form.plannedEndDate || null,
          rawWarehouseId: Number(form.rawWarehouseId) || null,
          finishedWarehouseId: Number(form.finishedWarehouseId) || null,
          workCenterId: Number(form.workCenterId) || null,
          plannedHours: Number(form.plannedHours) || 0,
          costPeriod: form.costPeriod,
          templateId: selectedTemplateId ? Number(selectedTemplateId) : null,
          sourceOrderId,
          costPolicy,
          allocations: costSources.flatMap((s:any)=>{
            const selected=allocations[`${s.sourceType}:${s.sourceRecordId}`]==="1";
            return selected?[{sourceType:s.sourceType,sourceRecordId:s.sourceRecordId,
              treatment:sourceTreatments[`${s.sourceType}:${s.sourceRecordId}`]||"manufacturing_overhead"}]:[];
          }),
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      if (createMode === "execute") {
        let status=j.status;
        if (status==="draft") {
          const approve = await fetch(`${API}/api/production/orders/${j.id}/approve`, {
            method:"POST", headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`}, body:"{}",
          });
          const aj=await approve.json(); if(!approve.ok) throw new Error(aj.error||"تعذر اعتماد الأمر");
          status="approved";
        }
        if (status==="approved") {
          const start = await fetch(`${API}/api/production/orders/${j.id}/status`, {
            method:"POST", headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},
            body:JSON.stringify({status:"in_production"}),
          });
          const sj=await start.json(); if(!start.ok) throw new Error(sj.error||"تعذر بدء التنفيذ");
        } else if (status!=="in_production") {
          throw new Error(`لا يمكن إعادة تنفيذ أمر حالته ${status}`);
        }
      }
      toast({ title: `✓ ${t("production.saved")}` });
      wizardRequestIdRef.current = crypto.randomUUID();
      setOpenCreate(false);
      setAllocations({});
      navigate(`/production/orders/${j.id}`);
    } catch (e: any) {
      toast({ title: t("production.errorOccurred"), description: e?.message, variant: "destructive" });
    } finally {
      setCreating(false);
    }
  }

  function applyConfiguration(configuration:any, templateId = "", fromOrder:number|null = null) {
    const c=configuration??{};
    setForm(f=>({...f,title:c.title||f.title,productItemId:c.productItemId||"",
      unitCode:c.unitCode||"PCE",rawWarehouseId:c.rawWarehouseId?String(c.rawWarehouseId):"",
      finishedWarehouseId:c.finishedWarehouseId?String(c.finishedWarehouseId):"",
      workCenterId:c.workCenterId?String(c.workCenterId):"",
      plannedHours:c.plannedHoursPerUnit&&Number(f.plannedQty)>0
        ?String(Number(c.plannedHoursPerUnit)*Number(f.plannedQty)):"",notes:c.notes||""}));
    if(c.costPolicy) setCostPolicy(p=>({...p,...c.costPolicy}));
    setAllocations({}); setSourceTreatments({}); setSelectedTemplateId(templateId); setSourceOrderId(fromOrder);
    wizardRequestIdRef.current = crypto.randomUUID();
    setOpenCreate(true); setWizardTab("basic");
  }

  async function manufactureAgain(id:number) {
    try {
      const r=await fetch(`${API}/api/production/orders/${id}/manufacture-again`,{headers:{Authorization:`Bearer ${token}`}});
      const j=await r.json(); if(!r.ok) throw new Error(j.error);
      applyConfiguration(j.configuration,"",id);
      toast({title:"تم نسخ الإعدادات فقط",description:"لم تُنسخ أرقام أو نتائج أو قيود أو توزيعات مصادر."});
    } catch(e:any) { toast({title:"تعذر التصنيع مرة أخرى",description:e.message,variant:"destructive"}); }
  }

  async function saveTemplate() {
    if(!form.productItemId) { toast({title:"اختر المنتج أولاً",variant:"destructive"}); return; }
    const name=window.prompt("اسم قالب التصنيع",form.title||"قالب تصنيع");
    if(!name) return;
    try {
      const qty=Number(form.plannedQty)||0;
      const r=await fetch(`${API}/api/production/wizard-templates`,{method:"POST",
        headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},
        body:JSON.stringify({name,configuration:{title:form.title,productItemId:Number(form.productItemId),
          unitCode:form.unitCode,rawWarehouseId:Number(form.rawWarehouseId)||null,
          finishedWarehouseId:Number(form.finishedWarehouseId)||null,workCenterId:Number(form.workCenterId)||null,
          plannedHoursPerUnit:qty>0?Number(form.plannedHours||0)/qty:0,notes:form.notes,costPolicy}})});
      const j=await r.json(); if(!r.ok) throw new Error(j.error);
      setTemplates(ts=>[j,...ts]); setSelectedTemplateId(String(j.id));
      toast({title:"تم حفظ قالب الإعدادات"});
    } catch(e:any){toast({title:"تعذر حفظ القالب",description:e.message,variant:"destructive"});}
  }

  const list = useMemo(() => rows ?? [], [rows]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 p-2 text-white shadow">
            <Factory className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{t("production.orders")}</h1>
            <p className="text-sm text-slate-500">{t("production.subtitle")}</p>
          </div>
        </div>
        <Button
          ref={triggerRef}
          data-testid="btn-new-order"
          onClick={() => (openCreate ? closePanel() : openNewPanel())}
          variant={openCreate ? "outline" : "default"}
          aria-expanded={openCreate}
          aria-controls="panel-new-order"
        >
          {openCreate ? <X className="h-4 w-4 me-1" /> : <Plus className="h-4 w-4 me-1" />}
          {openCreate ? t("common.cancel") : t("production.newOrder")}
        </Button>
      </div>

      {openCreate && (
        <div
          ref={panelRef}
          id="panel-new-order"
          role="region"
          aria-label={t("production.newOrder")}
          className="rounded-lg border border-violet-200 dark:border-violet-900/50 bg-gradient-to-br from-violet-50/60 to-fuchsia-50/40 dark:from-violet-950/20 dark:to-fuchsia-950/10 shadow-sm"
          data-testid="panel-new-order"
        >
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-violet-200/70 dark:border-violet-900/40">
            <div className="flex items-center gap-2 text-sm font-semibold text-violet-700 dark:text-violet-300">
              <Plus className="h-4 w-4" />
              {t("production.newOrder")}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={closePanel}
              aria-label={t("common.cancel")}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <form onSubmit={handleCreate} className="p-4 space-y-4">
            <div className="grid md:grid-cols-[1fr_auto] gap-2 items-end rounded-lg border bg-white/80 p-3">
              <div>
                <Label>قالب التصنيع السريع</Label>
                <SearchCombobox value={selectedTemplateId} placeholder="اختياري — اختر قالباً"
                  items={[{value:"",label:"بدون قالب"},...templates.map(x=>({value:String(x.id),label:x.name}))]}
                  onValueChange={v=>{
                    const template=templates.find(x=>String(x.id)===v);
                    if(template) applyConfiguration(template.configuration,v,null);
                    else setSelectedTemplateId("");
                  }}/>
              </div>
              <div className="text-xs text-slate-500">
                {sourceOrderId?`تصنيع مرة أخرى من الأمر #${sourceOrderId} — إعدادات فقط`:
                  selectedTemplateId?"تصنيع سريع: أكمل الكمية والتاريخ ثم راجع ونفّذ":"يمكن حفظ الإعدادات كقالب دون بيانات الحركة"}
              </div>
            </div>
            <div className="grid grid-cols-3 lg:grid-cols-6 gap-1 rounded-xl bg-white/80 border p-1">
              {([
                ["basic","البيانات",ClipboardList],["materials","المواد",Boxes],["routing","المراحل",Route],
                ["resources","الموارد",Cog],["costs","التكاليف",Calculator],["review","المراجعة",CheckCircle2],
              ] as const).map(([id,label,Icon])=>(
                <button key={id} type="button" onClick={()=>setWizardTab(id)}
                  className={`rounded-lg px-2 py-2 text-xs font-semibold flex items-center justify-center gap-1 ${wizardTab===id?"bg-violet-600 text-white":"hover:bg-violet-50 text-slate-600"}`}>
                  <Icon className="h-4 w-4"/>{label}
                </button>
              ))}
            </div>

            {wizardTab==="basic" && <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div><Label>رقم الأمر</Label><Input value={nextCode.number??"..."} readOnly disabled className="font-mono"/></div>
              <div className="md:col-span-3"><Label>عنوان الأمر *</Label><Input ref={firstFieldRef} required value={form.title} onChange={e=>setForm({...form,title:e.target.value})}/></div>
              <div className="md:col-span-2"><Label>المنتج النهائي *</Label><SearchCombobox
                value={form.productItemId===""?"":String(form.productItemId)} items={fgComboItems}
                placeholder="اختر المنتج" searchPlaceholder="ابحث بالاسم أو الكود…"
                onValueChange={v=>{const idNum=v===""?"":Number(v);const it=idNum===""?undefined:fgItems.find(x=>x.id===idNum);
                  setForm(f=>({...f,productItemId:idNum,unitCode:it?.unitCode||f.unitCode,title:f.title.trim()?f.title:(it?.nameAr??f.title)}));}}/></div>
              <div><Label>الكمية *</Label><Input type="number" min="0.0001" step="0.01" value={form.plannedQty} onChange={e=>setForm({...form,plannedQty:e.target.value})}/></div>
              <div><Label>الوحدة</Label><UnitCodeSelect value={form.unitCode} onChange={v=>setForm({...form,unitCode:v})}/></div>
              <div><Label>بداية مخططة</Label><Input type="date" value={form.plannedStartDate} onChange={e=>setForm({...form,plannedStartDate:e.target.value,costPeriod:e.target.value.slice(0,7)})}/></div>
              <div><Label>نهاية مخططة</Label><Input type="date" value={form.plannedEndDate} onChange={e=>setForm({...form,plannedEndDate:e.target.value})}/></div>
              <div className="md:col-span-2"><Label>ملاحظات</Label><Input value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})}/></div>
            </div>}

            {wizardTab==="materials" && <div className="space-y-3">
              <div className="rounded-lg border bg-blue-50 p-3 text-sm">يُحمّل قالب المكونات النشط تلقائياً ويُضرب في كمية الأمر. تكلفة المعاينة من متوسط تكلفة مخزن الخامات، وتُثبّت التكلفة الفعلية عند الصرف.</div>
              {!bomPreview?<div className="text-center py-8 text-amber-700">لا يوجد قالب مكونات نشط للمنتج المختار.</div>:
                <div><h3 className="font-bold mb-2">{bomPreview.template?.nameAr||bomPreview.nameAr}</h3>
                  <div className="divide-y border rounded-lg">{(bomPreview.lines??[]).map((l:any)=><div key={l.id} className="p-2 flex justify-between text-sm"><span>{l.description}</span><span className="font-mono">{l.quantity} {l.unitCode}</span></div>)}</div></div>}
            </div>}

            {wizardTab==="routing" && <div className="space-y-3">
              <div className="rounded-lg border bg-violet-50 p-3 text-sm">تُنسخ المراحل من مسار الإنتاج النشط كـ snapshot مستقل للأمر، فلا تغيّر تعديلات القالب اللاحقة تاريخ هذا الأمر.</div>
              {!routingPreview?<div className="text-center py-8 text-amber-700">لا يوجد مسار نشط؛ يمكن متابعة الأمر بلا مراحل.</div>:
                <div className="flex flex-wrap gap-2">{(routingPreview.stages??[]).map((s:any,i:number)=><div key={s.id} className="rounded-lg border bg-white p-3 min-w-36"><b>{i+1}. {s.nameAr}</b><p className="text-xs text-slate-500">{s.expectedDurationMinutes||0} دقيقة</p></div>)}</div>}
            </div>}

            {wizardTab==="resources" && <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div><Label>مخزن الخامات *</Label><SearchCombobox value={form.rawWarehouseId} onValueChange={v=>setForm({...form,rawWarehouseId:v})} placeholder="اختر" items={warehouses.map(w=>({value:String(w.id),label:w.nameAr||w.name||`#${w.id}`}))}/></div>
              <div><Label>مخزن الإنتاج التام *</Label><SearchCombobox value={form.finishedWarehouseId} onValueChange={v=>setForm({...form,finishedWarehouseId:v})} placeholder="اختر" items={warehouses.map(w=>({value:String(w.id),label:w.nameAr||w.name||`#${w.id}`}))}/></div>
              <div><Label>مركز العمل</Label><SearchCombobox value={form.workCenterId} onValueChange={v=>setForm({...form,workCenterId:v})} placeholder="اختياري" items={workCenters.map(w=>({value:String(w.id),label:`${w.code} — ${w.nameAr}`}))}/></div>
              <div><Label>الساعات المخططة</Label><Input type="number" min="0" step="0.25" value={form.plannedHours} onChange={e=>setForm({...form,plannedHours:e.target.value})}/></div>
            </div>}

            {wizardTab==="costs" && <div className="space-y-3">
              <div className="flex items-end gap-3"><div><Label>فترة التكلفة</Label><Input type="month" value={form.costPeriod} onChange={e=>setForm({...form,costPeriod:e.target.value})}/></div>
                <p className="text-xs text-slate-500 pb-2">تظهر فقط تكاليف مُرحّلة فعلياً من الرواتب، الإهلاك، والمصروفات المقدمة.</p></div>
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">اختر المصدر فقط؛ يحسب الخادم الحصة من ساعات/كمية الأمر والمقام أو المعدل المعتمد في شاشة المصدر، ويحفظ جميع عناصر المعادلة في لقطة غير قابلة للتعديل.</div>
              <div className="divide-y border rounded-lg">{costSources.length===0?<div className="p-6 text-center text-slate-500">لا توجد مصادر مُرحّلة لهذه الفترة.</div>:costSources.map((s:any)=>{
                const key=`${s.sourceType}:${s.sourceRecordId}`; return <div key={key} className="p-3 grid md:grid-cols-[1fr_100px_190px_110px] gap-3 items-center">
                  <div><b className="text-sm">{s.label}</b><p className="text-xs text-slate-500">المتاح {Number(s.availableAmount).toLocaleString()} • {s.meta?.allocationMethod||s.basis}</p></div>
                   <label className="flex gap-2 items-center text-sm"><input type="checkbox" disabled={!canClassifySources} checked={allocations[key]==="1"} onChange={e=>setAllocations({...allocations,[key]:e.target.checked?"1":""})}/> اختيار</label>
                   <select className="border rounded-md p-2 text-xs" value={sourceTreatments[key]||"manufacturing_overhead"}
                     disabled={!canClassifySources}
                     onChange={e=>setSourceTreatments({...sourceTreatments,[key]:e.target.value})}>
                     <option value="manufacturing_overhead">تكلفة صناعية غير مباشرة</option>
                     <option value="quality_prevention">جودة — وقاية</option>
                     <option value="quality_appraisal">جودة — فحص</option>
                     <option value="internal_failure">إعادة تشغيل / فشل داخلي</option>
                     <option value="abnormal_loss">خسارة غير طبيعية</option>
                     <option value="certification">شهادة / اعتماد</option>
                     <option value="royalty">Royalty</option>
                     <option value="warranty">ضمان</option>
                     <option value="economic">اقتصادية فقط</option>
                   </select>
                  <div className="text-end font-mono text-sm">{Number.isFinite(derivedSourceAmount(s))?derivedSourceAmount(s).toFixed(2):"—"}</div>
                </div>})}</div>
              {!canClassifySources && <p className="text-xs text-amber-700">عرض المصادر متاح، لكن اختيارها وتصنيفها يتطلب صلاحية ترحيل التصنيع.</p>}
              <div className="rounded-lg border p-3 space-y-3">
                <h3 className="font-bold text-sm">سياسات المعالجة المتقدمة</h3>
                <p className="text-xs text-slate-500">هذه تصنيفات تكلفة وتحليل فقط؛ لا تنشئ قيوداً جديدة. التغليف المباشر يبقى مادة BOM، والجودة والهالك وإعادة التشغيل تستخدم سجلات المحرك الحالي، والمصادر المُرحّلة تبقى مملوكة لوحداتها الأصلية.</p>
                <div className="grid md:grid-cols-4 gap-2 text-sm">
                  <div><Label>التغليف</Label><select className="w-full border rounded-md p-2" value={costPolicy.packaging} onChange={e=>setCostPolicy({...costPolicy,packaging:e.target.value})}>
                    <option value="primary">أولي / مباشر</option><option value="secondary">ثانوي</option><option value="protective">وقائي</option><option value="shipping">شحن</option><option value="promotional">ترويجي</option>
                  </select></div>
                  <div><Label>الجودة COQ</Label><select className="w-full border rounded-md p-2" value={costPolicy.quality} onChange={e=>setCostPolicy({...costPolicy,quality:e.target.value})}>
                    <option value="prevention">وقاية</option><option value="appraisal">فحص وتقييم</option><option value="internal_failure">فشل داخلي</option><option value="external_failure">فشل خارجي</option>
                  </select></div>
                  <div><Label>الهالك</Label><select className="w-full border rounded-md p-2" value={costPolicy.wasteTreatment} onChange={e=>setCostPolicy({...costPolicy,wasteTreatment:e.target.value})}>
                    <option value="normal_manufacturing">طبيعي — تصنيع</option><option value="abnormal_loss">غير طبيعي — خسارة</option>
                  </select></div>
                  <div><Label>إعادة التشغيل</Label><select className="w-full border rounded-md p-2" value={costPolicy.reworkTreatment} onChange={e=>setCostPolicy({...costPolicy,reworkTreatment:e.target.value})}>
                    <option value="internal_failure">فشل داخلي</option><option value="abnormal_loss">خسارة غير طبيعية</option>
                  </select></div>
                  <div><Label>الشهادات</Label><select className="w-full border rounded-md p-2" value={costPolicy.certificationLayer} onChange={e=>setCostPolicy({...costPolicy,certificationLayer:e.target.value})}>
                    <option value="manufacturing">تكلفة تصنيع</option><option value="economic">تكلفة اقتصادية</option>
                  </select></div>
                  <div><Label>Royalty</Label><select className="w-full border rounded-md p-2" value={costPolicy.royaltyLayer} onChange={e=>setCostPolicy({...costPolicy,royaltyLayer:e.target.value})}>
                    <option value="manufacturing">تصنيع</option><option value="operating">تشغيلية</option><option value="economic">اقتصادية</option>
                  </select></div>
                  <div><Label>الضمان</Label><select className="w-full border rounded-md p-2" value={costPolicy.warrantyLayer} onChange={e=>setCostPolicy({...costPolicy,warrantyLayer:e.target.value})}>
                    <option value="operating">تشغيلية / فشل خارجي</option><option value="manufacturing">تصنيع حسب السياسة</option>
                  </select></div>
                </div>
              </div>
            </div>}

            {wizardTab==="review" && <div className="grid md:grid-cols-3 gap-3">
              <div className="rounded-lg border p-3"><p className="text-xs text-slate-500">المنتج / الكمية</p><b>{fgItems.find(x=>x.id===Number(form.productItemId))?.nameAr||"—"} — {form.plannedQty||0} {form.unitCode}</b></div>
              <div className="rounded-lg border p-3"><p className="text-xs text-slate-500">المواد / المراحل</p><b>{bomPreview?.lines?.length||0} مادة • {routingPreview?.stages?.length||0} مرحلة</b></div>
              <div className="rounded-lg border p-3"><p className="text-xs text-slate-500">تكاليف المصادر</p><b>{costSources.reduce((sum:number,s:any)=>sum+(allocations[`${s.sourceType}:${s.sourceRecordId}`]==="1"?derivedSourceAmount(s):0),0).toFixed(2)}</b></div>
              <div className="md:col-span-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">الحفظ كمسودة لا يحرك المخزون. «حفظ وتنفيذ» يعتمد الأمر ثم يستخدم مسار التنفيذ المحاسبي والمخزني الحالي نفسه؛ وأي خطأ في الاعتماد أو الصرف يظهر صراحة.</div>
            </div>}

            <div className="flex items-center justify-between gap-2 pt-2 border-t">
              <Button type="button" variant="outline" onClick={closePanel}>{t("common.cancel")}</Button>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={saveTemplate}><Save className="h-4 w-4 me-1"/>حفظ كقالب</Button>
                <Button type="submit" variant="outline" disabled={creating} data-mode="draft">حفظ كمسودة</Button>
                <Button type="submit" disabled={creating} data-mode="execute" data-testid="btn-create-order">{creating?t("common.loading"):"حفظ وتنفيذ"}</Button>
              </div>
            </div>
          </form>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <div className="flex flex-wrap gap-2 items-center">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="absolute start-2 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("production.searchPlaceholder")}
                className="ps-8"
                data-testid="input-search"
              />
            </div>
            <div className="w-48" data-testid="select-status-filter">
              <SearchCombobox
                value={statusFilter || ""}
                onValueChange={(v) => setStatusFilter(v)}
                placeholder={t("production.filterAll")}
                searchPlaceholder="ابحث…"
                items={[
                  { value: "", label: t("production.filterAll") },
                  ...STATUSES.map((s) => ({ value: s, label: t(`production.status_${s}`) })),
                ]}
              />
            </div>
          </div>

          {(() => {
            const items: LegendItem[] = [
              { kind: "draft",         count: list.filter((x: any) => x.status === "draft").length },
              { kind: "approved",      count: list.filter((x: any) => x.status === "approved").length },
              { kind: "in_production", count: list.filter((x: any) => x.status === "in_production").length },
               { kind: "paused", count: list.filter((x: any) => x.status === "paused").length },
              { kind: "quality_check", count: list.filter((x: any) => x.status === "quality_check").length },
              { kind: "completed",     count: list.filter((x: any) => x.status === "completed" || x.status === "closed").length },
              { kind: "cancelled",     count: list.filter((x: any) => x.status === "cancelled").length },
               { kind: "reversed", count: list.filter((x: any) => x.status === "reversed").length },
            ];
            return <DocColorLegend items={items} />;
          })()}

          {/* Mobile cards (md-hidden) */}
          <div className="md:hidden space-y-3">
            {loading && rows === null && Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-32 w-full" />)}
            {!loading && list.length === 0 && (
              <div className="text-center py-8 text-sm text-slate-500">{t("production.noOrders")}</div>
            )}
            {list.map((o) => (
              <div key={o.id} data-status={o.status} className="rounded-2xl bg-white border border-orange-100 shadow-sm overflow-hidden">
                <div className="bg-gradient-to-r from-orange-500 to-orange-600 px-4 py-2.5 flex items-center justify-between">
                  <span className="text-white font-mono text-sm font-bold">{o.orderNumber}</span>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full bg-white/95 ${(STATUS_TONES[o.status] ?? "").replace(/bg-\w+-\d+/g,'').trim() || "text-orange-700"}`}>
                    {t(`production.status_${o.status}`)}
                  </span>
                </div>
                <div className="p-3 space-y-2">
                  <div className="flex items-start gap-2">
                    <div className="h-10 w-10 rounded-lg bg-orange-100 grid place-items-center text-orange-700 shrink-0"><Factory className="h-5 w-5" /></div>
                    <p className="font-bold text-sm flex-1 min-w-0">{o.title}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-center text-xs">
                    <div className="bg-slate-50 rounded-lg p-1.5">
                      <div className="text-[10px] text-muted-foreground">{t("production.plannedQty")}</div>
                      <div className="font-mono font-bold text-slate-800">{Number(o.plannedQty).toLocaleString("en-US")} <span className="text-[10px] text-slate-400">{o.unitCode}</span></div>
                    </div>
                    <div className="bg-orange-50 rounded-lg p-1.5">
                      <div className="text-[10px] text-muted-foreground">{t("production.producedQty")}</div>
                      <div className="font-mono font-bold text-orange-800">{Number(o.producedQty).toLocaleString("en-US")}</div>
                    </div>
                  </div>
                </div>
                <Link href={`/production/orders/${o.id}`} className="block py-2.5 text-center bg-orange-50 text-orange-700 text-sm font-semibold hover:bg-orange-100 border-t border-orange-100">
                  فتح التفاصيل ←
                </Link>
              </div>
            ))}
          </div>

          {/* Mobile FAB */}
          <button onClick={openNewPanel} className="md:hidden fixed bottom-6 end-6 z-40 group" aria-label={t("production.newOrder")}>
            <span className="absolute inset-0 rounded-full bg-orange-400/40 animate-ping" />
            <span className="relative h-14 w-14 rounded-full bg-gradient-to-br from-orange-500 to-orange-600 ring-4 ring-white shadow-2xl grid place-items-center text-white">
              <Plus className="h-7 w-7" />
            </span>
          </button>

          <div className="hidden md:block rounded-lg border bg-white dark:bg-slate-900">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                <tr>
                  <th className="text-start p-3">{t("production.orderNumber")}</th>
                  <th className="text-start p-3">{t("production.title_field")}</th>
                  <th className="text-start p-3">{t("production.status")}</th>
                  <th className="text-end p-3">{t("production.plannedQty")}</th>
                  <th className="text-end p-3">{t("production.producedQty")}</th>
                  <th className="text-end p-3"></th>
                </tr>
              </thead>
              <tbody>
                {loading && rows === null && Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i} className="border-t">
                    <td className="p-3" colSpan={6}><Skeleton className="h-6 w-full" /></td>
                  </tr>
                ))}
                {!loading && list.length === 0 && (
                  <tr><td colSpan={6} className="p-8 text-center text-slate-500">{t("production.noOrders")}</td></tr>
                )}
                {list.map((o) => (
                  <tr key={o.id}
                      data-status={o.status}
                      className={cn("border-t transition-colors", rowToneFor({ status: o.status }))}
                      title={buildToneTooltip({ status: o.status })}
                      data-testid={`row-order-${o.id}`}>
                    <td className="p-3 font-mono text-xs">{o.orderNumber}</td>
                    <td className="p-3">{o.title}</td>
                    <td className="p-3">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONES[o.status] ?? "bg-slate-100"}`}>
                        {t(`production.status_${o.status}`)}
                      </span>
                    </td>
                    <td className="p-3 text-end">{Number(o.plannedQty).toLocaleString("en-US")} <span className="text-xs text-slate-400">{o.unitCode}</span></td>
                    <td className="p-3 text-end">{Number(o.producedQty).toLocaleString("en-US")}</td>
                    <td className="p-3 text-end">
                      <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={()=>void manufactureAgain(o.id)} title="تصنيع مرة أخرى — نسخ الإعدادات فقط">
                        <Repeat2 className="h-4 w-4"/>
                      </Button>
                      <Link href={`/production/orders/${o.id}`}>
                        <Button size="sm" variant="ghost" data-testid={`btn-open-${o.id}`}>
                          <ArrowRight className="h-4 w-4" />
                        </Button>
                      </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <ProductionAIAssistant
            screenContext="production.orders.list"
            currentAction="viewing orders list"
          />
        </div>
      </div>
    </div>
  );
}
