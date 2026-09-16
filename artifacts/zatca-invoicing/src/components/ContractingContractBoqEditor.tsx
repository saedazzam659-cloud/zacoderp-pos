import { useCallback, useEffect, useMemo, useState } from "react";
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
  direction,
  contractId,
  contractType = "main",
  parentContractId = null,
  onChanged,
}: {
  projectId: number;
  direction: Direction;
  contractId: number;
  contractType?: string;
  parentContractId?: number | null;
  onChanged?: () => void;
}) {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [rows, setRows] = useState<BoqLine[]>([]);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [ownerLines, setOwnerLines] = useState<BoqLine[]>([]);
  const [baseLines, setBaseLines] = useState<BoqLine[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const contractQuery = direction === "owner"
    ? `ownerContractId=${contractId}`
    : `subcontractorContractId=${contractId}`;
  const path = `/api/contracting/projects/${projectId}/boq-lines?direction=${direction}&${contractQuery}`;

  const load = useCallback(async () => {
    if (!token || !contractId) return;
    setLoading(true);
    try {
      const basePath = parentContractId
        ? `${API}/api/contracting/projects/${projectId}/boq-lines?direction=${direction}&${direction === "owner" ? `ownerContractId=${parentContractId}` : `subcontractorContractId=${parentContractId}`}`
        : null;
      const [linesResponse, workItemsResponse, baseResponse] = await Promise.all([
        fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API}/api/contracting/projects/${projectId}/work-items`, { headers: { Authorization: `Bearer ${token}` } }),
        basePath ? fetch(basePath, { headers: { Authorization: `Bearer ${token}` } }) : Promise.resolve(null),
      ]);
      if (!linesResponse.ok) throw new Error((await linesResponse.json().catch(() => ({}))).error || `HTTP ${linesResponse.status}`);
      setRows(await linesResponse.json());
      if (workItemsResponse.ok) setWorkItems(await workItemsResponse.json());
      if (baseResponse?.ok) setBaseLines(await baseResponse.json());
      if (direction === "subcontract") {
        const ownerResponse = await fetch(`${API}/api/contracting/projects/${projectId}/boq-lines?direction=owner`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (ownerResponse.ok) setOwnerLines(await ownerResponse.json());
      }
    } catch (caught: any) {
      toast({ title: caught?.message || "تعذر تحميل جدول الكميات", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [contractId, direction, parentContractId, path, projectId, toast, token]);

  useEffect(() => { void load(); }, [load]);

  const workItemOptions = useMemo<ComboboxItem[]>(
    () => workItems.map(item => ({
      value: String(item.id),
      label: `${item.code ? `${item.code} — ` : ""}${item.nameAr}`,
    })),
    [workItems],
  );
  const ownerLineOptions = useMemo<ComboboxItem[]>(
    () => [
      { value: "__none__", label: "بدون ربط بسطر المالك" },
      ...ownerLines.map(line => ({
        value: String(line.id),
        label: `${line.workItemCode ? `${line.workItemCode} — ` : ""}${line.workItemName || "بند"} · ${Number(line.quantity).toLocaleString()} ${line.unit}`,
      })),
    ],
    [ownerLines],
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
    setDraft(emptyDraft());
  }

  function beginEdit(row: BoqLine) {
    setEditingId(row.id);
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
      <div className="flex items-center justify-between gap-2">
        <div>
          <h5 className="font-semibold">جدول كميات العقد</h5>
          <p className="text-[11px] text-slate-500">
            {direction === "owner"
              ? "الكميات والأسعار التجارية الخاصة بعقد المالك"
              : "الكميات والأسعار الخاصة بعقد الباطن — يمكن تقسيم سطر المالك بين عدة مقاولين"}
          </p>
        </div>
        {!draft && <Button size="sm" variant="outline" onClick={beginAdd}><Plus className="mx-1 h-4 w-4" />إضافة سطر</Button>}
      </div>

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
          <div><label className="text-[11px] text-slate-600">سعر الوحدة</label><Input type="number" min="0" value={draft.unitPrice} onChange={e => setDraft({ ...draft, unitPrice: e.target.value })} /></div>
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
            {!loading && rows.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-sm text-slate-500">لا توجد أسطر — أضف أول سطر</TableCell></TableRow>}
            {rows.map(row => (
              <TableRow key={row.id}>
                <TableCell className="font-medium">
                  {row.workItemCode ? `${row.workItemCode} — ` : ""}{row.workItemName || "بند محذوف"}
                  {row.sourceOwnerLineId != null && <div className="text-[10px] text-slate-500">مرتبط بسطر مالك #{row.sourceOwnerLineId}</div>}
                   {row.baseLineId != null && <div className="text-[10px] text-indigo-600">تغيير للسطر الأساسي #{row.baseLineId} · كمية: {row.quantityDelta ?? "0"} · سعر: {row.unitPriceDelta ?? "0"}</div>}
                </TableCell>
                <TableCell>{row.unit}</TableCell>
                <TableCell className="tabular-nums">{Number(row.quantity).toLocaleString("en-US")}</TableCell>
                <TableCell className="tabular-nums">{Number(row.unitPrice).toLocaleString("en-US")}</TableCell>
                <TableCell className="tabular-nums font-semibold">{Number(row.totalAmount).toLocaleString("en-US")} ر.س</TableCell>
                <TableCell className="text-end">
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