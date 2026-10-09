import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  AlertCircle,
  ArrowDownUp,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  CircleHelp,
  ClipboardList,
  Layers3,
  LoaderCircle,
  Package,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Shirt,
  Tags,
  X,
} from "lucide-react";
import { inventoryApi, type ItemVariant } from "@/lib/inventoryApi";
import BulkLabelDialog from "@/components/BulkLabelDialog";
import { generateClothingVariantIdentifiers } from "@/lib/clothingVariantIdentifiers";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { usePermission } from "@/hooks/usePermission";

type InventoryItem = {
  id: number;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  itemType?: string;
  tags?: string | null;
  groupId?: number | null;
  unitId?: number | null;
  costPrice?: number | string;
  salePrice?: number | string;
  vatRate?: number | string;
  parentItemId?: number | null;
  variantAttributes?: Record<string, string> | null;
  isBundle?: boolean;
  status?: string;
};

type ItemGroup = { id: number; nameAr: string };
type Unit = { id: number; nameAr: string };
type VariantDraft = {
  key: string;
  color: string;
  size: string;
  code: string;
  barcode: string;
  costPrice: string;
  salePrice: string;
};

const CLOTHING_MODEL_TAG = "ملابس وأحذية";

const nonNegativeAmount = (label: string) =>
  z.string().trim().min(1, `أدخل ${label}`).refine(
    (value) => Number.isFinite(Number(value)) && Number(value) >= 0,
    "أدخل قيمة رقمية غير سالبة.",
  );

const modelSchema = z.object({
  code: z.string().trim().min(1, "أدخل رمز الموديل"),
  nameAr: z.string().trim().min(1, "أدخل اسم الموديل"),
  nameEn: z.string().trim().optional(),
  groupId: z.string().min(1, "اختر مجموعة الصنف"),
  unitId: z.string().min(1, "اختر وحدة القياس"),
  costPrice: nonNegativeAmount("تكلفة الموديل"),
  salePrice: nonNegativeAmount("سعر البيع"),
  vatRate: nonNegativeAmount("نسبة الضريبة").refine(
    (value) => Number(value) <= 100,
    "يجب أن تكون نسبة الضريبة بين 0 و100.",
  ),
});
type ModelValues = z.infer<typeof modelSchema>;

const defaultModelValues: ModelValues = {
  code: "",
  nameAr: "",
  nameEn: "",
  groupId: "",
  unitId: "",
  costPrice: "",
  salePrice: "",
  vatRate: "15",
};

