import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import {
  listHistoricalOwnerBoqPriceReferences,
  type HistoricalOwnerBoqPriceReference,
} from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchCombobox, type ComboboxItem } from "@/components/ui/search-combobox";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { contractWorkItemDefaults } from "@/lib/contractingWorkItemDefaults";
import ContractingProjectScope from "./ContractingProjectScope";
import { ContractingArchiveAction } from "./ContractingArchiveAction";

const API = import.meta.env.VITE_API_URL || "";

type Direction = "owner" | "subcontract";
type WorkItem = {
  id: number;
  code: string | null;
  nameAr: string;
  unit: string;
  plannedQty: string;
};
type BoqLine = {
  id: number;
  workItemId: number;
  direction: Direction;
  ownerContractId: number | null;
  subcontractorContractId: number | null;
  sourceOwnerLineId: number | null;
  baseLineId: number | null;
  quantityDelta: string | null;
  unitPriceDelta: string | null;
  unitPriceOverride: string | null;
  lineCode: string | null;
  description: string | null;
  unit: string;
  quantity: string;
  unitPrice: string;
  totalAmount: string;
  workItemCode: string | null;
  workItemName: string | null;
};

type Draft = {
  workItemId: string;
  sourceOwnerLineId: string;
  lineCode: string;
  description: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  baseLineId: string;
  quantityDelta: string;
  unitPriceDelta: string;
  unitPriceOverride: string;
};

export type PendingContractBoqLine = Draft;

function referenceSourceLabel(source: HistoricalOwnerBoqPriceReference["latest"]): string {
  if (!source) return "—";
  return [
    `${source.projectName}${source.projectCode ? ` (${source.projectCode})` : ""}`,
    source.contractNumber ? `عقد ${source.contractNumber}` : null,
    source.contractDate || null,
  ].filter(Boolean).join(" · ");
}

