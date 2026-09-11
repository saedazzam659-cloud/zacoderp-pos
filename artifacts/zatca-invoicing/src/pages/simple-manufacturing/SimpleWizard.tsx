import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ClipboardList, Boxes, GitBranch, Cog, Calculator, CheckCircle2, Save, Play, Plus, Trash2, ExternalLink } from "lucide-react";
import { SearchCombobox } from "@/components/ui/search-combobox";
import UnitCodeSelect from "@/components/UnitCodeSelect";
import { DateField } from "@/components/ui/date-field";
import type { WizardState, Catalog } from "./types";
import { useToast } from "@/hooks/use-toast";
import { usePermission } from "@/hooks/usePermission";
import { Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export function SimpleWizard({
  token,
  catalog,
  busy,
  onSaveAccounting,
  onSubmit,
  onCancel
}: {
  token: string;
  catalog: Catalog;
  busy: boolean;
  onSaveAccounting: (data: {
    defaultWipAccountId: number | null;
    defaultRawInventoryAccountId: number | null;
    defaultFinishedGoodsAccountId: number | null;
  }) => Promise<unknown>;
  onSubmit: (mode: "draft" | "execute", payload: any) => Promise<void>;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const { actingCompanyId } = useAuth();
  const [tab, setTab] = useState<"basic" | "materials" | "routing" | "resources" | "costs" | "review">("basic");
  const [form, setForm] = useState<WizardState>({
    title: "", productItemId: "", plannedQty: "1", unitCode: "PCE", notes: "",
    plannedStartDate: new Date().toISOString().slice(0, 10), plannedEndDate: "",
    rawWarehouseId: catalog.warehouses[0]?.id ? String(catalog.warehouses[0].id) : "",
    finishedWarehouseId: catalog.warehouses[0]?.id ? String(catalog.warehouses[0].id) : "",
    workCenterId: "", plannedHours: "1", costPeriod: new Date().toISOString().slice(0, 7),
    templateId: "", sourceOrderId: null, costPolicy: { packaging: "primary", quality: "appraisal", wasteTreatment: "normal_manufacturing", reworkTreatment: "internal_failure", certificationLayer: "manufacturing", royaltyLayer: "economic", warrantyLayer: "operating" }
  });

  const [bomPreview, setBomPreview] = useState<any>(null);
  const [routingPreview, setRoutingPreview] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [costSources, setCostSources] = useState<any[]>([]);
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [sourceTreatments, setSourceTreatments] = useState<Record<string, string>>({});
  const [accountSettings, setAccountSettings] = useState({
    defaultWipAccountId: "",
    defaultRawInventoryAccountId: "",
    defaultFinishedGoodsAccountId: "",
  });

  // Inline BOM creation
  const [creatingBom, setCreatingBom] = useState(false);
  const [newBomLines, setNewBomLines] = useState<Array<{ itemId: string; quantity: string; unitCode: string }>>([]);

  // The facade keys wizard creation by this stable id. If a draft was created
  // and only the following start transition failed, retrying the footer action
  // replays that order instead of inserting a duplicate.
  const wizardRequestIdRef = useRef(crypto.randomUUID());
  const productRequestRef = useRef(0);
  const costRequestRef = useRef(0);

  const canCreate = usePermission("simple_manufacturing", "create");
  const canEdit = usePermission("simple_manufacturing", "edit");
  const canPost = usePermission("simple_manufacturing", "post");
  const canViewPayroll = usePermission("hr_payroll", "view");
  const canViewAssets = usePermission("fixed_assets", "view");
  const canViewJournals = usePermission("journal_entries", "view");

  useEffect(() => {
    const settings = catalog.accounting?.settings;
    if (!settings) return;
    setAccountSettings({
      defaultWipAccountId: settings.defaultWipAccountId ? String(settings.defaultWipAccountId) : "",
      defaultRawInventoryAccountId: settings.defaultRawInventoryAccountId ? String(settings.defaultRawInventoryAccountId) : "",
      defaultFinishedGoodsAccountId: settings.defaultFinishedGoodsAccountId ? String(settings.defaultFinishedGoodsAccountId) : "",
    });
  }, [catalog.accounting?.settings]);

  const request = useCallback(async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(actingCompanyId ? { "x-acting-company-id": String(actingCompanyId) } : {}),
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    let body: any = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(response.ok ? "استجابة غير صالحة من الخادم" : `HTTP ${response.status}`);
      }
    }
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    return body;
  }, [token, actingCompanyId]);

  // Filter finished goods for the product combobox
  const fgItems = catalog.items.filter(i => !i.itemNature || i.itemNature === "finished" || i.itemNature === "semi");
  const fgComboItems = [
    { value: "", label: "—" },
    ...fgItems.map(i => ({ value: String(i.id), code: i.code, label: i.nameAr }))
  ];
  const materialItems = catalog.items.filter(i =>
    !i.itemNature || ["raw", "semi", "consumable"].includes(i.itemNature),
  );

  // Fetch the simple-facade envelopes and their details when product changes.
  // The old implementation queried /production and converted errors to null,
  // which made a permission/tenant failure look exactly like "no recipe".
  useEffect(() => {
    const requestId = ++productRequestRef.current;
    const controller = new AbortController();
    if (!token || !form.productItemId) {
      setBomPreview(null);
      setRoutingPreview(null);
      setPreviewLoading(false);
      return () => controller.abort();
    }
    const id = Number(form.productItemId);
    setBomPreview(null);
    setRoutingPreview(null);
    setPreviewLoading(true);
    const load = async () => {
      try {
        const [bs, rs] = await Promise.all([
          request(`/api/simple-manufacturing/bom-templates?productItemId=${id}`, { signal: controller.signal }),
          request(`/api/simple-manufacturing/routings?productItemId=${id}`, { signal: controller.signal }),
        ]);
        if (!Array.isArray(bs) || !Array.isArray(rs)) throw new Error("استجابة الوصفة أو المسار غير صالحة");
        const b = bs.find((row: any) => row?.isActive !== false);
        const rt = rs.find((row: any) => row?.isActive !== false);
        const [bom, routing] = await Promise.all([
          b ? request(`/api/simple-manufacturing/bom-templates/${b.id}`, { signal: controller.signal }) : Promise.resolve(null),
          rt ? request(`/api/simple-manufacturing/routings/${rt.id}`, { signal: controller.signal }) : Promise.resolve(null),
        ]);
        if (requestId !== productRequestRef.current || controller.signal.aborted) return;
        if (bom !== null && (!bom || !Array.isArray(bom.lines))) throw new Error("استجابة تفاصيل الوصفة غير صالحة");
        if (routing !== null && (!routing || !Array.isArray(routing.stages))) throw new Error("استجابة تفاصيل المسار غير صالحة");
        setBomPreview(bom);
        setRoutingPreview(routing);
        setPreviewLoading(false);
      } catch (e: any) {
        if (e?.name !== "AbortError" && requestId === productRequestRef.current) {
          setBomPreview(null);
          setRoutingPreview(null);
          setPreviewLoading(false);
          toast({ title: "تعذر تحميل الوصفة والمسار", description: e.message, variant: "destructive" });
        }
      }
    };
    void load();
    return () => controller.abort();
  }, [request, token, form.productItemId, toast]);

  // Fetch cost sources when period changes
  useEffect(() => {
    const requestId = ++costRequestRef.current;
    const controller = new AbortController();
    if (!token || !form.costPeriod) {
      setCostSources([]);
      return () => controller.abort();
    }
    const load = async () => {
      try {
        const data = await request(
          `/api/simple-manufacturing/cost-sources?period=${encodeURIComponent(form.costPeriod)}`,
          { signal: controller.signal },
        );
        if (!Array.isArray(data)) throw new Error("استجابة مصادر التكلفة غير صالحة");
        if (requestId === costRequestRef.current && !controller.signal.aborted) {
          setCostSources(data);
          setAllocations({});
          setSourceTreatments({});
        }
      } catch (e: any) {
        if (e?.name !== "AbortError" && requestId === costRequestRef.current) {
          setCostSources([]);
          setAllocations({});
          setSourceTreatments({});
          toast({ title: "تعذر تحميل مصادر التكلفة", description: e.message, variant: "destructive" });
        }
      }
    };
    void load();
    return () => controller.abort();
  }, [request, token, form.costPeriod, toast]);

  const handleCreateBom = async () => {
    if (!form.productItemId || newBomLines.length === 0) return;
    try {
      const b = await request("/api/simple-manufacturing/setup/bom", {
        method: "POST",
        body: JSON.stringify({
          productItemId: Number(form.productItemId),
          nameAr: `وصفة ${catalog.items.find(i => String(i.id) === form.productItemId)?.nameAr || "جديدة"}`,
          outputQty: 1,
          lines: newBomLines.filter(l => l.itemId && Number(l.quantity) > 0).map(l => ({
            itemId: Number(l.itemId),
            quantity: Number(l.quantity),
            description: catalog.items.find(i => String(i.id) === l.itemId)?.nameAr || "مادة خام",
            ...(l.unitCode ? { unitCode: l.unitCode } : {})
          }))
        })
      });
      if (!b?.id) throw new Error("استجابة إنشاء الوصفة غير صالحة");
      productRequestRef.current += 1;
      const detail = await request(`/api/simple-manufacturing/bom-templates/${b.id}`);
      if (!detail || !Array.isArray(detail.lines)) throw new Error("استجابة تفاصيل الوصفة غير صالحة");
      setBomPreview(detail);
      setCreatingBom(false);
      setNewBomLines([]);
      toast({ title: "تم إنشاء قائمة المكونات بنجاح" });
    } catch (e: any) {
      toast({ title: e.message, variant: "destructive" });
    }
  };

  const handleTemplateChange = (val: string) => {
    if (!val) {
      setForm(f => ({ ...f, templateId: "" }));
      return;
    }
    const chosen = catalog.templates.find(t => String(t.id) === val);
    const conf = chosen?.configuration || {};
    const it = catalog.items.find(x => String(x.id) === String(conf.productItemId));
    const nextPlannedQty = conf.plannedQty ? String(conf.plannedQty) : form.plannedQty;
    setForm(f => ({
      ...f,
      templateId: val,
      title: conf.title || f.title,
      productItemId: conf.productItemId ? String(conf.productItemId) : f.productItemId,
      plannedQty: conf.plannedQty ? String(conf.plannedQty) : f.plannedQty,
      unitCode: conf.unitCode || it?.unitCode || f.unitCode,
      rawWarehouseId: conf.rawWarehouseId ? String(conf.rawWarehouseId) : f.rawWarehouseId,
      finishedWarehouseId: conf.finishedWarehouseId ? String(conf.finishedWarehouseId) : f.finishedWarehouseId,
      plannedHours: conf.plannedHoursPerUnit && Number(nextPlannedQty) > 0 ? String(Number(conf.plannedHoursPerUnit) * Number(nextPlannedQty)) : f.plannedHours,
      notes: conf.notes || f.notes,
      costPolicy: conf.costPolicy || f.costPolicy,
    }));
  };

  const submit = async (mode: "draft" | "execute") => {
    if (!form.title.trim() || !form.productItemId || !(Number(form.plannedQty) > 0)) {
      toast({ title: "بيانات أساسية مفقودة", description: "تأكد من إدخال العنوان واختيار المنتج والكمية", variant: "destructive" });
      setTab("basic");
      return;
    }
    if (!form.rawWarehouseId || !form.finishedWarehouseId) {
      toast({ title: "المخازن مفقودة", description: "تأكد من اختيار مستودعات الخامات والإنتاج", variant: "destructive" });
      setTab("resources");
      return;
    }
    if (!bomPreview?.lines?.length) {
      toast({ title: "الوصفة مفقودة", description: "أنشئ قائمة مواد نشطة للمنتج قبل حفظ أمر التصنيع.", variant: "destructive" });
      setTab("materials");
      return;
    }
    if (mode === "execute" &&
        (!accountSettings.defaultWipAccountId || !accountSettings.defaultRawInventoryAccountId)) {
      toast({
        title: "إعداد الحسابات مطلوب قبل البدء",
        description: "حدّد حساب إنتاج تحت التشغيل WIP وحساب مخزون الخامات في قسم إعداد حسابات التصنيع داخل تبويب الموارد ثم احفظهما.",
        variant: "destructive",
      });
      setTab("resources");
      return;
    }

    const configuredSettings = catalog.accounting?.settings;
    const accountingChanged = mode === "execute" && (
      String(configuredSettings?.defaultWipAccountId ?? "") !== accountSettings.defaultWipAccountId ||
      String(configuredSettings?.defaultRawInventoryAccountId ?? "") !== accountSettings.defaultRawInventoryAccountId ||
      String(configuredSettings?.defaultFinishedGoodsAccountId ?? "") !== accountSettings.defaultFinishedGoodsAccountId
    );
    if (accountingChanged) {
      try {
        await onSaveAccounting({
          defaultWipAccountId: accountSettings.defaultWipAccountId ? Number(accountSettings.defaultWipAccountId) : null,
          defaultRawInventoryAccountId: accountSettings.defaultRawInventoryAccountId ? Number(accountSettings.defaultRawInventoryAccountId) : null,
          defaultFinishedGoodsAccountId: accountSettings.defaultFinishedGoodsAccountId ? Number(accountSettings.defaultFinishedGoodsAccountId) : null,
        });
      } catch {
        setTab("resources");
        return;
      }
    }

    const payload = {
      wizardRequestId: wizardRequestIdRef.current,
      title: form.title.trim(),
      productItemId: Number(form.productItemId),
      plannedQty: Number(form.plannedQty),
      unitCode: form.unitCode,
      notes: form.notes || null,
      plannedStartDate: form.plannedStartDate || null,
      plannedEndDate: form.plannedEndDate || null,
      rawWarehouseId: Number(form.rawWarehouseId) || null,
      finishedWarehouseId: Number(form.finishedWarehouseId) || null,
      workCenterId: Number(form.workCenterId) || null,
      plannedHours: Number(form.plannedHours) || 0,
      costPeriod: form.costPeriod,
      templateId: form.templateId ? Number(form.templateId) : null,
      costPolicy: form.costPolicy,
      allocations: costSources.flatMap(s => {
        const key = `${s.sourceType}:${s.sourceRecordId}`;
        const selected = allocations[key] === "1";
        return selected && canPost ? [{
          sourceType: s.sourceType,
          sourceRecordId: s.sourceRecordId,
          treatment: sourceTreatments[key] || "manufacturing_overhead"
        }] : [];
      })
    };

    await onSubmit(mode, payload);
  };

  const saveAccounting = async () => {
    if (!accountSettings.defaultWipAccountId || !accountSettings.defaultRawInventoryAccountId) {
      toast({
        title: "حسابات الترحيل ناقصة",
        description: "حساب WIP وحساب مخزون الخامات مطلوبان لبدء الإنتاج.",
        variant: "destructive",
      });
      return;
    }
    await onSaveAccounting({
      defaultWipAccountId: Number(accountSettings.defaultWipAccountId),
      defaultRawInventoryAccountId: Number(accountSettings.defaultRawInventoryAccountId),
      defaultFinishedGoodsAccountId: accountSettings.defaultFinishedGoodsAccountId
        ? Number(accountSettings.defaultFinishedGoodsAccountId) : null,
    });
  };

  const calculateAllocatedTotal = () => {
    let total = 0;
    costSources.forEach(s => {
      const key = `${s.sourceType}:${s.sourceRecordId}`;
      if (allocations[key] === "1") {
        const method = s.meta?.allocationMethod || s.basis;
        let amount = 0;
        if (s.sourceType === "prepaid_amortization") {
          amount = Number(s.sourceAmount) * Number(form.plannedQty || 0) / Number(s.meta?.approvedProductionQuantity || 1);
        } else if (s.sourceType === "fixed_asset_depreciation" && method === "fixed_hourly_rate") {
          amount = Number(form.plannedHours || 0) * Number(s.meta?.fixedManufacturingRate || 0);
        } else {
          amount = Number(s.sourceAmount) * Number(form.plannedHours || 0) / Number(s.meta?.approvedManufacturingHours || s.meta?.approvedOperatingHours || 1);
        }
        total += amount;
      }
    });
    return total;
  };

  const calculateMaterialEstimate = () => {
    const lines = Array.isArray(bomPreview?.lines) ? bomPreview.lines : [];
    const hasCost = lines.some((line: any) => line.totalCost != null || line.unitCost != null);
    if (!hasCost) return null;
    return lines.reduce((total: number, line: any) => {
      const lineTotal = line.totalCost != null
        ? Number(line.totalCost)
        : Number(line.quantity || 0) * Number(line.unitCost || 0);
      return total + (Number.isFinite(lineTotal) ? lineTotal : 0);
    }, 0);
  };

  const steps = [
    { id: "basic" as const, label: "البيانات الأساسية", icon: ClipboardList },
    { id: "materials" as const, label: "المواد والوصفة", icon: Boxes },
    { id: "routing" as const, label: "مسار الإنتاج", icon: GitBranch },
    { id: "resources" as const, label: "الموارد", icon: Cog },
    { id: "costs" as const, label: "التكاليف", icon: Calculator },
    { id: "review" as const, label: "المراجعة", icon: CheckCircle2 }
  ];
  const accountingAccounts = (catalog.accounting?.accounts ?? [])
    .filter(account => account.accountType === "asset");
  const hasRequiredAccounting =
    !!accountSettings.defaultWipAccountId && !!accountSettings.defaultRawInventoryAccountId;

  return (
    <div className="space-y-4">
      {/* Wizard Header / Tabs */}
      <div className="flex gap-2 mb-4 bg-slate-50 border p-2 rounded-xl overflow-x-auto no-scrollbar">
        {steps.map(step => (
          <button
            key={step.id}
            onClick={() => setTab(step.id)}
            className={`flex-1 min-w-[120px] flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-sm font-semibold transition-all ${
              tab === step.id
                ? "bg-white text-violet-700 shadow-sm border border-violet-100"
                : "text-slate-500 hover:text-slate-700 hover:bg-slate-100"
            }`}
          >
            <step.icon className={`h-4 w-4 ${tab === step.id ? "text-violet-600" : ""}`} />
            {step.label}
          </button>
        ))}
      </div>

      <Card className="border-0 shadow-sm bg-white min-h-[400px]">
        <CardContent className="p-6">
          {tab === "basic" && (
            <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2">
              <div className="bg-blue-50/50 border border-blue-100 p-4 rounded-lg flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-blue-900">قالب تصنيع سريع</h3>
                  <p className="text-sm text-blue-700 opacity-80">اختر قالباً محفوظاً لتعبئة إعدادات الأمر. القالب يحفظ الإعدادات فقط ولا يُعد وصفة مواد.</p>
                </div>
                <div className="w-[300px]">
                  <SearchCombobox
                    value={form.templateId}
                    onValueChange={handleTemplateChange}
                    items={[{value:"",label:"بدون قالب"}, ...catalog.templates.map(t=>({value:String(t.id),label:t.name}))]}
                    placeholder="اختر القالب..."
                  />
                </div>
              </div>
              <div className="grid md:grid-cols-2 gap-6">
                <div className="space-y-2 md:col-span-2">
                  <Label className="text-base">عنوان أمر الإنتاج <span className="text-red-500">*</span></Label>
                  <Input value={form.title} onChange={e => setForm({...form, title: e.target.value})} placeholder="مثال: تشغيلة خبز أبيض - وردية الصباح" className="h-11" />
                </div>
                <div className="space-y-2">
                  <Label>المنتج النهائي (الهدف) <span className="text-red-500">*</span></Label>
                  <SearchCombobox
                    value={form.productItemId}
                    items={fgComboItems}
                    onValueChange={v => {
                      const it = catalog.items.find(x => String(x.id) === v);
                       setForm(f => ({ ...f, productItemId: v, title: f.title.trim() ? f.title : (it?.nameAr ?? f.title), unitCode: it?.unitCode || f.unitCode }));
                    }}
                    placeholder="ابحث عن المنتج..."
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>الكمية المخططة <span className="text-red-500">*</span></Label>
                    <Input type="text" inputMode="decimal" value={form.plannedQty} onChange={e => setForm({...form, plannedQty: e.target.value})} className="h-10 text-lg font-mono text-left" dir="ltr" />
                  </div>
                  <div className="space-y-2">
                    <Label>وحدة القياس</Label>
                    <UnitCodeSelect value={form.unitCode} onChange={v => setForm({...form, unitCode: v})} className="h-10" />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>تاريخ البدء المتوقع</Label>
                  <DateField value={form.plannedStartDate} onChange={e => setForm({...form, plannedStartDate: e.target.value, costPeriod: e.target.value.slice(0, 7)})} />
                </div>
                <div className="space-y-2">
                  <Label>تاريخ الانتهاء (اختياري)</Label>
                  <DateField value={form.plannedEndDate} onChange={e => setForm({...form, plannedEndDate: e.target.value})} />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label>ملاحظات على الطلبية</Label>
                  <Input value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} placeholder="أضف أي تفاصيل أخرى يحتاجها فريق العمل..." />
                </div>
              </div>
            </div>
          )}

          {tab === "materials" && (
            <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2">
              <div className="bg-slate-50 border p-4 rounded-lg text-sm text-slate-700 leading-relaxed">
                يُحمّل قالب المكونات النشط تلقائياً ويُضرب في كمية الأمر. تكلفة المعاينة من متوسط تكلفة مخزن الخامات، وتُثبّت التكلفة الفعلية عند صرف المواد.
              </div>

              {!form.productItemId ? (
                <div className="text-center py-12 text-slate-400">يرجى اختيار المنتج النهائي في التبويب الأول أولاً.</div>
              ) : previewLoading ? (
                <div className="text-center py-12 text-slate-500">جاري تحميل الوصفة النشطة...</div>
              ) : !bomPreview?.lines?.length ? (
                <div className="border-2 border-dashed rounded-xl p-8 text-center space-y-4">
                  <div className="inline-flex items-center justify-center p-3 bg-amber-100 text-amber-600 rounded-full">
                    <Boxes className="h-6 w-6" />
                  </div>
                  <div>
                    <h4 className="font-semibold text-slate-800 mb-1">لا توجد وصفة (قائمة مواد) نشطة لهذا المنتج</h4>
                    <p className="text-sm text-slate-500">القالب المختار يحفظ إعدادات الأمر فقط ولا يحتوي وصفة. يجب إنشاء قائمة مواد نشطة قبل حفظ الأمر.</p>
                  </div>
                  {!creatingBom ? (
                     <Button onClick={() => { setCreatingBom(true); setNewBomLines([{ itemId: "", quantity: "1", unitCode: "" }]); }} disabled={!canEdit}>
                      <Plus className="ml-2 h-4 w-4" />
                      إنشاء وصفة مكونات الآن
                    </Button>
                  ) : (
                    <div className="max-w-xl mx-auto bg-white border shadow-sm rounded-lg p-4 text-right space-y-3">
                      <h4 className="font-semibold border-b pb-2 mb-3">وصفة جديدة لـ {catalog.items.find(i=>String(i.id)===form.productItemId)?.nameAr}</h4>
                      {newBomLines.map((line, i) => (
                        <div key={i} className="flex gap-2 items-end">
                          <div className="flex-[2] space-y-1">
                            <Label className="text-xs">المادة</Label>
                            <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                              value={line.itemId} onChange={e => {
                                 setNewBomLines(lines => lines.map((line, index) => index === i
                                   ? { ...line, itemId: e.target.value }
                                   : line));
                              }}>
                              <option value="">اختر مادة...</option>
                               {materialItems.map(it => <option key={it.id} value={it.id}>{it.nameAr}</option>)}
                            </select>
                          </div>
                          <div className="flex-[1] space-y-1">
                            <Label className="text-xs">الكمية</Label>
                            <Input type="text" inputMode="decimal" className="h-9" value={line.quantity} onChange={e => {
                               setNewBomLines(lines => lines.map((line, index) => index === i
                                 ? { ...line, quantity: e.target.value }
                                 : line));
                            }} />
                          </div>
                          <div className="flex-[1] space-y-1">
                            <Label className="text-xs">الوحدة (فارغ=الأساسية)</Label>
                            <select className="flex h-9 w-full rounded-md border border-input bg-slate-50 px-2 py-1 text-xs shadow-sm"
                              value={line.unitCode} onChange={e => {
                                 setNewBomLines(lines => lines.map((line, index) => index === i
                                   ? { ...line, unitCode: e.target.value }
                                   : line));
                              }}>
                              <option value="">(افتراضي)</option>
                               {catalog.units?.map(u => <option key={u.id} value={u.code}>{u.code}</option>)}
                            </select>
                          </div>
                          <Button variant="ghost" size="icon" className="h-9 w-9 text-destructive shrink-0"
                             onClick={() => setNewBomLines(lines => lines.filter((_, idx) => idx !== i))}
                             disabled={newBomLines.length <= 1}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                      <div className="pt-2 flex justify-between">
                       <Button variant="outline" size="sm" onClick={() => setNewBomLines(lines => [...lines, { itemId: "", quantity: "1", unitCode: "" }])} disabled={!canEdit}>
                          إضافة مادة أخرى
                        </Button>
                        <div className="flex gap-2">
                          <Button variant="ghost" size="sm" onClick={() => setCreatingBom(false)}>إلغاء</Button>
                           <Button size="sm" onClick={handleCreateBom} disabled={busy || !canEdit || !newBomLines.length || newBomLines.some(l => !l.itemId || !(Number(l.quantity) > 0))}>حفظ وتطبيق</Button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <Card className="border-emerald-100 shadow-none">
                  <CardHeader className="bg-emerald-50/30 pb-3 border-b border-emerald-100">
                    <CardTitle className="text-emerald-800 text-base">{bomPreview.template?.nameAr || bomPreview.nameAr}</CardTitle>
                    <CardDescription>الوصفة المعتمدة للمنتج المختار</CardDescription>
                  </CardHeader>
                  <CardContent className="pt-4">
                    <div className="divide-y rounded-lg border">
                      {(bomPreview.lines ?? []).map((l: any) => (
                        <div key={l.id} className="p-3 flex justify-between items-center text-sm hover:bg-slate-50">
                           <span className="font-medium text-slate-700">
                             {l.itemNameAr || l.itemNameEn || l.description || `صنف #${l.itemId}`}
                           </span>
                          <div className="flex items-center gap-2">
                            <span className="text-slate-400 text-xs">الكمية للوحدة:</span>
                            <span className="font-mono bg-slate-100 px-2 py-0.5 rounded border">{l.quantity} {l.unitCode}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {tab === "routing" && (
            <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2">
              <div className="bg-slate-50 border p-4 rounded-lg text-sm text-slate-700 leading-relaxed">
                تُنسخ المراحل من مسار الإنتاج النشط كـ لقطة (Snapshot) مستقلة للأمر، فلا تغيّر التعديلات اللاحقة على المسار تاريخ هذا الأمر.
                <br/><strong className="text-slate-900 mt-2 block">ملاحظة: يمكنك متابعة الأمر بدون مراحل إذا كان الإنتاج بسيطاً ويتم بخطوة واحدة.</strong>
              </div>

              {!form.productItemId ? (
                <div className="text-center py-12 text-slate-400">يرجى اختيار المنتج النهائي أولاً.</div>
              ) : previewLoading ? (
                <div className="text-center py-12 text-slate-500">جاري تحميل مسار الإنتاج...</div>
              ) : !routingPreview ? (
                <div className="text-center py-12 text-slate-500 border-2 border-dashed rounded-xl bg-slate-50/50">
                  لا يوجد مسار نشط لهذا المنتج.
                  <p className="text-xs mt-1">سيتم تنفيذ الإنتاج كمرحلة واحدة مباشرة.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-3 relative before:absolute before:inset-y-0 before:start-[19px] before:w-0.5 before:bg-violet-100 pl-8">
                  {(routingPreview.stages ?? []).map((s: any, i: number) => (
                    <div key={s.id} className="relative rounded-lg border bg-white p-4 shadow-sm">
                      <div className="absolute top-1/2 -translate-y-1/2 -start-11 w-6 h-6 rounded-full bg-violet-100 border-2 border-violet-500 flex items-center justify-center text-xs font-bold text-violet-700 z-10">
                        {i + 1}
                      </div>
                      <div className="font-semibold text-slate-800">{s.nameAr}</div>
                      <div className="text-xs text-slate-500 mt-1 flex items-center gap-4">
                        <span>المدة المتوقعة: {s.expectedDurationMinutes || 0} دقيقة</span>
                        <span>تكلفة إضافية: {s.expectedCost || 0}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "resources" && (
            <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2">
              <Card className="border-amber-200 bg-amber-50/40 shadow-none">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base text-amber-900">إعداد حسابات ترحيل التصنيع</CardTitle>
                  <CardDescription className="text-amber-800">
                    تُستخدم حسابات الشركة الموجودة فقط. حفظ المسودة لا يرحّل قيداً ولا يحتاج حساب WIP؛ يلزم حفظ حساب WIP وحساب مخزون الخامات قبل بدء الإنتاج.
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-3 space-y-4">
                  {accountingAccounts.length === 0 ? (
                    <div className="rounded-lg border border-amber-300 bg-white p-3 text-sm text-amber-900">
                      لا توجد حسابات ترحيل نشطة في دليل حسابات الشركة. أضف حسابات قابلة للترحيل من دليل الحسابات ثم عد إلى هنا.
                    </div>
                  ) : (
                    <div className="grid md:grid-cols-3 gap-4">
                      {[
                        {
                          key: "defaultWipAccountId" as const,
                          label: "حساب إنتاج تحت التشغيل WIP",
                          required: true,
                        },
                        {
                          key: "defaultRawInventoryAccountId" as const,
                          label: "حساب مخزون الخامات",
                          required: true,
                        },
                        {
                          key: "defaultFinishedGoodsAccountId" as const,
                          label: "حساب مخزون الإنتاج التام (اختياري)",
                          required: false,
                        },
                      ].map(field => (
                        <div key={field.key} className="space-y-2">
                          <Label>{field.label} {field.required && <span className="text-red-500">*</span>}</Label>
                          <select
                            className="flex h-10 w-full rounded-md border border-input bg-white px-3 py-2 text-sm shadow-sm"
                            value={accountSettings[field.key]}
                            onChange={e => setAccountSettings(current => ({
                              ...current,
                              [field.key]: e.target.value,
                            }))}
                          >
                            <option value="">اختر حساباً من دليل الشركة...</option>
                            {accountingAccounts.map(account => (
                              <option key={account.id} value={account.id}>
                                {account.code} — {account.nameAr}
                              </option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-amber-200 pt-3">
                    <p className="text-xs text-amber-800">
                      اختيارات المخازن أدناه تُحفظ مع أمر التصنيع نفسه، وليست إعداد مخزن مستقلاً.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void saveAccounting().catch(() => {})}
                      disabled={busy || !canEdit || !hasRequiredAccounting || accountingAccounts.length === 0}
                      className="border-amber-300 bg-white text-amber-900 hover:bg-amber-100"
                    >
                      <Save className="ml-2 h-4 w-4" />
                      حفظ حسابات التصنيع
                    </Button>
                  </div>
                </CardContent>
              </Card>
              <div className="grid md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <Label>مخزن سحب الخامات <span className="text-red-500">*</span></Label>
                  <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm"
                    value={form.rawWarehouseId} onChange={e => setForm({...form, rawWarehouseId: e.target.value})}>
                    <option value="">اختر المخزن...</option>
                    {catalog.warehouses.map(w => <option key={w.id} value={w.id}>{w.nameAr}</option>)}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label>مستودع إيداع الإنتاج التام <span className="text-red-500">*</span></Label>
                  <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm"
                    value={form.finishedWarehouseId} onChange={e => setForm({...form, finishedWarehouseId: e.target.value})}>
                    <option value="">اختر المخزن...</option>
                    {catalog.warehouses.map(w => <option key={w.id} value={w.id}>{w.nameAr}</option>)}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label>مركز العمل (اختياري)</Label>
                  <Input placeholder="مثال: ورشة رقم 1" value={form.workCenterId} onChange={e => setForm({...form, workCenterId: e.target.value})} disabled />
                  <p className="text-xs text-slate-400">إدارة مراكز العمل متاحة في النسخة المتقدمة</p>
                </div>
                <div className="space-y-2">
                  <Label>إجمالي الساعات المخططة</Label>
                  <Input type="text" inputMode="decimal" value={form.plannedHours} onChange={e => setForm({...form, plannedHours: e.target.value})} className="h-10 text-left" dir="ltr" />
                  <p className="text-xs text-slate-500">يُستخدم هذا الرقم لتوزيع تكلفة الإهلاك والإيجار على الأمر بدقة.</p>
                </div>
              </div>
            </div>
          )}

          {tab === "costs" && (
            <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2">
              <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between bg-violet-50/50 p-4 rounded-xl border border-violet-100">
                <div className="space-y-1">
                  <h4 className="font-semibold text-violet-900">مصادر التكلفة الإضافية</h4>
                  <p className="text-xs text-violet-700/80">اختر المصادر (رواتب، إهلاك) التي ترغب بتحميل جزء من تكلفتها على هذا الأمر.</p>
                </div>
                <div className="w-full md:w-48 space-y-1">
                  <Label className="text-xs text-violet-800">تصفية حسب شهر التكلفة</Label>
                  <Input type="month" value={form.costPeriod} onChange={e => setForm({...form, costPeriod: e.target.value})} className="h-9 border-violet-200" />
                </div>
              </div>

              {!canPost && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  لا تملك صلاحية ترحيل التصنيع المبسط؛ ستظل بطاقات المصادر ظاهرة للقراءة، لكن لا يمكن اختيار مصدر أو بدء أمر بهذه التوزيعات.
                </div>
              )}
              {costSources.length === 0 ? (
                <div className="space-y-3">
                  {[
                    { type: "payroll", title: "أجور ورواتب (HR)", access: canViewPayroll, href: "/hr/payroll", hint: "فعّل أهلية التصنيع لمسير الرواتب، وحدد ساعات التصنيع الشهرية المعتمدة، ثم رحّل المسير وقيده." },
                    { type: "fixed_asset_depreciation", title: "إهلاك الأصول والآلات", access: canViewAssets, href: "/fixed-assets/assets", hint: "من الأصل ← ربط التصنيع: فعّل الاستخدام في التصنيع وحدد الساعات المعتمدة أو سعر الساعة، ثم رحّل إهلاك الشهر." },
                    { type: "prepaid_amortization", title: "إيجارات ومصروفات مقدمة", access: canViewJournals, href: "/accounting/adjustments", hint: "من المصروفات المقدمة: فعّل أهلية التصنيع للإيجار وحدد كمية الإنتاج المعتمدة، ثم رحّل قسط الاستهلاك للشهر." },
                  ].map(source => (
                    <div key={source.type} className="rounded-xl border bg-white p-4 flex items-center justify-between gap-3">
                      <div>
                        <div className="font-semibold text-slate-700">{source.title}</div>
                        <div className="text-xs text-slate-500 mt-1">لا توجد مصادر مرحّلة ومؤهلة لشهر {form.costPeriod}.</div>
                        <div className="text-xs text-slate-400 mt-1">{source.hint}</div>
                        {!source.access && <div className="text-xs text-amber-700 mt-1">لا تملك صلاحية فتح إعداد مالك هذا المصدر؛ يمكن اختيار مصادره فقط بصلاحية ترحيل التصنيع المبسط.</div>}
                      </div>
                      {source.access && (
                        <Link href={source.href}>
                          <a className="text-xs text-violet-700 hover:underline whitespace-nowrap">فتح الإعدادات</a>
                        </Link>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-3">
                  {/* explicit groups */}
                  {['payroll', 'fixed_asset_depreciation', 'prepaid_amortization', 'other'].map(groupType => {
                    const groupSources = costSources.filter(s =>
                      groupType === 'other' ? !['payroll', 'fixed_asset_depreciation', 'prepaid_amortization'].includes(s.sourceType)
                      : s.sourceType === groupType
                    );

                    if (groupSources.length === 0) return null;

                    const groupTitle = groupType === 'payroll' ? 'أجور ورواتب (HR)' :
                                       groupType === 'fixed_asset_depreciation' ? 'إهلاك الأصول والآلات' :
                                       groupType === 'prepaid_amortization' ? 'إيجارات ومصروفات مقدمة' : 'تكاليف غير مباشرة أخرى';

                    return (
                      <div key={groupType} className="border rounded-xl overflow-hidden">
                        <div className="bg-slate-50 px-4 py-2 border-b font-semibold text-slate-700 text-sm">{groupTitle}</div>
                        <div className="divide-y">
                          {groupSources.map(s => {
                            const key = `${s.sourceType}:${s.sourceRecordId}`;
                            const isSelected = allocations[key] === "1";
                            const ownerAccess = s.sourceType === "payroll"
                              ? canViewPayroll
                              : s.sourceType === "fixed_asset_depreciation"
                                ? canViewAssets
                                : canViewJournals;
                            const canSelect = canPost && Number(s.availableAmount ?? s.sourceAmount) > 0;
                            return (
                              <div key={key} className={`p-4 grid md:grid-cols-[1fr_120px_160px] gap-4 items-center transition-colors ${isSelected ? 'bg-violet-50/30' : ''}`}>
                                <div>
                                  <label className="flex items-start gap-3 cursor-pointer">
                                    <input type="checkbox" className="mt-1 h-4 w-4 rounded text-violet-600 focus:ring-violet-500"
                                      disabled={!canSelect}
                                      checked={isSelected}
                                      onChange={e => setAllocations(current => ({...current, [key]: e.target.checked ? "1" : ""}))}
                                    />
                                    <div>
                                      <b className="text-sm block text-slate-800">{s.label}</b>
                                      <p className="text-xs text-slate-500 mt-0.5">
                                        مبلغ المصدر: {Number(s.availableAmount || s.sourceAmount).toLocaleString()} • {s.meta?.allocationMethod || s.basis}
                                      </p>
                                       {!ownerAccess && <p className="text-xs text-amber-700 mt-1">لا تملك صلاحية فتح إعداد مالك المصدر؛ يظل اختيار المصدر محكوماً بصلاحية ترحيل التصنيع المبسط.</p>}
                                       {ownerAccess && Number(s.availableAmount ?? s.sourceAmount) <= 0 && <p className="text-xs text-slate-500 mt-1">تم توزيع كامل المصدر.</p>}
                                    </div>
                                  </label>
                                </div>
                                <div className="text-sm font-semibold text-slate-700 bg-white border px-3 py-1.5 rounded-lg text-center shadow-sm">
                                  {/* Calculate live amount */}
                                  {(() => {
                                    const method = s.meta?.allocationMethod || s.basis;
                                    let amt = 0;
                                    if (s.sourceType === "prepaid_amortization")
                                      amt = Number(s.sourceAmount) * Number(form.plannedQty || 0) / Number(s.meta?.approvedProductionQuantity || 1);
                                    else if (s.sourceType === "fixed_asset_depreciation" && method === "fixed_hourly_rate")
                                      amt = Number(form.plannedHours || 0) * Number(s.meta?.fixedManufacturingRate || 0);
                                    else
                                      amt = Number(s.sourceAmount) * Number(form.plannedHours || 0) / Number(s.meta?.approvedManufacturingHours || s.meta?.approvedOperatingHours || 1);
                                    return amt.toLocaleString(undefined, {maximumFractionDigits: 2});
                                  })()}
                                </div>
                                <select className="w-full text-xs rounded-lg border-slate-200 bg-white h-9 shadow-sm"
                                  disabled={!isSelected || !canSelect}
                                  value={sourceTreatments[key] || "manufacturing_overhead"}
                                   onChange={e => setSourceTreatments(current => ({...current, [key]: e.target.value}))}>
                                  <option value="manufacturing_overhead">تكلفة صناعية غير مباشرة</option>
                                  <option value="quality_prevention">تكلفة جودة وقائية</option>
                                  <option value="operating">مصاريف تشغيلية</option>
                                </select>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {tab === "review" && (
            <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2">
               {(() => {
                 const materialEstimate = calculateMaterialEstimate();
                 const manufacturingAllocation = calculateAllocatedTotal();
                 const totalEstimate = materialEstimate == null
                   ? null
                   : materialEstimate + manufacturingAllocation;
                 const unitEstimate = totalEstimate == null || !(Number(form.plannedQty) > 0)
                   ? null
                   : totalEstimate / Number(form.plannedQty);
                 return (
                   <>
              <div className="bg-slate-50 rounded-xl p-6 border text-center space-y-2">
                <h3 className="text-xl font-bold text-slate-800">{form.title || "بدون عنوان"}</h3>
                <p className="text-slate-500">
                  سيتم تصنيع <strong className="text-slate-900">{form.plannedQty} {form.unitCode}</strong> من <strong className="text-slate-900">{catalog.items.find(i=>String(i.id)===form.productItemId)?.nameAr || "—"}</strong>
                </p>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="border rounded-xl p-4">
                  <div className="text-xs font-semibold text-slate-500 uppercase mb-3">ملخص المخازن والمسار</div>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between"><span className="text-slate-500">سحب الخامات:</span> <span className="font-medium">{catalog.warehouses.find(w=>String(w.id)===form.rawWarehouseId)?.nameAr || "—"}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">إيداع الإنتاج:</span> <span className="font-medium">{catalog.warehouses.find(w=>String(w.id)===form.finishedWarehouseId)?.nameAr || "—"}</span></div>
                     <div className="flex justify-between"><span className="text-slate-500">الوصفة:</span> <span className="font-medium">{bomPreview?.lines?.length ? "جاهزة للتحميل" : "بدون وصفة"}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">المراحل:</span> <span className="font-medium">{routingPreview?.stages?.length ? `${routingPreview.stages.length} مراحل` : "مباشر (خطوة واحدة)"}</span></div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">حسابات بدء الإنتاج:</span>
                        <span className={`font-medium ${hasRequiredAccounting ? "text-emerald-700" : "text-amber-700"}`}>
                          {hasRequiredAccounting ? "مضبوطة" : "تحتاج إعداداً في الموارد"}
                        </span>
                      </div>
                  </div>
                </div>
                <div className="border rounded-xl p-4 bg-violet-50/30">
                  <div className="text-xs font-semibold text-violet-700 uppercase mb-3">مؤشرات التكلفة (تقديري)</div>
                  <div className="space-y-3">
                    <div className="flex justify-between items-center text-sm">
                       <span className="text-slate-600">تكلفة المواد من الوصفة:</span>
                       <span className="font-bold text-violet-700">
                         {materialEstimate == null ? "تثبت عند الصرف" : materialEstimate.toLocaleString(undefined, {maximumFractionDigits: 2})}
                       </span>
                     </div>
                     <div className="flex justify-between items-center text-sm">
                       <span className="text-slate-600">توزيع التصنيع المختار:</span>
                       <span className="font-bold text-violet-700">{manufacturingAllocation.toLocaleString(undefined, {maximumFractionDigits: 2})}</span>
                     </div>
                     <div className="flex justify-between items-center text-sm pt-2 border-t border-violet-100">
                       <span className="text-slate-600">إجمالي تكلفة الأمر التقديرية:</span>
                       <span className="font-bold text-lg text-violet-800">
                         {totalEstimate == null ? "تثبت عند الصرف" : totalEstimate.toLocaleString(undefined, {maximumFractionDigits: 2})}
                       </span>
                    </div>
                    <div className="flex justify-between items-center text-sm pt-2 border-t border-violet-100">
                       <span className="text-slate-600">نصيب الوحدة (مواد + تصنيع):</span>
                       <span className="font-bold text-violet-700">{unitEstimate == null ? "تثبت عند الصرف" : unitEstimate.toLocaleString(undefined, {maximumFractionDigits: 2})}</span>
                    </div>
                    <div className="text-xs text-slate-400 mt-2">
                       * لا تُخفي الشاشة تكلفة المواد خلف توزيع المصادر؛ إذا لم تُعد الوصفة تكلفة معاينة، يثبت إجمالي المواد وتكلفة الوحدة عند صرفها من المخزن.
                    </div>
                  </div>
                </div>
              </div>

                   </>
                 );
               })()}
            </div>
          )}
        </CardContent>
      </Card>
      <div className="sticky bottom-3 z-10 flex flex-col gap-3 rounded-xl border bg-white/95 p-3 shadow-lg backdrop-blur sm:flex-row sm:items-center">
        <Button variant="outline" className="sm:ml-auto" onClick={onCancel} disabled={busy}>
          إلغاء
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setTab(steps[Math.max(0, steps.findIndex(step => step.id === tab) - 1)]!.id)}
          disabled={busy || tab === "basic"}
        >
          السابق
        </Button>
        {tab !== "review" && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setTab(steps[Math.min(steps.length - 1, steps.findIndex(step => step.id === tab) + 1)]!.id)}
            disabled={busy}
          >
            التالي
          </Button>
        )}
        <Button
          type="button"
          variant="secondary"
          onClick={() => void submit("draft")}
          disabled={busy || !canCreate}
        >
          <Save className="ml-2 h-4 w-4" />
          حفظ مسودة
        </Button>
        <Button
          type="button"
          className="bg-violet-600 text-white shadow-md hover:bg-violet-700"
          onClick={() => {
            if (tab !== "review") setTab("review");
            else void submit("execute");
          }}
          disabled={busy || !canCreate || !canPost}
        >
          <Play className="ml-2 h-4 w-4" />
          مراجعة وبدء الإنتاج
        </Button>
      </div>
    </div>
  );
}
