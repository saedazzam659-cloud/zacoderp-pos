import { useState, useEffect, useRef, useCallback } from "react";
import { manufacturingProducts } from "./productOptions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ClipboardList, Boxes, GitBranch, Cog, Calculator, CheckCircle2, Save, Play, Plus, Trash2, RefreshCw } from "lucide-react";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { DateField } from "@/components/ui/date-field";
import type {
  WizardState,
  Catalog,
  ManufacturingCostCategory,
  ManufacturingCostConfiguration,
  ManufacturingCostMode,
} from "./types";
import { useToast } from "@/hooks/use-toast";
import { usePermission } from "@/hooks/usePermission";
import { useAuth } from "@/contexts/AuthContext";
import { saveUiPrefs } from "@/lib/uiPrefsApi";
import {
  DEFAULT_SIMPLE_MANUFACTURING_COST_MODES,
  sanitizeSimpleManufacturingCostModes,
  serializeSimpleManufacturingCostModes,
  simpleManufacturingCostPrefsScreen,
} from "./costPreferences";

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
    defaultWasteAccountId: number | null;
    electricityTariffPerKwh?: number | null;
  }) => Promise<unknown>;
  onSubmit: (mode: "draft" | "execute", payload: any) => Promise<void>;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const { actingCompanyId, user, setUser } = useAuth();
  const [tab, setTab] = useState<"basic" | "materials" | "routing" | "resources" | "costs" | "review">("basic");
  const [form, setForm] = useState<WizardState>({
    title: "", productItemId: "", plannedQty: "1", unitCode: "PCE", notes: "",
    plannedStartDate: new Date().toISOString().slice(0, 10), plannedEndDate: "",
    rawWarehouseId: catalog.warehouses[0]?.id ? String(catalog.warehouses[0].id) : "",
    finishedWarehouseId: catalog.warehouses[0]?.id ? String(catalog.warehouses[0].id) : "",
    workCenterId: "", plannedHours: "1", costPeriod: new Date().toISOString().slice(0, 7),
    templateId: "", sourceOrderId: null, resourceCostingVersion: false, costPolicy: { packaging: "primary", quality: "appraisal", wasteTreatment: "normal_manufacturing", reworkTreatment: "internal_failure", certificationLayer: "manufacturing", royaltyLayer: "economic", warrantyLayer: "operating" }
  });

  const [bomPreview, setBomPreview] = useState<any>(null);
  const [routingPreview, setRoutingPreview] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [costSources, setCostSources] = useState<any[]>([]);
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [sourceTreatments, setSourceTreatments] = useState<Record<string, string>>({});
  const [costModes, setCostModes] = useState<Record<ManufacturingCostCategory, ManufacturingCostMode>>({
    ...DEFAULT_SIMPLE_MANUFACTURING_COST_MODES,
  });
  const [costSourcesState, setCostSourcesState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [costSourcesError, setCostSourcesError] = useState<string | null>(null);
  const [resourceCostReadiness, setResourceCostReadiness] = useState<{ loading: boolean; ready: boolean; reason: string | null }>({
    loading: true, ready: false, reason: null,
  });
  const [costSourcesRefreshKey, setCostSourcesRefreshKey] = useState(0);
  const [costPrefsHydratedKey, setCostPrefsHydratedKey] = useState<string | null>(null);
  const [costPrefsSaveState, setCostPrefsSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [costPrefsAutosaveRevision, setCostPrefsAutosaveRevision] = useState(0);
  const costPrefsLastSavedRef = useRef<string | null>(null);
  const costPrefsContextRef = useRef<string | null>(null);
  const costPrefsHydratedKeyRef = useRef<string | null>(null);
  const costPrefsSerializedRef = useRef<string | null>(null);
  const costPrefsSaveInFlightRef = useRef<string | null>(null);
  const costPrefsOperationRef = useRef(0);
  const [manualCosts, setManualCosts] = useState<ManufacturingCostConfiguration>({
    payroll: { mode: "manual", amount: "", description: "", counterpartAccountId: "" },
    fixed_asset_depreciation: { mode: "manual", amount: "", description: "", counterpartAccountId: "" },
    prepaid_amortization: { mode: "manual", amount: "", description: "", counterpartAccountId: "" },
  });
  const [accountSettings, setAccountSettings] = useState({
    defaultWipAccountId: "",
    defaultRawInventoryAccountId: "",
    defaultFinishedGoodsAccountId: "",
    defaultWasteAccountId: "",
    electricityTariffPerKwh: "",
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

  const costPrefsTenantId = actingCompanyId ?? user?.companyId ?? null;
  const costPrefsScope = user
    ? `${String(user.id)}:${String(costPrefsTenantId ?? "none")}`
    : null;
  const costPrefsScreen = simpleManufacturingCostPrefsScreen(user?.id, costPrefsTenantId);
  const costPrefsContext = costPrefsScope && costPrefsScreen
    ? `${costPrefsScope}:${costPrefsScreen}`
    : null;
  costPrefsContextRef.current = costPrefsContext;
  costPrefsHydratedKeyRef.current = costPrefsHydratedKey;
  const serializedCostModes = JSON.stringify(sanitizeSimpleManufacturingCostModes(costModes));
  costPrefsSerializedRef.current = serializedCostModes;
  const costPrefsHydrated = !!costPrefsScope && costPrefsHydratedKey === costPrefsScope;
  const costPrefsDirty = costPrefsHydrated &&
    costPrefsLastSavedRef.current !== serializedCostModes;

  const canCreate = usePermission("simple_manufacturing", "create");
  const canEdit = usePermission("simple_manufacturing", "edit");
  const canPost = usePermission("simple_manufacturing", "post");

  // Durable cost-mode hydration is explicitly scoped to the authenticated
  // user + effective tenant. The key guard prevents an acting-company switch
  // from applying (or saving) another tenant's modes.
  useEffect(() => {
    if (!user || !costPrefsScope || !costPrefsScreen) {
      setCostPrefsHydratedKey(null);
      costPrefsLastSavedRef.current = null;
      return;
    }
    if (costPrefsHydratedKey === costPrefsScope) return;
    const persisted = user.uiPreferences?.[costPrefsScreen];
    const modes = sanitizeSimpleManufacturingCostModes(persisted);
    setCostModes(modes);
    costPrefsLastSavedRef.current = JSON.stringify(modes);
    setCostPrefsSaveState("idle");
    setCostPrefsHydratedKey(costPrefsScope);
  }, [user, costPrefsScope, costPrefsScreen, costPrefsHydratedKey]);

  // A request cannot be aborted through the small shared prefs client. Mark
  // the old operation stale immediately when the tenant/user context changes
  // so it cannot block a save in the new context.
  useEffect(() => {
    costPrefsSaveInFlightRef.current = null;
  }, [costPrefsContext]);

  const persistCostPreferences = useCallback(async (showSuccessToast: boolean) => {
    const operationContext = costPrefsContextRef.current;
    const operationScope = costPrefsScope;
    const operationScreen = costPrefsScreen;
    if (
      !user ||
      !operationContext ||
      !operationScope ||
      !operationScreen ||
      costPrefsHydratedKeyRef.current !== operationScope
    ) {
      if (showSuccessToast) {
        toast({
          title: "لم تكتمل تهيئة اختيارات التكاليف",
          description: "انتظر تحميل تفضيلات المستخدم ثم حاول الحفظ مرة أخرى.",
          variant: "destructive",
        });
      }
      return;
    }
    if (costPrefsSaveInFlightRef.current) return;

    const modes = sanitizeSimpleManufacturingCostModes(costModes);
    const payload = serializeSimpleManufacturingCostModes(modes);
    const serialized = JSON.stringify(modes);
    const operationId = `${operationContext}:${++costPrefsOperationRef.current}`;
    costPrefsSaveInFlightRef.current = operationId;
    setCostPrefsSaveState("saving");
    let succeeded = false;
    const isCurrentOperation = () =>
      costPrefsSaveInFlightRef.current === operationId &&
      costPrefsContextRef.current === operationContext &&
      costPrefsHydratedKeyRef.current === operationScope;

    try {
      // saveUiPrefs throws for every non-2xx response; an automatic failure is
      // intentionally left dirty for the explicit button, with no auto-retry.
      await saveUiPrefs(operationScreen, payload);
      if (!isCurrentOperation()) return;
      costPrefsLastSavedRef.current = serialized;
      // Keep a newly opened wizard in this same session in sync before the
      // next /auth/me refresh. The functional guard prevents a stale request
      // from writing an old tenant/user blob into a newly active context.
      setUser(current => {
        if (!isCurrentOperation()) return current;
        return current
          ? {
              ...current,
              uiPreferences: {
                ...(current.uiPreferences ?? {}),
                [operationScreen]: payload,
              },
            }
          : current;
      });
      succeeded = true;
      setCostPrefsSaveState("saved");
      if (showSuccessToast) toast({ title: "تم حفظ اختيارات طرق التكاليف" });
    } catch (error: any) {
      if (!isCurrentOperation()) return;
      setCostPrefsSaveState("error");
      if (showSuccessToast) {
        toast({
          title: "تعذر حفظ اختيارات التكاليف",
          description: error?.message || "حاول مرة أخرى.",
          variant: "destructive",
        });
      }
    } finally {
      if (costPrefsSaveInFlightRef.current === operationId) {
        costPrefsSaveInFlightRef.current = null;
        // A user may change modes while the previous request is in flight.
        // Re-arm one debounced pass after a successful save, but never turn a
        // failed automatic save into a retry loop.
        if (
          succeeded &&
          costPrefsContextRef.current === operationContext &&
          costPrefsHydratedKeyRef.current === operationScope &&
          costPrefsLastSavedRef.current !== costPrefsSerializedRef.current
        ) {
          setCostPrefsAutosaveRevision(value => value + 1);
        }
      }
    }
  }, [
    user,
    costPrefsScope,
    costPrefsScreen,
    costModes,
    setUser,
    toast,
  ]);

  // Remember mode choices without making the user press a button each time.
  // Hydration and tenant/user context are hard gates; the explicit button
  // remains available for immediate confirmation and for retrying an error.
  useEffect(() => {
    if (
      !user ||
      !costPrefsContext ||
      !costPrefsScope ||
      !costPrefsScreen ||
      costPrefsHydratedKey !== costPrefsScope ||
      costPrefsLastSavedRef.current === serializedCostModes
    ) {
      return;
    }
    const operationContext = costPrefsContext;
    const serialized = serializedCostModes;
    const timeout = setTimeout(() => {
      if (
        costPrefsContextRef.current !== operationContext ||
        costPrefsHydratedKeyRef.current !== costPrefsScope ||
        costPrefsLastSavedRef.current === serialized
      ) {
        return;
      }
      void persistCostPreferences(false);
    }, 800);
    return () => clearTimeout(timeout);
  }, [
    user,
    costPrefsContext,
    costPrefsScope,
    costPrefsScreen,
    costPrefsHydratedKey,
    serializedCostModes,
    costPrefsAutosaveRevision,
    persistCostPreferences,
  ]);

  useEffect(() => {
    const settings = catalog.accounting?.settings;
    if (!settings) return;
    setAccountSettings({
      defaultWipAccountId: settings.defaultWipAccountId ? String(settings.defaultWipAccountId) : "",
      defaultRawInventoryAccountId: settings.defaultRawInventoryAccountId ? String(settings.defaultRawInventoryAccountId) : "",
      defaultFinishedGoodsAccountId: settings.defaultFinishedGoodsAccountId ? String(settings.defaultFinishedGoodsAccountId) : "",
      defaultWasteAccountId: settings.defaultWasteAccountId ? String(settings.defaultWasteAccountId) : "",
      electricityTariffPerKwh: settings.electricityTariffPerKwh == null ? "" : String(settings.electricityTariffPerKwh),
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

  // Include configured BOM/routing/template outputs, not just nature labels.
  const fgItems = manufacturingProducts(catalog, form.productItemId);
  const fgComboItems = [
    { value: "", label: "—" },
    ...fgItems.map(i => ({ value: String(i.id), code: i.code, label: i.nameAr }))
  ];
  const materialItems = catalog.items.filter(i =>
    !i.itemNature || ["raw", "semi", "consumable"].includes(i.itemNature),
  );
  const selectedProduct = catalog.items.find(i => String(i.id) === form.productItemId);
  const plannedLaborPersonHours = (routingPreview?.stages ?? [])
    .filter((stage: any) => stage.resourceMode === "labor" || stage.resourceMode === "both")
    .reduce((sum: number, stage: any) =>
      sum + (Number(stage.expectedDurationMinutes || 0) / 60) * Number(stage.workerCount || 0), 0);
  const industrialSources = costSources.filter(source =>
    source.sourceType === "purchase_invoice" || source.sourceType === "purchase_return",
  );
  const productUnitOptions = selectedProduct?.unitOptions ?? (
    selectedProduct?.unitCode
      ? [{ code: selectedProduct.unitCode, nameAr: selectedProduct.unitCode, isBase: true }]
      : []
  );

  useEffect(() => {
    const controller = new AbortController();
    if (!token) {
      setResourceCostReadiness({ loading: false, ready: false, reason: "يلزم تسجيل الدخول للتحقق من جاهزية تكلفة الموارد." });
      return () => controller.abort();
    }
    setResourceCostReadiness({ loading: true, ready: false, reason: null });
    void request("/api/simple-manufacturing/resource-costing-readiness", { signal: controller.signal })
      .then((data: any) => {
        if (!controller.signal.aborted) {
          setResourceCostReadiness({
            loading: false,
            ready: data?.ready === true,
            reason: typeof data?.reason === "string" ? data.reason : null,
          });
        }
      })
      .catch((error: any) => {
        if (!controller.signal.aborted) setResourceCostReadiness({
          loading: false,
          ready: false,
          reason: error?.message || "تعذر التحقق من جاهزية تكلفة الموارد.",
        });
      });
    return () => controller.abort();
  }, [request, token]);

  useEffect(() => {
    if (!resourceCostReadiness.loading && !resourceCostReadiness.ready) {
      setForm(current => current.resourceCostingVersion
        ? { ...current, resourceCostingVersion: false }
        : current);
    }
  }, [resourceCostReadiness.loading, resourceCostReadiness.ready]);

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
      setCostSourcesError(null);
      setCostSourcesState("idle");
      return () => controller.abort();
    }
    setCostSourcesState("loading");
    setCostSourcesError(null);
    setCostSources([]);
    setAllocations({});
    setSourceTreatments({});
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
           setCostSourcesError(null);
           setCostSourcesState("loaded");
        }
      } catch (e: any) {
        if (e?.name !== "AbortError" && requestId === costRequestRef.current) {
          setCostSources([]);
          setAllocations({});
          setSourceTreatments({});
          setCostSourcesError(e?.message || "تعذر تحميل مصادر التكلفة");
          setCostSourcesState("error");
          toast({ title: "تعذر تحميل مصادر التكلفة", description: e.message, variant: "destructive" });
        }
      }
    };
    void load();
    return () => controller.abort();
  }, [request, token, form.costPeriod, costSourcesRefreshKey, toast]);

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
    const templateCosts = conf.costConfiguration && typeof conf.costConfiguration === "object"
      ? conf.costConfiguration as Partial<ManufacturingCostConfiguration> : {};
    const templateModes = {} as Record<ManufacturingCostCategory, ManufacturingCostMode>;
    const templateManuals = {} as ManufacturingCostConfiguration;
    (["payroll", "fixed_asset_depreciation", "prepaid_amortization"] as ManufacturingCostCategory[]).forEach(category => {
      const entry = templateCosts[category];
      const mode = entry?.mode === "linked" || entry?.mode === "manual" ? entry.mode : "none";
      templateModes[category] = mode;
      templateManuals[category] = {
        mode: "manual",
        amount: "",
        description: entry?.description || "",
        counterpartAccountId: entry?.counterpartAccountId ? String(entry.counterpartAccountId) : "",
      };
    });
    setForm(f => ({
      ...f,
      templateId: val,
      title: conf.title || f.title,
      productItemId: conf.productItemId ? String(conf.productItemId) : f.productItemId,
      plannedQty: conf.plannedQty ? String(conf.plannedQty) : f.plannedQty,
      unitCode: conf.unitCode || it?.unitOptions?.find(unit => unit.isBase)?.code || it?.unitCode || f.unitCode,
      rawWarehouseId: conf.rawWarehouseId ? String(conf.rawWarehouseId) : f.rawWarehouseId,
      finishedWarehouseId: conf.finishedWarehouseId ? String(conf.finishedWarehouseId) : f.finishedWarehouseId,
      plannedHours: conf.plannedHoursPerUnit && Number(nextPlannedQty) > 0 ? String(Number(conf.plannedHoursPerUnit) * Number(nextPlannedQty)) : f.plannedHours,
      notes: conf.notes || f.notes,
      costPolicy: conf.costPolicy || f.costPolicy,
    }));
    setCostModes(templateModes);
    setManualCosts(templateManuals);
    setAllocations({});
    setSourceTreatments({});
  };

  const costCategories: ManufacturingCostCategory[] = [
    "payroll", "fixed_asset_depreciation", "prepaid_amortization",
  ];

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
    for (const category of costCategories) {
      if (costModes[category] !== "manual") continue;
      const entry = manualCosts[category];
      const amount = Number(entry.amount || 0);
      if (!Number.isFinite(amount) || amount < 0) {
        toast({ title: "مبلغ تكلفة يدوية غير صحيح", variant: "destructive" });
        setTab("costs");
        return;
      }
      if (amount > 0 && (!entry.description.trim() || !entry.counterpartAccountId)) {
        toast({
          title: "بيانات التكلفة اليدوية ناقصة",
          description: "المبلغ الموجب يتطلب وصفاً وحساباً مقابلاً قابلاً للترحيل.",
          variant: "destructive",
        });
        setTab("costs");
        return;
      }
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
      String(configuredSettings?.defaultFinishedGoodsAccountId ?? "") !== accountSettings.defaultFinishedGoodsAccountId ||
      String(configuredSettings?.defaultWasteAccountId ?? "") !== accountSettings.defaultWasteAccountId
    );
    if (accountingChanged) {
      try {
        await onSaveAccounting({
          defaultWipAccountId: accountSettings.defaultWipAccountId ? Number(accountSettings.defaultWipAccountId) : null,
          defaultRawInventoryAccountId: accountSettings.defaultRawInventoryAccountId ? Number(accountSettings.defaultRawInventoryAccountId) : null,
          defaultFinishedGoodsAccountId: accountSettings.defaultFinishedGoodsAccountId ? Number(accountSettings.defaultFinishedGoodsAccountId) : null,
          defaultWasteAccountId: accountSettings.defaultWasteAccountId ? Number(accountSettings.defaultWasteAccountId) : null,
        });
      } catch {
        setTab("resources");
        return;
      }
    }
    const selectedPayrollSource = costModes.payroll === "linked" && costSources.some(source =>
      source.sourceType === "payroll" && allocations[`${source.sourceType}:${source.sourceRecordId}`] === "1",
    );
    if (form.resourceCostingVersion && selectedPayrollSource && !(plannedLaborPersonHours > 0)) {
      toast({
        title: "محرك ساعات العمالة المخططة مطلوب",
        description: "حدّد مدة متوقعة وعدد عمال موجباً لمراحل العمالة في مسار الإنتاج قبل ربط مصدر الرواتب.",
        variant: "destructive",
      });
      setTab("routing");
      return;
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
      ...(form.resourceCostingVersion && resourceCostReadiness.ready ? {
        resourceCostingVersion: 1,
        ...(selectedPayrollSource ? { plannedLaborPersonHours } : {}),
      } : {}),
      costPeriod: form.costPeriod,
      templateId: form.templateId ? Number(form.templateId) : null,
      costPolicy: form.costPolicy,
      costConfiguration: costCategories.reduce<Record<string, unknown>>((result, category) => {
        const entry = manualCosts[category];
        result[category] = {
          mode: costModes[category],
          amount: costModes[category] === "manual" ? Number(entry.amount || 0) : 0,
          description: costModes[category] === "manual" ? entry.description.trim() : "",
          counterpartAccountId: costModes[category] === "manual" && entry.counterpartAccountId
            ? Number(entry.counterpartAccountId) : null,
        };
        return result;
      }, {}),
      allocations: costSources.flatMap(s => {
        const key = `${s.sourceType}:${s.sourceRecordId}`;
        const category = s.sourceType as ManufacturingCostCategory;
        // Industrial purchase rows are existing posted overhead sources, not a
        // fourth manual-cost category.  Their source identity is submitted
        // unchanged so the server remains the sole owner of the allocation and
        // subsequent machine-hour reconciliation.
        const selected = (s.sourceType === "purchase_invoice" || s.sourceType === "purchase_return")
          ? allocations[key] === "1"
          : costModes[category] === "linked" && allocations[key] === "1";
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
      defaultWasteAccountId: accountSettings.defaultWasteAccountId
        ? Number(accountSettings.defaultWasteAccountId) : null,
      electricityTariffPerKwh: accountSettings.electricityTariffPerKwh
        ? Number(accountSettings.electricityTariffPerKwh) : null,
    });
  };

  const allocatedAmountForSource = (source: any): number => {
    const method = source.meta?.allocationMethod || source.basis;
    const sourceAmount = Number(source.sourceAmount || 0);
    const plannedQty = Number(form.plannedQty || 0);
    const plannedHours = Number(form.plannedHours || 0);
    let amount = 0;
    if (source.sourceType === "purchase_invoice") {
      const denominator = Number(source.meta?.approvedAllocationDriverTotal);
      const numerator = method === "production_quantity"
        ? plannedQty
        : method === "labor_hours"
          ? plannedLaborPersonHours
          : method === "machine_hours"
            ? plannedHours
            : 0;
      amount = numerator > 0 && denominator > 0 ? sourceAmount * numerator / denominator : 0;
    } else if (source.sourceType === "prepaid_amortization") {
      const denominator = Number(source.meta?.approvedProductionQuantity);
      amount = denominator > 0 ? sourceAmount * plannedQty / denominator : 0;
    } else if (source.sourceType === "fixed_asset_depreciation" && method === "fixed_hourly_rate") {
      amount = plannedHours * Number(source.meta?.fixedManufacturingRate || 0);
    } else {
      const denominator = Number(
        source.meta?.approvedManufacturingHours ?? source.meta?.approvedOperatingHours,
      );
      amount = denominator > 0 ? sourceAmount * plannedHours / denominator : 0;
    }
    return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
  };

  const manualAmountForCategory = (category: ManufacturingCostCategory): number => {
    const amount = Number(manualCosts[category].amount || 0);
    return Number.isFinite(amount) && amount > 0 ? Number(amount.toFixed(2)) : 0;
  };

  // Round each source before summing, matching the server's cent allocation.
  const calculateAllocatedTotal = () => {
    const linked = costSources.reduce((total, source) => {
      const key = `${source.sourceType}:${source.sourceRecordId}`;
      const industrial = source.sourceType === "purchase_invoice" || source.sourceType === "purchase_return";
      if (allocations[key] !== "1" ||
          (!industrial && costModes[source.sourceType as ManufacturingCostCategory] !== "linked")) return total;
      return total + allocatedAmountForSource(source);
    }, 0);
    const manual = costCategories.reduce((total, category) =>
      total + (costModes[category] === "manual" ? manualAmountForCategory(category) : 0), 0);
    return Number((linked + manual).toFixed(2));
  };

  // A BOM line is defined for the recipe's declared outputQty, not implicitly
  // for one finished unit. Keep the same dimensionless scale used by the
  // server when it snapshots/executes the order.
  const recipeOutputQty = Number(bomPreview?.outputQty);
  const recipeOutputUnit = bomPreview?.outputUnitCode || form.unitCode;
  const materialScale = Number.isFinite(recipeOutputQty) && recipeOutputQty > 0
    && Number.isFinite(Number(form.plannedQty)) && Number(form.plannedQty) > 0
    ? Number(form.plannedQty) / recipeOutputQty
    : null;

  const steps = [
    { id: "basic" as const, label: "البيانات الأساسية", icon: ClipboardList },
    { id: "materials" as const, label: "المواد والوصفة", icon: Boxes },
    { id: "routing" as const, label: "مسار الإنتاج", icon: GitBranch },
    { id: "resources" as const, label: "الموارد", icon: Cog },
    { id: "costs" as const, label: "التكاليف", icon: Calculator },
    { id: "review" as const, label: "المراجعة", icon: CheckCircle2 }
  ];
  const postingAccounts = (catalog.accounting?.accounts ?? []);
  const accountingAccounts = postingAccounts
    .filter(account => account.accountType === "asset");
  const wasteAccounts = postingAccounts
    .filter(account => account.accountType === "expense");
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
                       setForm(f => ({
                         ...f,
                         productItemId: v,
                         title: f.title.trim() ? f.title : (it?.nameAr ?? f.title),
                         unitCode: it?.unitOptions?.find(unit => unit.isBase)?.code || it?.unitCode || f.unitCode,
                       }));
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
                     <SearchCombobox
                       value={form.unitCode}
                       className="h-10"
                       placeholder="اختر وحدة مرتبطة بالمنتج..."
                       searchPlaceholder="ابحث عن وحدة..."
                       items={[
                         { value: "", label: "اختر وحدة..." },
                         ...productUnitOptions.map(unit => ({
                           value: unit.code,
                           code: unit.code,
                           label: unit.nameAr || unit.code,
                           labelEn: unit.nameEn || undefined,
                           description: unit.factor != null ? `المعامل إلى الأساسية ×${unit.factor}` : undefined,
                         })),
                       ]}
                       onValueChange={value => setForm({ ...form, unitCode: value })}
                     />
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
                            <SearchCombobox
                              value={line.itemId}
                              className="h-9"
                              placeholder="اختر مادة..."
                              searchPlaceholder="ابحث بالرمز أو الاسم..."
                              items={[
                                { value: "", label: "اختر مادة..." },
                                ...materialItems.map(it => ({
                                  value: String(it.id),
                                  code: it.code,
                                  label: it.nameAr,
                                  labelEn: it.nameEn || undefined,
                                })),
                              ]}
                              onValueChange={value => {
                                 const selected = catalog.items.find(item => String(item.id) === value);
                                 const baseCode = selected?.unitOptions?.find(unit => unit.isBase)?.code
                                   || selected?.unitCode || "";
                                 setNewBomLines(lines => lines.map((line, index) => index === i
                                   ? { ...line, itemId: value, unitCode: baseCode }
                                  : line));
                              }}
                            />
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
                            <SearchCombobox
                              value={line.unitCode}
                              className="h-9"
                              placeholder="(افتراضي)"
                              searchPlaceholder="ابحث عن الوحدة..."
                              items={[
                                { value: "", label: "(افتراضي)" },
                                ...((catalog.items.find(item => String(item.id) === line.itemId)?.unitOptions
                                  ?? []).map(u => ({
                                    value: u.code,
                                    code: u.code,
                                    label: u.nameAr || u.code,
                                    labelEn: u.nameEn || undefined,
                                    description: u.factor != null
                                      ? `المعامل إلى الأساسية ×${u.factor}`
                                      : undefined,
                                  }))),
                              ]}
                              onValueChange={value => {
                                setNewBomLines(lines => lines.map((line, index) => index === i
                                  ? { ...line, unitCode: value }
                                  : line));
                              }}
                            />
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
                    <CardDescription>
                      كميات المواد المطلوبة لإنتاج {Number(form.plannedQty || 0).toLocaleString("en-US", { maximumFractionDigits: 4 })} {form.unitCode} — تتحدث تلقائياً بنفس نسب الوصفة.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="pt-4">
                    <div className="divide-y rounded-lg border">
                      {(bomPreview.lines ?? []).map((l: any) => (
                        <div key={l.id} className="p-3 flex justify-between items-center text-sm hover:bg-slate-50">
                           <span className="font-medium text-slate-700">
                             {l.itemNameAr || l.itemNameEn || l.description || `صنف #${l.itemId}`}
                           </span>
                          <div className="flex flex-col items-end gap-1">
                            <span className="font-mono bg-emerald-50 text-emerald-900 px-2 py-0.5 rounded border border-emerald-200" data-testid={`material-required-${l.itemId}`}>
                               {materialScale != null && Number.isFinite(Number(l.quantity)) && l.usageFactor != null
                                 ? (Number(l.quantity) * materialScale * Number(l.usageFactorNumeric ?? l.usageFactor)).toLocaleString("en-US", { maximumFractionDigits: 6 })
                                 : "—"} {l.baseUnitCode || l.usageUnitCode || l.unitCode}
                            </span>
                            <span className="text-slate-400 text-xs">
                               أساس الاستخدام: {Number(l.quantity).toLocaleString("en-US", { maximumFractionDigits: 4 })} {l.usageUnitCode || l.unitCode}
                               {l.usageFactor != null ? ` × ${l.usageFactor} = ${(Number(l.quantity) * Number(l.usageFactorNumeric ?? l.usageFactor)).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${l.baseUnitCode || ""}` : " — لا يوجد ارتباط تحويل صالح"}
                               {" لكل "}{Number.isFinite(recipeOutputQty) && recipeOutputQty > 0 ? bomPreview.outputQty : "—"} {recipeOutputUnit}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="mt-3 text-xs text-slate-500">
                       المطلوب للمخزون = كمية الاستخدام × معامل وحدة الصنف × (الكمية المخططة ÷ كمية أساس الوصفة). لا تتغير الوصفة المحفوظة؛ تُحفظ كمية الاستخدام ووحدتها ومعاملها كلقطة تاريخية.
                    </p>
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
                <p className="mt-3 rounded-md border border-violet-200 bg-violet-50 p-3 text-violet-900">
                  هذه معاينة قبل إنشاء الأمر، وليست تسجيل التنفيذ الفعلي. بعد «مراجعة وبدء الإنتاج» ستفتح تفاصيل الأمر هنا، وفيها لكل مرحلة: ساعات تشغيل واحدة، عدد العمالة، الآلة، الكميات، والهالك وسببه وتصنيفه، مع زر حفظ وبدء وإنهاء المرحلة.
                </p>
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
                        <span>المدة (محرك التكلفة): {s.expectedDurationMinutes || 0} دقيقة</span>
                         <span>المورد: {s.resourceMode === "both" ? "آلة + عمالة" : s.resourceMode === "machine" ? "آلة" : "عمالة"}</span>
                         {(s.resourceMode === "labor" || s.resourceMode === "both") && <span>العمال: {s.workerCount ?? "—"}</span>}
                         {(s.resourceMode === "machine" || s.resourceMode === "both") && <span>الآلة: {s.resourceId == null ? "—" : `#${s.resourceId}`}</span>}
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
                     تُستخدم حسابات الشركة الموجودة والقابلة للترحيل فقط؛ لا ينشئ هذا النموذج حسابات تلقائياً.
                     حفظ المسودة لا يرحّل قيداً ولا يحتاج حساب WIP، لكن يلزم حفظ حساب إنتاج تحت التشغيل وحساب مخزون الخامات قبل بدء الإنتاج. حساب الإنتاج التام مطلوب عند الإقفال، وحساب الهالك مطلوب فقط إذا أدخلت كمية هالك موجبة.
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-3 space-y-4">
                  {accountingAccounts.length === 0 ? (
                    <div className="rounded-lg border border-amber-300 bg-white p-3 text-sm text-amber-900">
                      لا توجد حسابات ترحيل نشطة في دليل حسابات الشركة. أضف حسابات قابلة للترحيل من دليل الحسابات ثم عد إلى هنا.
                    </div>
                  ) : (
                    <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
                      {[
                        {
                          key: "defaultWipAccountId" as const,
                           label: "إنتاج تحت التشغيل (WIP) — أصل WIP",
                          required: true,
                          accounts: accountingAccounts,
                        },
                        {
                          key: "defaultRawInventoryAccountId" as const,
                           label: "مخزون الخامات — أصل المواد الخام",
                          required: true,
                          accounts: accountingAccounts,
                        },
                        {
                          key: "defaultFinishedGoodsAccountId" as const,
                           label: "مخزون الإنتاج التام — أصل المنتج (مطلوب قبل الإقفال)",
                          required: false,
                          accounts: accountingAccounts,
                        },
                        {
                          key: "defaultWasteAccountId" as const,
                          label: "حساب الهالك/الفروق — مصروف (اختياري)",
                          required: false,
                          accounts: wasteAccounts,
                        },
                      ].map(field => (
                        <div key={field.key} className="space-y-2">
                          <Label>{field.label} {field.required && <span className="text-red-500">*</span>}</Label>
                           <SearchCombobox
                             value={accountSettings[field.key]}
                             className="h-10"
                             placeholder="اختر حساباً من دليل الشركة..."
                             searchPlaceholder="ابحث بالرمز أو اسم الحساب..."
                             items={[
                               { value: "", label: "اختر حساباً من دليل الشركة..." },
                               ...(field.accounts ?? accountingAccounts).map(account => ({
                                 value: String(account.id),
                                 code: account.code,
                                 label: account.nameAr,
                                 labelEn: account.nameEn || undefined,
                               })),
                             ]}
                             onValueChange={value => setAccountSettings(current => ({
                               ...current,
                               [field.key]: value,
                             }))}
                           />
                           <p className="text-[11px] text-slate-500">
                             {accountSettings[field.key]
                                ? `المحدد: ${(field.accounts ?? accountingAccounts).find(account => String(account.id) === accountSettings[field.key])?.code ?? `#${accountSettings[field.key]}`}`
                                : field.key === "defaultWasteAccountId"
                                  ? "اختر حساب مصروف نشطاً وقابلاً للترحيل عند تسجيل هالك موجب."
                                  : "اختر حساباً موجوداً من دليل الشركة؛ لا يتم إنشاء حساب جديد هنا."}
                           </p>
                        </div>
                      ))}
                    </div>
                  )}
                   {accountSettings.defaultWipAccountId &&
                     accountSettings.defaultRawInventoryAccountId &&
                     accountSettings.defaultWipAccountId === accountSettings.defaultRawInventoryAccountId && (
                       <div className="rounded-lg border border-amber-300 bg-white p-3 text-xs text-amber-900">
                         تم اختيار الحساب نفسه لـ WIP ومخزون الخامات. راجع دليل الحسابات واختر الحسابين الصحيحين حسب طبيعة كل حساب؛ لن يتم إنشاء حساب بديل تلقائياً.
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
                  <SearchCombobox
                    value={form.rawWarehouseId}
                    className="h-10"
                    placeholder="اختر المخزن..."
                    searchPlaceholder="ابحث برمز أو اسم المخزن..."
                    items={[
                      { value: "", label: "اختر المخزن..." },
                      ...catalog.warehouses.map(w => ({
                        value: String(w.id),
                        code: w.code,
                        label: w.nameAr,
                      })),
                    ]}
                    onValueChange={value => setForm({...form, rawWarehouseId: value})}
                  />
                </div>
                <div className="space-y-2">
                  <Label>مستودع إيداع الإنتاج التام <span className="text-red-500">*</span></Label>
                  <SearchCombobox
                    value={form.finishedWarehouseId}
                    className="h-10"
                    placeholder="اختر المخزن..."
                    searchPlaceholder="ابحث برمز أو اسم المخزن..."
                    items={[
                      { value: "", label: "اختر المخزن..." },
                      ...catalog.warehouses.map(w => ({
                        value: String(w.id),
                        code: w.code,
                        label: w.nameAr,
                      })),
                    ]}
                    onValueChange={value => setForm({...form, finishedWarehouseId: value})}
                  />
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
              {resourceCostReadiness.ready ? <Card className={`shadow-none ${form.resourceCostingVersion ? "border-violet-300 bg-violet-50/40" : "border-slate-200"}`}>
                <CardContent className="space-y-3 pt-5">
                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded text-violet-600"
                      checked={form.resourceCostingVersion}
                      onChange={event => setForm(current => ({ ...current, resourceCostingVersion: event.target.checked }))}
                    />
                    <span>
                      <span className="block text-sm font-semibold text-slate-800">تفعيل تكلفة موارد المرحلة لهذا الأمر</span>
                      <span className="mt-1 block text-xs leading-6 text-slate-600">
                        خيار اختياري للأوامر الجديدة فقط. يستخدم ساعات تشغيل المرحلة الواحدة لحساب العمالة أو الإهلاك والكهرباء حسب المورد؛ لا يغيّر تكاليف أو أوامر سابقة.
                      </span>
                    </span>
                  </label>
                  {form.resourceCostingVersion && (
                    <div className="rounded-md border border-violet-200 bg-white p-3 text-xs leading-6 text-violet-950">
                      أكمل إعداد نوع المورد والآلة/عدد العمال في مسار الإنتاج. يحسب مصدر الرواتب المعتمد بساعات الشخص المخططة، بينما تحفظ نتائج المراحل كلقطات مصدرية ولا تُنشأ مصروفات مكررة.
                    </div>
                  )}
                </CardContent>
              </Card> : (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs leading-6 text-slate-600">
                  {resourceCostReadiness.loading
                    ? "يجري التحقق من جاهزية تكلفة موارد المراحل…"
                    : `تكلفة موارد المراحل غير متاحة حالياً${resourceCostReadiness.reason ? `: ${resourceCostReadiness.reason}` : ""}. لن يتغير سلوك الأوامر الحالية.`}
                </div>
              )}
              <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/40 p-4">
                <Label>تعريفة الكهرباء لكل kWh</Label>
                <Input
                  type="text"
                  inputMode="decimal"
                  dir="ltr"
                  value={accountSettings.electricityTariffPerKwh}
                  onChange={e => setAccountSettings(current => ({ ...current, electricityTariffPerKwh: e.target.value }))}
                  placeholder="مثال: 0.18"
                  className="max-w-xs bg-white"
                />
                <p className="text-xs leading-6 text-amber-900">
                  إعداد شركة قائم يُستخدم فقط للآلات التي فُعّل استهلاكها وتملك قدرة kW. لا توجد ساعات كهرباء منفصلة، ومرجع العداد/IoT يبقى مرجعاً مستقبلياً دون اتصال حي.
                </p>
              </div>
            </div>
          )}

          {tab === "costs" && (
            <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2">
              <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between bg-violet-50/50 p-4 rounded-xl border border-violet-100">
                <div className="space-y-1">
                  <h4 className="font-semibold text-violet-900">التكاليف الإضافية الفعلية</h4>
                  <p className="text-xs text-violet-700/80">اختر طريقة واحدة لكل بطاقة. لا تُرحّل أي تكلفة عند اختيار «بدون».</p>
                </div>
                <div className="flex w-full flex-col gap-3 md:w-auto md:items-end">
                  <div className="flex w-full flex-wrap items-end justify-end gap-2">
                    <div className="w-full space-y-1 md:w-48">
                      <Label className="text-xs text-violet-800">فترة المصادر المرتبطة</Label>
                      <Input type="month" value={form.costPeriod} onChange={e => setForm({...form, costPeriod: e.target.value})} className="h-9 border-violet-200" />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setCostSourcesRefreshKey(value => value + 1)}
                      disabled={costSourcesState === "loading" || !form.costPeriod}
                      className="border-violet-200 bg-white text-violet-800 hover:bg-violet-100"
                    >
                      <RefreshCw className={`ml-2 h-4 w-4 ${costSourcesState === "loading" ? "animate-spin" : ""}`} />
                      تحديث المصادر
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void persistCostPreferences(true)}
                      disabled={!costPrefsHydrated || costPrefsSaveState === "saving"}
                      className="border-violet-300 bg-white text-violet-900 hover:bg-violet-100"
                    >
                      <Save className="ml-2 h-4 w-4" />
                      {costPrefsSaveState === "saving" ? "جاري حفظ الاختيارات..." : "حفظ طرق التكاليف"}
                    </Button>
                    <span className="text-[11px] text-violet-700/80">
                      {!costPrefsHydrated
                        ? "جاري تحميل اختياراتك السابقة..."
                        : costPrefsSaveState === "error"
                          ? "تعذر الحفظ التلقائي؛ اضغط حفظ للمحاولة"
                        : costPrefsDirty
                          ? "توجد تغييرات غير محفوظة"
                          : "الاختيارات محفوظة لهذا المستخدم والشركة الحالية"}
                    </span>
                  </div>
                </div>
              </div>
              {costSourcesState === "loading" && (
                <div className="rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm text-violet-900">
                  جاري تحميل المصادر المرحّلة المؤهلة للفترة {form.costPeriod}...
                </div>
              )}
              {costSourcesState === "error" && (
                <div className="flex flex-col gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-semibold">تعذر تحميل مصادر التكلفة</p>
                    <p className="mt-1 text-xs">{costSourcesError || "حدث خطأ أثناء قراءة المصادر المرحّلة."}</p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setCostSourcesRefreshKey(value => value + 1)}
                    className="border-red-300 bg-white text-red-900 hover:bg-red-100"
                  >
                    <RefreshCw className="ml-2 h-4 w-4" />
                    إعادة المحاولة
                  </Button>
                </div>
              )}
              {costSourcesState === "loaded" && costSources.length === 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                  <p className="font-semibold">لا توجد مصادر مؤهلة للفترة {form.costPeriod}</p>
                  <p className="mt-1 text-xs leading-6">
                    يعرض الخادم فقط المصروفات المرحّلة بقيد مرحّل، والمؤهلة للتصنيع، وداخل شركتك وفروعك المسموح بها.
                    الرواتب تحتاج مسيرة منشورة/مدفوعة وساعات تصنيع معتمدة، والإهلاك يحتاج أصلاً مؤهلاً ومحرك توزيع صالحاً،
                    والمصروفات المقدمة تحتاج قسطاً مرحّلاً ومحرك كمية إنتاج صالحاً. لا يتم تجاوز قواعد الترحيل أو الشركة أو الفرع.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setCostSourcesRefreshKey(value => value + 1)}
                    className="mt-2 border-amber-300 bg-white text-amber-950 hover:bg-amber-100"
                  >
                    <RefreshCw className="ml-2 h-4 w-4" />
                    تحديث بعد إكمال الترحيل
                  </Button>
                </div>
              )}
              {!canPost && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  لا تملك صلاحية ترحيل التصنيع الذكي؛ ستظل بيانات المصادر للقراءة فقط.
                </div>
              )}
              <div className="grid gap-5 lg:grid-cols-3">
                {costCategories.map(category => {
                  const title = category === "payroll" ? "الرواتب والأجور"
                    : category === "fixed_asset_depreciation" ? "الإهلاك"
                    : "المصروفات المقدمة / الإيجار";
                  const hint = category === "payroll"
                    ? "مصادر مسيرات الرواتب المؤهلة للتصنيع"
                    : category === "fixed_asset_depreciation"
                      ? "مصادر إهلاك الأصول المؤهلة للتصنيع"
                      : "أقساط الإيجار والمصروفات المقدمة المرحّلة";
                  const rows = costSources.filter(source => source.sourceType === category);
                  const manual = manualCosts[category];
                  const mode = costModes[category];
                  const setMode = (next: ManufacturingCostMode) => {
                    setCostModes(current => ({ ...current, [category]: next }));
                    if (next !== "linked") {
                      setAllocations(current => Object.fromEntries(
                        Object.entries(current).filter(([key]) => !key.startsWith(`${category}:`)),
                      ));
                    }
                  };
                   const categoryTotal = mode === "linked"
                     ? rows.reduce((total, source) => {
                         const key = `${source.sourceType}:${source.sourceRecordId}`;
                         return total + (allocations[key] === "1" ? allocatedAmountForSource(source) : 0);
                       }, 0)
                     : mode === "manual" ? manualAmountForCategory(category) : 0;
                  return (
                    <Card key={category} className={`border-2 transition-colors ${mode === "manual" ? "border-amber-200 bg-amber-50/20" : mode === "linked" ? "border-violet-200" : "border-slate-200"}`}>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-base text-slate-800">{title}</CardTitle>
                        <CardDescription className="text-xs">{hint}</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <SearchCombobox
                          value={mode}
                          onValueChange={value => setMode((value === "linked" || value === "manual") ? value : "none")}
                          items={[
                            { value: "none", label: "بدون تكلفة" },
                            { value: "linked", label: "ربط مصدر مرحّل" },
                            { value: "manual", label: "إدخال تكلفة يدوية" },
                          ]}
                          placeholder="اختر الطريقة..."
                          searchPlaceholder="ابحث عن الطريقة..."
                        />
                        {mode === "none" && (
                          <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">اختياري — لن تُضاف تكلفة فعلية من هذه الفئة.</div>
                        )}
                        {mode === "linked" && (
                          <div className="space-y-2">
                            {costSourcesState === "loading" ? (
                              <div className="rounded-lg border border-violet-200 bg-violet-50 p-3 text-xs text-violet-800">
                                جاري تحميل المصادر المؤهلة للفترة...
                              </div>
                            ) : costSourcesState === "error" ? (
                              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                                تعذر تحميل المصادر. استخدم زر إعادة المحاولة أعلاه لمعرفة النتيجة الفعلية.
                              </div>
                            ) : !rows.length ? (
                              <div className="rounded-lg border border-dashed p-3 text-xs text-slate-500">
                                لا يوجد مصدر من فئة {title} مرحّل ومؤهل للفترة {form.costPeriod}.
                              </div>
                            ) : rows.map(source => {
                              const key = `${source.sourceType}:${source.sourceRecordId}`;
                              const selected = allocations[key] === "1";
                              const available = Number(source.availableAmount ?? 0);
                              const applied = Number(source.allocatedAmount ?? 0);
                               const method = source.meta?.allocationMethod || source.basis;
                               const actual = allocatedAmountForSource(source);
                              return (
                                <div key={key} className={`rounded-lg border p-3 space-y-2 ${selected ? "bg-violet-50/60 border-violet-200" : "bg-white"}`}>
                                  <label className="flex gap-2 items-start text-xs">
                                    <input type="checkbox" className="mt-0.5 h-4 w-4 rounded text-violet-600"
                                      disabled={!canPost || available <= 0}
                                      checked={selected}
                                      onChange={event => setAllocations(current => ({ ...current, [key]: event.target.checked ? "1" : "" }))}
                                    />
                                    <span className="font-semibold text-slate-800">{source.label}</span>
                                  </label>
                                  <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-500">
                                    <span>الفترة: {source.periodStart} — {source.periodEnd}</span>
                                    <span>الأساس: {method}</span>
                                    <span>المتاح: <b className="text-slate-700">{available.toLocaleString()}</b></span>
                                    <span>المطبق سابقاً: <b className="text-slate-700">{applied.toLocaleString()}</b></span>
                                    <span className="col-span-2">المبلغ الفعلي لهذا الأمر: <b className="text-violet-700">{actual.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b></span>
                                  </div>
                                  {selected && (
                                    <SearchCombobox
                                      className="h-8 text-xs"
                                      value={sourceTreatments[key] || "manufacturing_overhead"}
                                      placeholder="تصنيف المصدر..."
                                      searchPlaceholder="ابحث عن التصنيف..."
                                      items={[
                                        { value: "manufacturing_overhead", label: "تكلفة صناعية غير مباشرة" },
                                        { value: "quality_prevention", label: "تكلفة جودة وقائية" },
                                        { value: "operating", label: "مصاريف تشغيلية" },
                                      ]}
                                      onValueChange={value => setSourceTreatments(current => ({ ...current, [key]: value }))}
                                    />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {mode === "manual" && (
                          <div className="space-y-3">
                            <div className="space-y-1">
                              <Label className="text-xs">المبلغ الفعلي</Label>
                              <Input type="text" inputMode="decimal" dir="ltr" value={manual.amount}
                                onChange={event => setManualCosts(current => ({ ...current, [category]: { ...current[category], amount: event.target.value } }))} placeholder="0.00" />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">الوصف {Number(manual.amount || 0) > 0 && <span className="text-red-500">*</span>}</Label>
                              <Input value={manual.description}
                                onChange={event => setManualCosts(current => ({ ...current, [category]: { ...current[category], description: event.target.value } }))} placeholder="مثال: أجر فريق الإنتاج" />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">الحساب المقابل {Number(manual.amount || 0) > 0 && <span className="text-red-500">*</span>}</Label>
                              <SearchCombobox
                                value={manual.counterpartAccountId}
                                disabled={Number(manual.amount || 0) <= 0}
                                items={[{ value: "", label: "اختر الحساب..." }, ...postingAccounts.map(account => ({
                                  value: String(account.id), code: account.code,
                                  label: `${account.code} — ${account.nameAr}`,
                                }))]}
                                placeholder="اختر الحساب المقابل..."
                                searchPlaceholder="ابحث بالرمز أو الاسم..."
                                onValueChange={value => setManualCosts(current => ({ ...current, [category]: { ...current[category], counterpartAccountId: value } }))}
                              />
                              <p className="text-[11px] text-slate-500">سيُسجل القيد مديناً WIP ودائناً بهذا الحساب، دون إنشاء مصروف ثانٍ.</p>
                            </div>
                          </div>
                        )}
                        {categoryTotal > 0 && (
                          <div className="flex justify-between border-t pt-3 text-sm font-semibold text-violet-800">
                            <span>إجمالي الفئة المحددة</span>
                            <span>{Number(categoryTotal.toFixed(2)).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
                <Card className="border-2 border-indigo-200 bg-indigo-50/20">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base text-slate-800">المصادر الصناعية العامة</CardTitle>
                    <CardDescription className="text-xs">
                      فاتورة صناعية مرحّلة هي المصدر الفعلي للكهرباء العامة والمياه والصيانة والمواد غير المباشرة. لا ينشئ اختيارها مصروفاً جديداً أو يضيف تقدير تعريفة الآلة مرة ثانية.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {costSourcesState === "loading" ? (
                      <div className="rounded-lg border border-indigo-200 bg-white p-3 text-xs text-indigo-800">جاري تحميل المصادر الصناعية المؤهلة…</div>
                    ) : !industrialSources.length ? (
                      <div className="rounded-lg border border-dashed bg-white p-3 text-xs leading-6 text-slate-600">
                        لا توجد فاتورة شراء صناعية مرحّلة ومؤهلة للفترة {form.costPeriod}. يمكن إنهاء مرحلة آلة كهربائية مع تجميد دليل kWh/التعريفة؛ تُختار فاتورة الكهرباء المنشورة والمصنع ومركز التكلفة لاحقاً صراحةً في إقفال المصادر الشهري. لا يقبل الإقفال فاتورة غير مرحّلة أو تقديراً بديلاً.
                      </div>
                    ) : industrialSources.map(source => {
                      const key = `${source.sourceType}:${source.sourceRecordId}`;
                      const costType = source.meta?.costType || "industrial_overhead";
                      const driver = source.meta?.industrialDriver || source.meta?.allocationMethod || source.basis;
                      const selectable = source.sourceType === "purchase_invoice" &&
                        ["machine_hours", "labor_hours", "production_quantity"].includes(driver) &&
                        Number(source.availableAmount ?? 0) > 0;
                      const actual = allocatedAmountForSource(source);
                      return (
                        <div key={key} className={`rounded-lg border p-3 text-xs space-y-2 ${allocations[key] === "1" ? "border-indigo-300 bg-white" : "bg-white/70"}`}>
                          <label className="flex items-start gap-2">
                            <input
                              type="checkbox"
                              className="mt-0.5 h-4 w-4 rounded text-indigo-600"
                              checked={allocations[key] === "1"}
                              disabled={!canPost || !selectable}
                              onChange={event => setAllocations(current => ({ ...current, [key]: event.target.checked ? "1" : "" }))}
                            />
                            <span className="font-semibold text-slate-800">{source.label}</span>
                          </label>
                          <div className="grid grid-cols-2 gap-2 text-slate-600">
                            <span>النوع: {costType}</span>
                            <span>المحرك: {driver}</span>
                            <span>المتاح: {Number(source.availableAmount ?? 0).toLocaleString()}</span>
                            <span>نصيب الأمر المخطط: {actual.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                          </div>
                          {!selectable && (
                            <p className="rounded bg-amber-50 p-2 leading-5 text-amber-900">
                              {source.sourceType === "purchase_return"
                                ? "المرتجع معروض لتتبع المصدر فقط؛ لا يمكن اختياره كتوزيع موجب مستقل."
                                : "لا يمكن اختيار المصدر: يلزم قيد فاتورة شراء صناعية مرحّل، محرك ساعات آلة/عمالة أو كمية إنتاج، وإجمالي محرك معتمد ومبلغ متاح موجب."}
                            </p>
                          )}
                          {costType === "electricity" && driver === "machine_hours" && (
                            <p className="rounded bg-emerald-50 p-2 leading-5 text-emerald-900">مصدر كهرباء آلة مؤهل: تظل قيمة kWh/التعريفة لقطة استخدام فقط، ويُسوّى المصدر المرحّل مرة واحدة من ساعات الآلات الفعلية عند الإقفال.</p>
                          )}
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {tab === "costs" && (
            <div dir="rtl" className="mt-4 grid gap-4 rounded-xl border border-violet-200 bg-violet-50 p-4 sm:grid-cols-2">
              <div>
                <p className="text-sm text-violet-700">إجمالي التكاليف الإضافية</p>
                <p className="mt-1 text-2xl font-bold text-violet-950" dir="ltr">{calculateAllocatedTotal().toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
              </div>
              <div>
                <p className="text-sm text-violet-700">التكلفة الإضافية لكل وحدة مخططة</p>
                <p className="mt-1 text-2xl font-bold text-violet-950" dir="ltr">{Number(form.plannedQty) > 0 ? (calculateAllocatedTotal() / Number(form.plannedQty)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}</p>
              </div>
              <p className="text-xs text-violet-700 sm:col-span-2">تُحمّل عند تنفيذ الأمر، ولا تشمل تكلفة المواد. ترك البنود بدون تكلفة لا يمنع التنفيذ.</p>
            </div>
          )}

          {tab === "review" && (
            <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2">
               {(() => {
                 const manufacturingAllocation = calculateAllocatedTotal();
                  const additionalUnit = !(Number(form.plannedQty) > 0)
                   ? null
                    : manufacturingAllocation / Number(form.plannedQty);
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
                   <div className="text-xs font-semibold text-violet-700 uppercase mb-3">التكاليف الفعلية الإضافية</div>
                  <div className="space-y-3">
                    <div className="flex justify-between items-center text-sm">
                        <span className="text-slate-600">إجمالي الإضافي (مرتبط + يدوي):</span>
                        <span className="font-bold text-violet-700">{manufacturingAllocation.toLocaleString(undefined, {maximumFractionDigits: 2})}</span>
                     </div>
                     <div className="flex justify-between items-center text-sm">
                        <span className="text-slate-600">نصيب الوحدة الإضافي:</span>
                        <span className="font-bold text-violet-700">{additionalUnit == null ? "—" : additionalUnit.toLocaleString(undefined, {maximumFractionDigits: 2})}</span>
                     </div>
                    <div className="text-xs text-slate-400 mt-2">
                        * هذه أرقام فعلية للمصادر المرتبطة والمبالغ اليدوية فقط؛ لا تُخلط معها معاينة تكلفة المواد. تكلفة المواد الفعلية تثبت عند الصرف.
                    </div>
                  </div>
                </div>
              </div>

               <div className="border rounded-xl p-4">
                 <div className="text-xs font-semibold text-slate-500 uppercase mb-2">الكميات المطلوبة من الوصفة</div>
                 {materialScale == null ? (
                   <div className="text-sm text-amber-700">
                     كمية ناتج الوصفة غير صالحة؛ لا يمكن حساب المطلوب حتى تُراجع الوصفة.
                   </div>
                 ) : (
                   <>
                     <p className="text-xs text-slate-500 mb-3">
                       تنتج الوصفة {bomPreview?.outputQty} {recipeOutputUnit}. المطلوب =
                       كمية السطر × ({form.plannedQty} ÷ {bomPreview?.outputQty}).
                       هذه معاينة كمية فقط؛ لا تُنشئ رصيداً ولا تتجاوز تحقق المخزون.
                       بعد الحفظ افتح تفاصيل الأمر ووسّع «معاينة سحب التشغيلات» لرؤية المتاح في مخزن السحب قبل البدء.
                     </p>
                     <div className="divide-y rounded-lg border">
                       {(bomPreview?.lines ?? []).map((line: any) => (
                         <div key={line.id} className="flex items-center justify-between gap-3 p-2 text-sm">
                           <span>{line.itemNameAr || line.description || `صنف #${line.itemId}`}</span>
                           <span className="font-mono font-semibold">
                             {Number.isFinite(Number(line.quantity))
                                ? (Number(line.quantity) * materialScale * Number(line.usageFactorNumeric ?? line.usageFactor)).toLocaleString(undefined, { maximumFractionDigits: 6 })
                               : "—"}
                              {" "}{line.baseUnitCode || line.unitCode || ""}
                           </span>
                         </div>
                       ))}
                     </div>
                   </>
                 )}
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