function referenceMoney(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function emptyDraft(): Draft {
  return {
    workItemId: "",
    sourceOwnerLineId: "",
    lineCode: "",
    description: "",
    unit: "",
    quantity: "0",
    unitPrice: "0",
    baseLineId: "",
    quantityDelta: "0",
    unitPriceDelta: "0",
    unitPriceOverride: "",
  };
}

function total(draft: Pick<Draft, "quantity" | "unitPrice">): number {
  return Number(draft.quantity || 0) * Number(draft.unitPrice || 0);
}

export default function ContractingContractBoqEditor({
  projectId,
  projectName,
  projectCode,
  direction,
  active,
  contractId,
  contractType = "main",
  parentContractId = null,
  onChanged,
  pendingLines = [],
  onPendingLinesChange,
}: {
  projectId: number;
  projectName: string;
  projectCode: string;
  direction: Direction;
  active: boolean;
  contractId: number | null;
  contractType?: string;
  parentContractId?: number | null;
  onChanged?: () => void;
  pendingLines?: PendingContractBoqLine[] | null;
  onPendingLinesChange?: Dispatch<SetStateAction<PendingContractBoqLine[] | null>>;
}) {
  const { token, user, actingCompanyId } = useAuth() as any;
  const { toast } = useToast();
  const [rows, setRows] = useState<BoqLine[]>([]);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [ownerLines, setOwnerLines] = useState<BoqLine[]>([]);
  const [baseLines, setBaseLines] = useState<BoqLine[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingPendingIndex, setEditingPendingIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [priceReference, setPriceReference] = useState<HistoricalOwnerBoqPriceReference | null>(null);
  const [priceReferenceLoading, setPriceReferenceLoading] = useState(false);
  const [priceReferenceError, setPriceReferenceError] = useState<string | null>(null);
  const [priceReferenceRetry, setPriceReferenceRetry] = useState(0);

  const contractQuery = direction === "owner"
    ? `ownerContractId=${contractId}`
    : `subcontractorContractId=${contractId}`;
  const path = `/api/contracting/projects/${projectId}/boq-lines?direction=${direction}&${contractQuery}`;

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setLoadError(null);
    try {
      const basePath = parentContractId
        ? `${API}/api/contracting/projects/${projectId}/boq-lines?direction=${direction}&${direction === "owner" ? `ownerContractId=${parentContractId}` : `subcontractorContractId=${parentContractId}`}`
        : null;
      const [linesResponse, workItemsResponse, baseResponse] = await Promise.all([
        contractId ? fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } }) : Promise.resolve(null),
        fetch(`${API}/api/contracting/projects/${projectId}/work-items`, { headers: { Authorization: `Bearer ${token}` } }),
        basePath ? fetch(basePath, { headers: { Authorization: `Bearer ${token}` } }) : Promise.resolve(null),
      ]);
      if (linesResponse && !linesResponse.ok) throw new Error((await linesResponse.json().catch(() => ({}))).error || `HTTP ${linesResponse.status}`);
      if (!workItemsResponse.ok) throw new Error((await workItemsResponse.json().catch(() => ({}))).error || `HTTP ${workItemsResponse.status}`);
      const contractLines = linesResponse ? await linesResponse.json() : [];
      const projectItems = await workItemsResponse.json();
      if (!Array.isArray(contractLines) || !Array.isArray(projectItems)) {
        throw new Error("استجابة بنود العقد أو التنفيذ غير صالحة");
      }
      setRows(contractLines);
      setWorkItems(projectItems);
      // Only the first main agreement proposes project-owned WBS lines.
      // null is "not initialized"; [] is a deliberate empty/manual draft.
      if (contractId == null && contractType === "main" && pendingLines === null) {
        onPendingLinesChange?.(current => current ?? projectItems.map(contractWorkItemDefaults));
      } else if (contractId == null && pendingLines === null) {
        onPendingLinesChange?.(current => current ?? []);
      }
      if (baseResponse?.ok) setBaseLines(await baseResponse.json());
      if (direction === "subcontract") {
        const ownerResponse = await fetch(`${API}/api/contracting/projects/${projectId}/boq-lines?direction=owner`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (ownerResponse.ok) setOwnerLines(await ownerResponse.json());
      }
    } catch (caught: any) {
      setLoadError(caught?.message || "تعذر تحميل بنود المشروع");
      toast({ title: caught?.message || "تعذر تحميل جدول الكميات", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [contractId, contractType, direction, parentContractId, path, projectId, toast, token]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  useEffect(() => {
    const workItemId = Number(draft?.workItemId);
    if (!active || direction !== "owner" || !token || !Number.isInteger(workItemId) || workItemId <= 0) {
      setPriceReference(null);
      setPriceReferenceLoading(false);
      setPriceReferenceError(null);
      return;
    }

    const controller = new AbortController();
    setPriceReference(null);
    setPriceReferenceError(null);
    setPriceReferenceLoading(true);
    void listHistoricalOwnerBoqPriceReferences(projectId, { workItemId }, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(actingCompanyId ? { "x-acting-company-id": String(actingCompanyId) } : {}),
      },
      signal: controller.signal,
    }).then(references => {
      if (!controller.signal.aborted) setPriceReference(references[0] ?? null);
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) {
        setPriceReferenceError(caught instanceof Error ? caught.message : "تعذر تحميل مرجع الأسعار");
      }
    }).finally(() => {
      if (!controller.signal.aborted) setPriceReferenceLoading(false);
    });
    return () => controller.abort();
  }, [active, actingCompanyId, direction, draft?.workItemId, priceReferenceRetry, projectId, token]);

  const workItemOptions = useMemo<ComboboxItem[]>(
    () => workItems.map(item => ({
      value: String(item.id),
      label: `${item.code ? `${item.code} — ` : ""}${item.nameAr} · #${item.id}`,
    })),
    [workItems],
  );
  const availableWorkItems = useMemo(
    () => workItems.filter(item =>
      !rows.some(row => row.workItemId === item.id)
      && !(pendingLines ?? []).some(line => Number(line.workItemId) === item.id)),
    [workItems, rows, pendingLines],
  );
  const ownerLineOptions = useMemo<ComboboxItem[]>(
    () => [
      { value: "__none__", label: "بدون ربط بسطر المالك" },
      ...ownerLines.filter(line => !draft?.workItemId || String(line.workItemId) === draft.workItemId).map(line => ({
        value: String(line.id),
        label: `${line.workItemCode ? `${line.workItemCode} — ` : ""}${line.workItemName || "بند"} · ${Number(line.quantity).toLocaleString()} ${line.unit}`,
      })),
    ],
    [ownerLines, draft?.workItemId],
  );
  const baseLineOptions = useMemo<ComboboxItem[]>(
    () => [
      { value: "__none__", label: "اختر سطر العقد الأساسي" },
      ...baseLines.map(line => ({
        value: String(line.id),
        label: `${line.workItemCode ? `${line.workItemCode} — ` : ""}${line.workItemName || "بند"} · ${Number(line.quantity).toLocaleString()} ${line.unit}`,
      })),
    ],
    [baseLines],
  );

  function beginAdd() {
    setEditingId(null);
    setEditingPendingIndex(null);
    setDraft(emptyDraft());
  }

  function beginEdit(row: BoqLine) {
    setEditingId(row.id);
    setEditingPendingIndex(null);
    setDraft({
      workItemId: String(row.workItemId),
      sourceOwnerLineId: row.sourceOwnerLineId == null ? "" : String(row.sourceOwnerLineId),
      lineCode: row.lineCode ?? "",
      description: row.description ?? "",
      unit: row.unit,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      baseLineId: row.baseLineId == null ? "" : String(row.baseLineId),
      quantityDelta: row.quantityDelta ?? "0",
      unitPriceDelta: row.unitPriceDelta ?? "0",
      unitPriceOverride: row.unitPriceOverride ?? "",
    });
  }

  function chooseWorkItem(value: string) {
    const selected = workItems.find(item => String(item.id) === value);
    if (!selected) return;
    setDraft(current => !current || current.workItemId === value ? current : {
      ...current,
      ...contractWorkItemDefaults(selected),
    });
  }

  function chooseBaseLine(value: string) {
    const selected = baseLines.find(item => String(item.id) === value);
    setDraft(current => current ? {
      ...current,
      baseLineId: value === "__none__" ? "" : value,
      workItemId: selected ? String(selected.workItemId) : current.workItemId,
      unit: selected?.unit ?? current.unit,
      unitPrice: selected?.unitPrice ?? current.unitPrice,
    } : current);
  }

  async function save() {
    if (!draft?.workItemId) {
      toast({ title: "اختر بند التنفيذ", variant: "destructive" });
      return;
    }
    if (Number(draft.quantity) < 0 || Number(draft.unitPrice) < 0) {
      toast({ title: "الكمية والسعر لا يمكن أن يكونا سالبين", variant: "destructive" });
      return;
    }
    if (contractId == null || editingPendingIndex != null) {
      const next = [...(pendingLines ?? [])];
      if (editingPendingIndex == null) next.push(draft);
      else next[editingPendingIndex] = draft;
      onPendingLinesChange?.(next);
      setDraft(null);
      setEditingPendingIndex(null);
      return;
    }
    const body = {
      direction,
      workItemId: Number(draft.workItemId),
      ownerContractId: direction === "owner" ? contractId : null,
      subcontractorContractId: direction === "subcontract" ? contractId : null,
      sourceOwnerLineId: direction === "subcontract" && draft.sourceOwnerLineId !== "__none__" && draft.sourceOwnerLineId
        ? Number(draft.sourceOwnerLineId)
        : null,
      lineCode: draft.lineCode,
      description: draft.description,
      unit: draft.unit,
      quantity: draft.quantity,
      unitPrice: draft.unitPrice,
      baseLineId: isChangeOrder && draft.baseLineId ? Number(draft.baseLineId) : null,
      quantityDelta: isChangeOrder && draft.baseLineId ? draft.quantityDelta : null,
      unitPriceDelta: isChangeOrder && draft.baseLineId ? draft.unitPriceDelta : null,
      unitPriceOverride: isChangeOrder && draft.baseLineId && draft.unitPriceOverride
        ? draft.unitPriceOverride : null,
    };
    try {
      const response = await fetch(`${API}/api/contracting/${editingId == null ? `projects/${projectId}/boq-lines` : `boq-lines/${editingId}`}`, {
        method: editingId == null ? "POST" : "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
      setDraft(null);
      setEditingId(null);
      await load();
      onChanged?.();
    } catch (caught: any) {
      toast({ title: caught?.message || "تعذر حفظ سطر جدول الكميات", variant: "destructive" });
    }
  }

  const isChangeOrder = contractType === "change_order" || contractType === "addendum";

  async function remove(id: number) {
    if (!confirm("تأكيد حذف سطر جدول الكميات؟")) return;
    try {
      const response = await fetch(`${API}/api/contracting/boq-lines/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
      await load();
      onChanged?.();
    } catch (caught: any) {
      toast({ title: caught?.message || "تعذر حذف السطر", variant: "destructive" });
    }
  }

  return (
    <section className="col-span-2 mt-4 space-y-2 rounded-md border border-sky-200 bg-sky-50/50 p-3 dark:border-sky-900 dark:bg-sky-950/20" dir="rtl">
      <ContractingProjectScope projectId={projectId} projectName={projectName} projectCode={projectCode} />
      <div className="flex items-center justify-between gap-2">
        <div>
          <h5 className="font-semibold">جدول كميات العقد</h5>
          <p className="text-[11px] text-slate-500">
            {direction === "owner"
              ? "الكميات والأسعار التجارية الخاصة بعقد المالك"
              : "الكميات والأسعار الخاصة بعقد الباطن — يمكن تقسيم سطر المالك بين عدة مقاولين"}
          </p>
        </div>
        <div className="flex gap-2">
          {loadError && <Button size="sm" variant="outline" onClick={() => void load()}>إعادة تحميل البنود</Button>}
          {!draft && <Button size="sm" variant="outline" onClick={beginAdd}><Plus className="mx-1 h-4 w-4" />إضافة سطر</Button>}
        </div>
      </div>
      {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
      {contractId != null && direction === "owner" && contractType === "main" && !loadError && !loading && (
        <div className="rounded border border-sky-200 bg-white p-3 text-xs leading-5 dark:bg-slate-900">
          <p>بنود التنفيذ في المشروع ليست أسطر جدول كميات محفوظة في هذا العقد. البنود الموجودة مسبقًا في العقد تبقى بأسعارها وكمياتها.</p>
          {availableWorkItems.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span>{availableWorkItems.length} بند تنفيذ غير مرتبط بهذا العقد.</span>
              <Button type="button" size="sm" variant="outline" data-testid="import-project-work-items"
                onClick={() => onPendingLinesChange?.(current => [
                  ...(current ?? []),
                  ...availableWorkItems
                    .filter(item => !(current ?? []).some(line => Number(line.workItemId) === item.id))
                    .map(contractWorkItemDefaults),
                ])}>
                عرض البنود لإضافتها للعقد
              </Button>
              <span>ستظهر كمسودات قابلة للتعديل؛ احفظ العقد لتسجيلها. سعر البيع لا يُنسخ من التكلفة.</span>
            </div>
          ) : <p className="mt-1 text-muted-foreground">لا توجد بنود تنفيذ جديدة متاحة للإضافة.</p>}
        </div>
      )}

      {draft && (
        <div className="grid grid-cols-2 gap-2 rounded border bg-white p-3 dark:bg-slate-900 md:grid-cols-4" data-testid="contract-boq-line-editor">
          <div className="col-span-2">
            <label className="text-[11px] text-slate-600">بند المشروع</label>
            <SearchCombobox
              items={workItemOptions}
              value={draft.workItemId}
              onValueChange={chooseWorkItem}
              placeholder="اختر بنداً"
              searchPlaceholder="بحث بالكود أو اسم البند..."
              emptyText="لا توجد بنود تنفيذ"
              testId="contract-boq-work-item-picker"
            />
          </div>
          {draft.workItemId && (
            <p className="col-span-2 rounded border border-sky-100 bg-sky-50 p-2 text-xs leading-5 text-sky-900 md:col-span-4 dark:bg-sky-950 dark:text-sky-100">
              كمية البند المخططة بالمشروع: <strong>{workItems.find(item => String(item.id) === draft.workItemId)?.plannedQty ?? "—"} {workItems.find(item => String(item.id) === draft.workItemId)?.unit ?? ""}</strong>.
              {" "}تُقترح عند اختيار البند؛ عدّل كمية هذا العقد وأدخل سعره المتفق عليه. لا يُنقل سعر المالك أو التكلفة التخطيطية تلقائيًا.
              {" "}بعد حفظ السطر يظهر البند في مستخلصات هذا العقد لإدخال التنفيذ ونسبة الاعتماد.
            </p>
          )}
          {direction === "owner" && draft.workItemId && (
            <section className="col-span-2 space-y-2 rounded border border-emerald-200 bg-emerald-50/60 p-3 text-xs md:col-span-4 dark:border-emerald-900 dark:bg-emerald-950/20"
              aria-label="مرجع أسعار بنود المالك" data-testid="owner-boq-price-reference">
              <div>
                <h4 className="font-semibold text-emerald-950 dark:text-emerald-100">مرجع أسعار عقود المالك المعتمدة</h4>
                <p className="mt-1 text-slate-600 dark:text-slate-300">
                  مطابقة دقيقة لاسم بند المشروع ووحدته من عقود المالك المعتمدة في المشاريع الأخرى؛ لا تشمل عقود الباطن أو التكلفة التقديرية.
                  اختر السعر لإدخاله في هذا العقد، أو عدّل السعر يدويًا.
                </p>
              </div>
              {priceReferenceLoading && <p role="status" className="text-slate-500">جارٍ تحميل الأسعار المقارنة…</p>}
              {priceReferenceError && (
                <div role="alert" className="flex flex-wrap items-center gap-2 text-red-700">
                  <span>{priceReferenceError}</span>
                  <Button type="button" size="sm" variant="outline" onClick={() => setPriceReferenceRetry(value => value + 1)}>
                    إعادة المحاولة
                  </Button>
                </div>
              )}
              {!priceReferenceLoading && !priceReferenceError && priceReference && priceReference.comparableCount === 0 && (
                <p className="text-slate-500">لا توجد أسعار معتمدة مطابقة لهذا البند والوحدة.</p>
              )}
              {priceReference && priceReference.comparableCount > 0 && (
                <>
                  <div className="grid gap-2 md:grid-cols-2">
                    {priceReference.latest && (
                      <div className="rounded border bg-white p-2 dark:bg-slate-900">
                        <div className="font-semibold">آخر سعر معتمد</div>
                        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                          <strong className="tabular-nums">{referenceMoney(priceReference.latest.unitPrice)} ر.س / {priceReference.unit}</strong>
                          <Button type="button" size="sm" variant="outline"
                            onClick={() => setDraft(current => current ? { ...current, unitPrice: String(priceReference.latest!.unitPrice) } : current)}>
                            استخدام آخر سعر
                          </Button>
                        </div>
                        <div className="mt-1 text-slate-500">{referenceSourceLabel(priceReference.latest)}</div>
                      </div>
                    )}
                    {priceReference.medianUnitPrice != null && (
                      <div className="rounded border bg-white p-2 dark:bg-slate-900">
                        <div className="font-semibold">وسيط الأسعار ({priceReference.comparableCount} بندًا)</div>
                        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                          <strong className="tabular-nums">{referenceMoney(priceReference.medianUnitPrice)} ر.س / {priceReference.unit}</strong>
                          <Button type="button" size="sm" variant="outline"
                            onClick={() => setDraft(current => current ? { ...current, unitPrice: String(priceReference.medianUnitPrice) } : current)}>
                            استخدام الوسيط
                          </Button>
                        </div>
                        {priceReference.medianSources.length > 0 && (
                          <div className="mt-1 text-slate-500">
                            {priceReference.medianSources.map(referenceSourceLabel).join(" ؛ ")}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  {priceReference.recentSources.length > 1 && (
                    <details className="rounded border bg-white px-2 py-1 dark:bg-slate-900">
                      <summary className="cursor-pointer">عرض أسعار العقود المقارنة الحديثة</summary>
                      <ul className="mt-1 space-y-1">
                        {priceReference.recentSources.map((source, index) => (
                          <li key={`${source.contractNumber ?? "contract"}-${source.contractDate ?? "date"}-${index}`}>
                            <span className="font-semibold tabular-nums">{referenceMoney(source.unitPrice)} ر.س</span>
                            {" — "}{referenceSourceLabel(source)}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </>
              )}
            </section>
          )}
          {direction === "subcontract" && (
            <div className="col-span-2">
              <label className="text-[11px] text-slate-600">سطر المالك المصدر (اختياري)</label>
              <SearchCombobox
                items={ownerLineOptions}
                value={draft.sourceOwnerLineId || "__none__"}
                onValueChange={value => setDraft({ ...draft, sourceOwnerLineId: value === "__none__" ? "" : value })}
                placeholder="بدون ربط"
                searchPlaceholder="بحث في أسطر عقد المالك..."
                testId="contract-boq-source-owner-picker"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                الربط اختياري للتتبع فقط ومن أسطر مالك هذا المشروع. سعر وكمية عقد الباطن مستقلان ولا يُنسخان أو يُستبدلان بسعر المالك.
              </p>
            </div>
          )}
           {isChangeOrder && (
             <>
               <div className="col-span-2">
                 <label className="text-[11px] text-slate-600">سطر العقد الأساسي للتغيير</label>
                 <SearchCombobox
                   items={baseLineOptions}
                   value={draft.baseLineId || "__none__"}
                   onValueChange={chooseBaseLine}
                   placeholder="اختر سطر العقد الأساسي"
                   searchPlaceholder="بحث في سطور العقد الأساسي..."
                   emptyText="لا توجد سطور أساسية لهذا العقد"
                   testId="contract-boq-base-line-picker"
                 />
               </div>
               {draft.baseLineId && (
                 <>
                   <div><label className="text-[11px] text-slate-600">تعديل الكمية (موجب/سالب)</label><Input type="number" step="0.0001" value={draft.quantityDelta} onChange={e => setDraft({ ...draft, quantityDelta: e.target.value })} /></div>
                   <div><label className="text-[11px] text-slate-600">تعديل سعر الوحدة</label><Input type="number" step="0.01" value={draft.unitPriceDelta} onChange={e => setDraft({ ...draft, unitPriceDelta: e.target.value })} /></div>
                 </>
               )}
             </>
           )}
          <div><label className="text-[11px] text-slate-600">الكود</label><Input value={draft.lineCode} onChange={e => setDraft({ ...draft, lineCode: e.target.value })} /></div>
          <div><label className="text-[11px] text-slate-600">الوحدة</label><Input value={draft.unit} onChange={e => setDraft({ ...draft, unit: e.target.value })} placeholder="م² / م³ / ساعة" /></div>
          <div><label className="text-[11px] text-slate-600">الكمية</label><Input type="number" min="0" value={draft.quantity} onChange={e => setDraft({ ...draft, quantity: e.target.value })} /></div>
           <div>
             <label className="text-[11px] text-slate-600">سعر الوحدة</label>
             <Input type="number" min="0" value={draft.unitPrice} onChange={e => setDraft({ ...draft, unitPrice: e.target.value })} />
             <p className="mt-1 text-[11px] text-muted-foreground">
               {direction === "owner"
                 ? "هذا سعر البيع المتفق عليه مع المالك لهذا العقد؛ لا يوجد سعر بيع تلقائي في بند التنفيذ. تكلفة الوحدة التقديرية في خطة التنفيذ ليست سعر البيع. أدخل السعر هنا."
                 : "هذا سعر التعاقد مع المقاول الباطن، مستقل عن تكلفة التخطيط وعن سعر عقد المالك. أدخل السعر المتفق عليه هنا."}
             </p>
           </div>
          <div><label className="text-[11px] text-slate-600">الإجمالي</label><div className="rounded border bg-slate-50 px-3 py-2 text-sm tabular-nums">{total(draft).toLocaleString("en-US", { maximumFractionDigits: 2 })} ر.س</div></div>
          <div className="col-span-2"><label className="text-[11px] text-slate-600">الوصف</label><Input value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></div>
          <div className="col-span-2 flex items-end justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setDraft(null)}><X className="mx-1 h-3 w-3" />إلغاء</Button>
            <Button size="sm" onClick={() => void save()}>حفظ السطر</Button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded border bg-white dark:bg-slate-900">
        <Table>
          <TableHeader><TableRow>
            <TableHead>البند</TableHead><TableHead>الوحدة</TableHead><TableHead>الكمية</TableHead>
            <TableHead>السعر</TableHead><TableHead>الإجمالي</TableHead><TableHead>—</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {loading && rows.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-sm text-slate-500">جار التحميل…</TableCell></TableRow>}
             {!loading && !loadError && rows.length === 0 && (pendingLines ?? []).length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-sm text-slate-500">لا توجد أسطر محفوظة لهذا العقد — أضف أول سطر من بنود المشروع</TableCell></TableRow>}
             {(pendingLines ?? []).map((line, index) => (
               <TableRow key={`pending-${index}`} data-testid="pending-contract-boq-line">
                 <TableCell>{workItems.find(item => String(item.id) === line.workItemId)?.nameAr || line.description} <span className="text-xs text-amber-700">لم يحفظ بعد</span></TableCell>
                 <TableCell>{line.unit}</TableCell>
                 <TableCell>{line.quantity}</TableCell>
                 <TableCell>{line.unitPrice}</TableCell>
                 <TableCell>{total(line).toLocaleString("en-US")}</TableCell>
                 <TableCell>
                   <Button size="sm" variant="ghost" onClick={() => { setEditingId(null); setEditingPendingIndex(index); setDraft({ ...line }); }}><Pencil className="h-4 w-4" /></Button>
                   <Button size="sm" variant="ghost" onClick={() => onPendingLinesChange?.((pendingLines ?? []).filter((_, i) => i !== index))}><Trash2 className="h-4 w-4" /></Button>
                 </TableCell>
               </TableRow>
             ))}
            {rows.map(row => (
              <TableRow key={row.id}>
                <TableCell className="font-medium">
                  {row.workItemCode ? `${row.workItemCode} — ` : ""}{row.workItemName || "بند محذوف"}
                  {row.sourceOwnerLineId != null && <div className="text-[10px] text-slate-500">مرتبط بسطر مالك #{row.sourceOwnerLineId}</div>}
                   {direction === "subcontract" && row.sourceOwnerLineId == null && <div className="text-[10px] text-amber-700">تسعير باطن مستقل — بدون ربط بسطر مالك</div>}
                   {row.baseLineId != null && <div className="text-[10px] text-indigo-600">تغيير للسطر الأساسي #{row.baseLineId} · كمية: {row.quantityDelta ?? "0"} · سعر: {row.unitPriceDelta ?? "0"}</div>}
                </TableCell>
                <TableCell>{row.unit}</TableCell>
                <TableCell className="tabular-nums">{Number(row.quantity).toLocaleString("en-US")}</TableCell>
                <TableCell className="tabular-nums">{Number(row.unitPrice).toLocaleString("en-US")}</TableCell>
                <TableCell className="tabular-nums font-semibold">{Number(row.totalAmount).toLocaleString("en-US")} ر.س</TableCell>
                <TableCell className="text-end">
                   <ContractingArchiveAction
                     entityType="boqLine"
                     entityId={row.id}
                     companyName={user?.company?.nameAr || user?.company?.nameEn}
                     className="h-8 gap-1.5 text-xs"
                   />
                  <Button size="sm" variant="ghost" onClick={() => beginEdit(row)}><Pencil className="h-4 w-4" /></Button>
                  <Button size="sm" variant="ghost" onClick={() => void remove(row.id)}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}