const money = (value: number | string | null | undefined) => {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount)
    ? new Intl.NumberFormat("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)
    : "—";
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "تعذر إتمام العملية. حاول مرة أخرى.";

const pairKey = (color: string, size: string) => `${color.trim().toLocaleLowerCase()}::${size.trim().toLocaleLowerCase()}`;

function LoadingRows() {
  return (
    <div className="space-y-3 p-5" data-testid="loading-models-skeleton">
      {[0, 1, 2, 3].map((row) => (
        <div className="h-14 animate-pulse rounded-xl bg-[#edf1ed]" key={row} />
      ))}
    </div>
  );
}

function FormSelect({
  value,
  onChange,
  children,
  testId,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  testId: string;
  placeholder: string;
}) {
  return (
    <div className="relative">
      <select
        className="h-10 w-full appearance-none rounded-lg border border-[#d9dedb] bg-[#fbfcfa] px-3 pl-9 text-sm text-[#20352f] outline-none transition focus:border-[#16745e] focus:ring-2 focus:ring-[#16745e]/10"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        data-testid={testId}
      >
        <option value="">{placeholder}</option>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-[#77857f]" />
    </div>
  );
}

export default function ClothingModels() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const canCreateItems = usePermission("items", "create");
  const canEditItems = usePermission("items", "edit");
  const [search, setSearch] = useState("");
  const [activeModelId, setActiveModelId] = useState<number | null>(null);
  const [activeModelSnapshot, setActiveModelSnapshot] = useState<InventoryItem | null>(null);
  const [showCreateModel, setShowCreateModel] = useState(false);
  const [showAdoptModel, setShowAdoptModel] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [adoptSearch, setAdoptSearch] = useState("");
  const [adoptModelId, setAdoptModelId] = useState("");
  const [colorInput, setColorInput] = useState("");
  const [sizeInput, setSizeInput] = useState("");
  const [colors, setColors] = useState<string[]>([]);
  const [sizes, setSizes] = useState<string[]>([]);
  const [selectedPairs, setSelectedPairs] = useState<string[]>([]);
  const [variantDrafts, setVariantDrafts] = useState<Record<string, VariantDraft>>({});
  const [batchError, setBatchError] = useState<{ message: string; failedKey: string | null } | null>(null);
  const [savingProgress, setSavingProgress] = useState<{ done: number; total: number } | null>(null);

  const modelsQuery = useQuery({
    queryKey: ["clothing-models", search.trim()],
    queryFn: () => inventoryApi.getClothingModels(search, false),
  });
  const adoptableQuery = useQuery({
    queryKey: ["clothing-adoptable-models", adoptSearch.trim()],
    queryFn: () => inventoryApi.getClothingModels(adoptSearch, true),
    enabled: showAdoptModel,
  });
  const groupsQuery = useQuery({
    queryKey: ["item-groups"],
    queryFn: () => inventoryApi.getItemGroups(),
  });
  const unitsQuery = useQuery({
    queryKey: ["units"],
    queryFn: () => inventoryApi.getUnits(),
  });

  const models = (modelsQuery.data ?? []) as InventoryItem[];
  const adoptableModels = (adoptableQuery.data ?? []) as InventoryItem[];
  const filteredAdoptableModels = adoptableModels.filter((item) => item.unitId != null);
  const groups = (groupsQuery.data ?? []) as ItemGroup[];
  const units = (unitsQuery.data ?? []) as Unit[];
  const activeModel = models.find((model: InventoryItem) => model.id === activeModelId)
    ?? (activeModelSnapshot?.id === activeModelId ? activeModelSnapshot : null);
  const variantsQuery = useQuery({
    queryKey: ["item-variants", activeModelId],
    queryFn: () => inventoryApi.getItemVariants(activeModelId as number),
    enabled: activeModelId !== null,
  });
  const variants: ItemVariant[] = variantsQuery.data?.variants ?? [];

  const filteredModels = models;

  const existingPairKeys = useMemo(
    () => new Set(variants.map((variant) => pairKey(String(variant.variantAttributes?.["اللون"] ?? ""), String(variant.variantAttributes?.["المقاس"] ?? "")))),
    [variants],
  );

  const modelForm = useForm<ModelValues>({
    resolver: zodResolver(modelSchema),
    defaultValues: defaultModelValues,
  });

  const createModelMutation = useMutation({
    mutationFn: (values: ModelValues) =>
      inventoryApi.createItem({
        code: values.code.trim(),
        nameAr: values.nameAr.trim(),
        nameEn: values.nameEn?.trim() || null,
        itemType: "stock",
        groupId: Number(values.groupId),
        unitId: Number(values.unitId),
        costPrice: values.costPrice.trim(),
        salePrice: values.salePrice.trim(),
        vatRate: values.vatRate.trim(),
        parentItemId: null,
        variantAttributes: null,
        isBundle: false,
        tags: [CLOTHING_MODEL_TAG],
      }),
    onSuccess: async (created: InventoryItem) => {
      setActiveModelSnapshot(created);
      void queryClient.invalidateQueries({ queryKey: ["clothing-models"] });
      void queryClient.invalidateQueries({ queryKey: ["items"] });
      setShowCreateModel(false);
      modelForm.reset(defaultModelValues);
      if (created?.id) setActiveModelId(created.id);
      toast({ title: "تم إنشاء الموديل", description: "أصبح الموديل جاهزاً لإضافة الألوان والمقاسات." });
    },
    onError: (error) => toast({ title: "تعذر إنشاء الموديل", description: errorMessage(error), variant: "destructive" }),
  });

  const adoptModelMutation = useMutation({
    mutationFn: async (itemId: number) => {
      const item = adoptableModels.find((candidate) => candidate.id === itemId);
      if (!item) throw new Error("الصنف المحدد لم يعد متاحاً.");
      const tags = String(item.tags ?? "").split(",").map((tag) => tag.trim()).filter(Boolean);
      return inventoryApi.updateItem(itemId, { tags: [...tags, CLOTHING_MODEL_TAG] });
    },
    onSuccess: async (updated: InventoryItem, itemId) => {
      setActiveModelSnapshot(updated);
      void queryClient.invalidateQueries({ queryKey: ["clothing-models"] });
      void queryClient.invalidateQueries({ queryKey: ["clothing-adoptable-models"] });
      void queryClient.invalidateQueries({ queryKey: ["items"] });
      setShowAdoptModel(false);
      setAdoptSearch("");
      setAdoptModelId("");
      setActiveModelId(itemId);
      toast({ title: "تم ربط الصنف", description: "أصبح الصنف موديلًا في تشكيلة الملابس والأحذية." });
    },
    onError: (error) => toast({ title: "تعذر ربط الصنف", description: errorMessage(error), variant: "destructive" }),
  });

  const resetVariantBuilder = () => {
    setColors([]);
    setSizes([]);
    setSelectedPairs([]);
    setVariantDrafts({});
    setColorInput("");
    setSizeInput("");
    setBatchError(null);
    setSavingProgress(null);
  };

  const addColor = () => {
    const value = colorInput.trim();
    if (!value || colors.some((color) => color.toLocaleLowerCase() === value.toLocaleLowerCase())) return;
    setColors((current) => [...current, value]);
    setColorInput("");
  };
  const addSize = () => {
    const value = sizeInput.trim();
    if (!value || sizes.some((size) => size.toLocaleLowerCase() === value.toLocaleLowerCase())) return;
    setSizes((current) => [...current, value]);
    setSizeInput("");
  };

  const pairs = useMemo(
    () => colors.flatMap((color) => sizes.map((size) => ({ color, size, key: pairKey(color, size) }))),
    [colors, sizes],
  );
  const sellablePairs = pairs.filter((pair) => !existingPairKeys.has(pair.key));
  const chosenPairs = sellablePairs.filter((pair) => selectedPairs.includes(pair.key));

  const setDraftField = (key: string, field: keyof Omit<VariantDraft, "key" | "color" | "size">, value: string) => {
    setVariantDrafts((current) => ({
      ...current,
      [key]: { ...(current[key] ?? { key, color: "", size: "", code: "", barcode: "", costPrice: "", salePrice: "" }), [field]: value },
    }));
  };

  const generateMissingIdentifiers = () => {
    if (!activeModel || !chosenPairs.length) return;
    const knownItems = [...models, ...adoptableModels];
    const usedCodes = new Set(
      knownItems.map((item) => String(item.code ?? "").trim().toLocaleLowerCase()).filter(Boolean),
    );
    const usedBarcodes = new Set(
      knownItems.map((item) => String((item as InventoryItem & { barcode?: string | null }).barcode ?? "").trim().toLocaleLowerCase()).filter(Boolean),
    );
    for (const draft of Object.values(variantDrafts)) {
      if (draft.code.trim()) usedCodes.add(draft.code.trim().toLocaleLowerCase());
      if (draft.barcode.trim()) usedBarcodes.add(draft.barcode.trim().toLocaleLowerCase());
    }

    let generatedCodes = 0;
    let generatedBarcodes = 0;
    const next = { ...variantDrafts };
    for (const pair of chosenPairs) {
      const draft = next[pair.key]
        ? { ...next[pair.key] }
        : {
          key: pair.key,
          color: pair.color,
          size: pair.size,
          code: "",
          barcode: "",
          costPrice: "",
          salePrice: "",
        };
      if (draft.code.trim() && draft.barcode.trim()) continue;

      const suggested = generateClothingVariantIdentifiers(
        {
          parentItemId: activeModel.id,
          parentCode: activeModel.code,
          color: pair.color,
          size: pair.size,
        },
        usedCodes,
        usedBarcodes,
      );
      if (!draft.code.trim()) {
        draft.code = suggested.code;
        generatedCodes += 1;
      }
      if (!draft.barcode.trim()) {
        draft.barcode = suggested.barcode;
        generatedBarcodes += 1;
      }
      next[pair.key] = draft;
    }
    setVariantDrafts(next);
    toast({
      title: "تم توليد الرموز",
      description: `رموز أصناف: ${generatedCodes} · باركود: ${generatedBarcodes}. يمكنك تعديلها قبل الحفظ.`,
    });
  };

  const createVariantsMutation = useMutation({
    mutationFn: async ({ model, toCreate }: { model: InventoryItem; toCreate: VariantDraft[] }) => {
      let done = 0;
      const total = toCreate.length;
      setSavingProgress({ done, total });
      const latest = await inventoryApi.getItemVariants(model.id);
      const latestPairs = new Set((latest.variants ?? []).map((variant) =>
        pairKey(String(variant.variantAttributes?.["اللون"] ?? ""), String(variant.variantAttributes?.["المقاس"] ?? "")),
      ));
      for (const draft of toCreate) {
        const key = pairKey(draft.color, draft.size);
        if (latestPairs.has(key)) {
          done += 1;
          setSavingProgress({ done, total });
          continue;
        }
        await inventoryApi.addItemVariant(model.id, {
          code: draft.code.trim(),
          nameAr: `${model.nameAr} — ${draft.color} — ${draft.size}`,
          nameEn: model.nameEn ? `${model.nameEn} - ${draft.color} - ${draft.size}` : null,
          barcode: draft.barcode.trim() || null,
          costPrice: draft.costPrice.trim() || undefined,
          salePrice: draft.salePrice.trim() || undefined,
          variantAttributes: { "اللون": draft.color, "المقاس": draft.size },
        });
        latestPairs.add(key);
        done += 1;
        setSavingProgress({ done, total });
      }
      return { modelId: model.id };
    },
    onSuccess: async ({ modelId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["item-variants", modelId] }),
        queryClient.invalidateQueries({ queryKey: ["items"] }),
      ]);
      resetVariantBuilder();
      toast({ title: "اكتمل إنشاء المتغيرات", description: "تمت إضافة جميع التركيبات المحددة." });
    },
    onError: async (error) => {
      const message = errorMessage(error);
      setBatchError({ message, failedKey: null });
      if (activeModelId !== null) {
        await queryClient.invalidateQueries({ queryKey: ["item-variants", activeModelId] });
        await queryClient.refetchQueries({ queryKey: ["item-variants", activeModelId] });
      }
      await queryClient.invalidateQueries({ queryKey: ["items"] });
    },
  });

  const togglePair = (key: string) => {
    setSelectedPairs((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  };
  const handleBatchSave = () => {
    if (!activeModel || !chosenPairs.length) return;
    const missingSku = chosenPairs.find((pair) => !variantDrafts[pair.key]?.code?.trim());
    if (missingSku) {
      toast({ title: "أكمل رمز الصنف", description: `أدخل رمزاً للتركيبة ${missingSku.color} / ${missingSku.size}.`, variant: "destructive" });
      return;
    }
    const seenCodes = new Set<string>();
    const duplicateCode = chosenPairs.find((pair) => {
      const code = variantDrafts[pair.key].code.trim().toLocaleLowerCase();
      if (seenCodes.has(code)) return true;
      seenCodes.add(code);
      return false;
    });
    if (duplicateCode) {
      toast({ title: "رمز مكرر", description: "يجب أن يكون رمز كل متغير فريداً داخل هذه الدفعة.", variant: "destructive" });
      return;
    }
    const invalidPrice = chosenPairs.find((pair) => {
      const draft = variantDrafts[pair.key];
      return [draft.costPrice, draft.salePrice].some((value) =>
        value.trim() !== "" && (!Number.isFinite(Number(value)) || Number(value) < 0),
      );
    });
    if (invalidPrice) {
      toast({ title: "سعر غير صالح", description: "أدخل تكلفة وسعر بيع بقيم رقمية غير سالبة، أو اترك الحقل فارغًا لاستخدام سعر الموديل.", variant: "destructive" });
      return;
    }
    setBatchError(null);
    createVariantsMutation.mutate({
      model: activeModel,
      toCreate: chosenPairs.map((pair) => ({
        key: pair.key,
        color: pair.color,
        size: pair.size,
        code: variantDrafts[pair.key].code,
        barcode: variantDrafts[pair.key].barcode,
        costPrice: variantDrafts[pair.key].costPrice,
        salePrice: variantDrafts[pair.key].salePrice,
      })),
    });
  };

  const retryRemaining = async () => {
    if (!activeModel) return;
    await queryClient.invalidateQueries({ queryKey: ["item-variants", activeModel.id] });
    const refreshed = await queryClient.fetchQuery({
      queryKey: ["item-variants", activeModel.id],
      queryFn: () => inventoryApi.getItemVariants(activeModel.id),
    });
    const doneKeys = new Set((refreshed.variants ?? []).map((variant) =>
      pairKey(String(variant.variantAttributes?.["اللون"] ?? ""), String(variant.variantAttributes?.["المقاس"] ?? "")),
    ));
    const remaining = selectedPairs
      .filter((key) => !doneKeys.has(key))
      .map((key) => {
        const pair = pairs.find((candidate) => candidate.key === key);
        const draft = variantDrafts[key];
        return pair && draft ? { ...draft, color: pair.color, size: pair.size } : null;
      })
      .filter((draft): draft is VariantDraft => Boolean(draft));
    if (!remaining.length) {
      setBatchError(null);
      setSelectedPairs([]);
      setVariantDrafts({});
      toast({ title: "لا توجد تركيبات متبقية", description: "تم العثور على كل التركيبات المحددة في الموديل." });
      return;
    }
    setBatchError(null);
    createVariantsMutation.mutate({ model: activeModel, toCreate: remaining });
  };

  const selectModel = (model: InventoryItem) => {
    setActiveModelSnapshot(model);
    setActiveModelId(model.id);
    resetVariantBuilder();
  };

  const anyQueryError = modelsQuery.isError || groupsQuery.isError || unitsQuery.isError
    || (showAdoptModel && adoptableQuery.isError);
  const retryQueries = () => {
    void Promise.all([modelsQuery.refetch(), groupsQuery.refetch(), unitsQuery.refetch()]);
  };

  return (
    <main dir="rtl" className="min-h-[100dvh] bg-[#f3f5f1] text-[#1d332c]" data-testid="page-clothing-models">
      <div className="mx-auto max-w-[1500px] px-4 py-5 sm:px-6 lg:px-9 lg:py-8">
        <header className="relative mb-6 overflow-hidden rounded-[22px] bg-[#123d32] px-5 py-6 text-[#f3f1e9] shadow-[0_12px_32px_rgba(17,60,49,.13)] sm:px-8 sm:py-8">
          <div className="absolute -left-10 -top-20 h-64 w-64 rounded-full border border-[#c7ad73]/20" />
          <div className="absolute -left-1 top-5 h-40 w-40 rounded-full border border-[#c7ad73]/15" />
          <div className="relative flex flex-col justify-between gap-6 md:flex-row md:items-end">
            <div>
              <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold tracking-[.18em] text-[#d6c693]">
                <span className="h-px w-7 bg-[#d6c693]" />
                المخزون / إدارة التشكيلة
              </div>
              <h1 className="text-2xl font-bold leading-tight sm:text-[32px]">موديلات الملابس والأحذية</h1>
              <p className="mt-2 max-w-2xl text-sm leading-7 text-[#d2ded8]">
                حوّل كل موديل إلى أصناف مخزنية فعلية حسب اللون والمقاس — برمز وباركود وسعر مستقل لكل تركيبة.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {canEditItems && <button
                className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-white/20 px-4 text-sm font-semibold text-[#f3f1e9] transition hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-[#f3f1e9]/60"
                onClick={() => setShowAdoptModel(true)}
                data-testid="button-adopt-model"
              >
                <Package className="h-4 w-4" />
                ربط صنف موجود
              </button>}
              {canCreateItems && <button
                className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-[#d6c693] px-5 text-sm font-bold text-[#1b3d32] transition hover:bg-[#e3d7b5] focus:outline-none focus:ring-2 focus:ring-[#f3f1e9]/60 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => setShowCreateModel(true)}
                data-testid="button-create-model"
              >
                <Plus className="h-4 w-4" />
                موديل جديد
              </button>}
            </div>
          </div>
          <div className="relative mt-7 flex flex-wrap gap-2 border-t border-white/10 pt-4 text-xs text-[#d2ded8]">
            <span className="inline-flex items-center gap-2"><Layers3 className="h-3.5 w-3.5 text-[#d6c693]" /> الموديل أصل رئيسي</span>
            <span className="mx-1 text-white/30">/</span>
            <span className="inline-flex items-center gap-2"><Tags className="h-3.5 w-3.5 text-[#d6c693]" /> كل تركيبة صنف مستقل</span>
            <span className="mx-1 text-white/30">/</span>
            <span className="inline-flex items-center gap-2"><ClipboardList className="h-3.5 w-3.5 text-[#d6c693]" /> المخزون والحركات عبر الصنف الفرعي</span>
          </div>
        </header>

        <section className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label="ملخص التشكيلة">
          <div className="flex items-center gap-3 rounded-2xl border border-[#e0e5df] bg-[#fbfcfa] p-4">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#e5eee8] text-[#16745e]"><Shirt className="h-5 w-5" /></span>
            <div><p className="text-xs text-[#77857f]">الموديلات المعروضة</p><p className="mt-0.5 text-xl font-bold tabular-nums" data-testid="stat-model-count">{models.length.toLocaleString("ar-SA")}</p></div>
          </div>
          <div className="flex items-center gap-3 rounded-2xl border border-[#e0e5df] bg-[#fbfcfa] p-4">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#f2eddf] text-[#8b7040]"><Package className="h-5 w-5" /></span>
            <div><p className="text-xs text-[#77857f]">أصناف الموديل المحدد</p><p className="mt-0.5 text-xl font-bold tabular-nums" data-testid="stat-variant-count">{activeModel ? variants.length.toLocaleString("ar-SA") : "—"}</p></div>
          </div>
          <div className="flex items-center gap-3 rounded-2xl border border-[#e0e5df] bg-[#fbfcfa] p-4">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#e9ece7] text-[#586960]"><ArrowDownUp className="h-5 w-5" /></span>
            <div><p className="text-xs text-[#77857f]">التركيبات المحددة</p><p className="mt-0.5 text-xl font-bold tabular-nums" data-testid="stat-selected-pairs">{selectedPairs.length.toLocaleString("ar-SA")}</p></div>
          </div>
        </section>

        {anyQueryError && (
          <div className="mb-5 flex flex-col gap-3 rounded-xl border border-[#e5c8bd] bg-[#fff8f4] p-4 sm:flex-row sm:items-center sm:justify-between" role="alert" data-testid="alert-load-error">
            <div className="flex gap-3"><AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-[#a4482d]" /><div><p className="font-semibold text-[#743a2a]">تعذر تحميل بيانات التشكيلة</p><p className="mt-1 text-sm text-[#815c50]">تحقق من الاتصال ثم أعد المحاولة.</p></div></div>
            <button className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-[#d7b2a4] px-3 text-sm font-semibold text-[#743a2a] hover:bg-[#f9ebe5]" onClick={retryQueries} data-testid="button-retry-load"><RefreshCw className="h-4 w-4" /> إعادة المحاولة</button>
          </div>
        )}

        <div className="grid gap-5 xl:grid-cols-[minmax(320px,0.8fr)_minmax(0,1.6fr)]">
          <section className="overflow-hidden rounded-2xl border border-[#e0e5df] bg-[#fbfcfa] shadow-[0_3px_14px_rgba(27,54,43,.035)]">
            <div className="flex flex-col gap-4 border-b border-[#e8ece7] px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-base font-bold">الموديلات الرئيسية</h2>
                <p className="mt-1 text-xs text-[#77857f]">تظهر حتى 100 نتيجة؛ استخدم البحث للوصول إلى موديل آخر.</p>
              </div>
              <label className="relative block w-full sm:max-w-[220px]">
                <Search className="absolute right-3 top-2.5 h-4 w-4 text-[#86928c]" />
                <input className="h-9 w-full rounded-lg border border-[#dce2dc] bg-[#f8faf7] pr-9 pl-3 text-sm outline-none focus:border-[#16745e]" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="بحث بالاسم أو الرمز" data-testid="input-search-models" />
              </label>
            </div>

            {modelsQuery.isLoading ? <LoadingRows /> : models.length === 0 && !search.trim() ? (
              <div className="px-6 py-12 text-center" data-testid="empty-models">
                <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[#eaf0eb] text-[#16745e]"><Shirt className="h-6 w-6" /></div>
                <p className="mt-4 font-bold">لا توجد موديلات بعد</p>
                <p className="mx-auto mt-2 max-w-xs text-sm leading-6 text-[#77857f]">أنشئ موديلًا جديدًا أو اربط صنفًا مخزنيًا رئيسيًا موجودًا، ثم أضف ألوانه ومقاساته كأصناف فعلية.</p>
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  {canEditItems && <button className="inline-flex h-10 items-center gap-2 rounded-lg border border-[#d7e1d8] px-4 text-sm font-semibold text-[#365447] transition hover:bg-[#f2f6f2]" onClick={() => setShowAdoptModel(true)} data-testid="button-adopt-first-model"><Package className="h-4 w-4" /> ربط صنف موجود</button>}
                  {canCreateItems && <button className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#16745e] px-4 text-sm font-semibold text-white transition hover:bg-[#105a49]" onClick={() => setShowCreateModel(true)} data-testid="button-create-first-model"><Plus className="h-4 w-4" /> إنشاء موديل</button>}
                  {!canCreateItems && !canEditItems && <span className="rounded-lg bg-[#f4f7f3] px-4 py-2 text-xs text-[#77857f]">لا تملك صلاحية إضافة موديلات أو ربط أصناف.</span>}
                </div>
              </div>
            ) : filteredModels.length === 0 ? (
              <div className="px-6 py-10 text-center text-sm text-[#77857f]" data-testid="empty-search-results">لا توجد نتائج تطابق «{search}».</div>
            ) : (
              <div className="divide-y divide-[#edf0ec]" data-testid="list-models">
                {filteredModels.map((model: InventoryItem) => (
                  <button
                    className={`flex w-full items-center gap-3 px-5 py-4 text-right transition hover:bg-[#f2f6f2] ${activeModelId === model.id ? "bg-[#edf4ef] shadow-[inset_-3px_0_0_#16745e]" : ""}`}
                    key={model.id}
                    onClick={() => selectModel(model)}
                    data-testid={`row-model-${model.id}`}
                    aria-pressed={activeModelId === model.id}
                  >
                    <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${activeModelId === model.id ? "bg-[#16745e] text-white" : "bg-[#edf1ed] text-[#66756d]"}`}><Shirt className="h-[18px] w-[18px]" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold text-[#233a32]" data-testid={`text-model-name-${model.id}`}>{model.nameAr}</span>
                      <span className="mt-1 flex items-center gap-2 text-xs text-[#7b8982]"><span dir="ltr">{model.code}</span><span className="text-[#c2cbc4]">•</span><span>{money(model.salePrice)} ر.س</span></span>
                    </span>
                    <ChevronLeft className={`h-4 w-4 shrink-0 ${activeModelId === model.id ? "text-[#16745e]" : "text-[#9aa59e]"}`} />
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="min-w-0 overflow-hidden rounded-2xl border border-[#e0e5df] bg-[#fbfcfa] shadow-[0_3px_14px_rgba(27,54,43,.035)]">
            {!activeModel ? (
              <div className="flex min-h-[430px] flex-col items-center justify-center px-6 py-12 text-center" data-testid="empty-model-selection">
                <div className="grid h-16 w-16 place-items-center rounded-[20px] bg-[#e9efe9] text-[#16745e]"><Layers3 className="h-7 w-7" /></div>
                <h2 className="mt-5 text-lg font-bold">ابدأ من موديل موجود</h2>
                <p className="mt-2 max-w-sm text-sm leading-6 text-[#77857f]">اختر موديلًا من القائمة لإدارة أصناف اللون والمقاس. كل متغير يُنشأ كصنف مستقل ضمن النظام.</p>
              </div>
            ) : (
              <>
                <div className="flex flex-col justify-between gap-4 border-b border-[#e8ece7] px-5 py-5 sm:flex-row sm:items-center sm:px-6">
                  <div>
                    <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold text-[#728078]"><span>الموديل المحدد</span><span className="text-[#c2cbc4]">/</span><span dir="ltr">{activeModel.code}</span></div>
                    <h2 className="text-xl font-bold" data-testid={`text-active-model-${activeModel.id}`}>{activeModel.nameAr}</h2>
                    <p className="mt-1 text-xs text-[#77857f]">التكلفة الأساسية {money(activeModel.costPrice)} ر.س <span className="mx-1 text-[#c2cbc4]">·</span> سعر البيع {money(activeModel.salePrice)} ر.س</p>
                  </div>
                  <div className="flex items-center gap-2 self-start sm:self-auto">
                    <span className="rounded-full border border-[#dbe5dd] bg-[#f2f7f3] px-3 py-1.5 text-xs font-semibold text-[#33664f]" data-testid={`badge-variant-count-${activeModel.id}`}>{variants.length} صنف فرعي</span>
                    <button className="grid h-9 w-9 place-items-center rounded-lg border border-[#dce2dc] text-[#68776f] transition hover:bg-[#f2f5f1] disabled:opacity-50" onClick={() => void variantsQuery.refetch()} disabled={variantsQuery.isFetching} aria-label="تحديث الأصناف" data-testid="button-refresh-variants"><RefreshCw className={`h-4 w-4 ${variantsQuery.isFetching ? "animate-spin" : ""}`} /></button>
                  </div>
                </div>

                <div className="px-5 py-5 sm:px-6">
                  {variantsQuery.isLoading ? (
                    <div className="space-y-2" data-testid="loading-variants-skeleton"><div className="h-10 animate-pulse rounded-lg bg-[#edf1ed]" /><div className="h-10 animate-pulse rounded-lg bg-[#edf1ed]" /><div className="h-10 animate-pulse rounded-lg bg-[#edf1ed]" /></div>
                  ) : variantsQuery.isError ? (
                    <div className="flex items-center justify-between gap-3 rounded-xl border border-[#e5c8bd] bg-[#fff8f4] p-4" role="alert" data-testid="alert-variants-error">
                      <div className="flex items-center gap-2 text-sm text-[#743a2a]"><AlertCircle className="h-4 w-4 shrink-0" /> تعذر تحميل أصناف هذا الموديل.</div>
                      <button className="rounded-lg border border-[#d7b2a4] px-3 py-1.5 text-xs font-semibold text-[#743a2a]" onClick={() => void variantsQuery.refetch()} data-testid="button-retry-variants">إعادة المحاولة</button>
                    </div>
                  ) : (
                    <>
                      <div className="mb-5">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <div><h3 className="text-sm font-bold">الأصناف المرتبطة</h3><p className="mt-1 text-xs text-[#77857f]">هذه أصناف فعلية تستخدمها شاشات البيع والشراء والمخزون الحالية.</p></div>
                        </div>
                        {variants.length ? (
                          <div className="overflow-x-auto rounded-xl border border-[#e5e9e4]" data-testid="table-existing-variants">
                            <table className="w-full min-w-[610px] text-right text-xs">
                              <thead className="bg-[#f3f6f2] text-[#69776f]"><tr><th className="px-3 py-2.5 font-semibold">رمز الصنف</th><th className="px-3 py-2.5 font-semibold">اللون</th><th className="px-3 py-2.5 font-semibold">المقاس</th><th className="px-3 py-2.5 font-semibold">الباركود</th><th className="px-3 py-2.5 font-semibold">التكلفة</th><th className="px-3 py-2.5 font-semibold">سعر البيع</th></tr></thead>
                              <tbody className="divide-y divide-[#edf0ec]">
                                {variants.map((variant) => (
                                  <tr key={variant.id} className="bg-[#fbfcfa] hover:bg-[#f7f9f6]" data-testid={`row-variant-${variant.id}`}>
                                    <td className="px-3 py-3 font-semibold text-[#263d34]" dir="ltr">{variant.code}</td>
                                    <td className="px-3 py-3">{String(variant.variantAttributes?.["اللون"] ?? "—")}</td>
                                    <td className="px-3 py-3">{String(variant.variantAttributes?.["المقاس"] ?? "—")}</td>
                                    <td className="px-3 py-3 text-[#77857f]" dir="ltr">{variant.barcode || "—"}</td>
                                    <td className="px-3 py-3 tabular-nums">{money(variant.costPrice)}</td>
                                    <td className="px-3 py-3 tabular-nums">{money(variant.salePrice)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <div className="flex items-start gap-3 rounded-xl border border-dashed border-[#d9e1da] bg-[#f7faf7] p-4" data-testid="empty-variants">
                            <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-[#7b8b82]" />
                            <div><p className="text-sm font-semibold">لا توجد أصناف فرعية لهذا الموديل</p><p className="mt-1 text-xs leading-5 text-[#77857f]">أضف الألوان والمقاسات أدناه، ثم اختر التركيبات التي تبيعها فعليًا.</p></div>
                          </div>
                        )}
                      </div>

                      {canCreateItems ? <div className="border-t border-[#e8ece7] pt-5">
                        <div className="mb-4 flex items-start justify-between gap-3">
                          <div><h3 className="text-sm font-bold">تركيب تشكيلة جديدة</h3><p className="mt-1 text-xs text-[#77857f]">حدد المحاور أولًا، ثم علّم فقط التركيبات المعروضة في متجرك.</p></div>
                          <div className="flex flex-wrap items-center gap-2">
                            {variants.length > 0 && <button className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#d6e1d8] bg-white px-2.5 text-[11px] font-semibold text-[#365447] hover:bg-[#f2f6f2]" onClick={() => setLabelsOpen(true)} data-testid="button-print-variant-labels"><Printer className="h-3.5 w-3.5" /> طباعة ملصقات</button>}
                            <span className="rounded-full bg-[#f2eddf] px-2.5 py-1 text-[11px] font-semibold text-[#826d3f]">إنشاء متسلسل</span>
                          </div>
                        </div>
                        <div className="grid gap-4 md:grid-cols-2">
                          <div className="rounded-xl border border-[#e4e9e3] bg-[#f8faf7] p-4">
                            <label className="mb-2 block text-xs font-bold text-[#43554b]" htmlFor="color-entry">الألوان</label>
                            <div className="flex gap-2">
                              <input id="color-entry" className="h-10 min-w-0 flex-1 rounded-lg border border-[#d9dedb] bg-white px-3 text-sm outline-none focus:border-[#16745e]" value={colorInput} onChange={(event) => setColorInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addColor(); } }} placeholder="مثال: كحلي" data-testid="input-add-color" />
                              <button className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[#e3ede6] text-[#16745e] transition hover:bg-[#d3e4d9]" onClick={addColor} aria-label="إضافة لون" data-testid="button-add-color"><Plus className="h-4 w-4" /></button>
                            </div>
                            <div className="mt-3 flex min-h-7 flex-wrap gap-2" data-testid="list-colors">
                              {colors.map((color, index) => <span key={color} className="inline-flex items-center gap-1.5 rounded-full border border-[#dce7de] bg-white px-2.5 py-1 text-xs text-[#365447]" data-testid={`chip-color-${index}`}><span className="h-2 w-2 rounded-full bg-[#769c81]" />{color}<button className="mr-0.5 text-[#8b9890] hover:text-[#9a4c37]" onClick={() => setColors((current) => current.filter((item) => item !== color))} aria-label={`حذف اللون ${color}`} data-testid={`button-remove-color-${index}`}><X className="h-3 w-3" /></button></span>)}
                              {!colors.length && <span className="text-xs text-[#98a39c]">لم تتم إضافة ألوان</span>}
                            </div>
                          </div>
                          <div className="rounded-xl border border-[#e4e9e3] bg-[#f8faf7] p-4">
                            <label className="mb-2 block text-xs font-bold text-[#43554b]" htmlFor="size-entry">المقاسات</label>
                            <div className="flex gap-2">
                              <input id="size-entry" className="h-10 min-w-0 flex-1 rounded-lg border border-[#d9dedb] bg-white px-3 text-sm outline-none focus:border-[#16745e]" value={sizeInput} onChange={(event) => setSizeInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addSize(); } }} placeholder="مثال: ٣٨ أو L" data-testid="input-add-size" />
                              <button className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[#e3ede6] text-[#16745e] transition hover:bg-[#d3e4d9]" onClick={addSize} aria-label="إضافة مقاس" data-testid="button-add-size"><Plus className="h-4 w-4" /></button>
                            </div>
                            <div className="mt-3 flex min-h-7 flex-wrap gap-2" data-testid="list-sizes">
                              {sizes.map((size, index) => <span key={size} className="inline-flex items-center gap-1.5 rounded-full border border-[#dce7de] bg-white px-2.5 py-1 text-xs text-[#365447]" data-testid={`chip-size-${index}`}>{size}<button className="mr-0.5 text-[#8b9890] hover:text-[#9a4c37]" onClick={() => setSizes((current) => current.filter((item) => item !== size))} aria-label={`حذف المقاس ${size}`} data-testid={`button-remove-size-${index}`}><X className="h-3 w-3" /></button></span>)}
                              {!sizes.length && <span className="text-xs text-[#98a39c]">لم تتم إضافة مقاسات</span>}
                            </div>
                          </div>
                        </div>

                        {pairs.length > 0 && (
                          <div className="mt-5">
                            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                              <div><p className="text-xs font-bold">تركيبات اللون والمقاس</p><p className="mt-1 text-[11px] text-[#77857f]">الموجود مسبقًا غير قابل للتحديد منعًا للتكرار.</p></div>
                              <button className="text-xs font-semibold text-[#16745e] hover:underline disabled:text-[#a2ada5]" onClick={() => setSelectedPairs(sellablePairs.map((pair) => pair.key))} disabled={!sellablePairs.length} data-testid="button-select-all-pairs">تحديد كل المتاح</button>
                            </div>
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="grid-variant-combinations">
                              {pairs.map((pair) => {
                                const alreadyExists = existingPairKeys.has(pair.key);
                                const selected = selectedPairs.includes(pair.key);
                                return (
                                  <button
                                    key={pair.key}
                                    className={`flex min-h-11 items-center gap-2.5 rounded-xl border px-3 py-2 text-right transition ${alreadyExists ? "cursor-not-allowed border-[#e8ebe7] bg-[#f3f5f2] text-[#9aa49d]" : selected ? "border-[#87ad94] bg-[#eaf3ec] text-[#244d39]" : "border-[#e1e6e0] bg-white text-[#4c5e54] hover:border-[#abc3b0] hover:bg-[#f6faf6]"}`}
                                    onClick={() => !alreadyExists && togglePair(pair.key)}
                                    disabled={alreadyExists}
                                    aria-pressed={selected}
                                    data-testid={`button-pair-${pairs.indexOf(pair)}`}
                                  >
                                    <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-md border ${alreadyExists ? "border-[#d4dbd5] bg-[#e8ece8]" : selected ? "border-[#16745e] bg-[#16745e] text-white" : "border-[#cfd8d0] bg-white"}`}>{alreadyExists ? <Check className="h-3 w-3" /> : selected ? <Check className="h-3 w-3" /> : null}</span>
                                    <span className="flex-1 text-xs font-semibold">{pair.color} <span className="mx-1 text-[#a3ada6]">/</span> {pair.size}</span>
                                    <span className={`text-[10px] ${alreadyExists ? "text-[#87938a]" : selected ? "text-[#3c7757]" : "text-[#a3ada6]"}`}>{alreadyExists ? "مضاف" : selected ? "محدد" : ""}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {chosenPairs.length > 0 && (
                          <div className="mt-5 overflow-hidden rounded-xl border border-[#dfe7df]" data-testid="variant-draft-table">
                            <div className="flex flex-wrap items-center justify-between gap-2 bg-[#f3f7f3] px-4 py-3">
                              <div><p className="text-xs font-bold">بيانات الأصناف المحددة</p><p className="mt-1 text-[11px] text-[#77857f]">يمكن توليد الرمز والباركود تلقائيًا ثم تعديلهما؛ السعر الفارغ يرث قيمة الموديل.</p></div>
                              <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#cbdcd0] bg-white px-2.5 text-[11px] font-semibold text-[#286347] hover:bg-[#edf5ef]" onClick={generateMissingIdentifiers} data-testid="button-generate-variant-identifiers">توليد الناقص</button>
                              <span className="rounded-full bg-white px-2.5 py-1 text-xs font-bold text-[#16745e]">{chosenPairs.length} تركيبة</span>
                            </div>
                            <div className="divide-y divide-[#e9eee9]">
                              {chosenPairs.map((pair, index) => {
                                const draft = variantDrafts[pair.key] ?? { key: pair.key, color: pair.color, size: pair.size, code: "", barcode: "", costPrice: "", salePrice: "" };
                                return (
                                  <div className="grid gap-3 bg-white px-4 py-4 md:grid-cols-[minmax(95px,.7fr)_minmax(130px,1fr)_minmax(130px,1fr)]" key={pair.key} data-testid={`row-variant-draft-${index}`}>
                                    <div className="flex items-center gap-2 md:flex-col md:items-start md:justify-center md:gap-0">
                                      <span className="text-sm font-bold text-[#2d493b]">{pair.color} / {pair.size}</span>
                                      <span className="text-[10px] text-[#87938a]">تركيبة {index + 1}</span>
                                    </div>
                                      <div className="grid grid-cols-2 gap-2 md:grid-cols-1">
                                       <label className="text-[10px] font-semibold text-[#758279]">رمز الصنف <span className="text-[#a4482d]">*</span><input className="mt-1 h-9 w-full rounded-lg border border-[#d9dedb] bg-[#fbfcfa] px-2.5 text-xs text-[#20352f] outline-none focus:border-[#16745e]" value={draft.code} onChange={(event) => setDraftField(pair.key, "code", event.target.value)} placeholder={`${activeModel.code}-${index + 1}`} dir="ltr" data-testid={`input-variant-code-${index}`} /></label>
                                       <label className="text-[10px] font-semibold text-[#758279]">باركود اختياري<input className="mt-1 h-9 w-full rounded-lg border border-[#d9dedb] bg-[#fbfcfa] px-2.5 text-xs text-[#20352f] outline-none focus:border-[#16745e]" value={draft.barcode} onChange={(event) => setDraftField(pair.key, "barcode", event.target.value)} placeholder="يُترك فارغًا عند عدم توفره" dir="ltr" data-testid={`input-variant-barcode-${index}`} /></label>
                                    </div>
                                    <div className="grid grid-cols-2 gap-2">
                                      <label className="text-[10px] font-semibold text-[#758279]">التكلفة <span className="font-normal">— تورث عند الفراغ</span><input className="mt-1 h-9 w-full rounded-lg border border-[#d9dedb] bg-[#fbfcfa] px-2.5 text-xs text-[#20352f] outline-none focus:border-[#16745e]" value={draft.costPrice} onChange={(event) => setDraftField(pair.key, "costPrice", event.target.value)} type="number" min="0" step="0.01" placeholder={String(activeModel.costPrice ?? "تكلفة الموديل")} dir="ltr" data-testid={`input-variant-cost-${index}`} /></label>
                                      <label className="text-[10px] font-semibold text-[#758279]">سعر البيع <span className="font-normal">— يورث عند الفراغ</span><input className="mt-1 h-9 w-full rounded-lg border border-[#d9dedb] bg-[#fbfcfa] px-2.5 text-xs text-[#20352f] outline-none focus:border-[#16745e]" value={draft.salePrice} onChange={(event) => setDraftField(pair.key, "salePrice", event.target.value)} type="number" min="0" step="0.01" placeholder={String(activeModel.salePrice ?? "سعر الموديل")} dir="ltr" data-testid={`input-variant-sale-${index}`} /></label>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {batchError && (
                          <div className="mt-4 rounded-xl border border-[#e5c8bd] bg-[#fff8f4] p-4" role="alert" data-testid="alert-variant-partial-failure">
                            <div className="flex items-start gap-3">
                              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-[#a4482d]" />
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-bold text-[#743a2a]">توقفت الدفعة بعد تعثر طلب واحد</p>
                                <p className="mt-1 text-xs leading-5 text-[#815c50]">إنشاء الأصناف يتم بالتتابع وليس كعملية ذرّية. تم تحديث قائمة المتغيرات؛ الأصناف الناجحة باقية، وإعادة المحاولة ستتجاوز أي تركيبة موجودة.</p>
                                <p className="mt-2 break-words text-[11px] text-[#996451]" data-testid="text-variant-error-detail">{batchError.message}</p>
                              </div>
                            </div>
                            <button className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg bg-[#8c4b37] px-3 text-xs font-bold text-white transition hover:bg-[#713a2b] disabled:opacity-60" onClick={retryRemaining} disabled={createVariantsMutation.isPending} data-testid="button-retry-remaining"><RefreshCw className="h-3.5 w-3.5" /> إعادة محاولة المتبقي</button>
                          </div>
                        )}

                        <div className="mt-5 flex flex-col-reverse gap-3 border-t border-[#e8ece7] pt-4 sm:flex-row sm:items-center sm:justify-between">
                          <p className="flex items-start gap-2 text-[11px] leading-5 text-[#77857f]"><CircleHelp className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#8c9a90]" />لن تُنشأ تركيبة غير محددة. لكل متغير مخزونه ورمزه وباركوده المستقل.</p>
                          <button className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[#16745e] px-5 text-sm font-bold text-white transition hover:bg-[#105a49] focus:outline-none focus:ring-2 focus:ring-[#16745e]/30 disabled:cursor-not-allowed disabled:bg-[#a9b9af]" onClick={handleBatchSave} disabled={!chosenPairs.length || createVariantsMutation.isPending} data-testid="button-create-variants">
                            {createVariantsMutation.isPending ? <><LoaderCircle className="h-4 w-4 animate-spin" /> جارٍ الحفظ {savingProgress ? `${savingProgress.done} / ${savingProgress.total}` : ""}</> : <><Plus className="h-4 w-4" /> إنشاء {chosenPairs.length || ""} صنف فرعي</>}
                          </button>
                        </div>
                        {createVariantsMutation.isPending && savingProgress && (
                          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#e6ece7]" data-testid="progress-variant-creation"><div className="h-full rounded-full bg-[#16745e] transition-all" style={{ width: `${Math.min(100, (savingProgress.done / Math.max(savingProgress.total, 1)) * 100)}%` }} /></div>
                        )}
                      </div> : (
                        <div className="mt-5 border-t border-[#e8ece7] pt-5 text-xs leading-6 text-[#77857f]" data-testid="notice-no-create-permission">
                          لديك صلاحية عرض الموديلات والأصناف المرتبطة فقط. يلزم منح صلاحية إنشاء الأصناف لإضافة تركيبات جديدة.
                        </div>
                      )}
                    </>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </div>

      {showCreateModel && canCreateItems && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-[#142b23]/45 px-3 py-6 backdrop-blur-[2px]" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !createModelMutation.isPending) setShowCreateModel(false); }} data-testid="dialog-create-model-backdrop">
          <section role="dialog" aria-modal="true" aria-labelledby="create-model-title" className="my-auto w-full max-w-2xl overflow-hidden rounded-2xl border border-[#e1e6df] bg-[#fbfcfa] shadow-[0_24px_80px_rgba(12,42,32,.24)]" data-testid="dialog-create-model">
            <div className="flex items-start justify-between border-b border-[#e8ece7] bg-[#f4f7f3] px-5 py-5 sm:px-7">
              <div><div className="mb-2 flex items-center gap-2 text-[10px] font-semibold tracking-[.14em] text-[#8b7040]"><span className="h-px w-5 bg-[#b49a60]" /> أصل التشكيلة</div><h2 id="create-model-title" className="text-lg font-bold">إنشاء موديل رئيسي</h2><p className="mt-1 text-xs text-[#77857f]">بيانات الصنف الأساسية التي سترثها المتغيرات الجديدة.</p></div>
              <button className="grid h-9 w-9 place-items-center rounded-lg text-[#728078] hover:bg-[#e8ede8] disabled:opacity-40" onClick={() => setShowCreateModel(false)} disabled={createModelMutation.isPending} aria-label="إغلاق" data-testid="button-close-create-model"><X className="h-4 w-4" /></button>
            </div>
            <div className="p-5 sm:p-7">
              <Form {...modelForm}>
                <form onSubmit={modelForm.handleSubmit((values) => createModelMutation.mutate(values))} className="grid gap-x-4 gap-y-4 sm:grid-cols-2" data-testid="form-create-model">
                  <FormField control={modelForm.control} name="nameAr" render={({ field }) => <FormItem className="sm:col-span-2"><FormLabel>اسم الموديل بالعربية *</FormLabel><FormControl><input className="h-10 w-full rounded-lg border border-[#d9dedb] bg-white px-3 text-sm outline-none focus:border-[#16745e]" placeholder="مثال: قميص يومي بقصة مستقيمة" data-testid="input-model-name-ar" {...field} /></FormControl><FormMessage /></FormItem>} />
                  <FormField control={modelForm.control} name="code" render={({ field }) => <FormItem><FormLabel>رمز الموديل *</FormLabel><FormControl><input className="h-10 w-full rounded-lg border border-[#d9dedb] bg-white px-3 text-sm outline-none focus:border-[#16745e]" placeholder="مثال: SH-240" dir="ltr" data-testid="input-model-code" {...field} /></FormControl><FormMessage /></FormItem>} />
                  <FormField control={modelForm.control} name="nameEn" render={({ field }) => <FormItem><FormLabel>الاسم بالإنجليزية</FormLabel><FormControl><input className="h-10 w-full rounded-lg border border-[#d9dedb] bg-white px-3 text-sm outline-none focus:border-[#16745e]" placeholder="Optional model name" dir="ltr" data-testid="input-model-name-en" {...field} /></FormControl><FormMessage /></FormItem>} />
                  <FormField control={modelForm.control} name="groupId" render={({ field }) => <FormItem><FormLabel>مجموعة الصنف *</FormLabel><FormControl><FormSelect value={field.value} onChange={field.onChange} testId="select-model-group" placeholder={groupsQuery.isLoading ? "جارٍ تحميل المجموعات…" : "اختر المجموعة"}>{groups.map((group) => <option key={group.id} value={String(group.id)}>{group.nameAr}</option>)}</FormSelect></FormControl><FormMessage /></FormItem>} />
                  <FormField control={modelForm.control} name="unitId" render={({ field }) => <FormItem><FormLabel>وحدة القياس *</FormLabel><FormControl><FormSelect value={field.value} onChange={field.onChange} testId="select-model-unit" placeholder={unitsQuery.isLoading ? "جارٍ تحميل الوحدات…" : "اختر الوحدة"}>{units.map((unit) => <option key={unit.id} value={String(unit.id)}>{unit.nameAr}</option>)}</FormSelect></FormControl><FormMessage /></FormItem>} />
                  <FormField control={modelForm.control} name="costPrice" render={({ field }) => <FormItem><FormLabel>التكلفة الأساسية *</FormLabel><FormControl><input className="h-10 w-full rounded-lg border border-[#d9dedb] bg-white px-3 text-sm outline-none focus:border-[#16745e]" type="number" min="0" step="0.01" dir="ltr" placeholder="0.00" data-testid="input-model-cost" {...field} /></FormControl><FormMessage /></FormItem>} />
                  <FormField control={modelForm.control} name="salePrice" render={({ field }) => <FormItem><FormLabel>سعر البيع الأساسي *</FormLabel><FormControl><input className="h-10 w-full rounded-lg border border-[#d9dedb] bg-white px-3 text-sm outline-none focus:border-[#16745e]" type="number" min="0" step="0.01" dir="ltr" placeholder="0.00" data-testid="input-model-sale" {...field} /></FormControl><FormMessage /></FormItem>} />
                  <FormField control={modelForm.control} name="vatRate" render={({ field }) => <FormItem><FormLabel>نسبة الضريبة % *</FormLabel><FormControl><input className="h-10 w-full rounded-lg border border-[#d9dedb] bg-white px-3 text-sm outline-none focus:border-[#16745e]" type="number" min="0" step="0.01" dir="ltr" data-testid="input-model-vat" {...field} /></FormControl><FormMessage /></FormItem>} />
                  <div className="rounded-lg bg-[#eff4ef] px-3 py-2 text-xs leading-5 text-[#58705f] sm:col-span-2" data-testid="text-model-inheritance-note">سيُنشأ هذا كسجل أب عادي (ليس حزمة). مجموعة الصنف والوحدة والضريبة تُستخدم افتراضيًا للأصناف الفرعية.</div>
                  <div className="mt-1 flex flex-col-reverse gap-2 border-t border-[#e8ece7] pt-4 sm:col-span-2 sm:flex-row sm:justify-end">
                    <button type="button" className="h-10 rounded-lg border border-[#dce2dc] px-4 text-sm font-semibold text-[#607067] hover:bg-[#f1f4f0] disabled:opacity-50" onClick={() => setShowCreateModel(false)} disabled={createModelMutation.isPending} data-testid="button-cancel-create-model">إلغاء</button>
                    <button type="submit" className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[#16745e] px-5 text-sm font-bold text-white hover:bg-[#105a49] disabled:opacity-60" disabled={createModelMutation.isPending || !groups.length || !units.length} data-testid="button-submit-create-model">{createModelMutation.isPending ? <><LoaderCircle className="h-4 w-4 animate-spin" /> جارٍ الإنشاء…</> : <><CheckCircle2 className="h-4 w-4" /> إنشاء الموديل</>}</button>
                  </div>
                </form>
              </Form>
              {(!groups.length || !units.length) && !groupsQuery.isLoading && !unitsQuery.isLoading && (
                <p className="mt-3 text-xs text-[#9a4c37]" data-testid="text-missing-model-choices">يلزم توفر مجموعة صنف ووحدة قياس قبل إنشاء الموديل.</p>
              )}
            </div>
          </section>
        </div>
      )}
      {showAdoptModel && canEditItems && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-[#142b23]/45 px-3 py-6 backdrop-blur-[2px]" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !adoptModelMutation.isPending) setShowAdoptModel(false); }} data-testid="dialog-adopt-model-backdrop">
          <section role="dialog" aria-modal="true" aria-labelledby="adopt-model-title" className="my-auto w-full max-w-xl overflow-hidden rounded-2xl border border-[#e1e6df] bg-[#fbfcfa] shadow-[0_24px_80px_rgba(12,42,32,.24)]" data-testid="dialog-adopt-model">
            <div className="flex items-start justify-between border-b border-[#e8ece7] bg-[#f4f7f3] px-5 py-5">
              <div><div className="mb-2 flex items-center gap-2 text-[10px] font-semibold tracking-[.14em] text-[#8b7040]"><span className="h-px w-5 bg-[#b49a60]" /> ربط صنف قائم</div><h2 id="adopt-model-title" className="text-lg font-bold">اختر موديلًا من الأصناف الحالية</h2><p className="mt-1 text-xs leading-5 text-[#77857f]">يُضاف وسم تشكيلة فقط؛ تبقى بيانات الصنف وحركاته كما هي.</p></div>
              <button className="grid h-9 w-9 place-items-center rounded-lg text-[#728078] hover:bg-[#e8ede8] disabled:opacity-40" onClick={() => setShowAdoptModel(false)} disabled={adoptModelMutation.isPending} aria-label="إغلاق" data-testid="button-close-adopt-model"><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-4 p-5">
              <label className="relative block">
                <Search className="absolute right-3 top-2.5 h-4 w-4 text-[#86928c]" />
                <input className="h-10 w-full rounded-lg border border-[#dce2dc] bg-white pr-9 pl-3 text-sm outline-none focus:border-[#16745e]" value={adoptSearch} onChange={(event) => setAdoptSearch(event.target.value)} placeholder="ابحث بالاسم أو الرمز" data-testid="input-search-adoptable-models" />
              </label>
              <FormSelect value={adoptModelId} onChange={setAdoptModelId} testId="select-adopt-model" placeholder={adoptableQuery.isLoading ? "جارٍ تحميل الأصناف…" : "اختر صنفًا مخزنيًا رئيسيًا"}>
                {filteredAdoptableModels.map((item) => <option key={item.id} value={String(item.id)}>{item.nameAr} — {item.code}</option>)}
              </FormSelect>
              {filteredAdoptableModels.length === 0 && (
                <p className="rounded-lg bg-[#f4f7f3] px-3 py-3 text-xs leading-5 text-[#77857f]" data-testid="empty-adoptable-models">
                  {adoptableQuery.isLoading ? "جارٍ تحميل الأصناف…" : "لا توجد أصناف مخزنية رئيسية تطابق البحث. يمكنك إنشاء موديل جديد بدلًا من ذلك."}
                </p>
              )}
              <div className="flex flex-col-reverse gap-2 border-t border-[#e8ece7] pt-4 sm:flex-row sm:justify-end">
                <button type="button" className="h-10 rounded-lg border border-[#dce2dc] px-4 text-sm font-semibold text-[#607067] hover:bg-[#f1f4f0]" onClick={() => setShowAdoptModel(false)} disabled={adoptModelMutation.isPending} data-testid="button-cancel-adopt-model">إلغاء</button>
                <button type="button" className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[#16745e] px-5 text-sm font-bold text-white hover:bg-[#105a49] disabled:cursor-not-allowed disabled:opacity-50" onClick={() => adoptModelMutation.mutate(Number(adoptModelId))} disabled={!adoptModelId || adoptModelMutation.isPending} data-testid="button-confirm-adopt-model">
                  {adoptModelMutation.isPending ? <><LoaderCircle className="h-4 w-4 animate-spin" /> جارٍ الربط…</> : <><CheckCircle2 className="h-4 w-4" /> اعتماد كموديل</>}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
      <BulkLabelDialog
        open={labelsOpen}
        onOpenChange={setLabelsOpen}
        items={variants.map((variant) => ({
          id: variant.id,
          code: variant.code,
          nameAr: variant.nameAr,
          nameEn: variant.nameEn,
          barcode: variant.barcode,
          salePrice: variant.salePrice,
        }))}
      />
    </main>
  );
}
